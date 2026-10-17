/**
 * Minimal browser stubs so the app's core modules can run under `node --test`.
 * Import this file FIRST in every test (before any src/ module).
 */

class MemoryStorage {
  constructor() { this.data = new Map(); }
  getItem(k) { return this.data.has(k) ? this.data.get(k) : null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

globalThis.localStorage = new MemoryStorage();
globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
globalThis.window = Object.assign(new EventTarget(), { isSecureContext: true });
if (!globalThis.navigator) globalThis.navigator = {};

export const flush = () => new Promise(resolve => setImmediate(resolve));

/** Fake Web Bluetooth device exposing the Sonicake GATT service. */
export class FakeBleDevice extends EventTarget {
  constructor({ id = 'dev-1', name = 'Sonic Master BLE' } = {}) {
    super();
    this.id = id;
    this.name = name;
    this.failConnects = 0;     // number of upcoming gatt.connect() calls that reject
    this.connectCalls = 0;
    this.characteristic = null;
    const device = this;
    this.gatt = {
      connected: false,
      async connect() {
        device.connectCalls++;
        if (device.failConnects > 0) {
          device.failConnects--;
          throw new Error('GATT connect failed');
        }
        this.connected = true;
        return {
          getPrimaryService: async () => ({
            getCharacteristic: async () => {
              device.characteristic = new FakeCharacteristic();
              return device.characteristic;
            }
          })
        };
      },
      disconnect() {
        this.connected = false;
        device.dispatchEvent(new Event('gattserverdisconnected'));
      }
    };
  }

  /** Simulate the link dropping on its own (pedal out of range, power cycle...). */
  drop() {
    this.gatt.connected = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

export class FakeCharacteristic extends EventTarget {
  constructor() { super(); this.writes = []; }
  async startNotifications() {}
  async writeValueWithoutResponse(bytes) { this.writes.push(bytes); }
  /** Deliver a BLE notification the way Chrome does (DataView over a shared buffer). */
  notify(bytes) {
    const shared = new Uint8Array(bytes.length + 8);
    shared.set(bytes, 4);
    const value = new DataView(shared.buffer, 4, bytes.length);
    const event = new Event('characteristicvaluechanged');
    Object.defineProperty(event, 'target', { value: { value } });
    this.dispatchEvent(event);
  }
}
