#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createGameLoop } from './game-loop.js';

const args = process.argv.slice(2);
const gameDir = args.includes('--game-dir') ? args[args.indexOf('--game-dir') + 1] : null;
const resume = args.includes('--resume');
const ai = args.includes('--ai') ? Number(args[args.indexOf('--ai') + 1]) : 1;
if (!gameDir) {
  process.stderr.write('USAGE: loop-driver --game-dir DIR [--ai N] [--resume]\n');
  process.exit(2);
}

const fakeDir = path.join(gameDir, '.fake-player');
fs.mkdirSync(fakeDir, { recursive: true });
const fakeScript = path.join(fakeDir, 'fake-player.js');
fs.writeFileSync(fakeScript, 'process.stdin.on("data", () => {}); setTimeout(() => {}, 3600000);\n');
const fake = { command: process.execPath, scriptPath: fakeScript };

const resolver = async () => ({
  playerRuntime: 'claude',
  upperRuntime: 'claude',
  notices: [],
  decide: async () => ({ action: 'fold' }),
  oneshotStart: async () => ({
    sessionId: 'driver-session',
    command: fake.command,
    args: [fake.scriptPath],
    done: new Promise(() => {}),
    terminate: async () => ({ confirmed: true }),
  }),
});

const loop = createGameLoop({
  gameDir,
  resolver,
  opts: { port: 0, waitMs: 5_000 },
});

const run = resume ? loop.resume() : loop.bootstrap({ ai });
run.then(() => {
  const state = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'), 'utf8'));
  process.stdout.write(`${JSON.stringify({
    ready: true,
    phase: state.phase,
    port: state.port,
    sessionDir: gameDir,
  })}\n`);
}).catch((error) => {
  process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
  process.exit(1);
});
