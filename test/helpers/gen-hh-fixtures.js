#!/usr/bin/env node
// Regenerates the engine-produced hand-history records under
// test/fixtures/hand-history/generated/. Reproducible: the deck is pinned card
// for card for every card the fixture text shows, and the remaining 41 cards
// come from mulberry32(seed), so the same seed always yields the same deck.
//
//   node test/helpers/gen-hh-fixtures.js [--out <dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newDeck, shuffle } from '../../engine/cards.js';
import { mulberry32 } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENGINE = path.join(ROOT, 'engine/cli.js');
export const GENERATED_DIR = path.join(ROOT, 'test/fixtures/hand-history/generated');

// 3-handed with the button on user: startHand deals SB → BB → button.
const DEAL_ORDER = ['p1', 'p2', 'user'];

export const SCENARIOS = [
  {
    name: 'uncalled',
    fixture: '05-raise-to.txt',
    seed: 1005,
    stacks: { user: 5000, p1: 5000, p2: 5000 },
    holes: { user: ['Ah', 'Kd'], p1: ['2c', '3d'], p2: ['7s', '8s'] },
    board: [],
    actions: [['user', 'raise', 200], ['p1', 'fold'], ['p2', 'fold']],
  },
  {
    name: 'split',
    fixture: '09-showdown-muck-split.txt',
    seed: 1009,
    stacks: { user: 5000, p1: 5000, p2: 5000 },
    holes: { user: ['Ah', 'Kh'], p1: ['Ad', 'Kd'], p2: ['2h', '3d'] },
    board: ['Ts', 'Js', 'Qs', '9s', '2d'],
    actions: [
      ['user', 'call'], ['p1', 'call'], ['p2', 'check'],
      ['p1', 'check'], ['p2', 'check'], ['user', 'check'],
      ['p1', 'check'], ['p2', 'check'], ['user', 'check'],
      ['p1', 'check'], ['p2', 'check'], ['user', 'check'],
    ],
  },
  {
    name: 'side-pot',
    fixture: '10-side-pot.txt',
    seed: 1010,
    stacks: { user: 100, p1: 300, p2: 500 },
    holes: { user: ['Ah', 'Kh'], p1: ['Kc', 'Kd'], p2: ['As', 'Ad'] },
    board: ['2c', '7d', '9h', '3s', '4c'],
    actions: [['user', 'raise', 100], ['p1', 'raise', 300], ['p2', 'call']],
  },
];

export function buildDeck({ holes, board, seed }) {
  const pinned = [];
  for (let round = 0; round < 2; round += 1) {
    for (const playerId of DEAL_ORDER) pinned.push(holes[playerId][round]);
  }
  pinned.push(...(board ?? []));
  const pinnedSet = new Set(pinned);
  if (pinnedSet.size !== pinned.length) throw new Error(`중복 카드: ${pinned.join(',')}`);
  const rest = newDeck().filter((card) => !pinnedSet.has(card));
  return [...pinned, ...shuffle(rest, mulberry32(seed))];
}

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [ENGINE, ...args], { encoding: 'utf8' }).trim());
}

export function generateRecord(scenario, gameDir) {
  run(['init', '--ai', '2', '--game-dir', gameDir, '--stack', '5000', '--blinds', '25/50']);
  const statePath = path.join(gameDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  // init picks the button at random; startHand advances it one live seat, so
  // pinning the last seat here puts the button on user for every run.
  state.button = state.seats.length - 1;
  for (const seat of state.seats) seat.stack = scenario.stacks[seat.playerId];
  fs.writeFileSync(statePath, JSON.stringify(state));

  run(['new-hand', '--game-dir', gameDir, '--deck', buildDeck(scenario).join(',')]);
  for (const [playerId, action, amount] of scenario.actions) {
    const rest = amount == null ? [] : [String(amount)];
    run(['apply', playerId, action, ...rest, '--game-dir', gameDir]);
  }
  const after = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!after.lastHand) throw new Error(`${scenario.name}: 핸드가 끝나지 않았습니다.`);
  return after.lastHand;
}

export function generateRecords({ outDir = GENERATED_DIR } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const scenario of SCENARIOS) {
    const gameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-genhh-'));
    const record = generateRecord(scenario, gameDir);
    const file = path.join(outDir, `${scenario.name}.json`);
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    written.push(file);
    fs.rmSync(gameDir, { recursive: true, force: true });
  }
  return written;
}

export function readGeneratedRecord(name, dir = GENERATED_DIR) {
  return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
}

const thisFile = fileURLToPath(import.meta.url);
// `node --test` discovers helper files under test/. It must import this module
// without regenerating tracked fixtures as a test-suite side effect.
if (!process.env.NODE_TEST_CONTEXT
  && process.argv[1]
  && path.resolve(process.argv[1]) === thisFile) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const outDir = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : GENERATED_DIR;
  for (const file of generateRecords({ outDir })) process.stdout.write(`${file}\n`);
}
