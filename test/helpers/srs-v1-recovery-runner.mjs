#!/usr/bin/env node
// #272: recovers drill stores with one code tree's own nextQuestion, in a fresh
// process whose clock is frozen before that code loads. The capture runs it on
// the pinned producer (expected bytes); the test runs it on the current tree.
//
//   node test/helpers/srs-v1-recovery-runner.mjs <code root> <ISO time> <store>...
//
// Prints one JSON line: per store, { ok: true, dto } or { ok: false, code, message }.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// `node --test` runs every module under test/ without arguments: nothing to do.
if (process.argv.length === 2) process.exit(0);
const [root, now, ...stores] = process.argv.slice(2);
const RealDate = globalThis.Date;
const frozen = RealDate.parse(now ?? '');
if (!root || !Number.isFinite(frozen) || new RealDate(frozen).toISOString() !== now || !stores.length) {
  fs.writeSync(2, 'usage: srs-v1-recovery-runner.mjs <code root> <ISO time> <store>...\n');
  process.exit(2);
}
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(frozen); }
  static now() { return frozen; }
};
const { nextQuestion } = await import(pathToFileURL(path.join(root, 'tools', 'drill-cli.js')).href);
const results = [];
for (const store of stores) {
  try {
    results.push({ ok: true, dto: await nextQuestion(store) });
  } catch (error) {
    results.push({ ok: false, code: error.code ?? null, message: error.message });
  }
}
fs.writeSync(1, `${JSON.stringify(results)}\n`);
process.exit(0);
