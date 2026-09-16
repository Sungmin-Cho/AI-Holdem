import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAppServer } from '../tools/app-server.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';

test('public listener 404s host APIs and serves join', async () => {
  const storeDir = createOwnedTempDir('holdem-public');
  const manager = {
    snapshot: () => ({ state: 'lobby', instanceId: 'i', appRevision: 0, gameId: null, selectionVersion: 0, allowedCommands: ['start'] }),
    command: () => ({ requestId: 'x', status: 'rejected' }),
    receipt: () => ({ requestId: 'x', status: 'rejected' }),
    current: null,
    session: null,
  };
  const app = await startAppServer({
    manager,
    token: 'a'.repeat(64),
    storeDir,
    port: 0,
    publicPort: 0,
  });
  registerOwnedServer(app.server, 'app-loopback');
  try {
    const publicOrigin = `http://127.0.0.1:${app.publicPort}`;
    for (const path of ['/api/app', '/api/commands', '/api/stop', '/api/room']) {
      const res = await fetch(`${publicOrigin}${path}`);
      assert.equal(res.status, 404, path);
    }
    const join = await fetch(`${publicOrigin}/join`);
    assert.equal(join.status, 200);
    const opened = await fetch(`${app.origin}/api/room`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'a'.repeat(64)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'open', hostName: '호스트', totalSeats: 4, actionTimeoutSec: 60 }),
    });
    const openedBody = await opened.json();
    assert.equal(opened.status, 200, JSON.stringify(openedBody));
    const room = openedBody;
    const joined = await fetch(`${publicOrigin}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: room.joinCode, name: '민준' }),
    });
    const joinedBody = await joined.json();
    assert.equal(joined.status, 200, JSON.stringify(joinedBody));
  } finally {
    await app.close();
  }
});
