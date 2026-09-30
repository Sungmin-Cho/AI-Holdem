import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

if (!process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-'))) {
  if (process.argv[2] === 'fence') {
    fs.writeSync(1, `${JSON.stringify({ ok: false, code: 'FENCE_BOOM', message: 'injected fence failure' })}\n`);
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../tools/coach-control.js', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
}
