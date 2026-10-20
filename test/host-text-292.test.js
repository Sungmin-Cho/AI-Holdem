import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertHostText,
  hostReviewText,
  participantSessionOf,
  rosterListOf,
} from '../publish-contract.js';
import { REVIEW_COACH_HEADING, REVIEW_SECTION_WITHHELD } from '../shared/multiplayer-publish.js';

// #292 shared rules: the coach note's hand is required (D), a session is placed by the roster
// and the engine's seats (C), and a review's old coach summary is withheld whole (A).

const SEATS = [{ playerId: 'user', kind: 'human' }, { playerId: 'h1', kind: 'human' }, { playerId: 'p1', kind: 'ai' }];
const records = {
  1: { handNo: 1, holes: { user: ['Ah', 'Kh'], h1: ['Th', '2d'], p1: ['9s', '9c'] }, seats: SEATS },
  // h1 showed down hand 2: those cards are public.
  2: { handNo: 2, holes: { user: ['Qs', 'Qd'], h1: ['7c', '7d'], p1: ['3s', '4s'] }, showdown: { reveals: [{ playerId: 'h1' }] }, seats: SEATS },
};
const lookup = (handNo) => records[handNo] ?? null;

test('#292 D: 코치 노트는 정수 handNo가 있어야 판정을 통과한다', () => {
  assert.doesNotThrow(() => assertHostText({ coach: [{ handNo: 1, text: '프리플랍 콜 범위를 다시 봅니다.' }] }, lookup));
  assert.throws(() => assertHostText({ coach: [{ handNo: 1, text: '상대는 10♥를 버렸다' }] }, lookup), { code: 'FORBIDDEN_LITERAL' });
  for (const handNo of [undefined, '1', null, 1.5, Number.NaN]) {
    const note = { text: '프리플랍 콜 범위를 다시 봅니다.' };
    if (handNo !== undefined) note.handNo = handNo;
    assert.throws(() => assertHostText({ coach: [note] }, lookup), { code: 'FORBIDDEN_LITERAL_UNAVAILABLE' }, String(handNo));
  }
  // A hand no record names is unavailable too, however clean the text.
  assert.throws(() => assertHostText({ coach: [{ handNo: 9, text: '깨끗한 노트' }] }, lookup), { code: 'FORBIDDEN_LITERAL_UNAVAILABLE' });
  // The unavailable note the coach control queues is always judged clean.
  assert.doesNotThrow(() => assertHostText({ coach: [{ handNo: 1, text: '이 핸드의 코치 응답을 생성하지 못했습니다.', unavailable: true }] }, lookup));
  // A body without coach notes, or with training rows that name no hand, is unchanged.
  assert.doesNotThrow(() => assertHostText({ training: [{ evaluationId: 'x', reason: '7c2d' }] }, lookup));
});

test('#292 C: participantSessionOf는 로스터가 정하되 엔진 좌석과 어긋나면 판별 불가, 로스터가 없거나 못 읽으면 좌석, 둘 다 없을 때만 solo', () => {
  const soloRoster = [{ playerId: 'user', kind: 'human' }, { playerId: 'p1', kind: 'ai' }];
  const multiRoster = [{ playerId: 'user', kind: 'human' }, { playerId: 'h1', kind: 'human' }];
  const humanOnly = [{ playerId: 'user', kind: 'human' }, { playerId: 'h1', kind: 'human' }, { playerId: 'h2', kind: 'human' }];
  const soloSeats = [{ playerId: 'user', kind: 'human' }, { playerId: 'p1', kind: 'ai' }];
  const rows = [
    // [roster, seats, expected]
    [soloRoster, undefined, 'solo'],
    [soloRoster, soloSeats, 'solo'],
    [soloRoster, null, 'solo'], // seats that cannot be read leave the roster to decide
    [soloRoster, SEATS, 'unknown'], // the seats contradict the roster: neither decides
    [multiRoster, soloSeats, 'unknown'],
    [[], SEATS, 'unknown'],
    [multiRoster, undefined, 'multi'],
    [multiRoster, SEATS, 'multi'],
    [humanOnly, null, 'multi'],
    [{ players: multiRoster }, undefined, 'multi'],
    [{ players: soloRoster }, SEATS, 'unknown'],
    [undefined, undefined, 'solo'], // a bare relay directory
    [undefined, soloSeats, 'solo'],
    [undefined, SEATS, 'multi'],
    [undefined, null, 'unknown'],
    [null, undefined, 'unknown'],
    [null, null, 'unknown'],
    [null, soloSeats, 'solo'],
    [null, SEATS, 'multi'],
    [{}, undefined, 'unknown'], // the wrong shape is unreadable, not an empty roster
    [{ players: 'x' }, SEATS, 'multi'],
    // A row that is not a player makes the roster unreadable: the seats decide, or nothing does.
    [[null], undefined, 'unknown'],
    [[{}], null, 'unknown'],
    [[{ playerId: 'user' }, { playerId: 'user' }], undefined, 'unknown'],
    [[{ playerId: 'user', kind: 'human' }, { playerId: '' }], soloSeats, 'solo'],
    [[null], SEATS, 'multi'],
  ];
  for (const [roster, seats, expected] of rows) {
    assert.equal(participantSessionOf({ roster, seats }), expected, JSON.stringify({ roster, seats }));
  }
  assert.deepEqual(rosterListOf({ players: multiRoster }), multiRoster);
  assert.equal(rosterListOf({ players: {} }), null);
  assert.equal(rosterListOf(null), null);
});

function machineReview(coachLines, heading = '### 핸드별 코치 노트 요약') {
  return [
    '## 내 성향 통계', '', '- 플레이한 핸드: 2핸드', '',
    '## 결정적 핸드 2~3개 리플레이', '',
    '### 칩 손실이 컸던 핸드', '', '- 핸드 1: 120칩 손실. Th 보드에서 콜', '',
    heading, '', ...coachLines, '',
    '## 각 AI의 실제 아키타입 공개 + 읽기 평가', '', '- 상대 1 — 관찰 기록',
  ].join('\n');
}

test('#292 A: 구버전 코치 노트 요약 절은 카드와 무관하게 통째로 가리고 나머지는 그대로 둔다', () => {
  const review = machineReview(['- 핸드 1: 상대는 10♥를 버렸다', '- 핸드 1: 내 AhKh로 3벳했다', '- 핸드 2: 7c7d에 졌다']);
  const shown = hostReviewText(review);
  const lines = shown.split('\n');
  assert.equal(lines.filter((line) => line === REVIEW_SECTION_WITHHELD).length, 1);
  for (const quoted of ['10♥', 'AhKh로', '7c7d']) assert.equal(shown.includes(quoted), false, quoted);
  // The heading and everything outside the section stay as stored.
  assert.ok(lines.includes('### 핸드별 코치 노트 요약'));
  assert.ok(lines.includes('- 핸드 1: 120칩 손실. Th 보드에서 콜'));
  assert.ok(lines.includes('- 상대 1 — 관찰 기록'));
  // Every old section is withheld, each by one line; a blank line keeps its place.
  const twice = `${review}\n### 핸드별 코치 노트 요약\n\n- 핸드 3: 다른 노트`;
  assert.equal(hostReviewText(twice).split('\n').filter((line) => line === REVIEW_SECTION_WITHHELD).length, 2);
});

test('#292 A: 가림은 리뷰의 형식만으로 정해진다 — 같은 자리의 맞는 추측과 틀린 추측이 같게 보인다', () => {
  // An LLM text that copies the old heading only hides its own section, whatever it guesses.
  const right = machineReview(['- 핸드 1: 상대에게 10♥가 있었을 수 있다']);
  const wrong = machineReview(['- 핸드 1: 상대에게 9♣가 있었을 수 있다']);
  assert.equal(hostReviewText(right), hostReviewText(wrong));
  // The current section heading is shown as written: its lines were judged when it was made.
  const current = machineReview(['- 핸드 1: 내 AhKh로 3벳했다'], REVIEW_COACH_HEADING);
  assert.equal(hostReviewText(current), current);
  // A review without the old section, cards and all, is unchanged.
  const llm = '## 내 성향 통계\n상대 h1은 10♥를 가졌을 수 있다\n## 다음 게임에서 연습할 것\n- 핸드 1: 2d를 주목';
  assert.equal(hostReviewText(llm), llm);
});

test('#292 A: 절은 다음 markdown 제목에서 끝나고 강등된 제목은 절이 아니다', () => {
  const demoted = '#### 핸드별 코치 노트 요약\n- 핸드 1: 10♥\n### 핸드별 코치 노트 요약\n- 핸드 1: 10♥\n#3벳 메모\n## 다음\n- 핸드 1: 10♥';
  const lines = hostReviewText(demoted).split('\n');
  assert.deepEqual(lines, [
    '#### 핸드별 코치 노트 요약', '- 핸드 1: 10♥',
    '### 핸드별 코치 노트 요약', REVIEW_SECTION_WITHHELD,
    '## 다음', '- 핸드 1: 10♥',
  ]);
  const crlf = machineReview(['- 핸드 1: 상대는 10♥를 버렸다']).replace(/\n/g, '\r\n');
  assert.equal(hostReviewText(crlf).includes('10♥'), false);
  assert.equal(hostReviewText(undefined), undefined);
});
