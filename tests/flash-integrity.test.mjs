import './helpers.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connection } from '../src/core/connection.js';
import { presetEngine } from '../src/core/preset-engine.js';

const packets = Array.from({ length: 5 }, (_, i) => new Uint8Array([0xF0, i, 0xF7]));
const original = {};

beforeEach(() => {
  original.writeRawBytes = connection.writeRawBytes;
  connection.isConnected = true;
  connection.sessionId = 7;
});

afterEach(() => {
  connection.writeRawBytes = original.writeRawBytes;
  connection.isConnected = false;
});

test('delivers every packet in order and reports progress', async () => {
  const sent = [];
  connection.writeRawBytes = async (b) => { sent.push(b[1]); return true; };
  const progress = [];

  await presetEngine.streamFlashPackets(packets, 'Clone AMP 1', (cur, tot, pct) => progress.push([cur, tot, pct]));

  assert.deepEqual(sent, [0, 1, 2, 3, 4]);
  assert.deepEqual(progress.at(-1), [5, 5, 100]);
});

test('respects the 8ms inter-packet interval and the 1.2s flash settle time', async () => {
  const stamps = [];
  connection.writeRawBytes = async () => { stamps.push(Date.now()); return true; };

  const start = Date.now();
  await presetEngine.streamFlashPackets(packets, 'Clone AMP 1');
  const total = Date.now() - start;

  for (let i = 1; i < stamps.length; i++) {
    assert.ok(stamps[i] - stamps[i - 1] >= 7, `gap ${i} was ${stamps[i] - stamps[i - 1]}ms`);
  }
  assert.ok(total >= 1200 + 8 * packets.length - 20, `total ${total}ms is too short`);
});

test('retries a transient write failure on the same packet, without skipping or duplicating', async () => {
  const sent = [];
  let failedOnce = false;
  connection.writeRawBytes = async (b) => {
    if (b[1] === 2 && !failedOnce) { failedOnce = true; return false; }
    sent.push(b[1]);
    return true;
  };

  await presetEngine.streamFlashPackets(packets, 'Clone AMP 1');
  assert.deepEqual(sent, [0, 1, 2, 3, 4]);
});

test('aborts instead of reporting success when a packet keeps failing', async () => {
  const sent = [];
  connection.writeRawBytes = async (b) => {
    if (b[1] === 3) return false;
    sent.push(b[1]);
    return true;
  };

  await assert.rejects(
    presetEngine.streamFlashPackets(packets, 'Clone AMP 2'),
    /pacchetto 4\/5.*Clone AMP 2/s
  );
  assert.deepEqual(sent, [0, 1, 2], 'nothing is sent after the failing packet');
});

test('aborts when the link drops mid-stream and never resumes into a new session', async () => {
  const sent = [];
  connection.writeRawBytes = async (b) => {
    sent.push(b[1]);
    if (b[1] === 1) {
      // link drops, then auto-reconnect completes with a new session before the next packet
      connection.isConnected = false;
      connection.sessionId = 8;
      connection.isConnected = true;
    }
    return true;
  };

  await assert.rejects(presetEngine.streamFlashPackets(packets, 'User IR 3'), /Connessione.*persa.*User IR 3/s);
  assert.deepEqual(sent, [0, 1], 'packets 2-4 must not be sent into the new session');
});

test('flashCloneToPedal does not mark the slot as written when the stream fails', async () => {
  connection.writeRawBytes = async () => false;
  connection.writeCommand = async () => true;
  let markedWritten = false;
  const origReplace = presetEngine.replaceCloneProfile;
  presetEngine.replaceCloneProfile = () => { markedWritten = true; };

  try {
    // 2696-byte Low Model: the VTSI header is not validated by the packet builder
    const lowModel = new Uint8Array(2696);
    await assert.rejects(presetEngine.flashCloneToPedal(0, lowModel, 'TEST'));
    assert.equal(markedWritten, false, 'local metadata must not claim a successful flash');
  } finally {
    presetEngine.replaceCloneProfile = origReplace;
  }
});
