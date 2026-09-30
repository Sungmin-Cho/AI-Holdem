// #255: coach signal authority — the Linux `linux-v1` coach identity (extra conditions on
// "same" only; `ambiguous` keeps the #247 protection without signal authority) and the
// Windows check-and-terminate through one process handle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createPlayerRuntime, spawnCli } from '../tools/player-runtime.js';
import { ownedProcessStartTime, validOwnedIdentity } from '../engine/state.js';
import {
  parseWin32TerminateOutput, terminateWin32ProcessStartedAt, win32OwnedFileTime,
} from '../engine/process-identity.js';
import {
  coachReadingFor, compareStartTimes, createCoachProcessStartTime, observeRecordedIdentity, parseBootId, parseNsLink,
  parseNsPid, parseProcStatStartTicks, recordedTerminatorTimeoutMs, validCoachIdentity,
} from '../tools/coach-evidence.js';

const LSTART = 'Wed Sep 30 12:45:56 2026';
const OWNED = `utc-v1:${LSTART}`;
const BOOT = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const LINUX = `linux-v1:${LSTART};boot=${BOOT};pidns=4026531836;timens=4026531834;start=1234567`;
const PID = 4242;
const SELF = 77;

function stat(pid, comm, start) {
  return `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 4194304 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 5 18446744073709551615`;
}

test('#255 /proc parsers accept exactly the kernel shapes', () => {
  assert.equal(parseProcStatStartTicks(stat(PID, 'node', 1234567)), '1234567');
  // comm may hold spaces, parentheses and a newline; fields count from the last ')'.
  assert.equal(parseProcStatStartTicks(stat(PID, 'a) (b c', 42)), '42');
  assert.equal(parseProcStatStartTicks(stat(PID, 'x\ny) S 1 2', 43)), '43');
  for (const bad of [null, '', `${PID} (node) S 1 2 3`, stat(PID, 'node', 'x12'), stat(PID, 'node', '-1'), 'no paren at all']) {
    assert.equal(parseProcStatStartTicks(bad), null, String(bad));
  }
  assert.equal(parseNsLink('pid:[4026531836]', 'pid'), '4026531836');
  assert.equal(parseNsLink('time:[4026531834]', 'time'), '4026531834');
  for (const [text, kind] of [['time:[1]', 'pid'], ['pid:[x]', 'pid'], ['pid:4026531836', 'pid'], [null, 'pid']]) {
    assert.equal(parseNsLink(text, kind), null, `${text} as ${kind}`);
  }
  assert.equal(parseNsPid(`Name:\tnode\nNSpid:\t${SELF}\nNSpgid:\t${SELF}\n`, SELF), String(SELF));
  // Two values: this procfs belongs to an ancestor pid namespace (proc(5)).
  assert.equal(parseNsPid(`NSpid:\t9123\t${SELF}\n`, SELF), null);
  assert.equal(parseNsPid(`NSpid:\t${SELF + 1}\n`, SELF), null);
  assert.equal(parseNsPid('Name:\tnode\nPid:\t77\n', SELF), null, 'a kernel without NSpid');
  assert.equal(parseBootId(`${BOOT}\n`), BOOT);
  for (const bad of [BOOT.toUpperCase(), 'not-a-uuid', '', null]) assert.equal(parseBootId(bad), null);
});

test('#255 linux-v1 is a coach identity only; lifetime locks keep the owned forms', () => {
  assert.equal(validCoachIdentity(LINUX), true);
  assert.equal(validCoachIdentity(LINUX.replace('timens=4026531834', 'timens=none')), true);
  assert.equal(validCoachIdentity(OWNED), true);
  assert.equal(validCoachIdentity('win32-v1:2026-09-28T03:00:00.1234567Z'), true);
  for (const bad of [
    LINUX.replace(';start=1234567', ''), LINUX.replace(LSTART, 'Wed Sep 31 12:45:56 2026'),
    LINUX.replace(BOOT, 'nope'), LINUX.replace('start=1234567', 'start=01'), `${LINUX};x=1`, 'linux-v1:',
  ]) {
    assert.equal(validCoachIdentity(bad), false, bad);
  }
  assert.equal(validOwnedIdentity(LINUX), false, 'the lock validator never admits linux-v1');
});

test('#255 comparing linux-v1: equal text only, never a replacement', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(compareStartTimes(LINUX, LINUX, { platform }), 'same');
    for (const other of [LINUX.replace('start=1234567', 'start=1234568'), OWNED, 'garbage', LINUX.replace('12:45:56', '12:45:57')]) {
      assert.equal(compareStartTimes(LINUX, other, { platform }), 'unknown', `${other} on ${platform}`);
      assert.equal(compareStartTimes(other, LINUX, { platform }), 'unknown', `${other} on ${platform} (reversed)`);
    }
  }
  // The #247 rules are unchanged: utc-v1 differs only on darwin, win32-v1 everywhere.
  assert.equal(compareStartTimes(OWNED, 'utc-v1:Wed Sep 30 12:45:57 2026', { platform: 'darwin' }), 'different');
  assert.equal(compareStartTimes(OWNED, 'utc-v1:Wed Sep 30 12:45:57 2026', { platform: 'linux' }), 'unknown');
});

test('#255 an older comparator reads linux-v1 as no timestamp at all (downgrade fails closed for signals)', () => {
  // The pre-#255 comparator sent any text without an owned prefix through this shape and
  // returned unknown when it did not match (tools/coach-evidence.js at 3b8bb7c).
  const LSTART_SHAPE = /^\S+\s+\S+\s+\S+\s+\d{1,2}:\d{2}:\d{2}\s+\d{4}$|^\S+\s+\S+\s+\d{1,2}:\d{2}:\d{2}\s+\S+\s+\d{4}$/u;
  const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  for (const value of [LINUX, LINUX.replace('start=1234567', 'start=2026'), LINUX.replace('timens=4026531834', 'timens=none')]) {
    assert.equal(LSTART_SHAPE.test(value.trim()) || ISO_SHAPE.test(value), false, value);
  }
});

function fakeProc({ status = `Name:\tnode\nNSpid:\t${SELF}\n`, pidns = 'pid:[4026531836]', timens = 'time:[4026531834]', boot = `${BOOT}\n`, ticks = ['1234567'] } = {}) {
  let tick = 0;
  const files = {
    '/proc/self/status': status,
    '/proc/sys/kernel/random/boot_id': boot,
  };
  const links = { '/proc/self/ns/pid': pidns, '/proc/self/ns/time': timens };
  const reads = [];
  const fail = (code) => { throw Object.assign(new Error(code), { code }); };
  return {
    reads,
    fsImpl: {
      readFileSync(file) {
        reads.push(file);
        if (file === `/proc/${PID}/stat`) {
          const value = ticks[Math.min(tick, ticks.length - 1)];
          tick += 1;
          return value instanceof Error ? fail(value.message) : stat(PID, 'claude', value);
        }
        const value = files[file];
        if (value instanceof Error) fail(value.message);
        if (value === undefined) fail('ENOENT');
        return value;
      },
      readlinkSync(file) {
        const value = links[file];
        if (value instanceof Error) fail(value.message);
        if (value === undefined || value === null) fail('ENOENT');
        return value;
      },
    },
  };
}
const reader = (proc, owned = () => OWNED, platform = 'linux') => createCoachProcessStartTime({
  platform, fsImpl: proc.fsImpl, ownedStartTimeOf: owned, selfPid: SELF,
});

test('#255 the Linux coach reader appends scope and ticks, and otherwise falls back to the owned value', () => {
  // Order: tick, the owned ps sample, tick again — then the reader's own scope.
  const ordered = fakeProc();
  assert.equal(reader(ordered, () => { ordered.reads.push('owned'); return OWNED; })(PID), LINUX);
  assert.deepEqual(ordered.reads.slice(0, 3), [`/proc/${PID}/stat`, 'owned', `/proc/${PID}/stat`]);
  assert.equal(reader(fakeProc())(PID), LINUX);
  assert.equal(reader(fakeProc({ timens: null }))(PID), LINUX.replace('timens=4026531834', 'timens=none'),
    'no time namespaces in this kernel');
  // Every missing piece keeps the plain owned value — never a new null at spawn.
  for (const [label, proc] of [
    ['NSpid of an ancestor procfs', fakeProc({ status: `NSpid:\t9123\t${SELF}\n` })],
    ['no NSpid line', fakeProc({ status: 'Name:\tnode\n' })],
    ['pid ns unreadable', fakeProc({ pidns: new Error('EACCES') })],
    ['time ns unreadable', fakeProc({ timens: new Error('EACCES') })],
    ['boot id hidden', fakeProc({ boot: new Error('EACCES') })],
    ['stat unreadable', fakeProc({ ticks: [new Error('EACCES')] })],
    ['the pid changed between the two tick reads', fakeProc({ ticks: ['1234567', '1234999'] })],
    ['only the second tick read failed', fakeProc({ ticks: ['1234567', new Error('ENOENT')] })],
  ]) {
    assert.equal(reader(proc)(PID), OWNED, label);
  }
  assert.equal(reader(fakeProc(), () => null)(PID), null, 'a failed ps is still null');
  assert.equal(reader(fakeProc(), () => 'win32-v1:2026-09-28T03:00:00.1234567Z')(PID), 'win32-v1:2026-09-28T03:00:00.1234567Z');
  for (const platform of ['darwin', 'win32']) {
    const proc = fakeProc();
    assert.equal(reader(proc, () => OWNED, platform)(PID), OWNED, platform);
    assert.deepEqual(proc.reads, [], `${platform} reads no /proc`);
  }
});

test('#255 observing a linux-v1 record: one owned sample decides alive or ambiguous', () => {
  const calls = { legacy: 0, owned: 0, coach: 0, observations: 0 };
  const observe = (coach, { alive = true, platform = 'linux' } = {}) => {
    calls.observations += alive && coach !== undefined ? 1 : 0;
    return observeRecordedIdentity({ pid: PID, startTime: LINUX }, {
      processAlive: () => alive,
      startTimeOf: () => { calls.legacy += 1; return LSTART; },
      // The coach reading already embeds (or is) its one owned sample; a second owned read
      // could disagree with it, so it is never taken.
      ownedStartTimeOf: () => { calls.owned += 1; return null; },
      ...(coach === undefined ? {} : { coachStartTimeOf: () => { calls.coach += 1; return coach; } }),
      platform,
    });
  };
  assert.equal(observe(LINUX), 'alive');
  // The #247 rule would call these alive: protected, but no signal authority.
  assert.equal(observe(LINUX.replace('start=1234567', 'start=1234568')), 'ambiguous', 'a later process in the same second');
  assert.equal(observe(LINUX.replace('pidns=4026531836', 'pidns=4026532000')), 'ambiguous', 'another pid namespace');
  assert.equal(observe(OWNED), 'ambiguous', 'the coach reader fell back to the owned sample');
  for (const platform of ['linux', 'darwin', 'win32']) {
    assert.equal(observe('utc-v1:Wed Sep 30 12:45:57 2026', { platform }), 'unknown', `another lstart on ${platform} is no replacement`);
    assert.equal(observe(LINUX.replace('12:45:56', '12:45:57'), { platform }), 'unknown', `another embedded lstart on ${platform}`);
  }
  assert.equal(observe(null), 'unknown', 'the owned sample itself failed — as the #247 rule reads a null');
  assert.equal(observe(undefined), 'unknown', 'no coach reader');
  assert.equal(observe('win32-v1:2026-09-28T03:00:00.1234567Z'), 'unknown');
  assert.equal(observe(LINUX, { alive: false }), 'dead');
  assert.equal(calls.coach, calls.observations, 'one coach reading per observation');
  assert.deepEqual([calls.legacy, calls.owned], [0, 0], 'a linux-v1 record reads nothing but the coach reader');
  assert.equal(observeRecordedIdentity({ pid: PID, startTime: 'linux-v1:garbage' }, {
    processAlive: () => true, coachStartTimeOf: () => 'linux-v1:garbage', ownedStartTimeOf: () => OWNED,
  }), 'unknown', 'a malformed record is never alive');
});

test('#255 a handle that fell back to utc-v1 keeps being read as utc-v1', () => {
  assert.equal(coachReadingFor(OWNED, LINUX), OWNED, 'the extras came back: only the owned sample counts');
  assert.equal(coachReadingFor(OWNED, LINUX.replace('12:45:56', '12:45:57')), 'utc-v1:Wed Sep 30 12:45:57 2026');
  assert.equal(coachReadingFor(OWNED, OWNED), OWNED);
  assert.equal(coachReadingFor(LINUX, OWNED), OWNED, 'a linux-v1 record is never widened');
  assert.equal(coachReadingFor(LINUX, LINUX), LINUX);
  assert.equal(coachReadingFor(OWNED, null), null);
  assert.equal(coachReadingFor('win32-v1:2026-09-28T03:00:00.1234567Z', LINUX), LINUX);
});

// d2: a live direct child whose handle fell back to utc-v1 at spawn must stay terminable once
// the reader can add the Linux extras again.
test('#255 a one-shot child recorded as utc-v1 is still terminated when later read as linux-v1', { timeout: 30_000 }, async (t) => {
  let reads = 0;
  const runtime = createPlayerRuntime('codex', {
    processStartTime: () => (reads++ === 0 ? OWNED : LINUX),
    exec: (spec) => spawnCli({ ...spec, command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }),
  });
  t.after(() => runtime.dispose());
  const handle = runtime.oneshotStart({ tier: 'upper', prompt: 'coach' });
  handle.done.catch(() => {});
  assert.equal(handle.startTime, OWNED);
  assert.deepEqual(await handle.terminate(), { confirmed: true });
  assert.ok(reads >= 2, 'the child was observed again before the signal');
});

test('#255 win32-v1 converts to the creation FILETIME exactly', () => {
  assert.equal(win32OwnedFileTime('win32-v1:1970-01-01T00:00:00.0000000Z'), 116_444_736_000_000_000n);
  assert.equal(win32OwnedFileTime('win32-v1:1601-01-01T00:00:00.0000001Z'), 1n);
  const base = win32OwnedFileTime('win32-v1:2026-09-28T03:00:00.1234567Z');
  assert.equal(base, (BigInt(Date.UTC(2026, 8, 28, 3) / 1000) + 11_644_473_600n) * 10_000_000n + 1_234_567n);
  assert.equal(win32OwnedFileTime('win32-v1:2026-09-28T03:00:00.1234568Z') - base, 1n, '100 ns apart');
  for (const bad of [
    'win32-v1:2026-09-28T03:00:00.123456Z', 'win32-v1:2026-02-30T03:00:00.1234567Z', '2026-09-28T03:00:00.1234567Z',
    'utc-v1:Mon Sep 28 12:00:00 2026', 'win32-v1:2026-09-28T03:00:00.1234567+00:00', null,
  ]) {
    assert.equal(win32OwnedFileTime(bad), null, String(bad));
  }
});

test('#255 the terminate helper reports only its own tokens', () => {
  for (const token of ['terminated', 'replaced', 'absent', 'failed']) {
    assert.equal(parseWin32TerminateOutput({ status: 0, stdout: token, stderr: '' }), token);
    assert.equal(parseWin32TerminateOutput({ status: 0, stdout: `﻿${token}\r\n`, stderr: '' }), token);
  }
  for (const result of [
    { status: 0, stdout: 'replaced', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) },
    { status: 1, stdout: 'terminated', stderr: '' }, { status: 0, stdout: 'terminated', stderr: 'warning' },
    { status: 0, stdout: 'terminated\nextra', stderr: '' }, { status: null, stdout: '', stderr: '' }, null,
  ]) {
    assert.equal(parseWin32TerminateOutput(result), 'failed', JSON.stringify(result));
  }
});

test('#255 the handle terminator needs a whole second and never gets more than is left', () => {
  for (const [remainingNs, expected] of [
    [-5n, null], [0n, null], [500_000_000n, null], [999_000_000n, null], [999_500_000n, null], [999_999_999n, null],
    [1_000_000_000n, 1_000], [1_000_700_000n, 1_000], [42_000_000_000n, 42_000], [1_500, null], [Number.NaN, null],
  ]) {
    assert.equal(recordedTerminatorTimeoutMs(remainingNs), expected, String(remainingNs));
  }
});

test('#255 the terminate helper never starts for an unusable identity, and hides its console', () => {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: 'terminated', stderr: '' };
  };
  for (const [pid, value] of [[PID, OWNED], [PID, 'win32-v1:2026-09-28T03:00:00.123Z'], [0, 'win32-v1:2026-09-28T03:00:00.1234567Z'], [process.pid, 'win32-v1:2026-09-28T03:00:00.1234567Z']]) {
    assert.equal(terminateWin32ProcessStartedAt(pid, value, { spawn: spawnFn }), 'failed', `${pid} ${value}`);
  }
  assert.equal(calls.length, 0);
  assert.equal(terminateWin32ProcessStartedAt(PID, 'win32-v1:2026-09-28T03:00:00.1234567Z', { spawn: spawnFn, timeoutMs: 1234 }), 'terminated');
  assert.equal(calls.length, 1);
  const [{ args, options }] = calls;
  assert.equal(options.windowsHide, true);
  assert.ok(options.timeout <= 1234, 'bounded by the caller deadline');
  const script = args.at(-1);
  assert.match(script, new RegExp(`Run\\(${PID}, ${win32OwnedFileTime('win32-v1:2026-09-28T03:00:00.1234567Z')}\\)`));
  assert.equal(terminateWin32ProcessStartedAt(PID, 'win32-v1:2026-09-28T03:00:00.1234567Z', {
    spawn: () => { throw new Error('spawn failed'); },
  }), 'failed');
});

async function startIdle() {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"], {
    stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, exited };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function laterWin32(value) {
  const iso = value.slice('win32-v1:'.length);
  return `win32-v1:${new Date(Date.parse(iso) + 7_000).toISOString().slice(0, 19)}${iso.slice(19)}`;
}

test('#255 the real coach reader identifies a live child the same way twice', {
  skip: !['linux', 'darwin', 'win32'].includes(process.platform) && 'no owned start time', timeout: 60_000,
}, async (t) => {
  t.diagnostic(`node ${process.version}, libuv ${process.versions.uv}`);
  const { child } = await startIdle();
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const { coachProcessStartTime } = await import('../tools/coach-evidence.js');
  const first = coachProcessStartTime(child.pid);
  // Linux gives the full form wherever this procfs is our own pid namespace (the ubuntu
  // runners); elsewhere the reader falls back to the owned value.
  let fullLinux = false;
  if (process.platform === 'linux') {
    try { fullLinux = parseNsPid(fs.readFileSync('/proc/self/status', 'utf8'), process.pid) !== null; } catch { fullLinux = false; }
  }
  assert.match(first, { linux: fullLinux ? /^linux-v1:/ : /^utc-v1:/, darwin: /^utc-v1:/, win32: /^win32-v1:/ }[process.platform]);
  assert.equal(validCoachIdentity(first), true);
  assert.equal(coachProcessStartTime(child.pid), first);
  assert.equal(observeRecordedIdentity({ pid: child.pid, startTime: first }, {
    processAlive: alive, coachStartTimeOf: coachProcessStartTime, ownedStartTimeOf: ownedProcessStartTime,
  }), 'alive');
  if (fullLinux) {
    const later = first.replace(/start=(\d+)$/, (_, n) => `start=${BigInt(n) + 1n}`);
    assert.equal(observeRecordedIdentity({ pid: child.pid, startTime: later }, {
      processAlive: alive, coachStartTimeOf: coachProcessStartTime, ownedStartTimeOf: ownedProcessStartTime,
    }), 'ambiguous', 'the same lstart with another tick has no signal authority');
  }
});

test('#255 Windows: the handle check terminates only the recorded process', {
  skip: process.platform !== 'win32' && 'Windows process handles', timeout: 120_000,
}, async (t) => {
  const { child, exited } = await startIdle();
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const recorded = ownedProcessStartTime(child.pid);
  assert.match(recorded, /^win32-v1:/);
  assert.equal(terminateWin32ProcessStartedAt(child.pid, laterWin32(recorded)), 'replaced');
  assert.equal(alive(child.pid), true, 'another creation time is never terminated');
  assert.equal(terminateWin32ProcessStartedAt(child.pid, recorded), 'terminated');
  await exited;
  assert.equal(terminateWin32ProcessStartedAt(4_194_300, recorded), 'absent', 'no such pid');
  // The System process: access is denied (or, if a handle opens, its creation time differs).
  assert.notEqual(terminateWin32ProcessStartedAt(4, recorded), 'terminated');
});
