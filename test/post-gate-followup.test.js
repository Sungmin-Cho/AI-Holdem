import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePrivateEngineState } from '../publish-contract.js';
import { normalizeHand } from '../export/hand-normalizer.js';
import { validateCanonicalHand } from '../export/contracts.js';

// `engine/cli.js end --result abort`는 진행 중이던 핸드를 버린다: hand=null·gameOver=true·
// result='abort'로 두고 handNo는 건드리지 않으므로 lastHand.handNo가 handNo보다 하나 작다.
// 그 상태를 보안 술어가 거부하면 §6 롤백 절차의 "미해소 게시 해소"가 training annotation을
// 영원히 drain하지 못한다(exploit은 409, explanation은 500).
function abandonedHandState({ handNo, lastHandNo }) {
  const record = (no) => ({
    handNo: no,
    actions: [{
      playerId: 'p1', action: 'raise', amount: 250, street: 'preflop', currentBet: 100,
    }],
    holes: { user: ['Ah', 'Kd'], p1: ['Qs', 'Qc'] },
    startStacks: { user: 5000, p1: 5000 },
    endStacks: { user: 4750, p1: 5250 },
    board: [],
    pots: [],
  });
  return {
    schemaVersion: 1,
    stateVersion: 9,
    config: {},
    sessionToken: 'token',
    seats: [{ playerId: 'user' }, { playerId: 'p1' }],
    phase: 'idle',
    handNo,
    hand: null,
    lastHand: lastHandNo === null ? null : record(lastHandNo),
    gameOver: true,
    result: 'abort',
  };
}

test('mid-hand abort leaves a state the security predicate still accepts', () => {
  const aborted = abandonedHandState({ handNo: 8, lastHandNo: 7 });
  assert.equal(validatePrivateEngineState(aborted).gameOver, true);
});

test('abort during the first hand is accepted with no completed hand at all', () => {
  const aborted = abandonedHandState({ handNo: 1, lastHandNo: null });
  assert.equal(validatePrivateEngineState(aborted).gameOver, true);
});

test('a non-abort terminal state still requires lastHand to match handNo', () => {
  const forged = { ...abandonedHandState({ handNo: 8, lastHandNo: 7 }), result: 'completed' };
  assert.throws(() => validatePrivateEngineState(forged), { code: 'PRIVATE_LITERAL_INVALID' });
});

test('abort does not excuse a lastHand that runs ahead of handNo', () => {
  const forged = abandonedHandState({ handNo: 7, lastHandNo: 8 });
  assert.throws(() => validatePrivateEngineState(forged), { code: 'PRIVATE_LITERAL_INVALID' });
});

// legacy archive의 `actions`가 배열이 아니면 정규화기가 `[]`로 세탁해 계약이 `ok`를 준다.
// 그 결과 블라인드와 쇼다운만 있고 액션 줄이 하나도 없는 PokerStars 기록이 나간다.
function legacyHand(actions) {
  return {
    handNo: 1,
    button: 'p1',
    blinds: [50, 100],
    startStacks: { user: 5000, p1: 5000 },
    endStacks: { user: 5000, p1: 5000 },
    posts: [{ playerId: 'user', amount: 50, allIn: false }],
    uncalledReturns: {},
    actions,
    holes: {},
    board: [],
    pots: [],
  };
}

for (const [label, actions] of [['null', null], ['undefined', undefined], ['string', 'x'], ['object', {}]]) {
  test(`legacy archive with ${label} actions is unsupported, not ok`, () => {
    const hand = normalizeHand(legacyHand(actions));
    const verdict = validateCanonicalHand(hand);
    assert.equal(verdict.exportStatus, 'unsupported');
    assert.match(verdict.reason, /actions/);
  });
}

test('a hand that genuinely has no actions still exports', () => {
  const verdict = validateCanonicalHand(normalizeHand(legacyHand([])));
  assert.equal(verdict.exportStatus, 'ok');
});
