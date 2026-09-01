import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/drill-cli.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-drill-'));
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }).trim());
}

test('drill-cli start/next/answer/summary/due', () => {
  const storeDir = tmp();
  const started = run(['start', '--store-dir', storeDir, '--mode', 'free', '--seed', '1']);
  assert.equal(started.ok, true);
  assert.ok(started.count >= 1);
  const nxt = run(['next', '--store-dir', storeDir]);
  assert.equal(nxt.done, false);
  const answered = run(['answer', '--store-dir', storeDir, '--action', 'fold']);
  assert.equal(answered.ok, true);
  assert.equal(typeof answered.result.grade, 'string');
  const summary = run(['summary', '--store-dir', storeDir]);
  assert.equal(summary.answers.length, 1);
  const due = run(['due', '--store-dir', storeDir]);
  assert.equal(Array.isArray(due.due), true);
});
