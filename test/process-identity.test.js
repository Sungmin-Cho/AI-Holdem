import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeWin32StartTime,
  createProcessStartTime,
  posixProcessStartTime,
  processStartTime,
  win32ProcessStartTime,
} from '../engine/process-identity.js';

const CANON = '2026-09-04T12:34:56.7890123Z';

test('canonicalizeWin32StartTime: one UTC o-line is accepted', () => {
  assert.equal(canonicalizeWin32StartTime(`\uFEFF${CANON}\n`, ''), CANON);
});

test('canonicalizeWin32StartTime: extra lines, embedded CR/LF, or stderr are null', () => {
  assert.equal(canonicalizeWin32StartTime(`${CANON}\nextra\n`, ''), null);
  assert.equal(canonicalizeWin32StartTime(`${CANON}\r\nline2`, ''), null);
  assert.equal(canonicalizeWin32StartTime(`foo${CANON}`, ''), null);
  assert.equal(canonicalizeWin32StartTime(CANON, 'warning\n'), null);
  assert.equal(canonicalizeWin32StartTime('', ''), null);
});

test('win32ProcessStartTime: nonempty stderr or non-zero status is null', () => {
  const spawn = () => ({ status: 0, stdout: CANON, stderr: 'oops' });
  assert.equal(win32ProcessStartTime(process.pid, { spawn }), null);
  const fail = () => ({ status: 1, stdout: CANON, stderr: '' });
  assert.equal(win32ProcessStartTime(process.pid, { spawn: fail }), null);
});

test('win32ProcessStartTime: interpolates only a positive integer pid', () => {
  let command;
  win32ProcessStartTime(4321, {
    spawn: (exe, args) => {
      command = args[args.indexOf('-Command') + 1];
      return { status: 0, stdout: CANON, stderr: '' };
    },
  });
  assert.match(command, /GetProcessById\(4321\)/);
  assert.equal(win32ProcessStartTime(0, { spawn: () => assert.fail('must not spawn') }), null);
  assert.equal(win32ProcessStartTime('1; exit', { spawn: () => assert.fail('must not spawn') }), null);
});

test('createProcessStartTime: win32 never calls ps even if PATH has it', () => {
  let spawned = [];
  const startTimeOf = createProcessStartTime({
    platform: 'win32',
    spawn: (exe, args) => {
      spawned.push({ exe, args });
      return { status: 0, stdout: CANON, stderr: '' };
    },
    exec: () => assert.fail('posix exec must not run'),
  });
  assert.equal(startTimeOf(7), CANON);
  assert.equal(spawned.length, 1);
  assert.match(spawned[0].exe, /powershell\.exe$/i);
});

test('createProcessStartTime: unsupported platform is always null', () => {
  const startTimeOf = createProcessStartTime({ platform: 'freebsd', exec: () => 'x', spawn: () => ({}) });
  assert.equal(startTimeOf(process.pid), null);
});

test('posixProcessStartTime: missing pid is null', () => {
  assert.equal(posixProcessStartTime(99_999_999), null);
});

test('default processStartTime: current pid is a non-empty string and missing pid is null', () => {
  const a = processStartTime(process.pid);
  const b = processStartTime(process.pid);
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
  assert.equal(a, b);
  assert.equal(processStartTime(99_999_999), null);
});

test('win32 default processStartTime does not depend on ps and is one canonical line', () => {
  if (process.platform !== 'win32') return;
  const orig = process.env.PATH;
  process.env.PATH = '';
  try {
    const a = processStartTime(process.pid);
    const b = processStartTime(process.pid);
    assert.equal(typeof a, 'string');
    assert.ok(a.length > 0);
    assert.equal(a, b);
    assert.match(a, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(processStartTime(99_999_999), null);
  } finally {
    process.env.PATH = orig;
  }
});
