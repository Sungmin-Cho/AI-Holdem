import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { skipOnWin32 } from './helpers/platform.js';

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'lock-race-child.mjs');
const ROUNDS = 25;
const CONTENDERS = 8;

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', resolve));
}

test('lock race canary: 25 rounds × 8 contenders never overlap or steal', { timeout: 60_000 }, async (t) => {
  if (skipOnWin32(t, 'directory-rename install and hardlink reclaim are POSIX canaries')) return;
  const started = Date.now();
  const root = createOwnedTempDir('lock-race');
  let totalOverlaps = 0;
  let totalStolen = 0;
  let totalErrors = 0;
  let lockLeft = 0;
  const failures = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    const dir = path.join(root, `r${round}`);
    fs.mkdirSync(dir);
    const lockDir = path.join(dir, 'publish.lock.d');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'pid'), '2147480000');
    const kids = [];
    const outs = [];
    for (let i = 0; i < CONTENDERS; i += 1) {
      const out = path.join(dir, `c${i}.json`);
      outs.push(out);
      const child = registerOwnedProcess(
        spawn(process.execPath, [childPath, dir, out], { stdio: 'ignore' }),
        `lock-race r${round} c${i}`,
      );
      kids.push(child);
    }
    await Promise.all(kids.map(waitForExit));
    const recs = outs.map((file) => {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch { return { error: 'NO_OUTPUT' }; }
    });
    const ok = recs.filter((rec) => !rec.error).sort((a, b) => (BigInt(a.enter) < BigInt(b.enter) ? -1 : 1));
    const errors = recs.length - ok.length;
    totalErrors += errors;
    const roundOverlaps = [];
    for (let i = 1; i < ok.length; i += 1) {
      if (BigInt(ok[i].enter) < BigInt(ok[i - 1].exit)) {
        totalOverlaps += 1;
        roundOverlaps.push({
          a: ok[i - 1].pid,
          b: ok[i].pid,
          overlapUs: Number((BigInt(ok[i - 1].exit) - BigInt(ok[i].enter)) / 1000n),
        });
      }
    }
    const stolen = [];
    for (const rec of ok) {
      if (String(rec.pidEnter).trim() !== String(rec.pid)
        || String(rec.pidExit).trim() !== String(rec.pid)
        || rec.inoEnter !== rec.inoExit) {
        totalStolen += 1;
        stolen.push(rec);
      }
    }
    const left = fs.existsSync(lockDir);
    if (left) lockLeft += 1;
    if (errors || roundOverlaps.length || stolen.length || left) {
      failures.push({ round, errors, overlaps: roundOverlaps, stolen, lockLeft: left });
    }
  }

  const elapsed = Date.now() - started;
  const summary = { elapsedMs: elapsed, totalOverlaps, totalStolen, totalErrors, lockLeft, failures };
  t.diagnostic(JSON.stringify(summary));
  assert.equal(totalOverlaps, 0, JSON.stringify(summary));
  assert.equal(totalStolen, 0, JSON.stringify(summary));
  assert.equal(totalErrors, 0, JSON.stringify(summary));
  assert.equal(lockLeft, 0, JSON.stringify(summary));
});
