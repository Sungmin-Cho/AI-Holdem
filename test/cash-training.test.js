import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyAction, createGame, legalFor, startHand,
} from '../engine/hand.js';
import { userView } from '../engine/views.js';
import { archiveTag } from '../engine/game-archive.js';
import { newDeck } from '../engine/cards.js';
import { applyModeDefaults, engineInitFlags, gtoEvalNotice, parseGameLoopArgs } from '../tools/game-loop.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../engine/cli.js');

function cashGame(overrides = {}) {
  const startStack = overrides.startStack ?? 5000;
  const blinds0 = overrides.blinds0 ?? [25, 50];
  return createGame({
    aiCount: overrides.aiCount ?? 2,
    startStack,
    blinds0,
    mode: 'cash-training',
    levelEvery: null,
    startStackBb: startStack / blinds0[1],
    handLimit: overrides.handLimit,
    names: overrides.names,
  });
}

function playFolds(state) {
  let current = startHand(state, { deck: newDeck() }).state;
  while (!legalFor(current).handOver) {
    const legal = legalFor(current);
    current = applyAction(current, legal.toAct, legal.canCheck ? 'check' : 'fold').state;
  }
  return current;
}

test('옵션 생략 시 mode 부재는 tournament로 해석하고 레벨이 오른다', () => {
  const st = createGame({ aiCount: 2, levelEvery: 8 });
  assert.equal(st.config.mode, undefined);
  assert.equal(st.config.levelEvery, 8);
  assert.equal(st.sessionNet, undefined);
  let current = st;
  for (let i = 0; i < 9; i += 1) {
    current = playFolds(current);
  }
  assert.equal(current.level, 1);
  assert.equal(current.gameOver, false);
});

test('tournament + levelEvery null 은 거부한다', () => {
  assert.throws(
    () => createGame({ aiCount: 2, levelEvery: null }),
    { code: 'BAD_CONFIG' },
  );
});

test('cash-training: 핸드 간 top-up, endStacks는 top-up 전, 종료 핸드는 no top-up', () => {
  let st = cashGame({ startStack: 5000, handLimit: 2 });
  st.button = 2;
  st = playFolds(st);
  assert.equal(st.hand, null);
  assert.equal(st.lastHand.endStacks.user != null, true);
  for (const seat of st.seats) assert.equal(seat.stack, 5000);
  const endBeforeTopup = st.lastHand.endStacks.user;
  assert.notEqual(endBeforeTopup, undefined);
  const netAfter1 = st.sessionNet.user;
  assert.equal(netAfter1, endBeforeTopup - 5000);
  assert.equal(st.stats.user.net, endBeforeTopup - (st.lastHand.startStacks.user));
  assert.equal(st.gameOver, false);

  st = playFolds(st);
  assert.equal(st.gameOver, true);
  assert.equal(st.result, 'completed');
  for (const seat of st.seats) {
    assert.equal(seat.stack, st.lastHand.endStacks[seat.playerId]);
  }
  assert.equal(st.handNo, 2);
});

test('handLimit=1 종료 핸드에는 top-up이 없다', () => {
  let st = cashGame({ handLimit: 1 });
  st.button = 2;
  st = playFolds(st);
  assert.equal(st.gameOver, true);
  assert.equal(st.result, 'completed');
  assert.equal(st.handNo, 1);
  for (const seat of st.seats) {
    assert.equal(seat.stack, st.lastHand.endStacks[seat.playerId]);
  }
});

test('handLimit 생략/null은 무한 세션이고 1>=null 함정에 빠지지 않는다', () => {
  let omitted = cashGame();
  omitted.button = 2;
  omitted = playFolds(omitted);
  assert.equal(omitted.gameOver, false);
  assert.equal(omitted.result, null);

  assert.throws(
    () => createGame({
      aiCount: 2, mode: 'cash-training', levelEvery: null, handLimit: 0,
    }),
    { code: 'BAD_CONFIG' },
  );
  assert.throws(
    () => createGame({
      aiCount: 2, mode: 'cash-training', levelEvery: null, handLimit: 1.5,
    }),
    { code: 'BAD_CONFIG' },
  );
});

test('startHand 방어선: handNo가 limit 이상이면 딜링 없이 completed 1회', () => {
  const st = cashGame({ handLimit: 1 });
  st.handNo = 1;
  st.gameOver = false;
  const beforeStacks = st.seats.map((s) => s.stack);
  const { state, events } = startHand(st, { deck: newDeck() });
  assert.equal(state.handNo, 1);
  assert.equal(state.hand, null);
  assert.equal(state.gameOver, true);
  assert.equal(state.result, 'completed');
  assert.deepEqual(state.seats.map((s) => s.stack), beforeStacks);
  assert.equal(events.filter((e) => e.type === 'game_over').length, 1);
  assert.equal(events.find((e) => e.type === 'game_over').result, 'completed');
  assert.equal(events.some((e) => e.type === 'hand_start'), false);
});

test('cash-training은 0스택이어도 탈락·win/lose 하지 않고 레벨이 0이다', () => {
  let st = cashGame({ startStack: 5000, aiCount: 2 });
  st.button = 2;
  st = startHand(st, { deck: newDeck() }).state;
  const toAct = legalFor(st).toAct;
  st = applyAction(st, toAct, 'fold').state;
  while (!legalFor(st).handOver) {
    const legal = legalFor(st);
    st = applyAction(st, legal.toAct, 'fold').state;
  }
  assert.equal(st.gameOver, false);
  assert.equal(st.result, null);
  assert.equal(st.level, 0);
  assert.equal(st.seats.every((s) => s.out === false), true);
  assert.equal(st.seats.every((s) => s.stack === 5000), true);
});

test('view는 cash일 때만 mode/handLimit/sessionNet을 노출한다', () => {
  const tourney = userView(createGame({ aiCount: 2 }));
  assert.equal('mode' in tourney, false);
  assert.equal('handLimit' in tourney, false);
  assert.equal('sessionNet' in tourney, false);

  let cash = cashGame({ handLimit: 10 });
  cash.button = 2;
  cash = playFolds(cash);
  const view = userView(cash);
  assert.equal(view.mode, 'cash-training');
  assert.equal(view.handLimit, 10);
  assert.equal(typeof view.sessionNet.user, 'number');
});

test('archiveTag는 completed를 인식한다', () => {
  assert.equal(archiveTag({ gameOver: true, result: 'completed' }), 'completed');
});

test('cli --mode/--stack-bb/--hands 와 tournament 전용 거절', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-cash-'));
  const run = (args) => {
    try {
      return {
        status: 0,
        json: JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--game-dir', dir], {
          encoding: 'utf8',
          timeout: 20000,
        }).trim()),
      };
    } catch (error) {
      const stdout = String(error.stdout ?? '');
      let json = null;
      try { json = JSON.parse(stdout.trim()); } catch { /* ignore */ }
      return { status: error.status ?? 1, json };
    }
  };
  const badTourney = run(['init', '--ai', '2', '--hands', '3']);
  assert.equal(badTourney.status, 2);
  const badLevel = run(['init', '--ai', '2', '--mode', 'cash-training', '--level-every', '8']);
  assert.equal(badLevel.status, 2);
  const ok = run(['init', '--ai', '2', '--mode', 'cash-training', '--stack-bb', '100', '--blinds', '50/100', '--hands', '2']);
  assert.equal(ok.status, 0);
  const viewed = run(['view', '--for', 'user']);
  assert.equal(viewed.json.mode, 'cash-training');
  assert.equal(viewed.json.handLimit, 2);
});

test('engineInitFlags는 bootstrap/prepared session 공통으로 mode·stack-bb·hands를 붙인다', () => {
  assert.deepEqual(
    engineInitFlags({
      stack: 900,
      levelEvery: 4,
      blinds: '15/30',
      mode: 'cash-training',
      stackBb: 100,
      hands: 50,
    }),
    [
      '--stack', '900', '--level-every', '4', '--blinds', '15/30',
      '--mode', 'cash-training', '--stack-bb', '100', '--hands', '50',
    ],
  );
  assert.deepEqual(engineInitFlags({}), []);
});

test('applyModeDefaults: cash-training --ai 생략은 5, 명시는 유지, 토너먼트는 그대로', () => {
  const cash = applyModeDefaults(parseGameLoopArgs(['--mode', 'cash-training', '--store-dir', '/tmp/x']));
  assert.equal(cash.ai, 5);
  const explicit = applyModeDefaults(parseGameLoopArgs([
    '--mode', 'cash-training', '--ai', '3', '--store-dir', '/tmp/x',
  ]));
  assert.equal(explicit.ai, 3);
  const tourney = applyModeDefaults(parseGameLoopArgs(['--store-dir', '/tmp/x']));
  assert.equal(tourney.ai, undefined);
});

test('gtoEvalNotice: cash-training만, 6-max 100BB가 아니면 문면', () => {
  assert.equal(gtoEvalNotice({}), null);
  assert.equal(gtoEvalNotice({ mode: 'tournament', aiCount: 3, startStackBb: 100 }), null);
  assert.equal(gtoEvalNotice({ mode: 'cash-training', aiCount: 5, startStackBb: 100 }), null);
  const four = gtoEvalNotice({ mode: 'cash-training', aiCount: 3, startStackBb: 100 });
  assert.match(four, /6-max 100BB/);
  assert.match(four, /4인/);
  const stack = gtoEvalNotice({ mode: 'cash-training', aiCount: 5, startStackBb: 50 });
  assert.match(stack, /startStackBb=50/);
});

test('parseGameLoopArgs는 --mode/--stack-bb/--hands를 읽는다', () => {
  const parsed = parseGameLoopArgs([
    '--store-dir', '/tmp/store', '--ai', '5',
    '--mode', 'cash-training', '--stack-bb', '100', '--blinds', '50/100', '--hands', '100',
  ]);
  assert.equal(parsed.mode, 'cash-training');
  assert.equal(parsed.stackBb, 100);
  assert.equal(parsed.hands, 100);
  assert.equal(parsed.blinds, '50/100');
});
