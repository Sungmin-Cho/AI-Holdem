// #213: coach CLI stand-in for the bind-handle failure tests in game-loop-finalize.test.js.
// While `<game-dir>/.inject-coach-failure` exists, `bind-handle` and `fence` fail at once
// with an error envelope. Those tests used to hold publish.lock.d past a 1.5 s global
// childTimeoutMs instead, which win32 coach children exceed even without contention (so
// begin-owner and reserve died too). Every other command, and both of these once the
// marker is gone, run the real CLI.
// `node --test` also walks test/helpers/*.mjs, so stay inert under the runner.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const MARKER = '.inject-coach-failure';
const FAILING_COMMANDS = new Set(['bind-handle', 'fence']);

function injectedFailure(argv) {
  if (!FAILING_COMMANDS.has(argv[0])) return false;
  const index = argv.indexOf('--game-dir');
  return index !== -1 && fs.existsSync(path.join(argv[index + 1], MARKER));
}

const argv = process.argv.slice(2);
if (!process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-')) && argv.length > 0) {
  if (injectedFailure(argv)) {
    fs.writeSync(1, `${JSON.stringify({ ok: false, code: 'INJECTED_COACH_FAILURE', message: `injected ${argv[0]} failure` })}\n`);
    process.exitCode = 1;
  } else {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../../tools/coach-control.js', import.meta.url)), ...argv], { stdio: 'inherit' });
    process.exitCode = result.status ?? 1;
  }
}
