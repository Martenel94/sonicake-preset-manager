import { FakeBleDevice, flush } from './helpers.mjs';
import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { SonicakeConnection } from '../src/core/connection.js';

let conn;
let device;
let statuses;

async function connectedConnection() {
  device = new FakeBleDevice();
  globalThis.navigator.bluetooth = { requestDevice: async () => device };
  conn = new SonicakeConnection();
  statuses = [];
  conn.onStatusChange(s => statuses.push(s));
  await conn.connectBle();
  statuses.length = 0;
}

beforeEach(() => {
  localStorage.clear();
  mock.timers.enable({ apis: ['setTimeout'] });
});
afterEach(() => mock.timers.reset());

test('first connection opens a session and remembers the paired device', async () => {
  await connectedConnection();
  assert.equal(conn.isConnected, true);
  assert.equal(conn.sessionId, 1);
  assert.equal(localStorage.getItem('sonicake_ble_device_id'), 'dev-1');
});

test('an unexpected drop keeps the device and reconnects without the picker', async () => {
  await connectedConnection();
  const picker = mock.fn(globalThis.navigator.bluetooth.requestDevice);
  globalThis.navigator.bluetooth.requestDevice = picker;

  device.drop();
  assert.equal(conn.isConnected, false);
  assert.equal(conn.reconnecting, true);
  assert.ok(conn.bleDevice, 'paired device must be kept for the retry');
  assert.equal(statuses.at(-1).reconnecting, true);

  mock.timers.tick(1000);
  await flush();

  assert.equal(conn.isConnected, true);
  assert.equal(conn.reconnecting, false);
  assert.equal(conn.sessionId, 2, 'every reconnection starts a new link session');
  assert.equal(statuses.at(-1).isConnected, true);
  assert.equal(picker.mock.callCount(), 0, 'picker must never reopen');
});

test('retries back off 1s, 2s, 4s while the pedal is unreachable', async () => {
  await connectedConnection();
  device.failConnects = 2;
  device.drop();

  mock.timers.tick(999);
  await flush();
  assert.equal(device.connectCalls, 1, 'no attempt before the first delay');

  mock.timers.tick(1);
  await flush();
  assert.equal(device.connectCalls, 2);
  assert.equal(conn.isConnected, false);

  mock.timers.tick(2000);
  await flush();
  assert.equal(device.connectCalls, 3);
  assert.equal(conn.isConnected, false);

  mock.timers.tick(4000);
  await flush();
  assert.equal(device.connectCalls, 4);
  assert.equal(conn.isConnected, true);
});

test('gives up after the last attempt and falls back to a clean disconnected state', async () => {
  await connectedConnection();
  device.failConnects = 99;
  device.drop();

  for (const delay of conn.RECONNECT_DELAYS_MS) {
    mock.timers.tick(delay);
    await flush();
  }

  assert.equal(conn.isConnected, false);
  assert.equal(conn.reconnecting, false);
  assert.equal(conn.bleDevice, null);
  assert.equal(conn.connectionType, null);
  assert.equal(device.connectCalls, 1 + conn.RECONNECT_DELAYS_MS.length);
});

test('manual disconnect does not trigger reconnect and forgets the device', async () => {
  await connectedConnection();
  conn.disconnect();

  assert.equal(conn.reconnecting, false);
  assert.equal(conn.bleDevice, null);
  assert.equal(localStorage.getItem('sonicake_ble_device_id'), null);

  mock.timers.tick(60000);
  await flush();
  assert.equal(device.connectCalls, 1, 'no reconnect after a deliberate disconnect');
});

test('disconnect during the retry wait cancels it', async () => {
  await connectedConnection();
  device.drop();
  assert.equal(conn.reconnecting, true);

  conn.disconnect();
  mock.timers.tick(60000);
  await flush();

  assert.equal(device.connectCalls, 1);
  assert.equal(conn.isConnected, false);
});

test('page unload keeps the paired id so the next load can re-attach', async () => {
  await connectedConnection();
  conn.disconnect({ forget: false });
  assert.equal(localStorage.getItem('sonicake_ble_device_id'), 'dev-1');
});

test('returning to the tab skips the backoff wait', async () => {
  await connectedConnection();
  device.drop();
  assert.equal(device.connectCalls, 1);

  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  await flush();

  assert.equal(conn.isConnected, true);
  assert.equal(device.connectCalls, 2);
});

test('notifications are delivered once after reconnects (no stacked listeners)', async () => {
  await connectedConnection();
  const received = [];
  conn.onMessage(hex => received.push(hex));

  for (let i = 0; i < 2; i++) {
    device.drop();
    mock.timers.tick(1000);
    await flush();
  }
  assert.equal(conn.isConnected, true);

  device.characteristic.notify(new Uint8Array([0x80, 0x80, 0xF0, 0x01, 0x02, 0xF7]));
  assert.deepEqual(received, ['8080F00102F7']);
});

test('a fragment received before the drop is not glued to data after the reconnect', async () => {
  await connectedConnection();
  const received = [];
  conn.onMessage(hex => received.push(hex));

  device.characteristic.notify(new Uint8Array([0x80, 0x80, 0xF0, 0x11, 0x22])); // incomplete
  device.drop();
  mock.timers.tick(1000);
  await flush();

  device.characteristic.notify(new Uint8Array([0x80, 0x80, 0xF0, 0x33, 0xF7]));
  assert.deepEqual(received, ['8080F033F7']);
});

test('restoreBleSession silently re-attaches to the remembered device', async () => {
  device = new FakeBleDevice({ id: 'saved-1' });
  localStorage.setItem('sonicake_ble_device_id', 'saved-1');
  globalThis.navigator.bluetooth = { getDevices: async () => [device], requestDevice: async () => { throw new Error('picker!'); } };
  conn = new SonicakeConnection();

  assert.equal(await conn.restoreBleSession(), true);
  assert.equal(conn.isConnected, true);
});

test('restoreBleSession stays silent when the pedal is off or nothing is remembered', async () => {
  device = new FakeBleDevice({ id: 'saved-1' });
  device.failConnects = 1;
  globalThis.navigator.bluetooth = { getDevices: async () => [device] };

  conn = new SonicakeConnection();
  assert.equal(await conn.restoreBleSession(), false, 'nothing remembered');

  localStorage.setItem('sonicake_ble_device_id', 'saved-1');
  assert.equal(await conn.restoreBleSession(), false, 'pedal unreachable');
  assert.equal(conn.isConnected, false);
  assert.equal(conn.bleDevice, null);
});
