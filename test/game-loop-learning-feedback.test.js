import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  makeCoachAdapter,
  readJson,
  tmpGame,
  seedFinishedGame,
  expandFinishedGameToTwoHands,
  finalizingLoop,
  setupCoachHand,
  waitForCoachNote,
  startRun,
  stopRun,
} from './helpers/game-loop-fixtures.mjs';

// Learning calibration D9/D10: coaching keeps its substance (sanitized, not
// discarded), is grounded in engine-computed facts, and a synthesizer failure
// still leaves the outcome-blind process evaluation in the review.

test('D10 a synthesizer failure keeps the outcome-blind evaluator text and engine checks', { timeout: 30_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  expandFinishedGameToTwoHands(gameDir);
  const upper = makeCoachAdapter({
    synthesizerRounds: [{ raw: 'This is the optimal choice.' }, { raw: 'GTO 정답은 콜입니다.' }],
  });
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, { upper, stateOverrides: { handNo: 2 } });
  await loop.resume();
  assert.equal((await loop.run()).phase, 'done');
  assert.equal(upper.synthesizerStarts.length, 2);
  const review = readJson(path.join(gameDir, 'ui-snapshot.json')).review;
  assert.match(review, /LLM 설명을 제공할 수 없습니다/);
  assert.match(review, /### 과정 평가\(결과 공개 전 작성\)/);
  assert.match(review, /공개 정보 기준 과정 평가는 안정적이었습니다/);
  assert.match(review, /### 결정 점검\(엔진 계산\)/);
  assert.match(review, /참고 범위/);
  assert.doesNotMatch(review, /optimal choice|GTO 정답/);
});

test('D10 the evaluator receives engine decision facts for the user decisions', { timeout: 30_000 }, async (t) => {
  const gameDir = tmpGame();
  const init = await seedFinishedGame(gameDir);
  expandFinishedGameToTwoHands(gameDir);
  const upper = makeCoachAdapter();
  const { loop } = finalizingLoop(t, gameDir, init.sessionToken, { upper, stateOverrides: { handNo: 2 } });
  await loop.resume();
  assert.equal((await loop.run()).phase, 'done');
  const prompt = upper.evaluatorStarts[0].prompt;
  assert.match(prompt, /decision facts \(엔진 계산/);
  assert.match(prompt, /핸드 1 d-1-preflop-\d+: 팟 [\d.]+BB/);
  assert.match(prompt, /유효 스택 [\d.]+BB/);
});

test('D9/D10 the coach prompt is grounded in facts and an out-of-bounds sentence is removed before sealing', { timeout: 20_000 }, async (t) => {
  const upper = makeCoachAdapter({
    rounds: [{ raw: JSON.stringify({ handNo: 1, text: '체크 후 레이즈는 팟을 키웠습니다. GTO 정답은 콜입니다. 기대값이 낮은 라인은 아닙니다.' }) }],
  });
  const { gameDir, loop } = await setupCoachHand(t, { upper });
  const running = startRun(loop);
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  assert.match(upper.prompts[0], /결정 사실 카드\(엔진 계산/);
  assert.match(upper.prompts[0], /d-1-[a-z]+-\d+: 팟 [\d.]+BB/);
  assert.match(upper.prompts[0], /가장 비싼\(결정적인\) 결정 1개/);
  assert.doesNotMatch(upper.prompts[0], /무난한 폴드/);
  assert.equal(note.text, '체크 후 레이즈는 팟을 키웠습니다. 기대값이 낮은 라인은 아닙니다.');
});
