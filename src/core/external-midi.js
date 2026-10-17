/**
 * External MIDI Controller
 * Lets wireless / USB MIDI foot controllers (Chocolate MIDI, Airstep, generic MIDI pedals...)
 * drive the app: Program Change -> setlist song or preset slot, Control Change -> actions.
 *
 * Design notes
 * - Uses its OWN Web MIDI session requested WITHOUT sysex: a footswitch never needs it, so the
 *   browser permission stays as narrow as possible. The pedal's own SysEx link (connection.js)
 *   is untouched.
 * - The Smart Box's own MIDI port is excluded here: its Program Changes are already handled by
 *   connection.js ("pedal -> app", no hardware echo). Messages from this module go
 *   "controller -> app -> pedal" and DO sync the pedal.
 * - Opt-in: nothing is requested until the user enables it; the choice is remembered.
 */

import { presetEngine } from './preset-engine.js';

const STORAGE_KEY = 'sonicake_external_midi_v1';
const PEDAL_PORT_RE = /smart box|sonicake|sonic master|qme/i;

/** Actions a Control Change can trigger. */
export const CC_ACTIONS = [
  { id: 'prevSong',   label: 'Brano precedente',    hint: 'Scaletta' },
  { id: 'nextSong',   label: 'Brano successivo',    hint: 'Scaletta' },
  { id: 'prevPreset', label: 'Preset precedente',   hint: 'U01-F50' },
  { id: 'nextPreset', label: 'Preset successivo',   hint: 'U01-F50' },
  { id: 'toggleAB',   label: 'Alterna Tone A / B',  hint: 'A/B' }
];

/** Sensible defaults: CC 80-83 and 85 are "general purpose / undefined" in the MIDI spec. */
const DEFAULT_CONFIG = {
  enabled: false,
  channel: 0,          // 0 = omni (any channel), 1..16
  pcMode: 'setlist',   // 'setlist' | 'preset'
  ccMap: { '80': 'prevSong', '81': 'nextSong', '82': 'prevPreset', '83': 'nextPreset', '85': 'toggleAB' }
};

const CC_ON_THRESHOLD = 64;   // value >= 64 counts as "pressed"
const ACTION_DEBOUNCE_MS = 120;
const MONITOR_SIZE = 12;

class ExternalMidiController {
  constructor() {
    this.config = this.loadConfig();
    this.setlist = null;          // SetlistModal instance, injected via attach()
    this.access = null;           // MIDIAccess (sysex: false)
    this.boundInputs = new Map(); // input.id -> MIDIInput
    this.status = 'off';          // 'off' | 'ready' | 'unsupported' | 'denied'
    this.statusDetail = '';
    this.learnTarget = null;      // action id waiting for the next CC
    this.activity = [];           // newest first
    this.lastCcValue = new Map();
    this.lastActionAt = new Map();
    this.listeners = { change: new Set(), activity: new Set() };
  }

  // --- wiring / events ---

  attach({ setlist }) {
    this.setlist = setlist || null;
  }

  on(event, cb) {
    this.listeners[event]?.add(cb);
    return () => this.listeners[event]?.delete(cb);
  }

  emit(event, payload) {
    this.listeners[event]?.forEach(cb => {
      try { cb(payload); } catch (e) { console.warn('external-midi listener error', e); }
    });
  }

  // --- config persistence ---

  loadConfig() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        const ccMap = {};
        const validActions = new Set(CC_ACTIONS.map(a => a.id));
        for (const [cc, action] of Object.entries(raw.ccMap || {})) {
          const n = Number(cc);
          if (Number.isInteger(n) && n >= 0 && n <= 127 && validActions.has(action)) ccMap[String(n)] = action;
        }
        return {
          enabled: !!raw.enabled,
          channel: Number.isInteger(raw.channel) && raw.channel >= 0 && raw.channel <= 16 ? raw.channel : 0,
          pcMode: raw.pcMode === 'preset' ? 'preset' : 'setlist',
          ccMap: raw.ccMap ? ccMap : { ...DEFAULT_CONFIG.ccMap }
        };
      }
    } catch (e) {
      console.warn('Could not load external MIDI config', e);
    }
    return { ...DEFAULT_CONFIG, ccMap: { ...DEFAULT_CONFIG.ccMap } };
  }

  saveConfig() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.config));
    } catch (e) {
      console.warn('Could not save external MIDI config', e);
    }
    this.emit('change');
  }

  // --- lifecycle ---

  isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.requestMIDIAccess;
  }

  /** Re-enable on page load if the user turned it on in a previous visit. */
  async restore() {
    if (this.config.enabled) await this.enable({ silent: true });
  }

  async enable({ silent = false } = {}) {
    if (!this.isSupported()) {
      this.status = 'unsupported';
      this.statusDetail = 'Web MIDI non è supportata da questo browser (usa Chrome o Edge).';
      this.emit('change');
      return false;
    }
    try {
      // No sysex: a foot controller only needs short messages
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.access.onstatechange = () => this.bindInputs();
      this.config.enabled = true;
      this.status = 'ready';
      this.statusDetail = '';
      this.bindInputs();
      this.saveConfig();
      return true;
    } catch (err) {
      this.access = null;
      this.status = 'denied';
      this.statusDetail = `Accesso MIDI negato o non disponibile: ${err.message}`;
      // A failed silent restore must not erase the user's opt-in choice
      if (!silent) this.config.enabled = false;
      this.saveConfig();
      return false;
    }
  }

  disable() {
    this.cancelLearn();
    this.unbindAll();
    if (this.access) this.access.onstatechange = null;
    this.access = null;
    this.config.enabled = false;
    this.status = 'off';
    this.statusDetail = '';
    this.saveConfig();
  }

  unbindAll() {
    this.boundInputs.forEach(input => { input.onmidimessage = null; });
    this.boundInputs.clear();
    this.lastCcValue.clear();
  }

  /** (Re)attach to every connected input except the Smart Box itself. Safe to call repeatedly. */
  bindInputs() {
    if (!this.access) return;
    const present = new Map();
    this.access.inputs.forEach(input => {
      if (input.state === 'disconnected') return;
      if (PEDAL_PORT_RE.test(input.name || '')) return;
      present.set(input.id, input);
    });

    // Drop inputs that went away
    for (const [id, input] of this.boundInputs) {
      if (!present.has(id)) {
        input.onmidimessage = null;
        this.boundInputs.delete(id);
      }
    }
    // Attach new ones
    for (const [id, input] of present) {
      if (!this.boundInputs.has(id)) {
        input.onmidimessage = (event) => this.handleMessage(input, event);
        this.boundInputs.set(id, input);
      }
    }
    this.emit('change');
  }

  getInputNames() {
    return Array.from(this.boundInputs.values()).map(i => i.name || 'MIDI Input');
  }

  // --- configuration API (used by the modal) ---

  setChannel(channel) {
    const n = Number(channel);
    this.config.channel = Number.isInteger(n) && n >= 0 && n <= 16 ? n : 0;
    this.saveConfig();
  }

  setPcMode(mode) {
    this.config.pcMode = mode === 'preset' ? 'preset' : 'setlist';
    this.saveConfig();
  }

  /** Map a CC to an action. A CC drives one action only; an action can have several CCs. */
  assignCc(cc, actionId) {
    if (!CC_ACTIONS.some(a => a.id === actionId)) return;
    this.config.ccMap[String(cc)] = actionId;
    this.saveConfig();
  }

  removeCc(cc) {
    delete this.config.ccMap[String(cc)];
    this.saveConfig();
  }

  getCcsForAction(actionId) {
    return Object.entries(this.config.ccMap)
      .filter(([, a]) => a === actionId)
      .map(([cc]) => Number(cc))
      .sort((a, b) => a - b);
  }

  resetDefaults() {
    this.config.channel = DEFAULT_CONFIG.channel;
    this.config.pcMode = DEFAULT_CONFIG.pcMode;
    this.config.ccMap = { ...DEFAULT_CONFIG.ccMap };
    this.saveConfig();
  }

  startLearn(actionId) {
    this.learnTarget = actionId;
    this.emit('change');
  }

  cancelLearn() {
    if (this.learnTarget === null) return;
    this.learnTarget = null;
    this.emit('change');
  }

  // --- message handling ---

  handleMessage(input, event) {
    const data = event.data;
    if (!data || data.length < 2) return;

    const status = data[0];
    if (status >= 0xF0) return; // system messages / clock: ignore
    const type = status & 0xF0;
    const channel = (status & 0x0F) + 1;
    const device = input.name || 'MIDI Input';

    if (type === 0xB0 && data.length >= 3) {
      this.handleControlChange(device, input.id, channel, data[1], data[2]);
    } else if (type === 0xC0) {
      this.handleProgramChange(device, channel, data[1]);
    }
  }

  channelAllowed(channel) {
    return this.config.channel === 0 || this.config.channel === channel;
  }

  record(entry) {
    this.activity.unshift({ time: new Date(), ...entry });
    if (this.activity.length > MONITOR_SIZE) this.activity.length = MONITOR_SIZE;
    this.emit('activity', this.activity);
  }

  handleControlChange(device, inputId, channel, cc, value) {
    // MIDI learn takes any CC (channel filter intentionally bypassed) on its rising edge
    if (this.learnTarget && value >= CC_ON_THRESHOLD) {
      const actionId = this.learnTarget;
      this.learnTarget = null;
      this.assignCc(cc, actionId);
      this.record({ device, kind: 'CC', channel, number: cc, value, result: `Assegnato a "${this.actionLabel(actionId)}"` });
      return;
    }

    // Edge detection: a footswitch press fires once, not on every repeated value
    const key = `${inputId}:${channel}:${cc}`;
    const prev = this.lastCcValue.get(key) ?? 0;
    this.lastCcValue.set(key, value);
    const pressed = value >= CC_ON_THRESHOLD && prev < CC_ON_THRESHOLD;

    const actionId = this.config.ccMap[String(cc)];
    if (!this.channelAllowed(channel)) {
      if (pressed) this.record({ device, kind: 'CC', channel, number: cc, value, result: 'Ignorato (canale)' });
      return;
    }
    if (!actionId) {
      if (pressed) this.record({ device, kind: 'CC', channel, number: cc, value, result: 'Non assegnato' });
      return;
    }
    if (!pressed) return;

    this.runAction(actionId, { device, kind: 'CC', channel, number: cc, value });
  }

  handleProgramChange(device, channel, program) {
    if (!this.channelAllowed(channel)) {
      this.record({ device, kind: 'PC', channel, number: program, result: 'Ignorato (canale)' });
      return;
    }

    if (this.config.pcMode === 'preset') {
      const slot = program + 1; // PC 0-99 -> preset 1-100
      if (slot < 1 || slot > 100) {
        this.record({ device, kind: 'PC', channel, number: program, result: 'Fuori range (0-99)' });
        return;
      }
      presetEngine.selectPreset(slot, true);
      this.record({ device, kind: 'PC', channel, number: program, result: `Preset ${presetEngine.getSlotCode(slot)}` });
      return;
    }

    // Setlist mode: PC n selects the (n+1)-th song of the active setlist
    const songs = this.setlist?.getActiveSetlist?.()?.songs || [];
    if (!this.setlist || program >= songs.length) {
      this.record({ device, kind: 'PC', channel, number: program, result: `Fuori scaletta (${songs.length} brani)` });
      return;
    }
    this.setlist.selectSong(program);
    this.record({ device, kind: 'PC', channel, number: program, result: `Brano ${program + 1}: ${songs[program].title || ''}`.trim() });
  }

  actionLabel(actionId) {
    return CC_ACTIONS.find(a => a.id === actionId)?.label || actionId;
  }

  runAction(actionId, meta) {
    const now = Date.now();
    if (now - (this.lastActionAt.get(actionId) || 0) < ACTION_DEBOUNCE_MS) return;
    this.lastActionAt.set(actionId, now);

    const cur = presetEngine.currentSlot;
    switch (actionId) {
      case 'nextSong': this.setlist?.nextSong(); break;
      case 'prevSong': this.setlist?.prevSong(); break;
      case 'nextPreset': presetEngine.selectPreset(cur < 100 ? cur + 1 : 1, true); break;
      case 'prevPreset': presetEngine.selectPreset(cur > 1 ? cur - 1 : 100, true); break;
      case 'toggleAB': presetEngine.toggleAB(); break;
      default: return;
    }
    this.record({ ...meta, result: this.actionLabel(actionId) });
  }
}

export const externalMidi = new ExternalMidiController();
