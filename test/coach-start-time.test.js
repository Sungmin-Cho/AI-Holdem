// #247: coach handles record a start time that no clock step or time-zone change can move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coachProcessStartTime, linuxProcessStartTime, validCoachStartTime } from '../engine/state.js';
import { createPlayerRuntime, spawnCli } from '../tools/player-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOOT = '0f8c4a2e-1b2c-4d5e-8f90-a1b2c3d4e5f6';
const KIND = { linux: /^linux-v1:/, darwin: /^utc-v1:/, win32: /^win32-v1:/ }[process.platform];

function proc({ bootId = `${BOOT}\n`, stat }) {
  return (file) => {
    if (file === '/proc/sys/kernel/random/boot_id') return bootId;
    if (file === '/proc/4242/stat') {
      if (stat === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return stat;
    }
    throw new Error(`unexpected read ${file}`);
  };
}
// Fields 3–21 of /proc/<pid>/stat, then starttime (field 22) and a few more.
const tail = (start) => `S 1 4242 4242 0 -1 4194560 100 0 0 0 5 3 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

test('#247 Linux start time is the boot id and the start tick from /proc', () => {
  assert.equal(linuxProcessStartTime(4242, { readFile: proc({ stat: `4242 (node) ${tail(987654)}` }) }), `linux-v1:${BOOT}:987654`);
  // The command name may hold spaces and parentheses; only the last ')' ends it.
  assert.equal(linuxProcessStartTime(4242, { readFile: proc({ stat: `4242 (a) b (c) d) ${tail(5)}` }) }), `linux-v1:${BOOT}:5`);
  for (const [label, readFile] of [
    ['a vanished process', proc({})],
    ['a short record', proc({ stat: '4242 (node) S 1 4242' })],
    ['a non-numeric start', proc({ stat: `4242 (node) ${tail('12a')}` })],
    ['a signed start', proc({ stat: `4242 (node) ${tail('-5')}` })],
    ['no command name', proc({ stat: `4242 node ${tail(5)}` })],
    ['a malformed boot id', proc({ bootId: 'not-a-boot-id\n', stat: `4242 (node) ${tail(5)}` })],
  ]) {
    assert.equal(linuxProcessStartTime(4242, { readFile }), null, label);
  }
  for (const pid of [0, -1, 1.5, '4242', null]) assert.equal(linuxProcessStartTime(pid, { readFile: proc({ stat: `4242 (node) ${tail(5)}` }) }), null);
  assert.equal(validCoachStartTime(`linux-v1:${BOOT}:987654`), true);
  for (const bad of [`linux-v1:${BOOT}:`, `linux-v1:${BOOT}:01`, `linux-v1:${BOOT.toUpperCase()}:5`, `linux-v1:${BOOT}`, 'utc-v1:garbage', 'Mon Sep 28 12:00:00 2026']) {
    assert.equal(validCoachStartTime(bad), false, bad);
  }
});

test('#247 the coach reader on this platform reads its own kind, the same way every time', {
  skip: KIND ? false : `no coach start time on ${process.platform}`,
}, async () => {
  const own = coachProcessStartTime(process.pid);
  assert.match(own, KIND);
  assert.equal(validCoachStartTime(own), true);
  assert.equal(coachProcessStartTime(process.pid), own);
  // macOS readings are whole seconds: let the clock move on before starting another process.
  if (process.platform === 'darwin') await new Promise((resolve) => setTimeout(resolve, 1100));
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const other = coachProcessStartTime(child.pid);
    assert.match(other, KIND);
    assert.notEqual(other, own);
  } finally { child.kill(); }
});

test('#247 another time zone reads the same coach start time', {
  skip: KIND ? false : `no coach start time on ${process.platform}`,
}, async () => {
  const own = coachProcessStartTime(process.pid);
  const href = new URL('../engine/state.js', import.meta.url).href;
  for (const TZ of ['Asia/Seoul', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { coachProcessStartTime } from ${JSON.stringify(href)}; process.stdout.write(String(coachProcessStartTime(${process.pid})));`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const code = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(code, 0, err);
    assert.equal(out, own, `read from ${TZ}`);
  }
});

test('#247 a one-shot coach handle carries the coach start time by default', {
  skip: KIND ? false : `no coach start time on ${process.platform}`,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-coach-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const scriptPath = path.join(dir, 'script.json');
  fs.writeFileSync(scriptPath, JSON.stringify({
    matchers: [],
    default: { reply: `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })}\n` },
  }));
  const upper = createPlayerRuntime('codex', {
    env: { FAKE_CLI_SCRIPT: scriptPath, FAKE_CLI_LOG: path.join(dir, 'calls.jsonl') },
    exec: (spec) => spawnCli({ ...spec, command: process.execPath, args: [path.join(ROOT, 'test/helpers/fake-cli.js'), ...spec.args] }),
  });
  t.after(() => upper.dispose());
  const handle = upper.oneshotStart({ tier: 'upper', prompt: 'coach' });
  assert.match(handle.startTime, KIND);
  assert.equal(validCoachStartTime(handle.startTime), true);
  assert.equal((await handle.done).raw, 'ok');
});
