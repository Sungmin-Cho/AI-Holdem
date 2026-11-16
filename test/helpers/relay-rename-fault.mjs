import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './owned-fixtures.mjs';
import { nodeOptionsRequire } from './stalling-fetch.mjs';

// #347: a relay child whose rename onto one of its own files fails with a Windows-style errno a
// set number of times — the replacement a concurrent reader refuses on Windows — on every
// platform. The loop starts the relay with its stdio ignored and inherits this process's
// environment, so the preload goes in through NODE_OPTIONS for one test (restored after it) and
// acts only in the relay process (`server/server.js`); every other child loads it and does nothing.
// Each refused rename is written to `report` as one JSON line, synchronously.
export function relayRenameFault(t, { target = 'ui-snapshot.json', code = 'EPERM', after = 0, times = 1 } = {}) {
  const dir = createOwnedTempDir('holdem-relay-rename-fault');
  const preload = path.join(dir, 'relay-rename-fault.cjs');
  const report = path.join(dir, 'refused.jsonl');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    'const plan = process.env.HOLDEM_TEST_RELAY_RENAME_FAULT;',
    'const main = process.argv[1] ?? \'\';',
    "if (plan && path.basename(main) === 'server.js' && path.basename(path.dirname(main)) === 'server') {",
    '  const { target, code, after, times, report } = JSON.parse(plan);',
    '  const real = fs.renameSync;',
    '  let seen = 0;',
    '  let refused = 0;',
    '  fs.renameSync = function renameSync(from, to, ...rest) {',
    '    if (path.basename(String(to)) === target) {',
    '      seen += 1;',
    '      if (seen > after && refused < times) {',
    '        refused += 1;',
    "        fs.appendFileSync(report, JSON.stringify({ target, code, seen, refused }) + '\\n');",
    "        throw Object.assign(new Error(code + ': operation not permitted, rename'), { code, errno: -4048, syscall: 'rename' });",
    '      }',
    '    }',
    '    return real.call(this, from, to, ...rest);',
    '  };',
    '}',
    '',
  ].join('\n'));
  const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, HOLDEM_TEST_RELAY_RENAME_FAULT: process.env.HOLDEM_TEST_RELAY_RENAME_FAULT };
  process.env.NODE_OPTIONS = `${saved.NODE_OPTIONS ?? ''} ${nodeOptionsRequire(preload)}`.trim();
  process.env.HOLDEM_TEST_RELAY_RENAME_FAULT = JSON.stringify({ target, code, after, times, report });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return {
    refused: () => {
      try { return fs.readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
