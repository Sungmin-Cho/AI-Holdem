#!/usr/bin/env node
// #192 O4-rest 6: simulates a coach-control.js build that predates #192 E3's spawn-protocol
// flags (`--spawn-evidence`/`--accept-evidence`). A new loop instance still passes them, but
// this CLI build never learned about them — the real, current CLI's own argv-parsing layer now
// *requires* `--spawn-evidence 1` for `begin-owner`/`reserve`/`bind-handle` (`coach-control.js`'s
// `requireSpawnEvidence`), so simply stripping the flag and spawning the real CLI as a
// subprocess for those three commands would hit that gate and fail — not reproduce an old
// build that never had the gate at all. For exactly those three commands this shim calls the
// real module's underlying implementation directly (`createCoachControl()`), exactly as an old
// `cliMain` would have: never setting `spawnEvidence`, since that parameter did not exist yet.
// Every other command (including `accept`, which never carried a spawn-protocol gate at the
// CLI layer to begin with — only its own `--accept-evidence` field) is delegated to the real
// CLI as a genuine subprocess, with the two protocol flags simply stripped from argv first —
// mirroring how an old CLI's ordinary argv parsing never even looks at a flag it doesn't know.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createCoachControl } from '../../tools/coach-control.js';

const REAL_CLI = fileURLToPath(new URL('../../tools/coach-control.js', import.meta.url));
const STRIPPED_FLAGS = new Set(['--spawn-evidence', '--accept-evidence']);
const OLD_PROTOCOL_COMMANDS = new Set(['begin-owner', 'reserve', 'bind-handle']);

function stripProtocolFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (STRIPPED_FLAGS.has(argv[i])) { i += 1; continue; }
    out.push(argv[i]);
  }
  return out;
}

// Same simple `--key value` / boolean-flag convention as coach-control.js's own `parseCli`.
function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { opts[key] = true; continue; }
    opts[key] = next;
    i += 1;
  }
  return opts;
}

async function main() {
  const command = process.argv[2];
  const filteredArgs = stripProtocolFlags(process.argv.slice(3));

  if (!OLD_PROTOCOL_COMMANDS.has(command)) {
    const result = spawnSync(process.execPath, [REAL_CLI, command, ...filteredArgs], { stdio: 'inherit' });
    process.exit(result.status ?? 1);
    return;
  }

  const opts = parseArgs(filteredArgs);
  const gameDir = path.resolve(opts['game-dir'] ?? 'game');
  const cc = createCoachControl();
  let result;
  if (command === 'begin-owner') {
    result = await cc.beginOwner({
      gameDir,
      owner: opts.owner,
      completed: Number(opts.completed),
      statsFile: opts['stats-file'],
      snapshotFile: opts['snapshot-file'],
    });
  } else if (command === 'reserve') {
    result = await cc.reserve({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      attempt: Number(opts.attempt ?? 1),
      considerOverfold: Boolean(opts['consider-overfold']),
      statsFile: opts['stats-file'],
      snapshotFile: opts['snapshot-file'],
      ...(opts['deadline-ms'] !== undefined ? { deadlineMs: Number(opts['deadline-ms']) } : {}),
    });
  } else if (command === 'bind-handle') {
    result = await cc.bindHandle({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: Number(opts.generation),
      handle: opts.handle,
    });
  }
  fs.writeSync(1, `${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = error?.code ?? 'INTERNAL';
  fs.writeSync(1, `${JSON.stringify({ ok: false, code, message: error?.message ?? String(error) })}\n`);
  process.exit(1);
});
