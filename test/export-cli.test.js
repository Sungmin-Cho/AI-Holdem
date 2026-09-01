import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine/cli.js');
const EXPORT = path.join(ROOT, 'tools/export-hh.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-export-'));
}

function run(bin, args) {
  return JSON.parse(execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8' }).trim());
}

test('export canonical json and pokerstars text from a finished hand; secrets stay out', () => {
  const dir = tmp();
  run(ENGINE, ['init', '--ai', '2', '--game-dir', dir]);
  run(ENGINE, ['new-hand', '--game-dir', dir]);
  for (let i = 0; i < 40; i += 1) {
    const legal = run(ENGINE, ['legal', '--game-dir', dir]);
    if (legal.handOver) break;
    const action = legal.toAct === 'user' ? (legal.canCheck ? 'check' : 'fold') : (legal.canCheck ? 'check' : 'call');
    run(ENGINE, ['apply', legal.toAct, action, '--game-dir', dir]);
  }
  const jsonOut = path.join(dir, 'session.json');
  const exported = run(EXPORT, [
    '--game-dir', dir, '--format', 'canonical-json', '--out', jsonOut, '--exported-at', '2026-09-01T00:00:00.000Z',
  ]);
  assert.equal(exported.ok, true);
  const payload = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  assert.equal(payload.hands.length, 1);
  assert.ok(payload.hands[0].heroCards.length === 2);
  const raw = JSON.stringify(payload);
  assert.equal(raw.includes('sessionToken'), false);
  assert.equal(raw.includes('archetype'), false);
  const again = run(EXPORT, [
    '--game-dir', dir, '--format', 'canonical-json', '--out', path.join(dir, 'session-2.json'), '--exported-at', '2026-09-01T00:00:00.000Z',
  ]);
  assert.equal(fs.readFileSync(jsonOut, 'utf8'), fs.readFileSync(again.out, 'utf8'));
  const textOut = path.join(dir, 'session.txt');
  const text = run(EXPORT, ['--game-dir', dir, '--format', 'pokerstars', '--out', textOut, '--exported-at', '2026/09/01 0:00:00 ET']);
  assert.equal(text.ok, true);
  const body = fs.readFileSync(textOut, 'utf8');
  assert.match(body, /PokerStars Hand #AIH/);
  assert.match(body, /folds|calls|checks/);
  assert.equal(body.includes('raises by'), false);
  assert.equal(body.includes('sessionToken'), false);
  try {
    execFileSync(process.execPath, [EXPORT, '--game-dir', dir, '--format', 'canonical-json', '--out', jsonOut], { encoding: 'utf8' });
    assert.fail('overwrite should fail-closed');
  } catch (error) {
    assert.match(String(error.stdout ?? error.message), /EXISTS/);
  }
});
