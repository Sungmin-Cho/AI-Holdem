import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate7, compareScore } from '../engine/evaluator.js';

const s = (h) => evaluate7(h.split(' ')).score;

test('휠 스트레이트(A-2-3-4-5)는 5하이', () => {
  const wheel = s('As 2c 3d 4h 5s Kd Qc');
  const sixHigh = s('2s 3c 4d 5h 6s Kd Qc');
  assert.equal(compareScore(sixHigh, wheel), 1);
});

test('스틸 휠(A-5 스트레이트 플러시)', () => {
  const steel = s('As 2s 3s 4s 5s Kd Qc');
  assert.equal(steel[0], 8);
});

test('플러시는 스트레이트를 이긴다', () => {
  const flush = s('As Ks 9s 5s 2s 3d 4d');
  const straight = s('9c 8d 7h 6s 5c Ad Kd');
  assert.equal(compareScore(flush, straight), 1);
});

test('킥커 비교: 같은 원페어면 킥커 순서', () => {
  const a = s('As Ad Kc 9h 7s 4d 2c');
  const b = s('Ah Ac Qd 9c 7d 4s 2h');
  assert.equal(compareScore(a, b), 1);
});

test('보드 플레이 동점(스플릿)', () => {
  const board = 'As Ks Qs Js Ts';
  const a = s(`${board} 2c 3d`);
  const b = s(`${board} 7h 8h`);
  assert.equal(compareScore(a, b), 0);
});

test('로열', () => {
  const score = s('As Ks Qs Js Ts 2c 3d');
  assert.equal(score[0], 8);
  assert.equal(score[1], 14);
});

test('포카드+킥커', () => {
  const a = s('Ac Ad Ah As Kc Qd 2s');
  const b = s('Ac Ad Ah As Qc Jd 2s');
  assert.equal(compareScore(a, b), 1);
});

test('풀하우스 조합(777KK vs 777QQ)', () => {
  const sevensAndKings = s('7c 7d 7h Ks Kd 2s 3c');
  const sevensAndQueens = s('7c 7d 7h Qs Qd 2s 3c');
  assert.equal(compareScore(sevensAndKings, sevensAndQueens), 1);
});

test('투페어 킥커', () => {
  const a = s('Ac Ad Kc Kd Qs 2h 3h');
  const b = s('Ac Ad Kc Kd Js 2h 3h');
  assert.equal(compareScore(a, b), 1);
});

test('6-7장 중 최적 5장 선택', () => {
  const score = s('2c 2d 2h 5s 5d 5c Ah');
  assert.deepEqual(score.slice(0, 3), [6, 5, 2]);
});

test('스트레이트 중복 랭크', () => {
  const score = s('9c 9d 8h 7s 6c 5d Ah');
  assert.deepEqual(score, [4, 9]);
});

test('트립스', () => {
  const score = s('Ac Ad Ah 9s 7d 4c 2h');
  assert.equal(score[0], 3);
});

test('원페어 vs 하이카드', () => {
  const pair = s('Ac Ad Kc Qd 9s 7h 4c');
  const highCard = s('Ac Kd Qc Jd 9s 7h 4c');
  assert.equal(compareScore(pair, highCard), 1);
});

test('하이카드 킥커', () => {
  const a = s('Ac Kd Qc Jd 9s 7h 4c');
  const b = s('Ac Kd Qc Jd 8s 7h 4c');
  assert.equal(compareScore(a, b), 1);
});
