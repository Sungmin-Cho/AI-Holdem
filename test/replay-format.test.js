import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayRecord } from '../shared/hand-replay.js';
import { createActionController } from '../server/public/action-controller.js';
import './helpers/owned-fixtures.mjs';

const FORMAT_PATH = new URL('../server/public/replay-format.js', import.meta.url);
const formatMod = fs.existsSync(FORMAT_PATH) ? await import(FORMAT_PATH) : {};
const formatReplay = formatMod.formatReplay;
const actionVerbs = formatMod.actionVerbs;
const REPLAY_NOT_COMPLETED = formatMod.REPLAY_NOT_COMPLETED;
const REPLAY_UNAVAILABLE = formatMod.REPLAY_UNAVAILABLE;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function record(overrides = {}) {
  return {
    handNo: 1,
    level: 0,
    blinds: [50, 100],
    button: 'p1',
    board: ['Ah', '7c', '2d'],
    folded: ['p2'],
    allIn: [],
    holes: { user: ['As', 'Td'], p1: ['Kh', 'Qc'], p2: ['2h', '3d'] },
    positions: { user: 'BB', p1: 'BTN', p2: 'SB' },
    showdown: {
      reveals: [
        { playerId: 'user', cards: ['As', 'Td'], handName: '원페어' },
        { playerId: 'p1', cards: ['Kh', 'Qc'], handName: '하이 카드' },
      ],
      mucks: ['p2'],
    },
    pots: [{
      potIndex: 0,
      amount: 200,
      eligible: ['user', 'p1'],
      winners: [{ playerId: 'user', share: 200 }],
    }],
    startStacks: { user: 10_000, p1: 10_000, p2: 10_000 },
    endStacks: { user: 10_200, p1: 9_800, p2: 10_000 },
    posts: [],
    uncalledReturns: {},
    actions: [
      {
        decisionId: 'd-1-preflop-0', playerId: 'user', action: 'raise', amount: 250,
        street: 'preflop', potTotal: 150, note: 'steal',
      },
      {
        decisionId: 'd-1-preflop-1', playerId: 'p1', action: 'call',
        street: 'preflop', potTotal: 400, reason: 'call wide',
      },
      {
        playerId: 'p2', action: 'fold', street: 'preflop', potTotal: 400, reason: 'secret',
      },
      {
        playerId: 'p1', action: 'raise', amount: 100, street: 'flop', potTotal: 400,
      },
      {
        decisionId: 'd-1-flop-0', playerId: 'user', action: 'raise', amount: 300,
        street: 'flop', potTotal: 500, note: 'value',
      },
    ],
    decisions: [{
      actorId: 'user',
      decisionId: 'd-1-preflop-0',
      street: 'preflop',
      position: 'BB',
      holeCards: ['As', 'Td'],
      potBefore: 150,
      toCall: 100,
      effectiveStack: 10_000,
      forced: false,
      chosenAction: { action: 'raise', amount: 250 },
    }],
    ...overrides,
  };
}

function rowsOf(view) {
  return (view.streets ?? []).flatMap((street) => street.rows ?? []);
}

const NAMES = { user: '나', p1: '이서연', p2: '김민준' };

test('replay-format.js exports formatReplay and marker copy', () => {
  assert.equal(typeof formatReplay, 'function');
  assert.equal(typeof actionVerbs, 'function');
  assert.equal(typeof REPLAY_NOT_COMPLETED, 'string');
  assert.equal(typeof REPLAY_UNAVAILABLE, 'string');
});

test('formatReplay all: cards, six reason phrases, note, bet/raise verbs', () => {
  const replay = replayRecord(record({
    actions: [
      {
        decisionId: 'd-1-preflop-0', playerId: 'user', action: 'raise', amount: 250,
        street: 'preflop', potTotal: 150, note: 'steal',
      },
      {
        playerId: 'p1', action: 'call', street: 'preflop', potTotal: 400, reason: 'call wide',
      },
      {
        playerId: 'p2', action: 'fold', street: 'preflop', potTotal: 400,
        policyId: 'tag-v2',
      },
      {
        playerId: 'p3', action: 'check', street: 'flop', potTotal: 400, forced: true,
      },
      {
        playerId: 'p4', action: 'check', street: 'flop', potTotal: 400,
      },
      {
        playerId: 'p1', action: 'raise', amount: 100, street: 'flop', potTotal: 400,
      },
      {
        decisionId: 'd-1-flop-0', playerId: 'user', action: 'raise', amount: 300,
        street: 'flop', potTotal: 500,
      },
    ],
    holes: {
      user: ['As', 'Td'], p1: ['Kh', 'Qc'], p2: ['2h', '3d'], p3: ['9c', '8d'], p4: ['7s', '6s'],
    },
    positions: { user: 'BB', p1: 'BTN', p2: 'SB', p3: 'UTG', p4: 'MP' },
  }), { reveal: 'all' });
  const view = formatReplay(replay, { names: NAMES });
  assert.equal(view.kind, 'replay');
  assert.equal(view.header.handNo, 1);
  assert.deepEqual(view.header.blinds, [50, 100]);
  assert.deepEqual(view.header.board, ['Ah', '7c', '2d']);
  assert.equal(view.header.disclaimer, '핸드 종료 후 복기 공개(실전에서는 비공개 정보)');
  assert.match(view.header.reliability, /사후 설명/);
  assert.match(view.header.reliability, /의도|신뢰/);
  assert.ok(view.header.winners.includes('나'));

  const rows = rowsOf(view);
  const user = rows.find((row) => row.playerId === 'user' && row.street === 'preflop');
  assert.equal(user.name, '나');
  assert.equal(user.position, 'BB');
  assert.equal(user.verb, 'raise');
  assert.equal(user.amount, 250);
  assert.equal(user.pot, 150);
  assert.deepEqual(user.cards, ['As', 'Td']);
  assert.equal(user.note, 'steal');
  assert.equal(user.noteText, '내 메모: steal');
  assert.equal(user.reasonText, '');

  const model = rows.find((row) => row.playerId === 'p1' && row.street === 'preflop');
  assert.equal(model.reasonKind, 'model');
  assert.equal(model.reasonText, '모델이 밝힌 사유: call wide');
  assert.doesNotMatch(model.reasonText, /코치/);

  const policy = rows.find((row) => row.playerId === 'p2');
  assert.equal(policy.reasonKind, 'policy');
  assert.equal(policy.reasonText, '정책 플레이어 — 빈도표에서 샘플된 결정, 사유 없음. 정책 정체는 종합 리뷰에서 공개');
  assert.deepEqual(policy.cards, ['2h', '3d']);

  const forced = rows.find((row) => row.playerId === 'p3');
  assert.equal(forced.reasonKind, 'forced');
  assert.equal(forced.reasonText, '워치독 강제');

  const none = rows.find((row) => row.playerId === 'p4');
  assert.equal(none.reasonKind, 'none');
  assert.equal(none.reasonText, '사유 없음');

  const flopBet = rows.find((row) => row.playerId === 'p1' && row.street === 'flop');
  assert.equal(flopBet.verb, 'bet');
  const flopRaise = rows.find((row) => row.playerId === 'user' && row.street === 'flop');
  assert.equal(flopRaise.verb, 'raise');
});

test('formatReplay showdown hides unrevealed cards and uses hidden copy', () => {
  const replay = replayRecord(record(), { reveal: 'showdown' });
  const view = formatReplay(replay, { names: NAMES });
  const rows = rowsOf(view);
  const p2 = rows.find((row) => row.playerId === 'p2');
  assert.equal(p2.reasonKind, 'hidden');
  assert.equal(p2.reasonText, '비공개(복기 공개 범위: 쇼다운)');
  assert.equal(p2.cards, null);
  assert.equal(JSON.stringify(view).includes('2h'), false);
  assert.equal(JSON.stringify(view).includes('secret'), false);
  const user = rows.find((row) => row.playerId === 'user');
  assert.deepEqual(user.cards, ['As', 'Td']);
  const p1 = rows.find((row) => row.playerId === 'p1');
  assert.deepEqual(p1.cards, ['Kh', 'Qc']);
});

test('formatReplay coach 3-line status: ready, pending, unavailable', () => {
  const replay = replayRecord(record(), { reveal: 'all' });
  const ready = formatReplay(replay, {
    names: NAMES,
    coachNote: {
      handNo: 1,
      text: '프리플랍 레이즈는 무난했습니다.',
      decisions: [{
        decisionId: 'd-1-preflop-0',
        why: '블라인드 스틸 자리입니다.',
        outcome: '콜을 받고 에이스가 맞았습니다.',
        alternative: '더 크게 열어 폴드를 유도하세요.',
      }],
    },
  });
  const readyUser = rowsOf(ready).find((row) => row.decisionId === 'd-1-preflop-0');
  assert.equal(readyUser.coach.status, 'ready');
  assert.equal(readyUser.coach.why, '블라인드 스틸 자리입니다.');
  assert.equal(readyUser.coach.outcome, '콜을 받고 에이스가 맞았습니다.');
  assert.equal(readyUser.coach.alternative, '더 크게 열어 폴드를 유도하세요.');
  assert.equal(ready.coachSummary, '프리플랍 레이즈는 무난했습니다.');

  const pending = formatReplay(replay, { names: NAMES });
  const pendingUser = rowsOf(pending).find((row) => row.decisionId === 'd-1-preflop-0');
  assert.equal(pendingUser.coach.status, 'pending');
  assert.equal(pendingUser.coach.message, '코치 피드백 대기 중');

  const unavailable = formatReplay(replay, {
    names: NAMES,
    coachNote: { handNo: 1, text: '생성 실패', unavailable: true },
  });
  const down = rowsOf(unavailable).find((row) => row.decisionId === 'd-1-preflop-0');
  assert.equal(down.coach.status, 'unavailable');
  assert.equal(down.coach.message, '코치 피드백 불가');

  const arrivedEmpty = formatReplay(replay, {
    names: NAMES,
    coachNote: { handNo: 1, text: '요약만 있습니다.', decisions: [] },
  });
  const emptyUser = rowsOf(arrivedEmpty).find((row) => row.decisionId === 'd-1-preflop-0');
  assert.equal(emptyUser.coach, null);
  assert.equal(arrivedEmpty.coachSummary, '요약만 있습니다.');

  const arrivedPartial = rowsOf(ready).find((row) => row.decisionId === 'd-1-flop-0');
  assert.equal(arrivedPartial.coach, null);
});

test('formatReplay matches a study card by decisionId', () => {
  const replay = replayRecord(record(), { reveal: 'all' });
  const view = formatReplay(replay, {
    names: NAMES,
    trainingItems: [
      { decisionId: 'd-other', evaluationId: 'e-other', handNo: 1 },
      { decisionId: 'd-1-preflop-0', evaluationId: 'e-1', handNo: 1 },
    ],
  });
  const user = rowsOf(view).find((row) => row.decisionId === 'd-1-preflop-0');
  assert.equal(user.study.decisionId, 'd-1-preflop-0');
  assert.equal(user.study.evaluationId, 'e-1');
  const p1 = rowsOf(view).find((row) => row.playerId === 'p1');
  assert.equal(p1.study, null);
});

test('formatReplay markers use REPLAY_NOT_COMPLETED and REPLAY_UNAVAILABLE copy', () => {
  const missing = formatReplay({ handNo: 4, unavailable: true, reason: 'REPLAY_NOT_COMPLETED' });
  assert.equal(missing.kind, 'marker');
  assert.equal(missing.reason, 'REPLAY_NOT_COMPLETED');
  assert.equal(missing.message, REPLAY_NOT_COMPLETED);
  assert.match(missing.message, /끝나지 않았|아직/);

  const broken = formatReplay({ handNo: 5, unavailable: true, reason: 'REPLAY_UNAVAILABLE' });
  assert.equal(broken.kind, 'marker');
  assert.equal(broken.reason, 'REPLAY_UNAVAILABLE');
  assert.equal(broken.message, REPLAY_UNAVAILABLE);
  assert.match(broken.message, /불러올 수 없|할 수 없/);
});

test('actionVerbs treats a first postflop raise as a bet', () => {
  const verbs = actionVerbs([
    { type: 'hand_start', handNo: 1 },
    { type: 'action', action: 'raise', amount: 250, street: 'preflop' },
    { type: 'street', street: 'flop' },
    { type: 'action', action: 'raise', amount: 100, street: 'flop' },
    { type: 'action', action: 'raise', amount: 300, street: 'flop' },
  ]);
  const items = [...verbs.keys()];
  assert.equal(verbs.get(items[0]), 'raise');
  assert.equal(verbs.get(items[1]), 'bet');
  assert.equal(verbs.get(items[2]), 'raise');
});

test('UI markup, overlay, note, and handReplays wiring are present', () => {
  const html = read('server/public/index.html');
  assert.match(html, /id="intent-note"/);
  assert.match(html, /id="intent-note"[^>]*maxlength="160"|maxlength="160"[^>]*id="intent-note"/);
  assert.match(html, /id="replay-overlay"/);

  const app = read('server/public/app.js');
  assert.equal(app.includes("case 'talk'"), false);
  assert.match(app, /item\.type === 'talk'\) continue/);
  assert.match(app, /case 'narration'/);
  assert.match(app, /handReplays/);
  assert.match(app, /from '\.\/replay-format\.js'/);
  assert.match(app, /intent-note/);
  assert.match(app, /replay-overlay/);
  const handStart = app.slice(app.indexOf("case 'hand_start'"), app.indexOf("case 'level_up'"));
  assert.match(handStart, /복기/);
  const post = app.slice(app.indexOf('postAction:'), app.indexOf('onSnapshot:'));
  assert.match(post, /note/);
  assert.doesNotMatch(app, /hands\/hand-/);
  assert.doesNotMatch(app, /\/api\/replay/);
  assert.doesNotMatch(app, /selectHandRecord/);

  const css = read('server/public/style.css');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.equal((css.match(/\[hidden\]\s*\{\s*display:\s*none\s*!important/g) ?? []).length >= 1, true);
  assert.match(css, /\.replay-/);
  const replayCss = css.split('.replay-').slice(1).join('.replay-');
  assert.match(replayCss, /var\(--tw\)/);
  assert.match(css, /\.replay-card\s*\{[^}]*--ch:\s*calc\(var\(--tw\)/s);
  assert.match(css, /\.replay-card \.mini-card\s*\{[^}]*font-size:\s*var\(--ch\)/s);
  assert.match(css, /\.replay-card \.mini-suit\s*\{[^}]*var\(--c[hw]\)/s);

  const decisionReset = app.slice(
    app.indexOf('legal.decisionId !== lastDecisionId'),
    app.indexOf('legal.decisionId !== lastDecisionId') + 500,
  );
  assert.match(decisionReset, /intent-note/);
  assert.match(decisionReset, /\.value\s*=\s*['"]{2}/);
});

test('H10 documents replay reveal, notes, and server recompute', () => {
  const skill = read('.agents/skills/start-game/SKILL.md');
  assert.match(skill, /핸드 진행 중.*상대 홀카드·결정 사유·정책 필드/);
  assert.match(skill, /핸드 종료 후.*showdownPolicy/);
  assert.match(skill, /replayReveal/);
  assert.match(skill, /복기 내용은 서버가 아카이브에서 재계산/);
  assert.match(skill, /상대 LLM 플레이어는 복기 정보를 받지 않는다/);
  assert.match(skill, /아키타입·정책 정체는 종합 리뷰까지 비공개/);
  assert.match(skill, /의도 메모|복기 뷰/);

  const arch = read('ARCHITECTURE.md');
  assert.match(arch, /shared\/free-text\.js/);
  assert.match(arch, /shared\/hand-replay\.js/);
  assert.match(arch, /server\/public\/replay-format\.js/);
  assert.match(arch, /읽기 전용.*복기 재계산|복기 재계산.*읽기 전용/);
  assert.match(arch, /복기 트리거/);
  assert.match(arch, /트리거의 `handNo`는 선택자/);
  assert.match(arch, /reason.*note.*forced.*positions.*SAFE_ACTION_KEYS/);
  assert.match(arch, /canonicalPayloadJson/);
  assert.match(arch, /publish-contract\.js.*re-export|re-export.*publish-contract\.js/);
  assert.match(arch, /표식|handReplay/);

  const readme = read('README.md');
  assert.match(readme, /--showdown-policy open\|standard/);
  assert.match(readme, /--replay-reveal all\|showdown/);
  assert.match(readme, /복기 뷰/);
  assert.match(readme, /의도 메모/);
  assert.match(readme, /export는 쇼다운 카드만|쇼다운 카드만/);

  const agents = read('AGENTS.md');
  assert.match(agents, /--showdown-policy open\|standard/);
  assert.match(agents, /--replay-reveal all\|showdown/);
  assert.match(agents, /복기 뷰/);
  assert.match(agents, /의도 메모/);
  assert.match(agents, /export는 쇼다운 카드만/);
});

test('action-controller capture includes string note and excludes non-string', async () => {
  const legal = { decisionId: 'd-1-preflop-1', potTotal: 150, callAmount: 50, minRaiseTo: 100, maxRaiseTo: 1000, canRaise: true };
  function make(options = {}) {
    const values = options.values ?? new Map();
    const sent = [];
    const controller = createActionController({
      gameEpoch: 'game-a',
      storage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
      uuid: () => '00000000-0000-4000-8000-000000000001',
      timeoutMs: 15,
      postAction: async (body) => { sent.push(body); return { ok: true }; },
      getSnapshot: async () => ({ gameEpoch: 'game-a', view: { legal, gameOver: false } }),
      getStatus: async () => ({ ok: true, decisionId: legal.decisionId, requestId: null, phase: 'unreceived' }),
    });
    return { controller, values, sent, snapshot: { gameEpoch: 'game-a', view: { legal, gameOver: false } } };
  }

  const stringNote = make();
  await stringNote.controller.connect(stringNote.snapshot);
  await stringNote.controller.send('call', undefined, 'steal the blinds');
  assert.equal(stringNote.sent[0].note, 'steal the blinds');
  assert.equal(JSON.parse([...stringNote.values.values()][0]).note, 'steal the blinds');

  const numberNote = make();
  await numberNote.controller.connect(numberNote.snapshot);
  await numberNote.controller.send('call', undefined, 12);
  assert.equal('note' in numberNote.sent[0], false);

  const objectNote = make();
  await objectNote.controller.connect(objectNote.snapshot);
  await objectNote.controller.send('call', undefined, { text: 'nope' });
  assert.equal('note' in objectNote.sent[0], false);

  const key = 'holdem.action.v1.game-a';
  const restored = make({
    values: new Map([[key, JSON.stringify({
      decisionId: legal.decisionId, requestId: 'saved-id', action: 'call', note: 'saved plan',
    })]]),
  });
  await restored.controller.connect(restored.snapshot);
  await restored.controller.retry();
  assert.equal(restored.sent[0].note, 'saved plan');
  assert.equal(restored.sent[0].requestId, 'saved-id');

  const dropped = make({
    values: new Map([[key, JSON.stringify({
      decisionId: legal.decisionId, requestId: 'saved-bad', action: 'call', note: 99,
    })]]),
  });
  await dropped.controller.connect(dropped.snapshot);
  await dropped.controller.retry();
  assert.equal('note' in dropped.sent[0], false);
  assert.equal(dropped.sent[0].requestId, 'saved-bad');
});
