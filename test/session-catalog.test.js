import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  ensureSessionStore, prepareSession, commitSession, resolveCurrentSession,
} from '../engine/session-catalog.js';
import { acquireOwnedLock, releaseOwnedLock } from '../engine/state.js';
import { createGameLoop } from '../tools/game-loop.js';

function tmpStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-session-catalog-'));
}

test('empty store has no current session', () => {
  const storeDir = tmpStore();
  const store = ensureSessionStore(storeDir);
  assert.equal(store.current, null);
  assert.equal(resolveCurrentSession(storeDir), null);
});

test('store-dir catalog init does not sweep .training at the store root', () => {
  const storeDir = tmpStore();
  fs.mkdirSync(path.join(storeDir, '.training'));
  fs.writeFileSync(path.join(storeDir, '.training', 'marker'), 'keep');
  ensureSessionStore(storeDir);
  const prepared = prepareSession(storeDir);
  commitSession(storeDir, prepared);
  assert.equal(fs.readFileSync(path.join(storeDir, '.training', 'marker'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(storeDir, '.session-store')), true);
});

test('prepareSession creates only a staging directory under sessions/', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const prepared = prepareSession(storeDir);
  const sessionsDir = path.join(storeDir, '.session-store', 'sessions');
  const entries = fs.readdirSync(sessionsDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\..+\.creating$/);
  assert.equal(fs.existsSync(prepared.sessionDir), false);
  assert.equal(fs.existsSync(prepared.stagingDir), true);
  assert.equal(resolveCurrentSession(storeDir), null);
});

test('commit promotes staging then atomically selects it as current', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const prepared = prepareSession(storeDir);
  fs.writeFileSync(path.join(prepared.stagingDir, 'marker.txt'), 'hello');
  const committed = commitSession(storeDir, prepared);

  assert.equal(committed.gameId, prepared.gameId);
  assert.equal(committed.selectionVersion, 1);
  assert.equal(fs.existsSync(prepared.stagingDir), false);
  assert.equal(fs.readFileSync(path.join(committed.sessionDir, 'marker.txt'), 'utf8'), 'hello');

  const resolved = resolveCurrentSession(storeDir);
  assert.deepEqual(resolved, committed);

  const store = ensureSessionStore(storeDir);
  assert.deepEqual(store.current, committed);
});

test('second commit leaves the first session inode and bytes unchanged', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);

  const first = prepareSession(storeDir);
  fs.writeFileSync(path.join(first.stagingDir, 'marker.txt'), 'first');
  const firstCommitted = commitSession(storeDir, first);
  const firstMarkerPath = path.join(firstCommitted.sessionDir, 'marker.txt');
  const firstStatBefore = fs.statSync(firstMarkerPath);
  const firstBytesBefore = fs.readFileSync(firstMarkerPath, 'utf8');

  const second = prepareSession(storeDir);
  fs.writeFileSync(path.join(second.stagingDir, 'marker.txt'), 'second');
  const secondCommitted = commitSession(storeDir, second);

  assert.notEqual(secondCommitted.gameId, firstCommitted.gameId);
  assert.equal(secondCommitted.selectionVersion, 2);

  const firstStatAfter = fs.statSync(firstMarkerPath);
  const firstBytesAfter = fs.readFileSync(firstMarkerPath, 'utf8');
  assert.equal(firstStatAfter.ino, firstStatBefore.ino);
  assert.equal(firstBytesAfter, firstBytesBefore);
  assert.equal(fs.existsSync(firstCommitted.sessionDir), true);

  const resolved = resolveCurrentSession(storeDir);
  assert.deepEqual(resolved, secondCommitted);
});

test('stale concurrent prepare cannot replace current', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const first = prepareSession(storeDir);
  const stale = prepareSession(storeDir);
  fs.writeFileSync(path.join(first.stagingDir, 'marker.txt'), 'winner');
  fs.writeFileSync(path.join(stale.stagingDir, 'marker.txt'), 'stale');
  const committed = commitSession(storeDir, first);
  assert.throws(() => commitSession(storeDir, stale), (error) => error.code === 'CURRENT_CHANGED');
  assert.deepEqual(resolveCurrentSession(storeDir), committed);
  assert.equal(fs.existsSync(stale.stagingDir), true);
});

test('malformed current selector fails closed', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  fs.writeFileSync(path.join(storeDir, '.session-store', 'current.json'), 'not-json');
  assert.throws(() => resolveCurrentSession(storeDir), (e) => e.code === 'CURRENT_SELECTOR_INVALID');
  assert.throws(() => ensureSessionStore(storeDir), (e) => e.code === 'CURRENT_SELECTOR_INVALID');
});

test('symlinked current selector fails closed', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const decoyPath = path.join(storeDir, 'decoy.json');
  fs.writeFileSync(decoyPath, JSON.stringify({ gameId: '00000000-0000-4000-8000-000000000000', sessionRel: 'sessions/00000000-0000-4000-8000-000000000000', selectionVersion: 1 }));
  fs.symlinkSync(decoyPath, path.join(storeDir, '.session-store', 'current.json'));
  assert.throws(() => resolveCurrentSession(storeDir), (error) => error.code === 'CURRENT_SELECTOR_INVALID');
});

test('interrupted staging is never selected as current', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  prepareSession(storeDir);
  assert.equal(resolveCurrentSession(storeDir), null);
  const store = ensureSessionStore(storeDir);
  assert.equal(store.current, null);
});

test('resolveCurrentSession does not scan the sessions directory', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const sessionsDir = path.join(storeDir, '.session-store', 'sessions');
  const originalReaddirSync = fs.readdirSync;
  fs.readdirSync = (target, ...rest) => {
    if (path.resolve(String(target)) === path.resolve(sessionsDir)) {
      throw new Error('resolveCurrentSession must not scan sessions/');
    }
    return originalReaddirSync(target, ...rest);
  };
  try {
    assert.equal(resolveCurrentSession(storeDir), null);
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
});

test('preinitialized concrete sessions bind without rerunning init and remain immutable across next init', async () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const engineCli = path.resolve('engine/cli.js');
  const engineCalls = [];

  const initialize = () => {
    const prepared = prepareSession(storeDir);
    const stdout = execFileSync(process.execPath, [
      engineCli, 'init', '--ai', '1', '--game-dir', prepared.stagingDir,
    ], { encoding: 'utf8' });
    const initialized = JSON.parse(stdout);
    const committed = commitSession(storeDir, prepared);
    const lock = acquireOwnedLock(storeDir, 'loop.lock.d');
    const loop = createGameLoop({
      gameDir: committed.sessionDir,
      lockDir: storeDir,
      initialLockHandle: lock,
      resolver: async () => ({ notices: [] }),
      opts: { onEngineInvoke: (args) => engineCalls.push(args) },
    });
    return { initialized, committed, loop };
  };

  const first = initialize();
  await assert.rejects(
    first.loop.bootstrap({ ai: 1, preinitialized: first.initialized, skipLock: true }),
    (error) => error.code === 'NO_PLAYER_RUNTIME',
  );
  assert.equal(engineCalls.some((args) => args[0] === 'init'), false);
  const firstState = fs.readFileSync(path.join(first.committed.sessionDir, 'state.json'));
  const firstInode = fs.statSync(first.committed.sessionDir).ino;

  const second = initialize();
  await assert.rejects(
    second.loop.bootstrap({ ai: 1, preinitialized: second.initialized, skipLock: true }),
    (error) => error.code === 'NO_PLAYER_RUNTIME',
  );
  assert.notEqual(second.committed.gameId, first.committed.gameId);
  assert.equal(fs.statSync(first.committed.sessionDir).ino, firstInode);
  assert.deepEqual(fs.readFileSync(path.join(first.committed.sessionDir, 'state.json')), firstState);
});

test('production launcher init failure preserves current and staging, then releases store lock', () => {
  const storeDir = tmpStore();
  ensureSessionStore(storeDir);
  const previous = prepareSession(storeDir);
  fs.writeFileSync(path.join(previous.stagingDir, 'marker.txt'), 'previous');
  const committed = commitSession(storeDir, previous);
  const gameLoop = path.resolve('tools/game-loop.js');
  const failed = spawnSync(process.execPath, [
    gameLoop, '--store-dir', storeDir, '--ai', '1', '--blinds', 'invalid',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(resolveCurrentSession(storeDir), committed);
  assert.equal(fs.existsSync(path.join(storeDir, 'loop.lock.d')), false);
  const creating = fs.readdirSync(path.join(storeDir, '.session-store', 'sessions'))
    .filter((name) => name.endsWith('.creating'));
  assert.equal(creating.length, 1);
  assert.doesNotThrow(() => {
    const handle = acquireOwnedLock(storeDir, 'loop.lock.d');
    releaseOwnedLock(handle);
  });
});

test('production store force fails before creating catalog state', () => {
  const storeDir = tmpStore();
  const gameLoop = path.resolve('tools/game-loop.js');
  const failed = spawnSync(process.execPath, [
    gameLoop, '--store-dir', storeDir, '--ai', '1', '--force',
  ], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(failed.status, 5);
  assert.match(failed.stderr, /FORCE_UNAVAILABLE/);
  assert.equal(fs.existsSync(path.join(storeDir, '.session-store')), false);
});
