// #256: lifetime locks on Linux. A clock step moves `ps -o lstart` for a live process, so a
// recorded `utc-v1` mismatch is no proof of death there. A Linux writer appends the #255
// evidence (boot, its own pid and time namespaces, its start tick) as a fourth pid-file line;
// only a different tick read in the same pid and time namespaces is then death. The text
// identity (`utc-v1:<lstart>`) is unchanged, and a record without the line is dead on a
// mismatch only where a start time cannot move (Windows, a macOS reader).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireOwnedLock, createLinuxProcessStartTime, lifetimeIdentityStatus, lifetimeProcessStartTime, ownedIdentityStatus,
  ownedProcessStartTime, parseLinuxReading, parseOwnedLockIdentity, readOwnedLock, releaseOwnedLock,
} from '../engine/state.js';
import { initGameDir } from '../engine/game-archive.js';

const LSTART = 'Wed Sep 30 12:45:56 2026';
const LATER = 'Wed Sep 30 12:46:03 2026';
const BOOT = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const OTHER_BOOT = '1f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
const RECORDED = `utc-v1:${LSTART}`;
const EVIDENCE = `linux-v1:boot=${BOOT};pidns=4026531836;timens=4026531834;start=1234567`;
const reading = ({ lstart = LSTART, boot = BOOT, pidns = '4026531836', timens = '4026531834', start = '1234567' } = {}) => (
  `linux-v1:${lstart};boot=${boot};pidns=${pidns};timens=${timens};start=${start}`
);

function tmpDir(prefix = 'holdem-lifetime-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function spawnIdle(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  return child;
}

function exited(child) {
  return child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
}

function writeRecord(root, name, text) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'pid'), text, { mode: 0o600 });
  return path.join(dir, 'pid');
}

// A valid `ps -o lstart` text `seconds` later, in the owned (UTC, C locale) spelling.
function shiftLstart(lstart, seconds) {
  const d = new Date(Date.parse(`${lstart} UTC`) + seconds * 1000);
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const two = (n) => String(n).padStart(2, '0');
  return `${day} ${month} ${String(d.getUTCDate()).padStart(2, ' ')} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

test('#256 the rule: only a different tick in the same pid and time namespaces is death', () => {
  const cases = [
    ['identical reading', reading(), 'alive'],
    ['clock step: same namespaces, tick and boot; the lstart moved', reading({ lstart: LATER }), 'alive'],
    ['pid reuse: another tick', reading({ start: '1234568' }), 'dead'],
    ['pid reuse within the recorded second', reading({ start: '1234599' }), 'dead'],
    ['pid reuse after a clock step', reading({ lstart: LATER, start: '7' }), 'dead'],
    ['reboot: another boot, the init namespaces, another tick', reading({ boot: OTHER_BOOT, start: '99' }), 'dead'],
    ['the recorded tick under another boot, recorded lstart', reading({ boot: OTHER_BOOT }), 'alive'],
    ['the recorded tick under another boot, lstart moved', reading({ boot: OTHER_BOOT, lstart: LATER }), 'unknown'],
    ['another pid namespace, even with the recorded lstart and tick', reading({ pidns: '4026532000' }), 'unknown'],
    ['another pid namespace, another tick', reading({ pidns: '4026532000', start: '5' }), 'unknown'],
    ['another time namespace, another tick, recorded lstart', reading({ timens: '4026532001', start: '5' }), 'alive'],
    ['another time namespace, another tick, lstart moved', reading({ timens: 'none', lstart: LATER, start: '5' }), 'unknown'],
    ['the reader fell back to utc-v1, recorded lstart', RECORDED, 'alive'],
    ['the reader fell back to utc-v1, lstart moved', `utc-v1:${LATER}`, 'unknown'],
    ['a win32 reading', 'win32-v1:2026-09-30T12:45:56.1234567Z', 'unknown'],
    ['unreadable', null, 'unknown'],
    ['garbage', 'linux-v1:garbage', 'unknown'],
  ];
  for (const [label, current, expected] of cases) {
    assert.equal(lifetimeIdentityStatus(RECORDED, EVIDENCE, current), expected, label);
  }
  // The reader's own pid: only the reader can own it, and the reader cannot read another boot
  // than the one it recorded — so the recorded tick under another boot is another process.
  assert.equal(lifetimeIdentityStatus(RECORDED, EVIDENCE, reading({ boot: OTHER_BOOT, lstart: LATER }), { self: true }), 'dead');
  assert.equal(lifetimeIdentityStatus(RECORDED, EVIDENCE, reading({ boot: OTHER_BOOT }), { self: true }), 'dead');
  assert.equal(lifetimeIdentityStatus(RECORDED, EVIDENCE, reading({ lstart: LATER }), { self: true }), 'alive');
  assert.equal(lifetimeIdentityStatus(RECORDED, EVIDENCE, reading({ pidns: '4026532000', boot: OTHER_BOOT }), { self: true }), 'unknown');
  // Only a utc-v1 identity with one exact evidence line is ever judged by this rule.
  for (const [startTime, evidence] of [
    ['win32-v1:2026-09-30T12:45:56.1234567Z', EVIDENCE], [RECORDED, reading()], [RECORDED, `${EVIDENCE};x=1`],
    [RECORDED, EVIDENCE.replace('start=1234567', 'start=01')], [RECORDED, EVIDENCE.replace(BOOT, BOOT.toUpperCase())],
    [RECORDED, ''], ['utc-v1:Wed Sep 31 12:45:56 2026', EVIDENCE],
  ]) {
    assert.equal(lifetimeIdentityStatus(startTime, evidence, reading()), 'unknown', `${startTime} / ${evidence}`);
  }
});

test('#256 wire: a utc-v1 record may carry exactly one Linux evidence line', () => {
  assert.deepEqual(parseOwnedLockIdentity(`42\nutc-v1\n${LSTART}\n${EVIDENCE}`), { pid: 42, startTime: RECORDED, evidence: EVIDENCE });
  assert.deepEqual(parseOwnedLockIdentity(`42\nutc-v1\n${LSTART}`), { pid: 42, startTime: RECORDED });
  assert.deepEqual(parseOwnedLockIdentity(`42\nutc-v1\n${LSTART}\n${EVIDENCE.replace('timens=4026531834', 'timens=none')}`).evidence,
    EVIDENCE.replace('timens=4026531834', 'timens=none'));
  const widest = `linux-v1:boot=${BOOT};pidns=${'9'.repeat(20)};timens=${'9'.repeat(20)};start=${'9'.repeat(20)}`;
  const longest = `${'9'.repeat(15)}\nutc-v1\n${LSTART}\n${widest}`;
  assert.deepEqual(parseOwnedLockIdentity(longest), { pid: 999999999999999, startTime: RECORDED, evidence: widest });
  assert.ok(Buffer.byteLength(longest) < 256, 'the widest record fits the study reader bound');
  for (const bad of [
    `42\nutc-v1\n${LSTART}\n${EVIDENCE}\n`, `42\nutc-v1\n${LSTART}\n`, `42\nutc-v1\n${LSTART}\n${EVIDENCE}\n${EVIDENCE}`,
    `42\nwin32-v1\n2026-09-30T12:45:56.1234567Z\n${EVIDENCE}`, `42\nutc-v1\n${LSTART}\n${reading()}`,
    `42\nutc-v1\n${LSTART}\n${EVIDENCE.replace('linux-v1:', 'linux-v2:')}`, `42\nutc-v1\n${LSTART}\r\n${EVIDENCE}`,
    `42\nutc-v1\n${LSTART}\n${EVIDENCE}\r`, `042\nutc-v1\n${LSTART}\n${EVIDENCE}`,
    `42\nutc-v1\n${LSTART}\n${widest.replace(`start=${'9'.repeat(20)}`, `start=${'9'.repeat(21)}`)}`,
  ]) {
    assert.equal(parseOwnedLockIdentity(bad), null, JSON.stringify(bad));
  }
});

test('#256 a pre-#256 reader sees the four-line record as no identity (downgrade fails closed)', () => {
  // `parseOwnedLockIdentity` and the two-line legacy branch of `readPidFile` at 5905389: a
  // record that neither accepts has no pid, so owned readers call it unknown and never
  // reclaim or signal it.
  const OWNED = /^(?:utc-v1:[A-Z][a-z]{2} [A-Z][a-z]{2} [ 123]\d \d{2}:\d{2}:\d{2} \d{4}|win32-v1:.+)$/;
  const parse = (text) => {
    const lines = text.split('\n');
    if (lines.length !== 3 || !/^[1-9]\d*$/.test(lines[0]) || !OWNED.test(`${lines[1]}:${lines[2]}`)) return null;
    return { pid: Number(lines[0]), startTime: `${lines[1]}:${lines[2]}` };
  };
  const legacyTwoLine = (lines) => lines.length === 2 && !/^(?:utc|win32)-/.test(lines[1].trim());
  const text = `42\nutc-v1\n${LSTART}\n${EVIDENCE}`;
  assert.equal(parse(text), null);
  assert.equal(legacyTwoLine(text.split('\n')), false);
  assert.deepEqual(parse(`42\nutc-v1\n${LSTART}`), { pid: 42, startTime: RECORDED }, 'the copy still reads three lines');
});

test('#256 ownedIdentityStatus: one reading for an evidence record; kill(0) is death only in the recorded pid namespace', async (t) => {
  const child = spawnIdle(t);
  let reads = 0;
  const probe = (value, self = reading({ lstart: LATER, start: '42' })) => (pid) => {
    if (pid === child.pid) reads += 1;
    if (pid === child.pid) return value;
    return pid === process.pid ? self : ownedProcessStartTime(pid);
  };
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading({ lstart: LATER })), EVIDENCE), 'alive');
  assert.equal(reads, 1, 'one reading decides');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading({ start: '1' })), EVIDENCE), 'dead');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading({ pidns: '1' })), EVIDENCE), 'unknown');
  // An evidence line that does not parse is unknown before anything is read.
  reads = 0;
  for (const evidence of ['linux-v1:x', reading(), '']) {
    assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading()), evidence), 'unknown', evidence);
  }
  assert.equal(ownedIdentityStatus(child.pid, 'win32-v1:2026-09-30T12:45:56.1234567Z', probe(reading()), EVIDENCE), 'unknown');
  assert.equal(reads, 0);
  child.kill('SIGKILL');
  await exited(child);
  // ESRCH: the reader's own reading (its pid namespace) must be the recorded one.
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading()), EVIDENCE), 'dead');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading(), reading({ pidns: '4026532000' })), EVIDENCE), 'unknown',
    'another pid namespace cannot see the owner');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading(), `utc-v1:${LATER}`), EVIDENCE), 'unknown',
    'no scope for the reader: no proof');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading(), null), EVIDENCE), 'unknown');
  assert.equal(reads, 0, 'a dead pid is never read');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(reading())), 'dead', 'a record without evidence keeps ESRCH = dead');
});

test('#256 a record without evidence: a mismatched utc-v1 is death only for a macOS reader', async (t) => {
  const child = spawnIdle(t);
  const probe = (value) => (pid) => (pid === child.pid ? value : ownedProcessStartTime(pid));
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(`utc-v1:${LATER}`)), process.platform === 'darwin' ? 'dead' : 'unknown');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(RECORDED)), 'alive');
  const WIN = 'win32-v1:2026-09-30T12:45:56.1234567Z';
  assert.equal(ownedIdentityStatus(child.pid, WIN, probe('win32-v1:2026-09-30T12:46:03.1234567Z')), 'dead', 'a creation FILETIME never moves');
  assert.equal(ownedIdentityStatus(child.pid, RECORDED, probe(WIN)), 'unknown', 'two kinds prove nothing');
  // A Linux reader keeps a three-line owner whose lstart moved.
  const dir = tmpDir();
  const record = `${child.pid}\nutc-v1\n${LSTART}`;
  const pidFile = writeRecord(dir, 'loop.lock.d', record);
  const stepped = probe(`utc-v1:${LATER}`);
  if (process.platform === 'darwin') {
    assert.equal(readOwnedLock(dir, 'loop.lock.d', { processStartTime: stepped }).status, 'dead');
  } else {
    assert.equal(readOwnedLock(dir, 'loop.lock.d', { processStartTime: stepped }).status, 'unknown');
    assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: stepped }), { code: 'LOCKED' });
    assert.equal(fs.readFileSync(pidFile, 'utf8'), record);
  }
});

test('#256 a clock-stepped live owner keeps its lock; a reused pid is reclaimed', async (t) => {
  const child = spawnIdle(t);
  const probe = (childReading) => (pid) => (pid === child.pid ? childReading : ownedProcessStartTime(pid));
  const dir = tmpDir();
  const record = `${child.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`;
  const pidFile = writeRecord(dir, 'loop.lock.d', record);

  const stepped = probe(reading({ lstart: LATER }));
  const seen = readOwnedLock(dir, 'loop.lock.d', { processStartTime: stepped });
  assert.deepEqual(seen, { pid: child.pid, startTime: RECORDED, alive: true, status: 'alive' });
  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: stepped }), { code: 'LOCKED' });
  assert.equal(fs.readFileSync(pidFile, 'utf8'), record, 'the live owner record is untouched');

  const reused = probe(reading({ start: '1' }));
  assert.equal(readOwnedLock(dir, 'loop.lock.d', { processStartTime: reused }).status, 'dead');
  const handle = acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: reused });
  assert.equal(handle.pid, process.pid);
  assert.equal(handle.startTime, ownedProcessStartTime(process.pid));
  assert.equal(fs.readFileSync(pidFile, 'utf8'), `${process.pid}\n${handle.startTime.replace(':', '\n')}`,
    'an owned self reading is written as the three-line record it always was');
  releaseOwnedLock(handle);
  assert.equal(fs.existsSync(path.join(dir, 'loop.lock.d')), false);
});

test('#256 a stale lock naming the reader\'s own pid under another boot is reclaimed', () => {
  const dir = tmpDir();
  // A service started at boot got the same pid and the same tick again after a reboot.
  const pidFile = writeRecord(dir, 'app.lock.d', `${process.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`);
  const self = reading({ boot: OTHER_BOOT, lstart: LATER });
  const handle = acquireOwnedLock(dir, 'app.lock.d', { processStartTime: (pid) => (pid === process.pid ? self : null) });
  assert.equal(handle.startTime, `utc-v1:${LATER}`);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), `${process.pid}\nutc-v1\n${LATER}\n${EVIDENCE.replace(BOOT, OTHER_BOOT)}`);
  releaseOwnedLock(handle);
});

test('#256 reclaim needs both judgments dead: a reading that turns alive before the second keeps the lock', async (t) => {
  const child = spawnIdle(t);
  const dir = tmpDir();
  const record = `${child.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`;
  const pidFile = writeRecord(dir, 'study.lock.d', record);
  let reads = 0;
  // Read 1: acquireOwnedLock's own readOwnedLock; 2: reclaim's decided; 3: reclaim's confirmed.
  const probe = (pid) => {
    if (pid !== child.pid) return ownedProcessStartTime(pid);
    reads += 1;
    return reads < 3 ? reading({ start: '1' }) : reading({ lstart: LATER });
  };
  assert.throws(() => acquireOwnedLock(dir, 'study.lock.d', { processStartTime: probe }), { code: 'LOCKED' });
  assert.equal(reads, 3);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), record);
});

test('#256 an evidence line that changed after the judgment is not reclaimed', async (t) => {
  const child = spawnIdle(t);
  const other = EVIDENCE.replace('start=1234567', 'start=7654321');
  const dead = (pid) => (pid === child.pid ? reading({ start: '1' }) : ownedProcessStartTime(pid));
  // Between the decided and the confirmed judgment (rewritten in place: same inode, pid and
  // identity text; only the evidence differs).
  {
    const dir = tmpDir();
    const pidFile = writeRecord(dir, 'loop.lock.d', `${child.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`);
    let reads = 0;
    const probe = (pid) => {
      if (pid === child.pid && ++reads === 2) fs.writeFileSync(pidFile, `${child.pid}\nutc-v1\n${LSTART}\n${other}`);
      return dead(pid);
    };
    assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: probe }), { code: 'LOCKED' });
    assert.equal(fs.readFileSync(pidFile, 'utf8'), `${child.pid}\nutc-v1\n${LSTART}\n${other}`);
  }
  // After the reclaimer pinned the file (the #148 aside re-read).
  {
    const dir = tmpDir();
    const pidFile = writeRecord(dir, 'loop.lock.d', `${child.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`);
    const hooks = { afterLink() { fs.writeFileSync(pidFile, `${child.pid}\nutc-v1\n${LSTART}\n${other}`); } };
    assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d', { processStartTime: dead, hooks }), { code: 'LOCKED' });
    assert.equal(fs.readFileSync(pidFile, 'utf8'), `${child.pid}\nutc-v1\n${LSTART}\n${other}`);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'loop.lock.d')), ['pid'], 'the aside was removed');
  }
});

test('#256 the writer splits a Linux reading into the utc-v1 identity and the evidence line', () => {
  const dir = tmpDir();
  const self = reading();
  const probe = (pid) => (pid === process.pid ? self : null);
  const handle = acquireOwnedLock(dir, 'app.lock.d', { processStartTime: probe });
  assert.deepEqual(Object.keys(handle).sort(), ['dev', 'dir', 'ino', 'pid', 'startTime']);
  assert.equal(handle.startTime, RECORDED);
  assert.equal(fs.readFileSync(path.join(dir, 'app.lock.d', 'pid'), 'utf8'), `${process.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`);
  assert.equal(readOwnedLock(dir, 'app.lock.d', { processStartTime: probe }).status, 'alive');
  assert.equal(readOwnedLock(dir, 'app.lock.d', { processStartTime: () => reading({ lstart: LATER }) }).status, 'alive');
  // Nobody else may take it while its tick still matches.
  assert.throws(() => acquireOwnedLock(dir, 'app.lock.d', { processStartTime: probe }), { code: 'LOCKED' });
  releaseOwnedLock(handle);
  assert.equal(fs.existsSync(path.join(dir, 'app.lock.d')), false);
});

// A fake /proc for the Linux reader (all platforms).
function fakeProc({
  selfPid = 77, status = `Name:\tnode\nNSpid:\t77\n`, pidns = ['pid:[4026531836]'], timens = 'time:[4026531834]',
  timeForChildren, timensOffsets, boot = `${BOOT}\n`, ticks = { 77: '555', 4242: '1234567' },
} = {}) {
  const reads = [];
  let pidnsRead = 0;
  let bootRead = 0;
  let timensRead = 0;
  const nth = (value, i) => (Array.isArray(value) ? value[Math.min(i, value.length - 1)] : value);
  const enoent = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
  const stat = (pid, start) => `${pid} (node) S 1 ${pid} ${pid} 0 -1 4194304 100 0 0 0 1 2 0 0 20 0 1 0 ${start} 1000 5 1`;
  return {
    reads,
    fsImpl: {
      readFileSync(file) {
        reads.push(file);
        if (file === '/proc/self/stat') return stat(selfPid, ticks[selfPid]);
        const match = /^\/proc\/(\d+)\/stat$/.exec(file);
        if (match) return ticks[match[1]] === undefined ? enoent() : stat(match[1], ticks[match[1]]);
        if (file === '/proc/self/status') return status;
        if (file === '/proc/sys/kernel/random/boot_id') return nth(boot, bootRead++);
        if (file === '/proc/self/timens_offsets' && timensOffsets !== undefined) return timensOffsets;
        return enoent();
      },
      readlinkSync(file) {
        reads.push(file);
        if (file === '/proc/self/ns/pid') return pidns[Math.min(pidnsRead++, pidns.length - 1)];
        if (file === '/proc/self/ns/time') return nth(timens, timensRead++) ?? enoent();
        if (file === '/proc/self/ns/time_for_children' && timeForChildren !== undefined) return timeForChildren;
        return enoent();
      },
    },
  };
}

test('#256 the lifetime reader brackets the ticks with two agreeing scope reads and reads its own tick from /proc/self', () => {
  const OWN = `utc-v1:${LSTART}`;
  const lifetime = (proc) => createLinuxProcessStartTime({
    platform: 'linux', fsImpl: proc.fsImpl, ownedStartTimeOf: () => OWN, selfPid: 77, bracketScope: true,
  });
  const agreeing = fakeProc();
  assert.equal(lifetime(agreeing)(4242), reading());
  assert.equal(agreeing.reads[0], '/proc/self/status', 'the scope is read before the ticks');
  assert.ok(agreeing.reads.indexOf('/proc/4242/stat') > agreeing.reads.indexOf('/proc/self/ns/pid'));
  // Its own tick through /proc/self, never a numeric path another procfs could resolve.
  const own = fakeProc();
  assert.equal(lifetime(own)(77), reading({ start: '555' }));
  assert.ok(!own.reads.includes('/proc/77/stat'));
  // Any scope part changed between the two scope reads: no evidence, the owned value only.
  assert.equal(lifetime(fakeProc({ pidns: ['pid:[4026531836]', 'pid:[4026532000]'] }))(4242), OWN);
  assert.equal(lifetime(fakeProc({ boot: [`${BOOT}\n`, `${OTHER_BOOT}\n`] }))(4242), OWN);
  assert.equal(lifetime(fakeProc({ timens: ['time:[4026531834]', 'time:[4026532001]'] }))(4242), OWN);
  // No scope before the ticks: no evidence either (and no tick read at all).
  const ancestor = fakeProc({ status: 'NSpid:\t9123\t77\n' });
  assert.equal(lifetime(ancestor)(4242), OWN);
  assert.ok(!ancestor.reads.includes('/proc/4242/stat'));
  // `none` only when every time namespace file is missing.
  assert.equal(lifetime(fakeProc({ timens: null }))(4242), reading({ timens: 'none' }));
  assert.equal(lifetime(fakeProc({ timens: null, timeForChildren: 'time:[4026531834]' }))(4242), OWN);
  assert.equal(lifetime(fakeProc({ timens: null, timensOffsets: 'monotonic 0 0\nboottime 0 0\n' }))(4242), OWN);
  // The coach instance keeps the #255 order: tick, ps, tick, then the scope.
  const coach = fakeProc();
  const coachReader = createLinuxProcessStartTime({ platform: 'linux', fsImpl: coach.fsImpl, ownedStartTimeOf: () => OWN, selfPid: 77 });
  assert.equal(coachReader(4242), reading());
  assert.deepEqual(coach.reads.slice(0, 2), ['/proc/4242/stat', '/proc/4242/stat']);
  // Elsewhere nothing under /proc is read.
  const mac = fakeProc();
  assert.equal(createLinuxProcessStartTime({ platform: 'darwin', fsImpl: mac.fsImpl, ownedStartTimeOf: () => OWN, bracketScope: true })(4242), OWN);
  assert.deepEqual(mac.reads, []);
});

test('#256 init neither archives nor replaces a clock-stepped live loop; a reused pid lets it through', async (t) => {
  const child = spawnIdle(t);
  const dir = tmpDir('holdem-lifetime-init-');
  const record = `${child.pid}\nutc-v1\n${LSTART}\n${EVIDENCE}`;
  writeRecord(dir, 'loop.lock.d', record);
  const probe = (childReading) => (pid) => (pid === child.pid ? childReading : null);
  const before = fs.readdirSync(dir).sort();
  for (const force of [false, true]) {
    assert.throws(
      () => initGameDir(dir, { aiCount: 2, force }, { processStartTime: probe(reading({ lstart: LATER })) }),
      { code: force ? 'LOOP_ALIVE' : 'ACTIVE_GAME' },
    );
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
  assert.equal(fs.readFileSync(path.join(dir, 'loop.lock.d', 'pid'), 'utf8'), record);
  const result = initGameDir(dir, { aiCount: 2 }, { processStartTime: probe(reading({ start: '1' })) });
  assert.ok(result.sessionToken);
});

// Real Linux evidence. The ubuntu runners read it (#255 confirmed NSpid, namespace links and
// boot_id there); a Linux runner that cannot is a failure here, not a skip.
function realLinuxReading(pid) {
  return parseLinuxReading(lifetimeProcessStartTime(pid));
}
const LINUX = process.platform === 'linux';

test('#256 Linux: a real lock records the evidence line and reads back alive', { skip: !LINUX }, () => {
  assert.ok(realLinuxReading(process.pid), 'this Linux runner must read the lifetime evidence');
  const dir = tmpDir();
  const handle = acquireOwnedLock(dir, 'loop.lock.d');
  const lines = fs.readFileSync(path.join(dir, 'loop.lock.d', 'pid'), 'utf8').split('\n');
  assert.equal(lines.length, 4);
  assert.match(lines[3], /^linux-v1:boot=/);
  assert.equal(handle.startTime, `${lines[1]}:${lines[2]}`);
  assert.equal(handle.startTime, ownedProcessStartTime(process.pid));
  assert.equal(readOwnedLock(dir, 'loop.lock.d').status, 'alive');
  releaseOwnedLock(handle);
});

// A stand-in for a running app or study service: it answers exactly what the clients check,
// from a spec file the test writes once it knows the child's pid and port.
const FAKE_SERVICE = `
const http = require('node:http'); const fs = require('node:fs');
const file = process.argv[1];
const server = http.createServer((req, res) => {
  let spec; try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { res.writeHead(503); res.end('{}'); return; }
  const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/api/app') return send(req.headers.authorization === 'Bearer ' + spec.token ? 200 : 401, { instanceId: spec.instanceId });
  if (req.url === '/api/health') return req.headers['x-drill-token'] === spec.drillToken
    ? send(200, { ok: true, protocolVersion: 1, capabilities: { study: true }, ...spec.health }) : send(401, { ok: false });
  if (req.url === '/internal/parent-attach') {
    spec.attaches = (spec.attaches ?? 0) + 1; fs.writeFileSync(file, JSON.stringify(spec));
    const refuse = spec.refuseParent || (spec.refuseFrom !== undefined && spec.attaches >= spec.refuseFrom);
    return send(refuse ? 409 : 200, refuse ? { ok: false, code: 'PARENT_IDENTITY_MISMATCH' } : { ok: true });
  }
  send(404, {});
});
server.listen(0, '127.0.0.1', () => process.stdout.write(server.address().port + '\\n'));
`;

async function startFakeService(t) {
  const specFile = path.join(tmpDir('holdem-lifetime-spec-'), 'spec.json');
  const child = spawn(process.execPath, ['-e', FAKE_SERVICE, specFile], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (out.includes('\n')) resolve(Number(out.trim())); });
    child.once('exit', () => reject(new Error('fake service exited')));
  });
  return {
    child, port,
    spec: (value) => fs.writeFileSync(specFile, JSON.stringify(value)),
    read: () => JSON.parse(fs.readFileSync(specFile, 'utf8')),
  };
}

// A running study stand-in for `store`, owning a lock record with its real identity: the
// Linux evidence line where the runner reads it, the three-line owned record elsewhere.
function seedFakeStudy(store, service, real, { refuseParent = false } = {}) {
  real ??= { lstart: ownedProcessStartTime(service.child.pid).slice('utc-v1:'.length) };
  const training = path.join(store, '.training');
  fs.mkdirSync(training, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(store);
  const identity = {
    pid: service.child.pid, startTime: `utc-v1:${real.lstart}`, instanceId: randomUUID(),
    storeIdentity: createHash('sha256').update(JSON.stringify([fs.realpathSync(store), st.dev, st.ino])).digest('hex'),
    port: service.port,
  };
  const drillToken = randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(training, 'study-service.json'),
    JSON.stringify({ schemaVersion: 1, ...identity, drillToken, controlToken: randomBytes(32).toString('hex') }), { mode: 0o600 });
  service.spec({ drillToken, health: identity, refuseParent });
  writeRecord(training, 'study.lock.d', `${service.child.pid}\nutc-v1\n${real.lstart}${real.boot ? `\n${evidenceOf(real)}` : ''}`);
  return identity;
}

function evidenceOf(real, start = real.start) {
  return `linux-v1:boot=${real.boot};pidns=${real.pidns};timens=${real.timens};start=${start}`;
}

test('#256 Linux: a live owner whose lstart moved keeps its lock and init refuses; a reused pid is freed', { skip: !LINUX }, async (t) => {
  const child = spawnIdle(t);
  const real = realLinuxReading(child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  const moved = `${child.pid}\nutc-v1\n${shiftLstart(real.lstart, 7)}\n${evidenceOf(real)}`;
  const reused = `${child.pid}\nutc-v1\n${real.lstart}\n${evidenceOf(real, String(BigInt(real.start) + 1n))}`;
  const game = tmpDir('holdem-lifetime-real-');
  writeRecord(game, 'loop.lock.d', moved);
  assert.equal(readOwnedLock(game, 'loop.lock.d').status, 'alive');
  assert.throws(() => acquireOwnedLock(game, 'loop.lock.d'), { code: 'LOCKED' });
  assert.throws(() => initGameDir(game, { aiCount: 2 }), { code: 'ACTIVE_GAME' });
  assert.equal(fs.readFileSync(path.join(game, 'loop.lock.d', 'pid'), 'utf8'), moved);
  assert.deepEqual(fs.readdirSync(game), ['loop.lock.d']);
  writeRecord(game, 'loop.lock.d', reused);
  assert.equal(readOwnedLock(game, 'loop.lock.d').status, 'dead');
  const handle = acquireOwnedLock(game, 'loop.lock.d');
  assert.equal(handle.pid, process.pid);
  releaseOwnedLock(handle);
});

test('#256 Linux: the app service reports a live owner whose lstart moved as running', {
  skip: !LINUX || !['/usr/sbin/lsof', '/usr/bin/lsof'].some((file) => fs.existsSync(file)), timeout: 60_000,
}, async (t) => {
  const { inspectAppService } = await import('../tools/app-service.js');
  const service = await startFakeService(t);
  const real = realLinuxReading(service.child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  const lstart = shiftLstart(real.lstart, 7);
  const store = tmpDir('holdem-lifetime-app-');
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  service.spec({ token, instanceId });
  const record = `${service.child.pid}\nutc-v1\n${lstart}\n${evidenceOf(real)}`;
  writeRecord(store, 'app.lock.d', record);
  fs.mkdirSync(path.join(store, '.app'), { mode: 0o700 });
  const descriptor = { schemaVersion: 1, instanceId, pid: service.child.pid, startTime: `utc-v1:${lstart}`, origin: `http://127.0.0.1:${service.port}`, token };
  fs.writeFileSync(path.join(store, '.app', 'descriptor.json'), JSON.stringify(descriptor), { mode: 0o600 });
  const running = await inspectAppService(store);
  assert.equal(running.status, 'running');
  assert.equal(running.pid, service.child.pid);
  assert.equal(running.instanceId, instanceId);
  assert.equal(fs.readFileSync(path.join(store, 'app.lock.d', 'pid'), 'utf8'), record);
  // The same pid with another tick is a reused pid: the service is stopped.
  writeRecord(store, 'app.lock.d', `${service.child.pid}\nutc-v1\n${lstart}\n${evidenceOf(real, String(BigInt(real.start) + 1n))}`);
  assert.deepEqual(await inspectAppService(store), { status: 'stopped' });
});

test('#256 Linux: the study service keeps a live owner whose lstart moved and replaces one whose pid was reused', { skip: !LINUX, timeout: 120_000 }, async (t) => {
  const { inspectStudyService, ensureStudyService, stopStudyService } = await import('../tools/study-service.js');
  const service = await startFakeService(t);
  const real = realLinuxReading(service.child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  const store = tmpDir('holdem-lifetime-study-');
  const training = path.join(store, '.training');
  fs.mkdirSync(training, { mode: 0o700 });
  const st = fs.lstatSync(store);
  const lstart = shiftLstart(real.lstart, 7);
  const identity = {
    pid: service.child.pid, startTime: `utc-v1:${lstart}`, instanceId: randomUUID(),
    storeIdentity: createHash('sha256').update(JSON.stringify([fs.realpathSync(store), st.dev, st.ino])).digest('hex'),
    port: service.port,
  };
  const drillToken = randomBytes(32).toString('hex');
  const descriptorText = JSON.stringify({ schemaVersion: 1, ...identity, drillToken, controlToken: randomBytes(32).toString('hex') });
  const descriptorFile = path.join(training, 'study-service.json');
  fs.writeFileSync(descriptorFile, descriptorText, { mode: 0o600 });
  service.spec({ drillToken, health: identity });
  const record = `${service.child.pid}\nutc-v1\n${lstart}\n${evidenceOf(real)}`;
  const pidFile = writeRecord(training, 'study.lock.d', record);
  const running = await inspectStudyService(store);
  assert.equal(running.status, 'running');
  assert.equal(running.instanceId, identity.instanceId);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), record);
  assert.equal(fs.readFileSync(descriptorFile, 'utf8'), descriptorText);

  // The pid reused within the recorded second: the lock says dead by its tick, and the
  // descriptor naming that record is judged with the record's evidence, not its lstart
  // (`ensureOwned`'s stale descriptor and its dead-owner check). The replacement holds its
  // first publish, so the client meets its lock while the old descriptor is still on disk
  // and must recognise that descriptor as stale by the same evidence (the first-checkpoint
  // wait) — judged by its lstart alone it would be a live stranger and fail the start.
  writeRecord(training, 'study.lock.d', `${service.child.pid}\nutc-v1\n${lstart}\n${evidenceOf(real, String(BigInt(real.start) + 1n))}`);
  assert.deepEqual(await inspectStudyService(store), { status: 'stopped' });
  const replaced = await ensureStudyService(store, { testOptions: { publishDelayMs: 5000 } });
  t.after(() => stopStudyService(store, { expectedInstanceId: replaced.instanceId }).catch(() => {}));
  assert.notEqual(replaced.instanceId, identity.instanceId);
  assert.notEqual(replaced.pid, service.child.pid);
  assert.equal(fs.readFileSync(path.join(training, 'study.lock.d', 'pid'), 'utf8').split('\n').length, 4);
  await stopStudyService(store, { expectedInstanceId: replaced.instanceId });
});

test('#256 D6 Linux: a running study service that refuses the new loop lock stops the start before anything is committed', { skip: !LINUX, timeout: 60_000 }, async (t) => {
  const { prepareGameSession } = await import('../tools/game-loop.js');
  const { resolveCurrentSession } = await import('../engine/session-catalog.js');
  const service = await startFakeService(t);
  const real = realLinuxReading(service.child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  const store = tmpDir('holdem-lifetime-d6-');
  seedFakeStudy(store, service, real, { refuseParent: true });
  let reserved = false;
  await assert.rejects(
    prepareGameSession({ storeDir: store, ai: 1, port: 0 }, { resolver: async () => ({ player: null, upper: null, notices: [] }), onReserve: () => { reserved = true; } }),
    (error) => error.code === 'STUDY_SERVICE_INCOMPATIBLE' && error.cause?.code === 'PARENT_IDENTITY_MISMATCH',
  );
  assert.equal(service.read().attaches, 1, 'the refusal came from the running service');
  assert.equal(reserved, false);
  assert.equal(resolveCurrentSession(store), null, 'no session was committed');
  assert.equal(fs.existsSync(path.join(store, 'loop.lock.d')), false, 'the store loop lock was released');
  // A service that accepts the parent lets the start go on to the commit (it is attached once
  // here and again by the loop itself); the start then fails later for its own reasons only.
  const accepting = tmpDir('holdem-lifetime-d6-ok-');
  const other = await startFakeService(t);
  seedFakeStudy(accepting, other, realLinuxReading(other.child.pid));
  let reachedReservation = false;
  await assert.rejects(prepareGameSession({ storeDir: accepting, ai: 1, port: 0 }, {
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    onReserve: () => { reachedReservation = true; throw Object.assign(new Error('stop here'), { code: 'TEST_STOP' }); },
  }), { code: 'TEST_STOP' });
  assert.equal(reachedReservation, true);
  assert.equal(other.read().attaches, 1);
});

test('#256 D6: nothing is attached before the commit when the loop lock has no evidence line or no service runs', async () => {
  const { prepareGameSession } = await import('../tools/game-loop.js');
  const store = tmpDir('holdem-lifetime-d6-none-');
  let reachedReservation = false;
  await assert.rejects(prepareGameSession({ storeDir: store, ai: 1, port: 0 }, {
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    onReserve: () => { reachedReservation = true; throw Object.assign(new Error('stop here'), { code: 'TEST_STOP' }); },
  }), { code: 'TEST_STOP' });
  assert.equal(reachedReservation, true);
  assert.equal(fs.existsSync(path.join(store, '.training')), false, 'nothing of the study service was created');
});

test('#256 Linux: a refusal after the commit carries the same code, and the committed session stays for a resume', { skip: !LINUX, timeout: 120_000 }, async (t) => {
  const { launchSession } = await import('../tools/session-launcher.js');
  const { resolveCurrentSession } = await import('../engine/session-catalog.js');
  const service = await startFakeService(t);
  const real = realLinuxReading(service.child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  const store = tmpDir('holdem-lifetime-d6-late-');
  seedFakeStudy(store, service, real);
  // The pre-commit attach succeeds; the service then turns the loop's own attach down, the
  // way one started by an older client between the check and the commit would.
  const spec = service.read();
  service.spec({ ...spec, refuseFrom: 2 });
  await assert.rejects(
    launchSession({ storeDir: store, ai: 1, port: 0, opponentRuntime: 'policy' }, { resolver: async () => ({ player: null, upper: null, notices: [] }) }),
    (error) => error.code === 'STUDY_SERVICE_INCOMPATIBLE' && error.cause?.code === 'PARENT_IDENTITY_MISMATCH',
  );
  assert.equal(service.read().attaches, 2);
  assert.ok(resolveCurrentSession(store), 'the committed session is kept');
  assert.equal(fs.existsSync(path.join(store, 'loop.lock.d')), false);
});

test('#256 a refusal is renamed only for a four-line loop lock; a three-line one keeps its code', {
  skip: process.platform === 'win32' ? 'the study stand-in writes POSIX private files' : false, timeout: 120_000,
}, async (t) => {
  const { launchSession } = await import('../tools/session-launcher.js');
  const service = await startFakeService(t);
  const store = tmpDir('holdem-lifetime-refusal-');
  seedFakeStudy(store, service, LINUX ? realLinuxReading(service.child.pid) : null, { refuseParent: true });
  await assert.rejects(
    launchSession({ storeDir: store, ai: 1, port: 0, opponentRuntime: 'policy' }, { resolver: async () => ({ player: null, upper: null, notices: [] }) }),
    (error) => (LINUX
      ? error.code === 'STUDY_SERVICE_INCOMPATIBLE' && error.cause?.code === 'PARENT_IDENTITY_MISMATCH'
      : error.code === 'PARENT_IDENTITY_MISMATCH'),
  );
});

test('#256 Linux: with the default readers, ESRCH is death only in this process\'s own pid namespace', { skip: !LINUX }, async (t) => {
  const child = spawnIdle(t);
  const real = realLinuxReading(child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  child.kill('SIGKILL');
  await exited(child);
  const record = (pidns) => `linux-v1:boot=${real.boot};pidns=${pidns};timens=${real.timens};start=${real.start}`;
  assert.equal(ownedIdentityStatus(child.pid, `utc-v1:${real.lstart}`, undefined, record(real.pidns)), 'dead');
  assert.equal(ownedIdentityStatus(child.pid, `utc-v1:${real.lstart}`, undefined, record('1')), 'unknown');
  const dir = tmpDir();
  writeRecord(dir, 'loop.lock.d', `${child.pid}\nutc-v1\n${real.lstart}\n${record('1')}`);
  assert.equal(readOwnedLock(dir, 'loop.lock.d').status, 'unknown', 'an owner recorded in another pid namespace is not seen dead');
  assert.throws(() => acquireOwnedLock(dir, 'loop.lock.d'), { code: 'LOCKED' });
});

test('#256 D6 Linux: a study owner neither alive nor dead is waited on, then stops the start before the commit', { skip: !LINUX, timeout: 90_000 }, async (t) => {
  const { prepareGameSession } = await import('../tools/game-loop.js');
  const { resolveCurrentSession } = await import('../engine/session-catalog.js');
  const service = await startFakeService(t);
  const real = realLinuxReading(service.child.pid);
  assert.ok(real, 'this Linux runner must read the lifetime evidence');
  const store = tmpDir('holdem-lifetime-d6-unknown-');
  seedFakeStudy(store, service, real);
  // A three-line record whose lstart moved: on Linux that proves neither life nor death.
  const record = `${service.child.pid}\nutc-v1\n${shiftLstart(real.lstart, 7)}`;
  writeRecord(path.join(store, '.training'), 'study.lock.d', record);
  let reserved = false;
  await assert.rejects(
    prepareGameSession({ storeDir: store, ai: 1, port: 0 }, { resolver: async () => ({ player: null, upper: null, notices: [] }), onReserve: () => { reserved = true; } }),
    { code: 'STUDY_DESCRIPTOR_CORRUPT' },
  );
  assert.equal(reserved, false);
  assert.equal(resolveCurrentSession(store), null, 'no session was committed');
  assert.equal(fs.existsSync(path.join(store, 'loop.lock.d')), false);
  assert.equal(fs.readFileSync(path.join(store, '.training', 'study.lock.d', 'pid'), 'utf8'), record);
  assert.equal(service.read().attaches ?? 0, 0, 'nothing was attached to an unproven owner');
});
