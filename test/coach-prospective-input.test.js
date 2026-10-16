import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyAction } from '../engine/hand.js';
import { validateCoachDecisions } from '../publish-contract.js';
import { coachingClaimAllowed, sanitizeCoachingText } from '../shared/reference.js';
import { buildProcessInput } from '../training/process-review.js';
import { setup3 } from './helpers/fixtures.js';
import './helpers/owned-fixtures.mjs';
import {
  makeCoachAdapter,
  readJson,
  setupCoachHand,
  startRun,
  stopRun,
  waitForCoachNote,
} from './helpers/game-loop-fixtures.mjs';

// Hand-coach input exists at decision time: one target decision, picked from committed cost,
// with only its own snapshot. These tests drive the real engine for the hand record and the
// real validated projection (training/process-review.js) for the model input.
//
// tools/coach-prompt.js is loaded inside the pure tests, not at the top: the loop tests below
// must stay runnable against a base commit that does not have the module, so a pinned-base run
// fails on the behavior they assert and not on an import.
const loadCoachPrompt = () => import('../tools/coach-prompt.js');

// The sidecar's fixed outcome. Spelled out here so a test fails if the message ever changes.
const FIXED_OUTCOME = '결과는 리플레이에서 별도로 확인하세요.';

// user raise 150 preflop, flop bet 400 (the costliest), then two checks. Three players.
function playedRecord() {
  let state = setup3(5000, 5000, 5000);
  const steps = [['user', 'raise', 150], ['p1', 'call'], ['p2', 'fold'], ['p1', 'check'],
    ['user', 'raise', 400], ['p1', 'call'], ['p1', 'check'], ['user', 'check'], ['p1', 'check'], ['user', 'check']];
  for (const [who, action, amount] of steps) state = applyAction(state, who, action, amount).state;
  return structuredClone(state.lastHand);
}

const NOTE_ROW = (decisionId, extra = {}) => ({
  decisionId,
  why: '사실 카드의 SPR과 선택 크기를 근거로 봅니다.',
  alternative: '체크로 팟을 작게 유지할 수 있었습니다.',
  ...extra,
});

const FOCUS = '없음';
const selectionOf = async (record, handNo = record.handNo) => {
  const { selectCoachTarget } = await loadCoachPrompt();
  return selectCoachTarget(buildProcessInput([record]), handNo);
};
const promptOf = async (record, { handNo = record.handNo, overfoldReserved = false } = {}) => {
  const { buildProspectiveCoachPrompt } = await loadCoachPrompt();
  const selection = await selectionOf(record, handNo);
  assert.ok(selection, 'a valid target was expected');
  return buildProspectiveCoachPrompt({ handNo, selection, practiceFocus: FOCUS, overfoldReserved });
};
const targetIdOf = async (record) => (await selectionOf(record))?.decision.decisionId;

const unusedCard = (record) => {
  const used = JSON.stringify(record);
  for (const rank of '23456789TJQKA') for (const suit of 'cdhs') if (!used.includes(`${rank}${suit}`)) return `${rank}${suit}`;
  throw new Error('no unused card');
};

test('the costliest committed decision is the target, whatever came after', async () => {
  const record = playedRecord();
  assert.deepEqual(record.decisions.map((d) => d.decisionId), ['d-1-preflop-0', 'd-1-flop-4', 'd-1-turn-7', 'd-1-river-9']);
  const selection = await selectionOf(record, 1);
  assert.equal(selection.decision.decisionId, 'd-1-flop-4');
  assert.equal(selection.cost, 400);
  assert.match(selection.factsLine, /^d-1-flop-4: 팟 [\d.]+BB/);
});

test('ties go to the earlier decision and a fold counts the price it declined', async () => {
  const { committedCost } = await loadCoachPrompt();
  const record = playedRecord();
  // Turn and river checks both cost 0: with the preflop and flop raises removed the turn wins.
  const checksOnly = { ...record, decisions: record.decisions.slice(2) };
  assert.equal(await targetIdOf(checksOnly), 'd-1-turn-7');
  const folded = structuredClone(record.decisions[2]);
  folded.chosenAction = { action: 'fold', amount: 0 };
  folded.toCall = 900; folded.legal.callAmount = 900; folded.legal.canCheck = false;
  assert.equal(committedCost(folded), 900);
  assert.equal(committedCost({ ...folded, chosenAction: { action: 'check', amount: 0 } }), 0);
});

test('a deliberate decision outranks a timeout auto-action', async () => {
  const record = playedRecord();
  record.decisions[1].forced = true; // the costliest decision was an auto-action
  assert.equal(await targetIdOf(record), 'd-1-preflop-0');
  for (const snap of record.decisions) snap.forced = true;
  assert.equal(await targetIdOf(record), 'd-1-flop-4', 'with only auto-actions the cost rule still applies');
});

test('invalid or legacy legal evidence never becomes a target', async () => {
  const record = playedRecord();
  const broken = structuredClone(record);
  delete broken.decisions[1].legal; // the costliest snapshot has no legal evidence
  assert.equal(await targetIdOf(broken), 'd-1-preflop-0', 'the next valid decision is judged instead');
  const tampered = structuredClone(record);
  tampered.decisions[0].legal.callAmount += 1;
  assert.equal(await targetIdOf(tampered), 'd-1-flop-4');

  const legacy = structuredClone(record);
  for (const snap of legacy.decisions) { snap.schemaVersion = 1; delete snap.legal; }
  assert.equal(await selectionOf(legacy, 1), null, 'no strategy prompt for raw legacy data');
  assert.equal(await selectionOf({ handNo: 1 }, 1), null);
  assert.equal(await selectionOf(record, 2), null, 'a different hand number is never accepted');
});

test('outcome, showdown, future board, final actions, stacks and identities do not reach the prompt', async () => {
  const record = playedRecord();
  const baseline = await promptOf(record);

  const other = structuredClone(record);
  const spare = unusedCard(record);
  other.board = [...record.board.slice(0, 3), spare, record.board[4]];
  other.holes.p1 = ['2c', '2d'].map((card) => (JSON.stringify(record).includes(card) ? spare : card));
  other.showdown = { reveals: [{ playerId: 'p1', cards: ['As', 'Ad'] }], mucks: [] };
  other.pots = [{ potIndex: 0, amount: 1, eligible: ['p1'], winners: [{ playerId: 'p1', amount: 1 }] }];
  other.endStacks = { user: 1, p1: 14999, p2: 0 };
  other.net = { user: -4999, p1: 4999, p2: 0 };
  other.winners = ['p1'];
  other.result = 'loss';
  other.actions = [...record.actions, { playerId: 'p1', action: 'raise', amount: 5000, street: 'river' }];
  other.names = { p1: 'Shark', p2: 'Fish' };
  other.archetypes = { p1: 'maniac', p2: 'rock' };
  assert.equal(await promptOf(other), baseline, 'only completed-hand fields changed');

  for (const secret of [...record.board.slice(3), ...record.holes.p1, 'showdown', 'endStacks', 'winners', 'archetype']) {
    assert.ok(!baseline.includes(secret), `prompt leaked ${secret}`);
  }
  assert.ok(!baseline.includes('(replay)'));
  assert.ok(!baseline.includes('d-1-turn') && !baseline.includes('d-1-river'), 'later decisions are not shown');
});

test('a changed later user decision does not leak into an earlier selected target', async () => {
  const record = playedRecord();
  const baseline = await promptOf(record);
  assert.match(baseline, /d-1-flop-4/);

  const other = structuredClone(record);
  const spare = unusedCard(record);
  const turnCard = record.board[3];
  const swapCard = (snap) => JSON.parse(JSON.stringify(snap).replaceAll(`"${turnCard}"`, `"${spare}"`));
  other.decisions[2] = swapCard(other.decisions[2]);
  other.decisions[3] = swapCard(other.decisions[3]);
  other.decisions[3].chosenAction = { action: 'check', amount: 0 };
  other.decisions[3].potBefore += 12;
  assert.notDeepEqual(other.decisions[2].board, record.decisions[2].board, 'the later snapshots really changed');
  assert.notDeepEqual(other.decisions[3].board, record.decisions[3].board);
  assert.equal(await promptOf(other), baseline);

  // The control: the target's own snapshot is the input.
  const own = structuredClone(record);
  own.decisions[1].board = [...own.decisions[1].board.slice(0, 2), spare];
  own.decisions[1].priorActions = own.decisions[1].priorActions.map((action) => (
    action.board.length ? { ...action, board: [...action.board.slice(0, 2), spare] } : action));
  assert.notEqual(await promptOf(own), baseline);
  assert.ok((await promptOf(own)).includes(spare));
});

test('the prompt separates price arithmetic from heuristic equity and hand strength from EV', async () => {
  const prompt = await promptOf(playedRecord());
  assert.match(prompt, /필요 승률·팟 오즈·SPR은 가격 산술이다/);
  assert.match(prompt, /에퀴티는 별도의 휴리스틱 시뮬레이션/);
  assert.match(prompt, /같은 근거로 합치거나 콜의 EV로 환산하지 마라/);
  assert.match(prompt, /메이드 핸드 강도·드로는 사실이다\. 그것이 곧 이 액션의 EV는 아니다/);
  assert.match(prompt, /결정 사실 카드\(엔진 계산/);
  assert.match(prompt, /가장 비싼\(결정적인\) 결정 1개\(d-1-flop-4\)/);
  assert.match(prompt, /outcome 필드는 쓰지 마라/);
  assert.ok(!/"outcome"/.test(prompt.split('출력은 JSON 한 줄만:')[1].split('\n')[0]), 'the JSON shape does not ask for an outcome');
});

test('the sidecar injects the fixed outcome and the model cannot supply one', async () => {
  const { COACH_FIXED_OUTCOME, applyProspectiveNoteContract } = await loadCoachPrompt();
  assert.equal(COACH_FIXED_OUTCOME, FIXED_OUTCOME);
  const target = (await selectionOf(playedRecord(), 1)).decision.decisionId;
  const modelNote = {
    handNo: 1,
    text: '필요 승률보다 낮아 보입니다.',
    decisions: [NOTE_ROW(target, { outcome: '결국 상대가 이겼다.' })],
  };
  assert.deepEqual(applyProspectiveNoteContract(modelNote).decisions.map((row) => row.outcome), [FIXED_OUTCOME]);
  assert.equal(modelNote.decisions[0].outcome, '결국 상대가 이겼다.', 'the parsed note is not mutated');
  // A row the model gave no outcome gets the fixed one, so the shape validates.
  assert.deepEqual(applyProspectiveNoteContract({ handNo: 1, text: 'ok', decisions: [NOTE_ROW(target)] })
    .decisions.map((row) => row.outcome), [FIXED_OUTCOME]);
  // The containment pass keeps a string the model wrote anyway, so the card validators see it.
  const contained = applyProspectiveNoteContract(modelNote, { keepModelOutcome: true });
  assert.deepEqual(contained.decisions.map((row) => row.outcome), ['결국 상대가 이겼다.']);
  assert.deepEqual(applyProspectiveNoteContract({ handNo: 1, text: 'ok', decisions: [NOTE_ROW(target)] }, { keepModelOutcome: true })
    .decisions.map((row) => row.outcome), [FIXED_OUTCOME]);
  // Rows naming another decision are left intact for the validator to refuse; a note without
  // decisions, and anything that is not a note, passes through untouched.
  const foreign = applyProspectiveNoteContract({ handNo: 1, text: 'ok', decisions: [NOTE_ROW('d-1-river-9')] });
  assert.equal(foreign.decisions[0].decisionId, 'd-1-river-9');
  const textOnly = { handNo: 1, text: 'ok' };
  assert.deepEqual(applyProspectiveNoteContract(textOnly), textOnly);
  assert.equal(applyProspectiveNoteContract('not json'), 'not json');
  assert.equal(applyProspectiveNoteContract(null), null);
});

test('legitimate showdown-value and hypothetical range advice survives the note contract', async () => {
  const { applyProspectiveNoteContract } = await loadCoachPrompt();
  const target = (await selectionOf(playedRecord(), 1)).decision.decisionId;
  const advice = '쇼다운 가치가 있어 체크를 고려하세요.';
  const hypothetical = '예를 들어 Qh Jh 같은 핸드라면 이 가격에 콜 레인지에 넣을 수 있습니다.';
  const note = {
    handNo: 1,
    text: `${advice} ${hypothetical}`,
    decisions: [NOTE_ROW(target, { why: advice, alternative: hypothetical })],
  };
  const sealed = applyProspectiveNoteContract(note);
  assert.equal(sealed.text, note.text);
  assert.equal(sealed.decisions[0].why, advice);
  assert.equal(sealed.decisions[0].alternative, hypothetical);
  assert.equal(sealed.decisions[0].outcome, FIXED_OUTCOME);
  // The existing contract, not this module, decides whether such text is acceptable.
  assert.equal(sanitizeCoachingText(note.text).text, note.text);
  assert.equal(coachingClaimAllowed(note.text), true);
  assert.equal(validateCoachDecisions(sealed.decisions, 1), null);
});

test('the contract changes only outcome, whatever the model wrote in the other fields', async () => {
  const { applyProspectiveNoteContract } = await loadCoachPrompt();
  const target = (await selectionOf(playedRecord(), 1)).decision.decisionId;
  const wordings = [
    '결국 상대가 이겼습니다.', '결과적으로 졌습니다.', '쇼다운에서 뒤집혔습니다.', 'It turned out he won.',
    '리버에 Ah가 나왔습니다.', '상대는 AsKs를 들고 있었다.', '가정: A♠ K♠ 같은 레인지', '', '  ', 'あ', '\n줄바꿈\n',
  ];
  for (const wording of wordings) {
    const note = { handNo: 1, text: wording, overfold: true, decisions: [NOTE_ROW(target, { why: wording, alternative: wording, outcome: wording })] };
    for (const keepModelOutcome of [false, true]) {
      const out = applyProspectiveNoteContract(note, { keepModelOutcome });
      const { outcome, ...row } = out.decisions[0];
      assert.deepEqual({ ...out, decisions: [row] }, { ...note, decisions: [{ decisionId: target, why: wording, alternative: wording }] });
      assert.equal(outcome, keepModelOutcome ? wording : FIXED_OUTCOME);
    }
  }
});

// --- real game loop: prompt capture with the injected runtime fixtures -----------------------
// The loop spawns `ps` for process identity; these run wherever the existing game-loop
// integration tests run. None of them imports tools/coach-prompt.js.

// HU, hand 1: p1 call, user check (preflop BB), flop raise 50. Deal order p1, user, p1, user,
// then flop x3, turn, river. Everything after the flop and p1's cards is undealt at decision time.
const DECK_A = ['7h', 'As', '2c', 'Kd', 'Qs', 'Jd', '9c', '4h', '3s'];
const DECK_B = ['8d', 'As', '3d', 'Kd', 'Qs', 'Jd', '9c', 'Th', '5s'];

// The id the prompt names as the one decision to judge.
const promptTarget = (prompt) => /\((d-\d+-[a-z]+-\d+)\)만 한국어/.exec(prompt)?.[1] ?? null;

// The target's snapshot JSON, on the line after its header.
const snapshotOf = (prompt) => {
  const lines = prompt.split('\n');
  return JSON.parse(lines[lines.findIndex((line) => line.startsWith('결정 시점 스냅샷(')) + 1]);
};

// One hand, no hand 2: nothing is live when the note is checked, so a card named in advice
// cannot collide with a hidden live card and be deferred.
const ONE_HAND = { mode: 'cash-training', stack: undefined, stackBb: 100, hands: 1 };

async function capturePrompt(t, { deck, replayReveal }) {
  const upper = makeCoachAdapter({ rounds: [{ raw: JSON.stringify({ handNo: 1, text: '필요 승률과 SPR을 근거로 한 판단입니다.' }) }] });
  const { gameDir, loop } = await setupCoachHand(t, { upper, deck, bootstrap: { replayReveal } });
  const running = startRun(loop);
  await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  return { prompt: upper.prompts[0], gameDir };
}

test('captured hand-coach prompt is byte-identical when only undealt cards, reveal policy and replay change', { timeout: 60_000 }, async (t) => {
  const a = await capturePrompt(t, { deck: DECK_A, replayReveal: 'all' });
  const b = await capturePrompt(t, { deck: DECK_B, replayReveal: 'showdown' });
  const replayA = fs.readFileSync(path.join(a.gameDir, '.coach-hand-1-replay.json'), 'utf8');
  const replayB = fs.readFileSync(path.join(b.gameDir, '.coach-hand-1-replay.json'), 'utf8');
  assert.notEqual(replayA, replayB, 'the captured replay does differ (raw capture stays intact)');
  assert.equal(a.prompt, b.prompt);
  assert.match(a.prompt, /hand 1 \(redacted\):/);
  assert.doesNotMatch(a.prompt, /\(replay\):/);
  assert.match(a.prompt, /d-1-flop-\d+: 팟 [\d.]+BB/);
  for (const card of ['7h', '2c', '8d', '3d', '4h', '3s', 'Th', '5s']) {
    assert.ok(!a.prompt.includes(`"${card}"`), `prompt carries undealt card ${card}`);
  }
  assert.ok(!a.prompt.includes(replayA) && !a.prompt.includes(replayB), 'the replay capture is not model input');

  // The boundary is the future, not the past: earlier actions are the target's context, but no
  // decision after the target is named and exactly one snapshot is shown.
  const snapshot = snapshotOf(a.prompt);
  const indexOf = (id) => Number(id.split('-').at(-1));
  assert.equal(snapshot.decisionId, promptTarget(a.prompt));
  assert.ok(snapshot.priorActions.length > 0, 'earlier actions are shown as context');
  assert.ok(snapshot.priorActions.every((action) => indexOf(action.decisionId) < indexOf(snapshot.decisionId)));
  const named = [...a.prompt.matchAll(/d-1-[a-z]+-(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(Math.max(...named), indexOf(snapshot.decisionId), 'no decision after the target is named');
  assert.equal((a.prompt.match(/"holeCards"/g) ?? []).length, 1, 'one snapshot only');
});

test('the published note carries the fixed outcome and only the selected decision id is accepted', { timeout: 60_000 }, async (t) => {
  let target = null;
  const rounds = [
    { get raw() {
      target = promptTarget(upper.prompts[0]);
      return JSON.stringify({ handNo: 1, text: '다른 결정을 평가했습니다.', decisions: [NOTE_ROW('d-1-preflop-1', { outcome: FIXED_OUTCOME })] });
    } },
    { get raw() {
      return JSON.stringify({ handNo: 1, text: '대상 결정을 평가했습니다.', decisions: [NOTE_ROW(target, { outcome: '상대가 이겼습니다.' })] });
    } },
  ];
  const upper = makeCoachAdapter({ rounds });
  const { gameDir, loop } = await setupCoachHand(t, { upper });
  const running = startRun(loop);
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  assert.ok(target, 'the prompt names the one decision to judge');
  assert.notEqual(target, 'd-1-preflop-1');
  assert.equal(upper.starts.length, 2, 'the non-target id is refused once, then a retry is accepted');
  assert.equal(note.unavailable, undefined);
  assert.equal(note.decisions.length, 1);
  assert.equal(note.decisions[0].decisionId, target);
  assert.equal(note.decisions[0].outcome, FIXED_OUTCOME);
});

test('legitimate showdown-value and hypothetical range advice is published unchanged', { timeout: 60_000 }, async (t) => {
  const text = '쇼다운 가치가 있어 체크를 고려하세요. 예를 들어 Qh Jh 같은 핸드라면 이 가격에 콜 레인지에 넣을 수 있습니다.';
  const why = '쇼다운 가치가 있어 체크가 팟을 작게 유지합니다.';
  const alternative = '예를 들어 Qh Jh 같은 핸드라면 이 가격에 콜 레인지에 넣을 수 있습니다.';
  const upper = makeCoachAdapter({
    rounds: [{ get raw() {
      return JSON.stringify({ handNo: 1, text, decisions: [{ decisionId: promptTarget(upper.prompts[0]), why, alternative }] });
    } }],
  });
  const { gameDir, loop } = await setupCoachHand(t, { upper, deck: DECK_A, bootstrap: { replayReveal: 'all', ...ONE_HAND } });
  const running = startRun(loop);
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  assert.equal(upper.starts.length, 1, 'ordinary advice is not retried');
  assert.equal(note.unavailable, undefined);
  assert.equal(note.text, text);
  assert.equal(note.decisions.length, 1);
  assert.equal(note.decisions[0].why, why);
  assert.equal(note.decisions[0].alternative, alternative);
  assert.equal(note.decisions[0].outcome, FIXED_OUTCOME);
});

test('a removed unsupported outcome does not discard valid decision advice', { timeout: 60_000 }, async (t) => {
  const outcome = '솔버가 검증한 결과, 콜은 틀린 선택이 아닙니다.';
  assert.equal(sanitizeCoachingText(outcome).text, '', 'the existing sanitizer removes this claim');
  const upper = makeCoachAdapter({ rounds: [{ get raw() {
    return JSON.stringify({ handNo: 1, text: '가격과 SPR을 확인하세요.',
      decisions: [NOTE_ROW(promptTarget(upper.prompts[0]), { outcome })] });
  } }] });
  const { gameDir, loop } = await setupCoachHand(t, { upper, deck: DECK_A, bootstrap: { ...ONE_HAND } });
  const running = startRun(loop);
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  assert.equal(upper.starts.length, 1);
  assert.equal(note.decisions?.length, 1, 'valid why and alternative survive');
  assert.equal(note.decisions[0].why, NOTE_ROW('unused').why);
  assert.equal(note.decisions[0].alternative, NOTE_ROW('unused').alternative);
  assert.equal(note.decisions[0].outcome, FIXED_OUTCOME);
});

// A model that writes an outcome anyway cannot slip a hidden card past the existing
// validators, and what it wrote is never published.
for (const [replayReveal, hidden] of [['showdown', true], ['all', false]]) {
  test(`a model-written outcome naming a ${hidden ? 'hidden' : 'public'} opponent card (${replayReveal}) is ${hidden ? 'refused and retried' : 'replaced by the fixed outcome'}`, { timeout: 60_000 }, async (t) => {
    const ghost = DECK_A[0]; // p1's first hole card
    const upper = makeCoachAdapter({
      rounds: [
        { get raw() {
          return JSON.stringify({
            handNo: 1,
            text: '카드 없이 평가합니다.',
            decisions: [NOTE_ROW(promptTarget(upper.prompts[0]), { outcome: `상대는 ${ghost}를 가지고 있었다.` })],
          });
        } },
        { raw: JSON.stringify({ handNo: 1, text: '재시도 후 카드 없이 평가합니다.' }) },
      ],
    });
    const { gameDir, loop } = await setupCoachHand(t, { upper, deck: DECK_A, bootstrap: { replayReveal, ...ONE_HAND } });
    const running = startRun(loop);
    const note = await waitForCoachNote(gameDir, 1);
    await stopRun(loop, running);
    assert.ok(readJson(path.join(gameDir, 'hands', 'hand-0001.json')).holes.p1.includes(ghost), 'p1 holds the named card');
    // Prose fields only: the proof's hex digest can spell a club or diamond card by chance.
    assert.ok(!JSON.stringify([note.text, note.decisions]).includes(ghost), 'the model-written outcome was not published');
    if (hidden) {
      assert.equal(upper.starts.length, 2, 'the existing private-card validators refused the first note');
      assert.equal(note.text, '재시도 후 카드 없이 평가합니다.');
      assert.equal(note.decisions, undefined);
    } else {
      assert.equal(upper.starts.length, 1, 'a public card is not a leak');
      assert.equal(note.decisions[0].outcome, FIXED_OUTCOME);
    }
  });
}

test('a hand without valid decision-time evidence is published unavailable and never prompts', { timeout: 60_000 }, async (t) => {
  const upper = makeCoachAdapter();
  const legacy = (record) => {
    for (const snap of record?.decisions ?? []) { snap.schemaVersion = 1; delete snap.legal; }
  };
  let gameDirRef = null;
  const { gameDir, loop } = await setupCoachHand(t, {
    upper,
    loopOpts: {
      onEngineInvoke(args) {
        if (args[0] !== 'hand' || !args.includes('--redacted') || !gameDirRef) return;
        const statePath = path.join(gameDirRef, 'state.json');
        const state = readJson(statePath);
        legacy(state.lastHand);
        fs.writeFileSync(statePath, JSON.stringify(state));
        const archive = path.join(gameDirRef, 'hands', 'hand-0001.json');
        if (fs.existsSync(archive)) {
          const record = readJson(archive);
          legacy(record);
          fs.writeFileSync(archive, JSON.stringify(record));
        }
      },
    },
  });
  gameDirRef = gameDir;
  const running = startRun(loop);
  const note = await waitForCoachNote(gameDir, 1);
  await stopRun(loop, running);
  assert.equal(note.unavailable, true);
  assert.equal(upper.starts.length, 0, 'raw legacy data is never sent to the model');
});
