import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDrillServer } from '../server/drill-server.js';
import { startServer } from '../server/server.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-dsrv-'));
}

test('drill server uses its own token and game server does not serve drill.html', async () => {
  const storeDir = tmp();
  const gameDir = tmp();
  const drill = await startDrillServer({ storeDir, port: 0, token: 'drill-tok' });
  const game = await startServer({ gameDir, port: 0, token: 'game-tok' });
  try {
    const denied = await fetch(`http://127.0.0.1:${drill.port}/api/next`);
    assert.equal(denied.status, 401);
    const started = await fetch(`http://127.0.0.1:${drill.port}/api/start?token=drill-tok`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'free', seed: '1' }),
    });
    assert.equal((await started.json()).ok, true);
    const page = await fetch(`http://127.0.0.1:${drill.port}/drill.html`);
    assert.equal(page.status, 200);
    const missing = await fetch(`http://127.0.0.1:${game.port}/drill.html`);
    assert.equal(missing.status, 404);
  } finally {
    await drill.close();
    await game.close();
  }
});
