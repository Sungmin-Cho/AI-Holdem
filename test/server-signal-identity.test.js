// #257: PID signals outside the coach path. The loop reads its relay server's start time in the
// owned form (UTC, fixed locale) and records that in lock.json, where `init --force` reads it
// back with the reader the record's form names. On Windows a recorded `win32-v1` identity is
// checked and terminated through one process handle, unless a PID-signal seam is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ownedProcessStartTime, processStartTime } from '../engine/state.js';
import { initGameDir, stopServer } from '../engine/game-archive.js';
import { createGameLoop, recordedTerminatorOptions } from '../tools/game-loop.js';
import { gameEpochOf } from '../publish-contract.js';
import {
  ROOT, REAL_LSOF, tmpGame, readJson, initGame, makeAdapter, resolverFor, startExternalServer, terminateIfAlive, waitUntilDead,
} from './helpers/game-loop-fixtures.mjs';

const OWNED = 'utc-v1:Wed Sep 30 12:45:56 2026';
const WIN = 'win32-v1:2026-09-30T12:45:56.1234567Z';
const LEGACY = 'Wed Sep 30 14:45:56 2026';

function spawnIdle(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => terminateIfAlive(child));
  return child;
}

// Another creation time the process never had, in the owned Windows spelling (7 digits kept).
function laterWin32(value) {
  const [, whole, fraction] = /^win32-v1:(.+)\.(\d{7})Z$/.exec(value);
  return `win32-v1:${new Date(Date.parse(`${whole}Z`) + 7_000).toISOString().slice(0, 19)}.${fraction}Z`;
}

test('#257 engine stopServer reads a record with the reader its form names', () => {
  for (const [expected, reader] of [[OWNED, 'owned'], [WIN, 'owned'], [LEGACY, 'legacy']]) {
    const calls = { owned: 0, legacy: 0 };
    const signals = [];
    let alive = true;
    stopServer(42, {
      expectedStartTime: expected,
      ownedProcessStartTime: () => { calls.owned += 1; return expected; },
      processStartTime: () => { calls.legacy += 1; return expected; },
      isAlive: () => alive,
      kill: (pid, signal) => { signals.push([pid, signal]); alive = false; },
      sleepSync() {},
    });
    assert.deepEqual(calls, reader === 'owned' ? { owned: 1, legacy: 0 } : { owned: 0, legacy: 1 }, expected);
    assert.deepEqual(signals, [[42, 'SIGTERM']], expected);
  }
  // An owned record never matches a legacy reading, whatever the zone.
  const signals = [];
  stopServer(42, {
    expectedStartTime: OWNED,
    ownedProcessStartTime: () => 'utc-v1:Wed Sep 30 12:46:03 2026',
    processStartTime: () => OWNED,
    isAlive: () => true,
    kill: (pid, signal) => signals.push([pid, signal]),
    sleepSync() {},
  });
  assert.deepEqual(signals, []);
});

test('#257 engine stopServer terminates a win32-v1 record through the handle unless a kill seam is injected', () => {
  for (const outcome of ['terminated', 'replaced', 'absent', 'failed']) {
    const events = [];
    let alive = true;
    stopServer(42, {
      expectedStartTime: WIN,
      isAlive: () => alive,
      beforeSignal: (pid, signal) => events.push(['before', pid, signal]),
      terminate: (pid, startTime) => {
        events.push(['terminate', pid, startTime]);
        if (outcome === 'terminated') alive = false;
        return outcome;
      },
      ownedProcessStartTime: () => { throw new Error('the handle path reads no start time'); },
      sleepSync() {},
    });
    assert.deepEqual(events, [['before', 42, 'SIGTERM'], ['terminate', 42, WIN]], outcome);
  }
  // A utc-v1 record, or an injected kill seam, keeps the pid path.
  for (const [expected, deps] of [[OWNED, { terminate: () => assert.fail('utc-v1 is never a handle') }], [WIN, {}]]) {
    const signals = [];
    let alive = true;
    stopServer(42, {
      expectedStartTime: expected,
      ...deps,
      ownedProcessStartTime: () => expected,
      isAlive: () => alive,
      kill: (pid, signal) => { signals.push(signal); alive = false; },
      sleepSync() {},
    });
    assert.deepEqual(signals, ['SIGTERM'], expected);
  }
});

test('#257 init --force stops an owned-record server through the owned reader', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: 42, port: 8877, sessionToken: first.sessionToken, startedAt: new Date().toISOString(), serverStartTime: OWNED,
  }));
  const signals = [];
  let alive = true;
  const out = initGameDir(dir, { aiCount: 2, force: true }, {
    callerPpid: 0,
    ownedProcessStartTime: (pid) => (pid === 42 ? OWNED : null),
    processStartTime: (pid) => (pid === 42 ? assert.fail('an owned record is not read with the legacy reader') : processStartTime(pid)),
    isAlive: (pid) => (pid === 42 ? alive : false),
    kill: (pid, signal) => { signals.push([pid, signal]); alive = false; },
    sleepSync() {},
  });
  assert.deepEqual(signals, [[42, 'SIGTERM']]);
  assert.ok(out.sessionToken);
  assert.notEqual(out.sessionToken, first.sessionToken, 'the forced init went through');
});

test('#257 an owned reading is the same text from another time zone', { skip: process.platform === 'win32' ? 'win32 readings are UTC already' : false }, (t) => {
  const child = spawnIdle(t);
  const stateUrl = pathToFileURL(path.join(ROOT, 'engine/state.js')).href;
  const read = (tz) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `import { ownedProcessStartTime } from ${JSON.stringify(stateUrl)}; process.stdout.write(String(ownedProcessStartTime(${child.pid})));`],
  { encoding: 'utf8', env: { ...process.env, TZ: tz }, windowsHide: true });
  const seoul = read('Asia/Seoul');
  assert.match(seoul, /^utc-v1:/);
  assert.equal(seoul, read('America/Los_Angeles'));
  assert.equal(seoul, ownedProcessStartTime(child.pid));
  // A record written from Seoul stops the right process from here, and nothing else.
  const signals = [];
  let alive = true;
  stopServer(child.pid, {
    expectedStartTime: seoul, isAlive: () => alive, kill: (pid, signal) => { signals.push([pid, signal]); alive = false; }, sleepSync() {},
  });
  assert.deepEqual(signals, [[child.pid, 'SIGTERM']]);
});

test('#257 a loop records its relay server in the owned form', { timeout: 30_000 }, async (t) => {
  const gameDir = tmpGame();
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100 });
  const lock = readJson(path.join(gameDir, 'lock.json'));
  assert.equal(lock.serverStartTime, ownedProcessStartTime(lock.serverPid));
  assert.match(lock.serverStartTime, process.platform === 'win32' ? /^win32-v1:/ : /^utc-v1:/);
  const serverPid = lock.serverPid;
  await loop.requestStop();
  await waitUntilDead(serverPid);
});

async function adoptExternalServer(t, { processTerminator, signalProcess }) {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
    ownerSessionId: 'old-owner', startedAt: '2026-09-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  // The loop sees the server as a Windows-recorded identity on every platform.
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      processStartTime: (pid) => (pid === external.child.pid ? WIN : processStartTime(pid)),
      processTerminator: processTerminator && ((pid, startTime, options) => processTerminator(pid, startTime, options, external.child)),
      signalProcess,
    },
  });
  await loop.resume();
  return { loop, external, gameDir };
}

test('#257 an adopted server is stopped through the recorded terminator, never by pid', { timeout: 30_000 }, async (t) => {
  const calls = [];
  const signals = [];
  const { loop, external } = await adoptExternalServer(t, {
    processTerminator: (pid, startTime, options, child) => { calls.push([pid, startTime, options]); child.kill('SIGKILL'); return 'terminated'; },
    signalProcess: (pid, signal) => signals.push([pid, signal]),
  });
  await loop.requestStop();
  await waitUntilDead(external.child.pid);
  assert.deepEqual(calls.map(([pid, startTime]) => [pid, startTime]), [[external.child.pid, WIN]]);
  assert.ok(calls.every(([, , options]) => options && typeof options === 'object'));
  assert.deepEqual(signals, []);
});

for (const first of ['terminated', 'absent']) {
  test(`#257 an adopted server still alive after a first ${first} is checked and terminated again`, { timeout: 30_000 }, async (t) => {
    const calls = [];
    const { loop, external, gameDir } = await adoptExternalServer(t, {
      processTerminator: (pid, startTime, options, child) => {
        calls.push(pid);
        if (calls.length === 1) return first;
        child.kill('SIGKILL');
        return 'terminated';
      },
      signalProcess: () => assert.fail('never by pid'),
    });
    await loop.requestStop();
    await waitUntilDead(external.child.pid);
    assert.deepEqual(calls, [external.child.pid, external.child.pid]);
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), false);
  });
}

test('#257 a second attempt that finds the pid replaced leaves the server, its lock and the loop lock', { timeout: 30_000 }, async (t) => {
  let calls = 0;
  let recover = false;
  const { loop, external, gameDir } = await adoptExternalServer(t, {
    processTerminator: (pid, startTime, options, child) => {
      calls += 1;
      if (recover) { child.kill('SIGKILL'); return 'terminated'; }
      return calls === 1 ? 'terminated' : 'replaced';
    },
    signalProcess: () => assert.fail('never by pid'),
  });
  await assert.rejects(loop.requestStop(), { code: 'SERVER_IDENTITY_MISMATCH' });
  assert.equal(calls, 2);
  assert.doesNotThrow(() => process.kill(external.child.pid, 0));
  assert.equal(readJson(path.join(gameDir, 'lock.json')).serverPid, external.child.pid);
  assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true);
  recover = true;
  await loop.requestStop();
  await waitUntilDead(external.child.pid);
});

test('#257 an injected signalProcess alone keeps the adopted server on the pid path', { timeout: 30_000 }, async (t) => {
  const signals = [];
  let external;
  const adopted = await adoptExternalServer(t, {
    processTerminator: undefined,
    signalProcess: (pid, signal) => { signals.push([pid, signal]); process.kill(pid, signal); },
  });
  external = adopted.external;
  await adopted.loop.requestStop();
  await waitUntilDead(external.child.pid);
  assert.deepEqual(signals, [[external.child.pid, 'SIGTERM']]);
});

for (const [outcome, code] of [['replaced', 'SERVER_IDENTITY_MISMATCH'], ['failed', 'SERVER_SIGNAL_FAILED']]) {
  test(`#257 an adopted server the terminator reports ${outcome} is left alone (${code})`, { timeout: 30_000 }, async (t) => {
    let answer = outcome;
    const signals = [];
    const { loop, external, gameDir } = await adoptExternalServer(t, {
      processTerminator: (pid, startTime, options, child) => {
        if (answer === 'terminated') child.kill('SIGKILL');
        return answer;
      },
      signalProcess: (pid, signal) => signals.push([pid, signal]),
    });
    await assert.rejects(loop.requestStop(), { code });
    assert.doesNotThrow(() => process.kill(external.child.pid, 0), 'the server was signalled');
    assert.deepEqual(signals, []);
    assert.equal(fs.existsSync(path.join(gameDir, 'loop.lock.d')), true);
    answer = 'terminated';
    await loop.requestStop();
    await waitUntilDead(external.child.pid);
  });
}

test('#257 --force stops a Windows-recorded loop owner through the recorded terminator', { timeout: 60_000 }, async (t) => {
  const gameDir = tmpGame();
  const holder = spawnIdle(t);
  fs.mkdirSync(path.join(gameDir, 'loop.lock.d'));
  fs.writeFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), `${holder.pid}\n${WIN.replace(':', '\n')}`);
  const calls = [];
  const signals = [];
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      processStartTime: (pid) => (pid === holder.pid ? WIN : processStartTime(pid)),
      ownedProcessStartTime: (pid) => (pid === holder.pid ? WIN : ownedProcessStartTime(pid)),
      processTerminator: (pid, startTime, options) => { calls.push([pid, startTime]); holder.kill('SIGKILL'); return 'terminated'; },
      signalProcess: (pid, signal) => signals.push([pid, signal]),
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, force: true });
  assert.deepEqual(calls, [[holder.pid, WIN]]);
  assert.deepEqual(signals.filter(([pid]) => pid === holder.pid), []);
});

// Records every signal `process.kill` is asked to send to `pid` (probes with 0 excepted) while
// letting it through, so a test can prove the default Windows path never signals by pid.
function watchPidSignals(t, pid) {
  const signals = [];
  const original = process.kill;
  process.kill = function kill(target, signal) {
    if (target === pid && signal !== 0) signals.push(signal ?? 'SIGTERM');
    return original.call(process, target, signal);
  };
  t.after(() => { process.kill = original; });
  return signals;
}

test('#257 Windows: engine stopServer ends the recorded process through its handle and spares another creation time', {
  skip: process.platform !== 'win32', timeout: 60_000,
}, async (t) => {
  const target = spawnIdle(t);
  const recorded = ownedProcessStartTime(target.pid);
  const signals = watchPidSignals(t, target.pid);
  // No seam: the default Windows selection. Another creation time is refused by the handle's
  // own FILETIME check (there is no pre-read on this path).
  stopServer(target.pid, { expectedStartTime: laterWin32(recorded) });
  assert.doesNotThrow(() => process.kill(target.pid, 0), 'a replaced creation time is never terminated');
  stopServer(target.pid, { expectedStartTime: recorded });
  await waitUntilDead(target.pid, 10_000);
  assert.deepEqual(signals, [], 'never by pid');
});

test('#257 Windows: an adopted server is stopped through the default handle terminator, never by pid', { skip: process.platform !== 'win32', timeout: 120_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await initGame(gameDir);
  fs.writeFileSync(path.join(gameDir, 'loop-state.json'), JSON.stringify({
    phase: 'bootstrap', sessionToken: init.sessionToken, gameEpoch: gameEpochOf(init.sessionToken),
    ownerSessionId: 'old-owner', startedAt: '2026-09-30T00:00:00.000Z', notices: [], metrics: [],
  }));
  const external = await startExternalServer(gameDir, init.sessionToken);
  t.after(() => terminateIfAlive(external.child));
  const signals = watchPidSignals(t, external.child.pid);
  const loop = createGameLoop({ gameDir, resolver: resolverFor(makeAdapter()), opts: { port: 0 } });
  await loop.resume();
  await loop.requestStop();
  await waitUntilDead(external.child.pid, 10_000);
  assert.deepEqual(signals, [], 'never by pid');
});

test('#257 engine stopServer waits between the two handle attempts and after the last one', () => {
  for (const second of ['terminated', 'replaced']) {
    let ms = 0;
    const events = [];
    let calls = 0;
    let alive = true;
    stopServer(42, {
      expectedStartTime: WIN,
      now: () => new Date(ms),
      sleepSync: (wait) => { ms += wait; },
      isAlive: () => alive,
      beforeSignal: (pid, signal) => events.push([`before:${signal}`, ms]),
      terminate: () => {
        calls += 1;
        events.push(['terminate', ms]);
        return calls === 1 ? 'terminated' : second;
      },
    });
    // The first termination never landed: 5 s of waiting, a fresh check, then 200 ms more.
    assert.deepEqual(events.map(([name]) => name), ['before:SIGTERM', 'terminate', 'before:SIGKILL', 'terminate'], second);
    assert.ok(events[2][1] - events[1][1] >= 5000, `waited ${events[2][1] - events[1][1]} ms before the second attempt`);
    assert.equal(ms - events[3][1], second === 'terminated' ? 200 : 0, `${second}: the last wait`);
  }
  // The loop re-check refuses the second attempt: nothing more is sent.
  let calls = 0;
  let ms = 0;
  assert.throws(() => stopServer(42, {
    expectedStartTime: WIN, now: () => new Date(ms), sleepSync: (wait) => { ms += wait; }, isAlive: () => true,
    beforeSignal: (pid, signal) => { if (signal === 'SIGKILL') throw Object.assign(new Error('loop'), { code: 'LOOP_ALIVE' }); },
    terminate: () => { calls += 1; return 'terminated'; },
  }), { code: 'LOOP_ALIVE' });
  assert.equal(calls, 1);
});

test('#257 engine seam precedence: an explicit terminate wins, null turns it off', () => {
  const run = (deps) => {
    const events = [];
    let alive = true;
    stopServer(42, {
      expectedStartTime: WIN, sleepSync() {}, isAlive: () => alive, ownedProcessStartTime: () => WIN,
      kill: (pid, signal) => { events.push(`kill:${signal}`); alive = false; },
      ...deps(events, () => { alive = false; }),
    });
    return events;
  };
  assert.deepEqual(run((events, die) => ({ terminate: () => { events.push('terminate'); die(); return 'terminated'; } })), ['terminate'],
    'with both seams the terminator is used, as for coaches (#255)');
  assert.deepEqual(run(() => ({ terminate: null })), ['kill:SIGTERM'], 'null turns the handle path off');
});

test('#257 engine: on Windows without a kill seam an explicit null terminate still takes the pid path', (t) => {
  const signals = [];
  let alive = true;
  const original = process.kill;
  process.kill = (pid, signal) => {
    if (pid !== 42) return original.call(process, pid, signal);
    signals.push(signal);
    alive = false;
    return true;
  };
  t.after(() => { process.kill = original; });
  stopServer(42, {
    expectedStartTime: WIN, platform: 'win32', terminate: null,
    ownedProcessStartTime: () => WIN, isAlive: () => alive, sleepSync() {},
  });
  assert.deepEqual(signals, ['SIGTERM'], 'the default handle terminator stayed off');
});

test('#257 --force never signals a loop owner alive by its tick whose lstart moved (#256 I4)', { timeout: 60_000 }, async (t) => {
  const gameDir = tmpGame();
  const holder = spawnIdle(t);
  const BOOT = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
  const scope = `boot=${BOOT};pidns=4026531836;timens=4026531834;start=1234567`;
  const record = `${holder.pid}\nutc-v1\nWed Sep 30 12:45:56 2026\nlinux-v1:${scope}`;
  fs.mkdirSync(path.join(gameDir, 'loop.lock.d'));
  fs.writeFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), record);
  const signals = [];
  const terminations = [];
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(makeAdapter()),
    opts: {
      port: 0,
      processStartTime: (pid) => (pid === holder.pid ? `linux-v1:Wed Sep 30 12:46:03 2026;${scope}` : processStartTime(pid)),
      ownedProcessStartTime: (pid) => (pid === holder.pid ? 'utc-v1:Wed Sep 30 12:46:03 2026' : ownedProcessStartTime(pid)),
      signalProcess: (pid, signal) => signals.push([pid, signal]),
      processTerminator: (...args) => { terminations.push(args); return 'terminated'; },
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await assert.rejects(loop.bootstrap({ ai: 1, force: true }), { code: 'LOOP_IDENTITY_MISMATCH' });
  assert.deepEqual(signals, []);
  assert.deepEqual(terminations, []);
  assert.doesNotThrow(() => process.kill(holder.pid, 0));
  assert.equal(fs.readFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), 'utf8'), record);
});

test('#257 a bound stop starts the handle terminator only with a whole second left', () => {
  const now = () => 5_000_000_000n;
  assert.deepEqual(recordedTerminatorOptions(null, now), {}, 'no finalization deadline: the default timeout');
  assert.deepEqual(recordedTerminatorOptions(undefined, now), {});
  assert.equal(recordedTerminatorOptions(5_999_999_999n, now), null, '999,999,999 ns left: not started');
  assert.deepEqual(recordedTerminatorOptions(6_000_000_000n, now), { timeoutMs: 1000 });
  assert.deepEqual(recordedTerminatorOptions(7_500_000_000n, now), { timeoutMs: 2500 });
  assert.equal(recordedTerminatorOptions(4_000_000_000n, now), null, 'already past');
});

test('#257 init --force passes the handle seam to the server stop', () => {
  const dir = tmpGame();
  const first = initGameDir(dir, { aiCount: 2 });
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: 42, port: 8877, sessionToken: first.sessionToken, startedAt: new Date().toISOString(), serverStartTime: WIN,
  }));
  const calls = [];
  let alive = true;
  initGameDir(dir, { aiCount: 2, force: true }, {
    callerPpid: 0,
    isAlive: (pid) => (pid === 42 ? alive : false),
    terminate: (pid, startTime) => { calls.push([pid, startTime]); alive = false; return 'terminated'; },
    kill: () => assert.fail('never by pid when a handle seam is given'),
    sleepSync() {},
  });
  assert.deepEqual(calls, [[42, WIN]]);
});

test('#257 with both readers injected the legacy one reads the server', { timeout: 30_000 }, async (t) => {
  const gameDir = tmpGame();
  const loop = createGameLoop({
    gameDir, resolver: resolverFor(makeAdapter()),
    opts: { port: 0, processStartTime: (pid) => processStartTime(pid), ownedProcessStartTime: (pid) => ownedProcessStartTime(pid) },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  await loop.bootstrap({ ai: 1, stack: 100 });
  const lock = readJson(path.join(gameDir, 'lock.json'));
  assert.equal(lock.serverStartTime, processStartTime(lock.serverPid), 'an injected processStartTime stays the server reader');
  await loop.requestStop();
});

test('#257 the server reader answers null, not an exception, inside an exhausted caller deadline', async (t) => {
  const { serverProcessStartTime } = await import('../engine/state.js');
  const { withPlatformDeadline } = await import('../shared/platform-files.js');
  // Another live process: this process's own reading is cached on Windows once read.
  const other = spawnIdle(t);
  const exhausted = (read) => withPlatformDeadline(1, () => read(other.pid), { now: () => 2 });
  // The legacy reader's contract: an exhausted budget is an unreadable start time.
  assert.equal(exhausted(processStartTime), null);
  assert.equal(exhausted(serverProcessStartTime), null);
  assert.notEqual(serverProcessStartTime(other.pid), null, 'outside the budget the same process reads fine');
});

for (const [outcome, code] of [['replaced', 'LOOP_IDENTITY_MISMATCH'], ['failed', 'LOOP_SIGNAL_FAILED']]) {
  test(`#257 --force leaves a Windows-recorded loop owner the terminator reports ${outcome} (${code})`, { timeout: 60_000 }, async (t) => {
    const gameDir = tmpGame();
    const holder = spawnIdle(t);
    const record = `${holder.pid}\n${WIN.replace(':', '\n')}`;
    fs.mkdirSync(path.join(gameDir, 'loop.lock.d'));
    fs.writeFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), record);
    const loop = createGameLoop({
      gameDir, resolver: resolverFor(makeAdapter()),
      opts: {
        port: 0,
        processStartTime: (pid) => (pid === holder.pid ? WIN : processStartTime(pid)),
        ownedProcessStartTime: (pid) => (pid === holder.pid ? WIN : ownedProcessStartTime(pid)),
        processTerminator: () => outcome,
        signalProcess: () => assert.fail('never by pid'),
      },
    });
    t.after(() => loop.requestStop().catch(() => {}));
    await assert.rejects(loop.bootstrap({ ai: 1, force: true }), { code });
    assert.doesNotThrow(() => process.kill(holder.pid, 0));
    assert.equal(fs.readFileSync(path.join(gameDir, 'loop.lock.d', 'pid'), 'utf8'), record);
  });
}

for (const outcome of ['terminated', 'replaced']) {
  test(`#257 --force stops a Windows-recorded server through the handle (${outcome})`, {
    skip: !REAL_LSOF && process.platform !== 'win32' ? 'lsof is required for authoritative listener binding' : false, timeout: 60_000,
  }, async (t) => {
    const gameDir = tmpGame();
    const init = await initGame(gameDir);
    const external = await startExternalServer(gameDir, init.sessionToken);
    t.after(() => terminateIfAlive(external.child));
    const before = fs.readFileSync(path.join(gameDir, 'state.json'));
    const calls = [];
    const loop = createGameLoop({
      gameDir, resolver: resolverFor(makeAdapter()),
      opts: {
        port: 0,
        processStartTime: (pid) => (pid === external.child.pid ? WIN : processStartTime(pid)),
        processTerminator: (pid, startTime) => {
          calls.push([pid, startTime]);
          if (outcome === 'terminated') external.child.kill('SIGKILL');
          return outcome;
        },
        signalProcess: (pid, signal) => { if (pid === external.child.pid) assert.fail('never by pid'); process.kill(pid, signal); },
      },
    });
    t.after(() => loop.requestStop().catch(() => {}));
    if (outcome === 'terminated') {
      await loop.bootstrap({ ai: 1, force: true });
      await waitUntilDead(external.child.pid);
      assert.deepEqual(calls, [[external.child.pid, WIN]]);
    } else {
      await assert.rejects(loop.bootstrap({ ai: 1, force: true }), { code: 'SERVER_IDENTITY_MISMATCH' });
      assert.deepEqual(calls, [[external.child.pid, WIN]]);
      assert.doesNotThrow(() => process.kill(external.child.pid, 0));
      assert.equal(readJson(path.join(gameDir, 'lock.json')).serverPid, external.child.pid);
      assert.deepEqual(fs.readFileSync(path.join(gameDir, 'state.json')), before, 'the game was not archived');
    }
  });
}
