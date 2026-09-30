// #247: coach handles record the owned start time — no time zone, so a reader in another
// zone reads the same text for the same process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownedProcessStartTime, validOwnedIdentity } from '../engine/state.js';
import { validCoachIdentity } from '../tools/coach-evidence.js';
import { createPlayerRuntime, spawnCli } from '../tools/player-runtime.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIND = { linux: /^utc-v1:/, darwin: /^utc-v1:/, win32: /^win32-v1:/ }[process.platform];
// #255: on Linux a coach handle adds the reader's scope and the start tick.
const COACH_KIND = { linux: /^linux-v1:/, darwin: /^utc-v1:/, win32: /^win32-v1:/ }[process.platform];
const skip = KIND ? false : `no owned start time on ${process.platform}`;

test('#247 another time zone reads the same owned start time', { skip }, async () => {
  const own = ownedProcessStartTime(process.pid);
  assert.match(own, KIND);
  assert.equal(validOwnedIdentity(own), true);
  const href = new URL('../engine/state.js', import.meta.url).href;
  for (const TZ of ['Asia/Seoul', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { ownedProcessStartTime } from ${JSON.stringify(href)}; process.stdout.write(String(ownedProcessStartTime(${process.pid})));`],
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

test('#247 a one-shot coach handle carries the owned start time by default', { skip }, async (t) => {
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
  assert.match(handle.startTime, COACH_KIND);
  assert.equal(validCoachIdentity(handle.startTime), true);
  assert.equal((await handle.done).raw, 'ok');
});
