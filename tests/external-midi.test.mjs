import './helpers.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { presetEngine } from '../src/core/preset-engine.js';
import { externalMidi } from '../src/core/external-midi.js';

class FakeMidiInput {
  constructor(id, name) { this.id = id; this.name = name; this.state = 'connected'; this.onmidimessage = null; }
  send(...bytes) { this.onmidimessage?.({ data: Uint8Array.from(bytes) }); }
}

let access;
let selectCalls;
let abToggles;
let setlist;

function makeAccess(inputs) {
  const map = new Map(inputs.map(i => [i.id, i]));
  return { inputs: map, onstatechange: null };
}

async function enableWith(inputs) {
  access = makeAccess(inputs);
  globalThis.navigator.requestMIDIAccess = async () => access;
  return externalMidi.enable();
}

beforeEach(() => {
  // disable() persists the config, so it must run BEFORE the storage is wiped
  if (externalMidi.status === 'ready') externalMidi.disable();
  localStorage.clear();
  externalMidi.config = externalMidi.loadConfig();
  externalMidi.activity = [];
  externalMidi.lastCcValue.clear();
  externalMidi.lastActionAt.clear();
  externalMidi.learnTarget = null;

  selectCalls = [];
  abToggles = 0;
  presetEngine.currentSlot = 10;
  presetEngine.selectPreset = async (slot, sync) => { selectCalls.push([slot, sync]); };
  presetEngine.toggleAB = () => { abToggles++; };

  setlist = {
    songs: [{ title: 'Uno' }, { title: 'Due' }, { title: 'Tre' }],
    getActiveSetlist() { return { songs: this.songs }; },
    selected: [],
    selectSong(i) { this.selected.push(i); },
    next: 0, prev: 0,
    nextSong() { this.next++; },
    prevSong() { this.prev++; }
  };
  externalMidi.attach({ setlist });
});

test('requests Web MIDI without sysex permission', async () => {
  let options;
  globalThis.navigator.requestMIDIAccess = async (o) => { options = o; return makeAccess([]); };
  await externalMidi.enable();
  assert.equal(options.sysex, false);
});

test('never listens to the Smart Box port, only to external controllers', async () => {
  const pedal = new FakeMidiInput('p', 'Smart Box');
  const ctrl = new FakeMidiInput('c', 'Chocolate MIDI');
  await enableWith([pedal, ctrl]);

  assert.equal(pedal.onmidimessage, null);
  assert.equal(typeof ctrl.onmidimessage, 'function');
  assert.deepEqual(externalMidi.getInputNames(), ['Chocolate MIDI']);
});

test('Program Change in setlist mode selects the matching song', async () => {
  const ctrl = new FakeMidiInput('c', 'Airstep');
  await enableWith([ctrl]);

  ctrl.send(0xC0, 1); // PC 1 -> 2nd song
  assert.deepEqual(setlist.selected, [1]);
});

test('Program Change beyond the setlist length is ignored and logged', async () => {
  const ctrl = new FakeMidiInput('c', 'Airstep');
  await enableWith([ctrl]);

  ctrl.send(0xC0, 9);
  assert.deepEqual(setlist.selected, []);
  assert.match(externalMidi.activity[0].result, /Fuori scaletta/);
});

test('Program Change in preset mode syncs the pedal (slot = PC + 1)', async () => {
  const ctrl = new FakeMidiInput('c', 'Airstep');
  await enableWith([ctrl]);
  externalMidi.setPcMode('preset');

  ctrl.send(0xC0, 0);
  ctrl.send(0xC0, 99);
  ctrl.send(0xC0, 100); // out of range
  assert.deepEqual(selectCalls, [[1, true], [100, true]]);
});

test('channel filter drops messages from other channels', async () => {
  const ctrl = new FakeMidiInput('c', 'Airstep');
  await enableWith([ctrl]);
  externalMidi.setChannel(3);

  ctrl.send(0xC0 | 0, 1); // channel 1
  ctrl.send(0xC0 | 2, 2); // channel 3
  assert.deepEqual(setlist.selected, [2]);
});

test('CC fires once per press, not on repeated values or on release', async () => {
  const ctrl = new FakeMidiInput('c', 'Chocolate MIDI');
  await enableWith([ctrl]);

  ctrl.send(0xB0, 81, 127);
  ctrl.send(0xB0, 81, 127); // repeated value
  ctrl.send(0xB0, 81, 0);   // release
  assert.equal(setlist.next, 1);
});

test('default CC mapping drives presets and A/B, wrapping around 1..100', async () => {
  const ctrl = new FakeMidiInput('c', 'Chocolate MIDI');
  await enableWith([ctrl]);

  ctrl.send(0xB0, 83, 127); // next preset: 10 -> 11
  presetEngine.currentSlot = 100;
  ctrl.send(0xB0, 83, 0);
  externalMidi.lastActionAt.clear(); // a real second press comes >120ms later
  ctrl.send(0xB0, 83, 127); // wrap to 1
  presetEngine.currentSlot = 1;
  ctrl.send(0xB0, 82, 127); // previous preset: 1 -> 100
  ctrl.send(0xB0, 85, 127); // A/B

  assert.deepEqual(selectCalls, [[11, true], [1, true], [100, true]]);
  assert.equal(abToggles, 1);
});

test('a bouncing switch (two presses within 120ms) triggers the action once', async () => {
  const ctrl = new FakeMidiInput('c', 'Chocolate MIDI');
  await enableWith([ctrl]);

  ctrl.send(0xB0, 81, 127);
  ctrl.send(0xB0, 81, 0);
  ctrl.send(0xB0, 81, 127);
  assert.equal(setlist.next, 1);
});

test('MIDI learn assigns the next pressed CC to the chosen action', async () => {
  const ctrl = new FakeMidiInput('c', 'Chocolate MIDI');
  await enableWith([ctrl]);

  externalMidi.startLearn('nextSong');
  ctrl.send(0xB0, 20, 127);
  assert.equal(externalMidi.learnTarget, null);
  assert.deepEqual(externalMidi.getCcsForAction('nextSong'), [20, 81]);

  ctrl.send(0xB0, 20, 0);
  ctrl.send(0xB0, 20, 127);
  assert.equal(setlist.next, 1, 'learned CC now triggers the action');
});

test('hot-plug: a controller plugged in later is picked up, one removed is released', async () => {
  const first = new FakeMidiInput('a', 'Airstep');
  await enableWith([first]);

  const second = new FakeMidiInput('b', 'Chocolate MIDI');
  access.inputs.set('b', second);
  access.onstatechange();
  assert.equal(typeof second.onmidimessage, 'function');

  access.inputs.delete('a');
  access.onstatechange();
  assert.equal(first.onmidimessage, null);
});

test('settings persist and the user opt-in survives a failed silent restore', async () => {
  const ctrl = new FakeMidiInput('c', 'Airstep');
  await enableWith([ctrl]);
  externalMidi.setChannel(5);
  externalMidi.setPcMode('preset');
  externalMidi.removeCc(85);

  const reloaded = externalMidi.loadConfig();
  assert.equal(reloaded.enabled, true);
  assert.equal(reloaded.channel, 5);
  assert.equal(reloaded.pcMode, 'preset');
  assert.equal(reloaded.ccMap['85'], undefined);

  externalMidi.status = 'off';
  globalThis.navigator.requestMIDIAccess = async () => { throw new Error('denied'); };
  await externalMidi.enable({ silent: true });
  assert.equal(externalMidi.status, 'denied');
  assert.equal(externalMidi.loadConfig().enabled, true, 'a failed auto-restore must not erase the opt-in');
});
