/**
 * Sonicake Connection Manager
 * Supports Web MIDI (USB) and Web Bluetooth (BLE) with unified SysEx transport.
 */

export class SonicakeConnection {
  constructor() {
    this.connectionType = null; // 'usb', 'ble', or null
    this.isConnected = false;
    this.deviceName = 'Disconnected';
    
    // USB MIDI
    this.midiAccess = null;
    this.midiInput = null;
    this.midiOutput = null;
    this.usbMidiBuffer = null;
    this.usbMultiPacketResponses = {};
    
    // BLE
    this.bleDevice = null;
    this.bleServer = null;
    this.bleCharacteristic = null;
    this.SERVICE_UUID = '03b80e5a-ede8-4b33-a751-6ce34ec4c700';
    this.CHARACTERISTIC_UUID = '7772e5db-3868-4112-a1a9-f2669d106bf3';
    this.bleBuffer = [];

    // Link session: incremented on every successful (re)connection. Long-running
    // operations (flash streaming) capture it and abort if it changes mid-flight,
    // so a stream is never resumed into a different session.
    this.sessionId = 0;

    // BLE auto-reconnect
    this.autoReconnect = true;
    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000];
    this.BLE_DEVICE_ID_KEY = 'sonicake_ble_device_id';
    // Stable references so add/removeEventListener never leak or double-bind
    this._onBleDisconnected = (event) => this.handleBleDisconnected(event);
    this._onBleValue = (event) => this.handleBleValue(event);

    if (typeof document !== 'undefined') {
      // Returning to the tab (or the network coming back) is the best moment to retry now
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.retryReconnectNow();
      });
      window.addEventListener('online', () => this.retryReconnectNow());
    }

    // Callbacks
    this.messageHandlers = new Set();
    this.statusHandlers = new Set();
    this.logHandlers = new Set();
    this.programChangeHandlers = new Set();
  }

  onMessage(callback) {
    this.messageHandlers.add(callback);
    return () => this.messageHandlers.delete(callback);
  }

  onProgramChange(callback) {
    this.programChangeHandlers.add(callback);
    return () => this.programChangeHandlers.delete(callback);
  }

  onStatusChange(callback) {
    this.statusHandlers.add(callback);
    return () => this.statusHandlers.delete(callback);
  }

  onLog(callback) {
    this.logHandlers.add(callback);
    return () => this.logHandlers.delete(callback);
  }

  log(message, type = 'info') {
    this.logHandlers.forEach(handler => handler({ message, type, time: new Date() }));
  }

  notifyStatus() {
    const status = {
      isConnected: this.isConnected,
      type: this.connectionType,
      deviceName: this.deviceName,
      reconnecting: this.reconnecting,
      reconnectAttempt: this.reconnectAttempt,
      reconnectMaxAttempts: this.RECONNECT_DELAYS_MS.length
    };
    this.statusHandlers.forEach(handler => handler(status));
  }

  /**
   * Check for connected USB MIDI devices
   */
  async getAvailableUsbDevices() {
    if (!navigator.requestMIDIAccess) {
      this.log('Web MIDI API is not supported in this browser. Please use Chrome or Edge.', 'warning');
      return [];
    }

    try {
      this.midiAccess = await navigator.requestMIDIAccess({ sysex: true });
      const inputs = Array.from(this.midiAccess.inputs.values());
      const outputs = Array.from(this.midiAccess.outputs.values());

      const pairs = [];
      inputs.forEach(input => {
        const matchingOutput = outputs.find(output => 
          output.name === input.name || 
          output.name.includes(input.name) || 
          input.name.includes(output.name)
        );
        pairs.push({
          name: input.name || 'MIDI Device',
          input,
          output: matchingOutput || outputs[0] || null
        });
      });

      return pairs;
    } catch (err) {
      this.log(`Error checking MIDI devices: ${err.message}`, 'error');
      return [];
    }
  }

  /**
   * Connect via USB MIDI
   */
  async connectUsb(devicePair = null) {
    try {
      this.log('Scanning for USB MIDI devices...', 'info');
      const pairs = await this.getAvailableUsbDevices();

      if (pairs.length === 0) {
        throw new Error('No USB MIDI devices found. Make sure your Smart Box is turned on and connected via USB.');
      }

      // Prioritize devices named 'Smart Box', 'Sonicake', 'Sonic', or 'QME'
      let selected = devicePair;
      if (!selected) {
        selected = pairs.find(p => /smart box|sonicake|sonic|qme/i.test(p.name)) || pairs[0];
      }

      if (!selected.output) {
        throw new Error(`Device "${selected.name}" has no corresponding MIDI Output port.`);
      }

      this.midiInput = selected.input;
      this.midiOutput = selected.output;
      this.connectionType = 'usb';
      this.deviceName = selected.name;

      this.usbMidiBuffer = null;
      this.usbMultiPacketResponses = {};

      this.midiInput.onmidimessage = (event) => this.handleUsbMidiMessage(event);

      this.isConnected = true;
      this.sessionId++;
      this.log(`Connected via USB MIDI: ${selected.name}`, 'success');
      this.notifyStatus();
      return true;
    } catch (err) {
      this.log(`USB connection failed: ${err.message}`, 'error');
      throw err;
    }
  }

  /**
   * Handle incoming USB MIDI messages (reassemble SysEx packets)
   */
  handleUsbMidiMessage(event) {
    let data = event.data;
    if (!data || data.length === 0) return;

    // Check for standard MIDI Program Change (0xC0 - 0xCF)
    if ((data[0] & 0xF0) === 0xC0 && data.length >= 2) {
      const pcSlot = data[1] + 1; // 1-based (1 to 100)
      this.log(`Received MIDI Program Change from hardware: slot ${pcSlot}`, 'info');
      this.programChangeHandlers.forEach(handler => handler(pcSlot));
      return;
    }

    // Ignore non-SysEx MIDI packets if not in the middle of reassembling a SysEx buffer
    if (this.usbMidiBuffer === null && data[0] !== 0xF0) {
      return;
    }

    // Check for SysEx (starts with F0, ends with F7)
    if (data.length < 4 || data[0] !== 0xF0 || data[data.length - 1] !== 0xF7) {
      // Chunked / partial SysEx packet
      if (this.usbMidiBuffer === null) {
        this.usbMidiBuffer = new Uint8Array(data);
      } else {
        const combined = new Uint8Array(this.usbMidiBuffer.length + data.length);
        combined.set(this.usbMidiBuffer);
        combined.set(data, this.usbMidiBuffer.length);
        this.usbMidiBuffer = combined;
      }

      // Check if complete now
      if (this.usbMidiBuffer[0] === 0xF0 && this.usbMidiBuffer[this.usbMidiBuffer.length - 1] === 0xF7) {
        data = this.usbMidiBuffer;
        this.usbMidiBuffer = null;
      } else {
        return;
      }
    }

    let message = data;
    if (this.usbMidiBuffer !== null) {
      const combined = new Uint8Array(this.usbMidiBuffer.length + data.length);
      combined.set(this.usbMidiBuffer);
      combined.set(data, this.usbMidiBuffer.length);
      message = combined;
      this.usbMidiBuffer = null;
    }

    // Packet counting
    const totalPackets = (message[3] << 4) | message[4];
    const currentPacket = (message[5] << 4) | message[6];

    if (totalPackets > 1) {
      const responseId = `${message[3]}_${message[4]}`;
      if (this.usbMultiPacketResponses[responseId] && (Date.now() - this.usbMultiPacketResponses[responseId].startTime > 2500)) {
        delete this.usbMultiPacketResponses[responseId];
      }
      if (!this.usbMultiPacketResponses[responseId]) {
        this.usbMultiPacketResponses[responseId] = {
          totalPackets,
          packets: {},
          startTime: Date.now()
        };
      }

      const response = this.usbMultiPacketResponses[responseId];
      response.packets[currentPacket] = message;

      let allPacketsReceived = true;
      for (let i = 0; i < totalPackets; i++) {
        if (!(i in response.packets)) {
          allPacketsReceived = false;
          break;
        }
      }

      if (allPacketsReceived) {
        const reassembledPayload = [];
        for (let i = 0; i < totalPackets; i++) {
          const pkt = response.packets[i];
          const payloadStart = 9;
          const payloadEnd = pkt.length - 1;
          for (let j = payloadStart; j < payloadEnd; j++) {
            reassembledPayload.push(pkt[j]);
          }
        }

        const singlePacketMessage = new Uint8Array(reassembledPayload.length + 10);
        singlePacketMessage[0] = 0xF0;
        singlePacketMessage[1] = message[1];
        singlePacketMessage[2] = message[2];
        singlePacketMessage[3] = 0x00;
        singlePacketMessage[4] = 0x01;
        singlePacketMessage[5] = 0x00;
        singlePacketMessage[6] = 0x00;
        singlePacketMessage[7] = message[7];
        singlePacketMessage[8] = message[8];
        singlePacketMessage.set(reassembledPayload, 9);
        singlePacketMessage[singlePacketMessage.length - 1] = 0xF7;

        delete this.usbMultiPacketResponses[responseId];

        // Format as BLE-equivalent hex starting with 8080F0 for unified handlers
        const hex = '8080' + Array.from(singlePacketMessage).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        this.dispatchMessage(hex);
      }
    } else {
      // Single packet message
      const hex = '8080' + Array.from(message).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      this.dispatchMessage(hex);
    }
  }

  /**
   * Connect via Web Bluetooth (BLE)
   */
  async connectBle() {
    if (!navigator.bluetooth) {
      if (!window.isSecureContext) {
        throw new Error('Web Bluetooth richiede HTTPS quando usato da smartphone/rete locale. Apri la pagina con https:// anziché http:// (es. https://' + (window.location.hostname || '192.168.1.218') + ':5173).');
      }
      throw new Error('Web Bluetooth API non è supportata da questo browser. Usa Google Chrome o Microsoft Edge.');
    }

    try {
      this.log('Searching for Sonicake Bluetooth devices...', 'info');
      try {
        this.bleDevice = await navigator.bluetooth.requestDevice({
          filters: [
            { name: 'Sonic Master BLE' },
            { namePrefix: 'Sonic' },
            { namePrefix: 'Smart' },
            { namePrefix: 'Pocket' },
            { namePrefix: 'QME' },
            { services: [this.SERVICE_UUID] }
          ],
          optionalServices: [this.SERVICE_UUID]
        });
      } catch (scanErr) {
        // If user cancelled, rethrow
        if (scanErr.name === 'NotFoundError' && scanErr.message?.toLowerCase().includes('user cancelled')) {
          throw scanErr;
        }
        // Fallback: broaden search with acceptAllDevices
        this.log('Riprovo scansione Bluetooth con tutti i dispositivi...', 'info');
        this.bleDevice = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [this.SERVICE_UUID]
        });
      }

      this.log(`Connecting to BLE device: ${this.bleDevice.name}...`, 'info');

      // A fresh manual connection replaces any reconnect cycle in progress
      this.cancelReconnect();

      // Same function reference every time: the browser dedupes, so this never stacks listeners
      this.bleDevice.addEventListener('gattserverdisconnected', this._onBleDisconnected);

      await this.openBleSession();
      this.rememberBleDevice();

      this.log(`Connected via Bluetooth: ${this.deviceName}`, 'success');
      this.notifyStatus();
      return true;
    } catch (err) {
      // Don't leave a half-attached device behind after a failed first connection
      if (!this.isConnected && this.bleDevice) {
        try { this.bleDevice.removeEventListener('gattserverdisconnected', this._onBleDisconnected); } catch (e) {}
        try { if (this.bleDevice.gatt?.connected) this.bleDevice.gatt.disconnect(); } catch (e) {}
        this.bleDevice = null;
      }
      this.log(`Bluetooth connection failed: ${err.message}`, 'error');
      throw err;
    }
  }

  /**
   * Open (or re-open) the GATT session on this.bleDevice and start notifications.
   * Shared by the first connection and by every reconnect, so the picker is never needed again.
   */
  async openBleSession() {
    const device = this.bleDevice;
    if (!device) throw new Error('Nessun dispositivo Bluetooth selezionato.');

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(this.SERVICE_UUID);
    const characteristic = await service.getCharacteristic(this.CHARACTERISTIC_UUID);

    // The device may have been released (manual disconnect) while we were awaiting
    if (this.bleDevice !== device) {
      try { device.gatt.disconnect(); } catch (e) {}
      throw new Error('Connessione Bluetooth annullata.');
    }

    // Drop the listener on the previous characteristic object, if any
    if (this.bleCharacteristic) {
      try { this.bleCharacteristic.removeEventListener('characteristicvaluechanged', this._onBleValue); } catch (e) {}
    }

    // A fragment left over from before a link drop must never be glued to new data
    this.bleBuffer = [];
    characteristic.addEventListener('characteristicvaluechanged', this._onBleValue);
    await characteristic.startNotifications();

    this.bleServer = server;
    this.bleCharacteristic = characteristic;
    this.connectionType = 'ble';
    this.deviceName = device.name || 'Sonicake BLE';
    this.isConnected = true;
    this.sessionId++;
  }

  /**
   * Incoming BLE notification: normalise to the unified "8080F0...F7" hex form,
   * reassembling fragments. (event.target.value is a DataView over a shared buffer
   * on Android Chrome, hence the explicit byteOffset/byteLength slice.)
   */
  handleBleValue(event) {
    const val = event.target.value;
    if (!val) return;
    const data = new Uint8Array(val.buffer, val.byteOffset, val.byteLength);
    if (data.length === 0) return;

    const startsWithSysEx = (data[0] === 0x80 && data[1] === 0x80 && data[2] === 0xF0) || data[0] === 0xF0;
    const endsWithSysEx = data[data.length - 1] === 0xF7;

    // 1. Single standalone packet
    if (this.bleBuffer.length === 0 && startsWithSysEx && endsWithSysEx) {
      let hex = Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      if (!hex.startsWith('8080')) hex = '8080' + hex;
      this.dispatchMessage(hex);
      return;
    }

    // 2. Fragmented packet - accumulate bytes
    for (let i = 0; i < data.length; i++) {
      this.bleBuffer.push(data[i]);
    }

    // Check if buffer is completed with 0xF7
    if (this.bleBuffer.length >= 4 && this.bleBuffer[this.bleBuffer.length - 1] === 0xF7) {
      const buf = new Uint8Array(this.bleBuffer);
      this.bleBuffer = [];
      let hex = Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      if (!hex.startsWith('8080')) hex = '8080' + hex;
      this.dispatchMessage(hex);
    }
  }

  // --- BLE auto-reconnect ---

  rememberBleDevice() {
    try {
      if (this.bleDevice?.id) localStorage.setItem(this.BLE_DEVICE_ID_KEY, this.bleDevice.id);
    } catch (e) {}
  }

  forgetBleDevice() {
    try { localStorage.removeItem(this.BLE_DEVICE_ID_KEY); } catch (e) {}
  }

  /**
   * The GATT link dropped without the user asking for it (pedal out of range,
   * power cycle, OS suspended the radio...). Keep the paired device and retry.
   */
  handleBleDisconnected(event) {
    // Ignore echoes of a disconnect we caused ourselves, and events from a stale device
    if (!this.bleDevice || this.connectionType !== 'ble') return;
    if (event?.target && event.target !== this.bleDevice) return;
    // Already handling a drop (a failed reconnect attempt also fires this event)
    if (this.reconnecting) return;

    this.log('Bluetooth link lost', 'warning');
    this.isConnected = false;
    this.bleServer = null;
    this.bleCharacteristic = null;
    this.bleBuffer = [];

    if (this.autoReconnect) {
      this.reconnecting = true;
      this.reconnectAttempt = 0;
      this.scheduleReconnect();
    } else {
      this.disconnect();
    }
  }

  scheduleReconnect() {
    if (!this.reconnecting || this.reconnectTimer) return;

    if (this.reconnectAttempt >= this.RECONNECT_DELAYS_MS.length) {
      this.log('Riconnessione Bluetooth non riuscita: premi Bluetooth per ricollegare la pedaliera.', 'error');
      this.disconnect();
      return;
    }

    const delay = this.RECONNECT_DELAYS_MS[this.reconnectAttempt];
    this.log(`Riconnessione Bluetooth tra ${Math.round(delay / 1000)}s (tentativo ${this.reconnectAttempt + 1}/${this.RECONNECT_DELAYS_MS.length})...`, 'info');
    this.reconnectTimer = setTimeout(() => this.attemptReconnect(), delay);
    this.notifyStatus();
  }

  async attemptReconnect() {
    this.reconnectTimer = null;
    if (!this.reconnecting || !this.bleDevice) return;

    this.reconnectAttempt++;
    this.notifyStatus();
    try {
      await this.openBleSession();
    } catch (err) {
      // User cancelled (disconnect) while the attempt was in flight
      if (!this.reconnecting || !this.bleDevice) return;
      this.log(`Riconnessione fallita: ${err.message}`, 'warning');
      this.scheduleReconnect();
      return;
    }

    this.reconnecting = false;
    this.reconnectAttempt = 0;
    this.log(`Bluetooth riconnesso: ${this.deviceName}`, 'success');
    // isConnected is true again: listeners (main.js) re-run the hardware sync
    this.notifyStatus();
  }

  /** Skip the backoff wait and try right now (tab visible again, network back). */
  retryReconnectNow() {
    if (!this.reconnecting || !this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attemptReconnect();
  }

  cancelReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnecting = false;
    this.reconnectAttempt = 0;
  }

  /**
   * On page load, silently re-attach to the pedal paired in a previous visit.
   * Best-effort: needs navigator.bluetooth.getDevices() (not available in every browser),
   * and the pedal must be on and in range. Never opens a picker or shows an error.
   * @returns {Promise<boolean>}
   */
  async restoreBleSession() {
    try {
      if (this.isConnected || this.reconnecting) return false;
      if (!navigator.bluetooth?.getDevices) return false;
      const savedId = localStorage.getItem(this.BLE_DEVICE_ID_KEY);
      if (!savedId) return false;

      const devices = await navigator.bluetooth.getDevices();
      const device = devices.find(d => d.id === savedId);
      if (!device) return false;

      this.bleDevice = device;
      device.addEventListener('gattserverdisconnected', this._onBleDisconnected);
      await this.openBleSession();
      this.log(`Bluetooth ripristinato automaticamente: ${this.deviceName}`, 'success');
      this.notifyStatus();
      return true;
    } catch (err) {
      // Pedal off / out of range / browser refused: stay quiet, the user can press Bluetooth
      if (!this.isConnected) {
        try { this.bleDevice?.removeEventListener('gattserverdisconnected', this._onBleDisconnected); } catch (e) {}
        this.bleDevice = null;
      }
      return false;
    }
  }

  /**
   * Dispatch raw incoming hex message to registered handlers
   */
  dispatchMessage(hexString) {
    this.messageHandlers.forEach(handler => handler(hexString));
  }

  /**
   * Send a SysEx hex command string to the pedal
   * @param {string} commandString Hex string, with or without 8080 prefix
   */
  async writeCommand(commandString) {
    if (!this.isConnected) {
      this.log('Cannot send: Device is not connected', 'error');
      return false;
    }

    try {
      const cleanHex = commandString.replace(/\s+/g, '');
      const hexBytes = cleanHex.match(/.{1,2}/g).map(byte => parseInt(byte, 16));
      const commandBytes = new Uint8Array(hexBytes);

      if (this.connectionType === 'usb' && this.midiOutput) {
        // For USB MIDI, strip the 8080 prefix if present
        let payload = commandBytes;
        if (payload[0] === 0x80 && payload[1] === 0x80) {
          payload = payload.slice(2);
        }
        this.midiOutput.send(payload);
        this.log(`Sent USB MIDI: ${cleanHex.slice(4)}`, 'sent');
      } else if (this.connectionType === 'ble' && this.bleCharacteristic) {
        // For BLE, keep or prepend 8080
        let payload = commandBytes;
        if (payload[0] !== 0x80 || payload[1] !== 0x80) {
          const blePacket = new Uint8Array(commandBytes.length + 2);
          blePacket[0] = 0x80;
          blePacket[1] = 0x80;
          blePacket.set(commandBytes, 2);
          payload = blePacket;
        }
        await this.bleCharacteristic.writeValueWithoutResponse(payload);
        this.log(`Sent BLE: ${cleanHex}`, 'sent');
      }
      return true;
    } catch (err) {
      this.log(`Send command failed: ${err.message}`, 'error');
      return false;
    }
  }

  /**
   * Send a raw Uint8Array packet directly to the pedal (Web MIDI or BLE)
   * Essential for high-speed streaming chunk uploads to flash memory.
   * @param {Uint8Array} bytes
   * @returns {Promise<boolean>}
   */
  async writeRawBytes(bytes) {
    if (!this.isConnected) return false;

    try {
      if (this.connectionType === 'usb' && this.midiOutput) {
        let payload = bytes;
        if (payload[0] === 0x80 && payload[1] === 0x80) {
          payload = payload.slice(2);
        }
        this.midiOutput.send(payload);
        return true;
      } else if (this.connectionType === 'ble' && this.bleCharacteristic) {
        let payload = bytes;
        if (payload[0] !== 0x80 || payload[1] !== 0x80) {
          const blePacket = new Uint8Array(bytes.length + 2);
          blePacket[0] = 0x80;
          blePacket[1] = 0x80;
          blePacket.set(bytes, 2);
          payload = blePacket;
        }
        await this.bleCharacteristic.writeValueWithoutResponse(payload);
        return true;
      }
    } catch (err) {
      this.log(`writeRawBytes failed: ${err.message}`, 'error');
    }
    return false;
  }

  /**
   * Disconnect current active device (also cancels any BLE reconnect in progress).
   * @param {{forget?: boolean}} [options] forget=false keeps the paired BLE device id so the
   *   next page load can silently re-attach (used when the page is just unloading).
   */
  disconnect({ forget = true } = {}) {
    this.cancelReconnect();

    if (this.connectionType === 'usb' && this.midiInput) {
      this.midiInput.onmidimessage = null;
      try { this.midiInput.close?.(); } catch (e) {}
      try { this.midiOutput?.close?.(); } catch (e) {}
      this.midiInput = null;
      this.midiOutput = null;
    } else if (this.connectionType === 'ble' && this.bleDevice) {
      // Detach first so our own gatt.disconnect() is not mistaken for a link drop
      try { this.bleDevice.removeEventListener('gattserverdisconnected', this._onBleDisconnected); } catch (e) {}
      try { this.bleCharacteristic?.removeEventListener('characteristicvaluechanged', this._onBleValue); } catch (e) {}
      if (this.bleDevice.gatt && this.bleDevice.gatt.connected) {
        this.bleDevice.gatt.disconnect();
      }
      this.bleDevice = null;
      this.bleServer = null;
      this.bleCharacteristic = null;
      this.bleBuffer = [];
      if (forget) this.forgetBleDevice();
    }

    this.isConnected = false;
    this.connectionType = null;
    this.deviceName = 'Disconnected';
    this.notifyStatus();
    this.log('Disconnected from device', 'info');
  }
}

export const connection = new SonicakeConnection();
