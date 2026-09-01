#!/usr/bin/env node
import fs from 'node:fs';

const mode = process.env.SOLVER_FAULT ?? 'ok';

if (mode === 'die') process.exit(2);
if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  if (mode === 'timeout' || mode === 'ignore-term') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'flood') {
    const chunk = 'x'.repeat(64 * 1024);
    const write = () => {
      if (!process.stdout.write(chunk)) process.stdout.once('drain', write);
      else setImmediate(write);
    };
    write();
    return;
  }
  if (mode === 'partial') {
    fs.writeSync(1, '{"schemaVersion":1,"accuracy":"heuristic"');
    process.exit(0);
  }
  const body = JSON.stringify({
    schemaVersion: 1,
    accuracy: 'heuristic',
    providerId: 'fake-solver',
    providerVersion: '1.0.0',
    evBb: null,
    actions: [{ action: 'check', frequency: 1, evBb: null }],
    rangeMatrix: { schemaVersion: 1, accuracy: 'heuristic', cells: [], evBb: null },
  });
  fs.writeSync(1, `${body}\n`);
});
