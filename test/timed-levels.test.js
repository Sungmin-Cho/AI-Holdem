import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGame, startHand, applyAction, legalFor, blindsForLevel } from '../engine/hand.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');
const MINUTE = 60_000;

function cli(gameDir, args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args, '--game-dir', gameDir], { encoding: 'utf8', timeout: 20000 });
    return { status: 0, json: JSON.parse(stdout.trim()) };
  } catch (error) {
    let json = null;
    try { json = JSON.parse(String(error.stdout ?? '').trim()); } catch { /* non-JSON */ }
    return { status: error.status ?? 1, json, stderr: String(error.stderr ?? '') };
  }
}
const tmpGame = () => fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-timed-'));
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

// Every player folds to the big blind, so the hand ends at once.
function foldOut(state) {
  let next = state;
  while (next.hand) {
    const legal = legalFor(next);
    next = applyAction(next, legal.toAct, legal.canCheck ? 'check' : 'fold').state;
  }
  return next;
}
function play(state, playMs) {
  const started = startHand(state, { playMs });
  return { state: foldOut(started.state), events: started.events };
}

test('a timed tournament keeps one level mode and no hand-based period', () => {
  const game = createGame({ aiCount: 2, levelMinutes: 2 });
  assert.equal(game.config.levelMinutes, 2);
  assert.equal(game.config.levelEvery, null);
  assert.equal(Object.hasOwn(game, 'levelClock'), false);
  // Hand-based games do not grow the new keys.
  const handBased = createGame({ aiCount: 2 });
  assert.equal(handBased.config.levelEvery, 8);
  assert.equal(Object.hasOwn(handBased.config, 'levelMinutes'), false);
  for (const levelMinutes of [0, 61, 1.5, '2']) {
    assert.throws(() => createGame({ aiCount: 2, levelMinutes }), { code: 'BAD_CONFIG' });
  }
  assert.throws(() => createGame({ aiCount: 2, levelMinutes: 2, levelEvery: 8 }), { code: 'BAD_CONFIG' });
  assert.throws(() => createGame({ aiCount: 2, mode: 'cash-training', levelEvery: null, levelMinutes: 2 }), { code: 'BAD_CONFIG' });
});

test('a level lasts its minutes of play from the hand it took effect and rises one step per hand', () => {
  let state = createGame({ aiCount: 2, levelMinutes: 2 });
  const levels = [];
  const record = (playMs) => {
    const { state: next, events } = play(state, playMs);
    state = next;
    const start = events.find((event) => event.type === 'hand_start');
    levels.push({ level: start.level, blinds: start.blinds, up: events.some((event) => event.type === 'level_up') });
  };
  record(0);
  assert.deepEqual(state.levelClock, { levelStartedMs: 0, playMs: 0 });
  record(2 * MINUTE - 1);
  // A hand that ran far past several levels still raises only one step.
  record(9 * MINUTE);
  assert.deepEqual(state.levelClock, { levelStartedMs: 9 * MINUTE, playMs: 9 * MINUTE });
  record(10 * MINUTE);
  record(11 * MINUTE);
  assert.deepEqual(levels.map((row) => row.level), [0, 0, 1, 1, 2]);
  assert.deepEqual(levels.map((row) => row.up), [false, false, true, false, true]);
  assert.deepEqual(levels[4].blinds, blindsForLevel(2, [25, 50]));
});

test('a play time that runs backwards never lowers the clock or the level', () => {
  let state = createGame({ aiCount: 2, levelMinutes: 1 });
  state = play(state, 5 * MINUTE).state;
  state = play(state, 1000).state;
  assert.deepEqual(state.levelClock, { levelStartedMs: 5 * MINUTE, playMs: 5 * MINUTE });
  assert.equal(state.level, 0);
  state = play(state, 6 * MINUTE).state;
  assert.equal(state.level, 1);
});

test('a timed hand needs the play time and a hand-based hand ignores it', () => {
  const timed = createGame({ aiCount: 2, levelMinutes: 2 });
  for (const playMs of [undefined, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => startHand(timed, { playMs }), { code: 'BAD_CONFIG' });
  }
  const handBased = createGame({ aiCount: 2, levelEvery: 1 });
  const first = play(handBased, 999 * MINUTE).state;
  assert.equal(Object.hasOwn(first, 'levelClock'), false);
  assert.equal(startHand(first).state.level, 1);
});

test('engine CLI: init --level-minutes and step --new-hand --play-ms', () => {
  const dir = tmpGame();
  assert.equal(cli(dir, ['init', '--ai', '2', '--level-minutes', '2']).status, 0);
  assert.equal(readState(dir).config.levelMinutes, 2);
  // The play time is required for a timed game and only with --new-hand.
  for (const args of [['step', '--new-hand'], ['new-hand'], ['step', '--new-hand', '--play-ms', '-1'], ['step', '--new-hand', '--play-ms', 'x']]) {
    const result = cli(dir, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.json?.code, 'USAGE');
  }
  const started = cli(dir, ['step', '--new-hand', '--play-ms', '0']);
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(readState(dir).levelClock, { levelStartedMs: 0, playMs: 0 });
  assert.equal(cli(dir, ['step', 'user', 'fold', '--play-ms', '5']).json?.code, 'USAGE');

  const legacyDir = tmpGame();
  assert.equal(cli(legacyDir, ['init', '--ai', '2', '--level-minutes', '1']).status, 0);
  assert.equal(cli(legacyDir, ['new-hand', '--play-ms', '0']).status, 0);
});

test('engine CLI rejects a second level mode, cash-training and out-of-range minutes', () => {
  for (const args of [
    ['init', '--ai', '2', '--level-minutes', '2', '--level-every', '8'],
    ['init', '--ai', '2', '--mode', 'cash-training', '--level-minutes', '2'],
    ['init', '--ai', '2', '--level-minutes', '0'],
    ['init', '--ai', '2', '--level-minutes', '61'],
  ]) {
    const dir = tmpGame();
    const result = cli(dir, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(result.json?.code, 'USAGE');
    assert.equal(fs.existsSync(path.join(dir, 'state.json')), false);
  }
  // A hand-based game accepts and ignores the play time on a new hand.
  const dir = tmpGame();
  assert.equal(cli(dir, ['init', '--ai', '2']).status, 0);
  assert.equal(cli(dir, ['step', '--new-hand', '--play-ms', '5']).status, 0);
  assert.equal(Object.hasOwn(readState(dir), 'levelClock'), false);
});
