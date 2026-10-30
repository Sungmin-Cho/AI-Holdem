import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  planNextStep, nextStepGate, nextStepView, unfinishedRun, coverageGuidance, completionGuidance, drillRequest, formatStudyError, formatWhen, cardGate,
} from '../server/drill-public/study-format.js';
import { createStudyController } from '../server/drill-public/drill.js';
import { startDrillServer } from '../tools/drill-server.js';
import { startDrill, answerQuestion, readDrillSession } from '../tools/drill-cli.js';
import { LEGACY_REFERENCE_SOURCE, V2_REFERENCE_SOURCE, V3_REFERENCE_SOURCE } from '../shared/reference.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

const SOURCE = { ...V3_REFERENCE_SOURCE };
const NOW = Date.parse('2026-10-16T00:00:00.000Z');
const HOUR = 3_600_000;
const iso = (offsetHours) => new Date(NOW + offsetHours * HOUR).toISOString();
const coverage = (overrides = {}) => ({ evaluatedDecisions: 40, supportedDecisions: 30, unsupportedDecisions: 10, unverifiedDecisions: 0,
  referenceAvailableDecisions: 30, exactComparableDecisions: 30, assistedDecisions: 0, projectedReferenceDecisions: 0,
  comparisonUnavailableDecisions: 0, ...overrides });
const assessment = (id, overrides = {}) => ({ id, mode: 'assessment', total: 10, startedAt: iso(-50), complete: true, completedAt: iso(-49),
  sourceIdentity: { ...SOURCE }, result: { total: 10, allowed: 7, allowedActionRate: 0.7, foldBaselineRate: 0.4 },
  retest: { eligible: true, nextAvailableAt: iso(-25) }, ...overrides });
const base = (overrides = {}) => ({
  schemaVersion: 1, source: { ...SOURCE },
  game: { overall: { evaluatedDecisions: 40, supportedDecisions: 30 }, coverage: coverage() },
  practice: { overall: { evaluatedDecisions: 0, supportedDecisions: 0 }, coverage: coverage({ evaluatedDecisions: 0, exactComparableDecisions: 0 }) },
  bank: { totalCount: 0, dueCount: 0, graduatedCount: 0 },
  goal: { origin: 'default', sourceIdentity: null, spotKey: '6max-100bb-btn-rfi-v3', handClass: 'AJo', reason: 'default-supported-spot' },
  assessments: [], retests: [], trends: { practice: [], game: [] },
  ...overrides,
});
const observedGoal = (overrides = {}) => ({ origin: 'game', sourceIdentity: { ...SOURCE }, spotKey: '6max-100bb-bb-vs-single-raise-btn-v3', handClass: 'KJo', reason: 'reference-deviation', ...overrides });
const idle = (overrides = {}) => ({ session: null, pending: null, busy: false, recovery: false, awaitNext: false, replacementOnly: false, feedback: null, error: null, target: null, ...overrides });
const finishedSession = (mode = 'assessment', overrides = {}) => ({ ok: true, sessionId: 's1', mode, done: true, index: 10, count: 10, question: null,
  sourceIdentity: { ...SOURCE }, studyRun: { id: 'run-1', mode, total: 10, startedAt: iso(-1) }, ...overrides });

test('CTA priority is due review, then eligible retest, then observed practice, then assessment', () => {
  const full = base({ bank: { totalCount: 5, dueCount: 2, graduatedCount: 0 }, goal: observedGoal(), assessments: [assessment('a1')] });
  const daily = planNextStep(full);
  assert.equal(daily.kind, 'daily'); assert.equal(daily.measured, false);
  assert.deepEqual(daily.selectors, { mode: 'daily', source: SOURCE });

  const retest = planNextStep({ ...full, bank: { totalCount: 5, dueCount: 0, graduatedCount: 0 } });
  assert.equal(retest.kind, 'retest'); assert.equal(retest.measured, true);
  assert.deepEqual(retest.selectors, { mode: 'retest', assessmentId: 'a1' });

  const practice = planNextStep({ ...full, bank: { totalCount: 0, dueCount: 0 }, assessments: [] });
  assert.equal(practice.kind, 'practice'); assert.equal(practice.measured, false);
  assert.deepEqual(practice.selectors, { mode: 'free', spotKey: '6max-100bb-bb-vs-single-raise-btn-v3', handClass: 'KJo', source: SOURCE });

  const fresh = planNextStep(base());
  assert.equal(fresh.kind, 'assessment'); assert.equal(fresh.measured, true);
  assert.deepEqual(fresh.selectors, { mode: 'assessment', source: SOURCE });
});

test('practice and measured actions are labelled differently', () => {
  const practice = planNextStep(base({ goal: observedGoal() }));
  const assess = planNextStep(base());
  assert.match(practice.label, /연습/); assert.doesNotMatch(practice.label, /평가/);
  assert.match(assess.label, /평가/); assert.match(assess.detail, /측정/);
  assert.match(practice.detail, /측정/); // says it is not a measured run
  assert.match(practice.detail, /따로 측정하는 실행이 아닙니다/);
});

test('a retest sends only the assessment id and chooses the latest eligible completed baseline', () => {
  const plan = planNextStep(base({ assessments: [
    assessment('old', { completedAt: iso(-100) }),
    assessment('new', { completedAt: iso(-30) }),
    assessment('later-but-not-due', { completedAt: iso(-2), retest: { eligible: false, nextAvailableAt: iso(22) } }),
  ] }));
  assert.equal(plan.kind, 'retest');
  assert.deepEqual(plan.selectors, { mode: 'retest', assessmentId: 'new' });
  assert.equal(Object.hasOwn(plan.selectors, 'source'), false);
});

test('a malformed completedAt never wins the latest eligible assessment, whatever its position', () => {
  const malformed = ['not-a-date', 'foo 1', '2026-13-45T00:00:00.000Z', '2026-10-16', '', '   ', undefined, null, 0, 123, 1.7e12, {}, [], true];
  const good = assessment('good', { completedAt: iso(-30) });
  const older = assessment('older', { completedAt: iso(-100) });
  for (const completedAt of malformed) {
    const bad = assessment('bad', { completedAt });
    for (const list of [[good, bad], [bad, good], [older, bad, good], [bad, older, good], [good, older, bad]]) {
      const plan = planNextStep(base({ assessments: list.map((run) => structuredClone(run)) }));
      assert.equal(plan.kind, 'retest', JSON.stringify(completedAt));
      assert.deepEqual(plan.selectors, { mode: 'retest', assessmentId: 'good' }, `${JSON.stringify(completedAt)} ${list.map((run) => run.id)}`);
    }
    // With no valid date to rank, nothing is offered as a retest rather than guessing.
    assert.equal(planNextStep(base({ assessments: [assessment('bad', { completedAt })] })).kind, 'assessment', JSON.stringify(completedAt));
  }
  // Equal valid dates keep the later entry, as before.
  const tie = planNextStep(base({ assessments: [assessment('first', { completedAt: iso(-30) }), assessment('second', { completedAt: iso(-30) })] }));
  assert.equal(tie.selectors.assessmentId, 'second');
});

test('unknown or unproven retest eligibility never produces a retest action', () => {
  const variants = [
    { retest: undefined }, { retest: {} }, { retest: { eligible: 'true' } }, { retest: { eligible: 1 } },
    { retest: { eligible: null, reason: 'INCOMPLETE_ASSESSMENT' } }, { reason: 'INCONSISTENT_RUN' }, { complete: false },
    { complete: 'yes' }, { mode: 'retest' }, { assessmentId: 'a-parent' }, { id: '' }, { id: 7 },
    { sourceIdentity: { ...SOURCE, contentSha256: '0'.repeat(64) } }, { sourceIdentity: null },
  ];
  for (const overrides of variants) {
    const plan = planNextStep(base({ assessments: [{ ...assessment('a1'), ...overrides }] }));
    assert.notEqual(plan.kind, 'retest', JSON.stringify(overrides));
    assert.equal(plan.kind, 'assessment', JSON.stringify(overrides));
  }
  const waiting = planNextStep(base({ assessments: [assessment('a1', { retest: { eligible: false, nextAvailableAt: iso(5) } })] }));
  assert.equal(waiting.kind, 'assessment');
  assert.ok(waiting.notes.some((line) => /재평가 가능 시각/.test(line)));
});

test('derives actions from raw numeric counts and ignores formatted strings', () => {
  for (const dueCount of ['3', '3개', -1, 1.5, NaN, null, undefined, Infinity, 0]) {
    const plan = planNextStep(base({ bank: { totalCount: 5, dueCount }, due: '9개 오늘 복습' }));
    assert.notEqual(plan.kind, 'daily', String(dueCount));
  }
  assert.equal(planNextStep(base({ bank: { totalCount: 5, dueCount: 1 } })).kind, 'daily');
  assert.equal(planNextStep(base({ bank: undefined, due: '9개 오늘 복습' })).kind, 'assessment');
});

test('source or hash mismatch offers no source-bound action and never substitutes another version', () => {
  const badHash = { ...SOURCE, contentSha256: 'f'.repeat(64) };
  const wrongId = { ...SOURCE, id: 'other-baseline' };
  const synthetic = { id: 'fake-solver', version: '1.0.0', contentSha256: SOURCE.contentSha256 };
  for (const source of [badHash, wrongId, synthetic, null, undefined, {}, 'text']) {
    const plan = planNextStep(base({ source, bank: { totalCount: 5, dueCount: 4 }, goal: observedGoal({ sourceIdentity: source }) }));
    assert.equal(plan.kind, 'none', JSON.stringify(source));
    assert.equal(plan.selectors, null);
    assert.match(plan.detail, /출처/);
  }
  // A verified assessment can still be retested by id alone: the server derives its source.
  const retest = planNextStep(base({ source: badHash, assessments: [assessment('a1', { sourceIdentity: { ...V2_REFERENCE_SOURCE } })] }));
  assert.equal(retest.kind, 'retest');
  assert.deepEqual(retest.selectors, { mode: 'retest', assessmentId: 'a1' });
});

test('the daily and assessment selectors carry the summary source exactly, including its hash, whatever the version', () => {
  for (const known of [LEGACY_REFERENCE_SOURCE, V2_REFERENCE_SOURCE, V3_REFERENCE_SOURCE]) {
    const daily = planNextStep(base({ source: { ...known }, bank: { totalCount: 1, dueCount: 1 } }));
    assert.deepEqual(daily.selectors.source, { id: known.id, version: known.version, contentSha256: known.contentSha256 });
    const assess = planNextStep(base({ source: { ...known, extra: 'ignored' } }));
    assert.deepEqual(Object.keys(assess.selectors.source).sort(), ['contentSha256', 'id', 'version']);
  }
});

test('targeted practice requires a source-matched observed goal', () => {
  const cases = [
    observedGoal({ origin: 'default' }),
    observedGoal({ sourceIdentity: null }),
    observedGoal({ sourceIdentity: { ...V2_REFERENCE_SOURCE } }),
    observedGoal({ sourceIdentity: { ...SOURCE, contentSha256: 'a'.repeat(64) } }),
    observedGoal({ spotKey: '6max-100bb-btn-rfi-v2' }), // key from another version than the source
    observedGoal({ spotKey: '6max-100bb-btn-rfi' }),
    observedGoal({ spotKey: 'BAD KEY' }), observedGoal({ spotKey: undefined }),
    observedGoal({ handClass: 'ZZ' }), observedGoal({ handClass: undefined }), observedGoal({ handClass: 'AKx' }),
    observedGoal({ origin: 'tournament' }),
  ];
  for (const goal of cases) {
    const plan = planNextStep(base({ goal }));
    assert.equal(plan.kind, 'assessment', JSON.stringify(goal));
  }
  const v2 = planNextStep(base({ source: { ...V2_REFERENCE_SOURCE }, goal: observedGoal({ sourceIdentity: { ...V2_REFERENCE_SOURCE }, spotKey: '6max-100bb-btn-rfi-v2' }) }));
  assert.equal(v2.kind, 'practice');
  const v1 = planNextStep(base({ source: { ...LEGACY_REFERENCE_SOURCE }, goal: observedGoal({ sourceIdentity: { ...LEGACY_REFERENCE_SOURCE }, spotKey: '6max-100bb-btn-rfi' }) }));
  assert.equal(v1.kind, 'practice');
});

test('transfer is never advertised as an available action', () => {
  for (const summary of [base(), base({ goal: observedGoal() }), base({ bank: { totalCount: 3, dueCount: 3 } }), base({ assessments: [assessment('a1')] })]) {
    const plan = planNextStep(summary);
    assert.notEqual(plan.mode, 'transfer');
    assert.doesNotMatch(JSON.stringify(plan), /transfer|일반화 연습(?:을|이)? 시작|일반화 연습 가능/);
  }
});

test('planning is pure: it never touches the summary it reads', () => {
  const summary = base({ bank: { totalCount: 2, dueCount: 2 }, goal: observedGoal(), assessments: [assessment('a1')] });
  const before = JSON.stringify(summary);
  planNextStep(summary); planNextStep(summary);
  assert.equal(JSON.stringify(summary), before);
  const plan = planNextStep(summary);
  plan.selectors.source.contentSha256 = 'mutated';
  assert.equal(planNextStep(summary).selectors.source.contentSha256, SOURCE.contentSha256);
  assert.equal(summary.source.contentSha256, SOURCE.contentSha256);
});

test('the CTA is gated by busy, recovery, pending and every unfinished mode', () => {
  assert.equal(nextStepGate(idle()), null);
  assert.equal(nextStepGate(idle({ session: finishedSession('free') })), null);
  assert.equal(nextStepGate(idle({ session: { ok: true, sessionId: null, done: true, count: 0, index: 0 } })), null);
  assert.equal(nextStepGate(null)?.code, 'LOADING');
  assert.equal(nextStepGate(idle(), { authenticated: false })?.code, 'UNAUTHORIZED');
  assert.equal(nextStepGate(idle({ busy: true }))?.code, 'BUSY');
  assert.equal(nextStepGate(idle({ recovery: true }))?.code, 'RECOVERY');
  assert.equal(nextStepGate(idle({ pending: { kind: 'answer', body: {} } }))?.code, 'RECOVERY');
  assert.equal(nextStepGate(idle({ replacementOnly: true, session: finishedSession('free', { done: false, index: 0 }) }))?.code, 'REPLACEMENT_ONLY');
  for (const mode of ['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest', 'transfer']) {
    const running = finishedSession(mode, { done: false, index: 3, question: { questionId: 'q' } });
    assert.equal(nextStepGate(idle({ session: running }))?.code, 'UNFINISHED', mode);
    assert.equal(unfinishedRun(idle({ session: running })), true, mode);
    // A completed run is still unfinished until the user acknowledges the last answer.
    assert.equal(nextStepGate(idle({ session: finishedSession(mode), awaitNext: true }))?.code, 'UNFINISHED', mode);
    assert.equal(nextStepGate(idle({ session: finishedSession(mode) })), null, mode);
  }
  assert.ok(nextStepGate(idle({ busy: true })).text.length > 5);
});

test('summary rerenders cannot re-enable a gated CTA', () => {
  const running = idle({ session: finishedSession('assessment', { done: false, index: 4, question: { questionId: 'q' } }) });
  const offers = [base(), base({ bank: { totalCount: 3, dueCount: 3 } }), base({ assessments: [assessment('a1')] }), base({ goal: observedGoal() })];
  for (const state of [running, idle({ busy: true }), idle({ recovery: true })]) {
    for (const summary of offers) {
      const view = nextStepView(summary, state);
      assert.equal(view.disabled, true);
      assert.ok(view.plan.selectors, 'the plan is still described while the action is disabled');
      assert.ok(view.gate.text);
    }
  }
  const ready = nextStepView(offers[0], idle());
  assert.equal(ready.disabled, false); assert.equal(ready.gate, null);
  const noPlan = nextStepView(base({ source: null }), idle());
  assert.equal(noPlan.disabled, true);
});

function controllerFixture({ current, startResponse = { ok: true, count: 10, sessionId: 'next' }, target } = {}) {
  const calls = [];
  const memory = new Map();
  const ids = ['seed-1', 'key-1', 'seed-2', 'key-2'];
  let live = current;
  const controller = createStudyController({
    storage: { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) },
    storageKey: 'next-step', initialTarget: target, uuid: () => ids.shift() ?? 'extra',
    api: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body });
      if (url === '/api/start') { live = { ...finishedSession('free', { done: false, index: 0, count: 10, question: { questionId: 'q1', prompt: { legalActions: ['fold'] } } }) }; return startResponse; }
      return live ?? { ok: false, httpStatus: 409, code: 'NO_SESSION' };
    },
  });
  return { controller, calls, setCurrent: (value) => { live = value; } };
}

test('loading and rendering the plan never posts; only an explicit start does, with the exact selectors', async () => {
  const f = controllerFixture({ current: finishedSession('free'), target: { spotKey: '6max-100bb-utg-rfi-v3', handClass: 'AA' } });
  await f.controller.restore();
  const summary = base({ bank: { totalCount: 2, dueCount: 2 }, goal: observedGoal(), assessments: [assessment('a1')] });
  nextStepView(summary, f.controller.state); planNextStep(summary);
  assert.deepEqual(f.calls.map((call) => call.method), ['GET']);

  const plan = planNextStep(summary);
  await f.controller.start(plan.selectors, { protectUnfinished: true });
  const starts = f.calls.filter((call) => call.url === '/api/start');
  assert.equal(starts.length, 1);
  // The page URL target must not leak into a non-free next step. The protected-start
  // condition travels in the request so the server can enforce it under its own lock.
  assert.deepEqual(starts[0].body, { mode: 'daily', source: SOURCE, protectUnfinished: true, seed: 'seed-1', idempotencyKey: 'key-1' });
});

test('exact dispatch per next-step kind: retest has no source, practice names its target, assessment binds the source', async () => {
  const cases = [
    [base({ assessments: [assessment('a9')] }), { mode: 'retest', assessmentId: 'a9' }],
    [base({ goal: observedGoal() }), { mode: 'free', spotKey: '6max-100bb-bb-vs-single-raise-btn-v3', handClass: 'KJo', source: SOURCE }],
    [base(), { mode: 'assessment', source: SOURCE }],
  ];
  for (const [summary, expected] of cases) {
    // The URL target belongs to another spot; the observed goal must win for the free mode.
    const f = controllerFixture({ current: finishedSession('free'), target: { spotKey: '6max-100bb-utg-rfi-v3', handClass: 'AA' } });
    await f.controller.restore();
    await f.controller.start(planNextStep(summary).selectors, { protectUnfinished: true });
    const start = f.calls.find((call) => call.url === '/api/start');
    assert.deepEqual(start.body, { ...expected, protectUnfinished: true, seed: 'seed-1', idempotencyKey: 'key-1' });
  }
});

test('a protected next-step start never replaces an unfinished, recovering or pending run', async () => {
  const selectors = planNextStep(base()).selectors;
  for (const mode of ['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest', 'transfer']) {
    const running = finishedSession(mode, { done: false, index: 2, question: { questionId: 'q1', prompt: { legalActions: ['fold'] } } });
    const f = controllerFixture({ current: running });
    await f.controller.restore();
    await f.controller.start(selectors, { protectUnfinished: true });
    assert.equal(f.calls.some((call) => call.url === '/api/start'), false, mode);
    // The explicit main Start button keeps its existing replacement behaviour.
    await f.controller.start({ mode: 'free' });
    assert.equal(f.calls.filter((call) => call.url === '/api/start').length, 1, `${mode} explicit start`);
  }
  // A just-finished run waiting for the user's acknowledgement is also protected.
  const waiting = controllerFixture({ current: finishedSession('assessment', { lastResult: { status: 'reference-adherence', grade: 'mixed' } }) });
  await waiting.controller.restore();
  assert.equal(waiting.controller.state.awaitNext, true);
  await waiting.controller.start(selectors, { protectUnfinished: true });
  assert.equal(waiting.calls.some((call) => call.url === '/api/start'), false);

  const recovering = controllerFixture({ current: { ok: false, httpStatus: 500, code: 'ERROR' } });
  await recovering.controller.restore();
  await recovering.controller.start(selectors, { protectUnfinished: true });
  assert.equal(recovering.calls.some((call) => call.url === '/api/start'), false);
});

test('source-unverified sessions are replacement-only and a protected start does not replace them', async () => {
  const legacy = finishedSession('free', { done: false, index: 1, sourceIdentity: null, question: { questionId: 'q1', prompt: { legalActions: ['fold'] } } });
  const f = controllerFixture({ current: legacy });
  await f.controller.restore();
  assert.equal(f.controller.state.replacementOnly, true);
  await f.controller.start(planNextStep(base()).selectors, { protectUnfinished: true });
  assert.equal(f.calls.some((call) => call.url === '/api/start'), false);
});

test('a rejected retest start surfaces the server code without resuming another source', async () => {
  const f = controllerFixture({ current: finishedSession('free'), startResponse: { ok: false, httpStatus: 409, code: 'SOURCE_CHANGED' } });
  await f.controller.restore();
  await f.controller.start(planNextStep(base({ assessments: [assessment('a1')] })).selectors, { protectUnfinished: true });
  const starts = f.calls.filter((call) => call.url === '/api/start');
  assert.equal(starts.length, 1);
  assert.equal(f.controller.state.error.code, 'SOURCE_CHANGED');
  assert.equal(f.calls.filter((call) => call.url === '/api/start').length, 1, 'no automatic second attempt');
});

// ---- Server-enforced protected start (review R3): real drill server, temp store only --------
const PROTECTED = { mode: 'assessment', source: { ...SOURCE } };
const sessionFileOf = (storeDir) => path.join(storeDir, '.training', 'drill-session.json');
const readSessionFile = (storeDir) => JSON.parse(fs.readFileSync(sessionFileOf(storeDir), 'utf8'));
const readSessionBytes = (storeDir) => fs.readFileSync(sessionFileOf(storeDir));

async function realBackend() {
  const storeDir = createOwnedTempDir('holdem-nextstep');
  const token = 'next-step-token';
  const server = await startDrillServer({ storeDir, port: 0, token });
  const requests = [];
  // #301: the controller turns any thrown call into { code: 'CONNECTION' }; keep
  // what actually threw so an assertion can name it.
  const failures = [];
  const call = async (pathname, options = {}) => {
    const [route, init] = drillRequest(pathname, token, options);
    if (init.method === 'POST') requests.push({ pathname, body: JSON.parse(init.body) });
    // #301: one connection per request. This client shares the server's event loop,
    // and answerAll is one synchronous stretch (it never yields to the loop; seconds
    // on a slow Windows runner). When it outlasts the server's idle close
    // (keepAliveTimeout 5s plus Node's 1s buffer), no idle timer has run on either
    // side. The next POST is then written on the kept-alive socket in that same turn
    // (seen with Node 20 and 22 in CI, Node 26 locally), which cancels the client's
    // idle timer; the server's overdue timer then closes the socket under the
    // request, and fetch fails with ECONNRESET (a POST is never retried). A browser
    // tab is another process, and browsers resend a request whose reused connection
    // closed before any response; the product controller is unchanged.
    init.headers = { ...init.headers, connection: 'close' };
    let response = null;
    try {
      response = await fetch(new URL(route, `http://127.0.0.1:${server.port}`), init);
      const body = await response.json();
      return { ...body, httpStatus: response.status, ok: response.ok && body.ok === true };
    } catch (error) {
      const shape = (value) => (value ? { code: value.code ?? null, name: value.name ?? null, message: value.message ?? null } : null);
      failures.push({ pathname, method: init.method, status: response?.status ?? null, ...shape(error), cause: shape(error.cause) });
      throw error;
    }
  };
  return { storeDir, server: server.server, requests, failures, call, close: () => server.close() };
}
/** One browser tab: its own sessionStorage and controller state over a shared backend. */
function tab(backend, label, api = backend.call) {
  const memory = new Map();
  let count = 0;
  const controller = createStudyController({
    api, storageKey: 'two-tab', uuid: () => `${label}-${++count}`,
    storage: { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) },
  });
  return { controller, memory };
}
async function answerAll(storeDir, { upTo = Infinity } = {}) {
  const session = readSessionFile(storeDir);
  for (let index = session.index; index < session.queue.length && index < upTo; index += 1) {
    const question = session.queue[index];
    const [action, size] = question.prompt.legalActions[0].split(':');
    await answerQuestion(storeDir, { action, ...(size ? { sizeBb: Number(size) } : {}), sessionId: session.sessionId, questionId: question.questionId, attemptNo: index });
  }
}
const tempStore = () => createOwnedTempDir('holdem-nextstep');
const rejectsWith = (code) => (error) => error?.code === code;

test('a stale idle tab cannot replace another tab\'s unfinished run, and a deliberate Start still can', async () => {
  const backend = await realBackend();
  try {
    const a = tab(backend, 'a');
    const b = tab(backend, 'b');
    await a.controller.restore(); await b.controller.restore();
    assert.equal(b.controller.state.session.sessionId, null);
    const selectors = planNextStep(base()).selectors;

    await a.controller.start(selectors, { protectUnfinished: true });
    assert.equal(a.controller.state.error, null, JSON.stringify(backend.failures));
    const original = readSessionFile(backend.storeDir);
    const originalBytes = readSessionBytes(backend.storeDir);
    assert.equal(original.mode, 'assessment'); assert.equal(original.queue.length, 10); assert.equal(original.index, 0);

    // B never saw A's run: its cached state is idle and its button is enabled.
    assert.equal(unfinishedRun(b.controller.state), false);
    assert.equal(nextStepView(base(), b.controller.state).disabled, false);
    await b.controller.start(selectors, { protectUnfinished: true });

    const attempts = backend.requests.filter((request) => request.pathname === '/api/start');
    assert.equal(attempts.length, 2, 'B really asked the server');
    assert.equal(attempts[1].body.protectUnfinished, true);
    assert.equal(b.controller.state.error.code, 'UNFINISHED_RUN');
    assert.ok(readSessionBytes(backend.storeDir).equals(originalBytes), 'the original session is byte-identical');
    assert.equal(readSessionFile(backend.storeDir).sessionId, original.sessionId);
    // The rejected request is cleared (no endless retry) and B shows the server's session.
    assert.equal(b.controller.state.pending, null); assert.equal(b.memory.size, 0);
    assert.equal(b.controller.state.busy, false); assert.equal(b.controller.state.recovery, false);
    assert.equal(b.controller.state.session.sessionId, original.sessionId);
    assert.equal(nextStepView(base(), b.controller.state).gate.code, 'UNFINISHED');
    await b.controller.retry();
    await b.controller.start(selectors, { protectUnfinished: true });
    assert.equal(backend.requests.filter((request) => request.pathname === '/api/start').length, 2, 'no automatic or client-side retry reaches the server');

    // The ordinary Start button is a deliberate replacement and carries no condition.
    await b.controller.start({ mode: 'free' });
    const replacement = backend.requests.filter((request) => request.pathname === '/api/start')[2];
    assert.equal(Object.hasOwn(replacement.body, 'protectUnfinished'), false);
    assert.equal(b.controller.state.error, null, JSON.stringify(backend.failures));
    const after = readSessionFile(backend.storeDir);
    assert.notEqual(after.sessionId, original.sessionId);
    assert.equal(after.mode, 'free');
    assert.equal(b.controller.state.session.sessionId, after.sessionId);
  } finally { await backend.close(); }
});

test('a stale tab may still start the next step once the other tab\'s run is finished', async () => {
  const backend = await realBackend();
  try {
    const a = tab(backend, 'a');
    const b = tab(backend, 'b');
    await a.controller.restore(); await b.controller.restore();
    await a.controller.start({ mode: 'free' });
    await answerAll(backend.storeDir);
    const finished = readSessionFile(backend.storeDir);
    assert.equal(finished.index, finished.queue.length);
    await b.controller.start(planNextStep(base()).selectors, { protectUnfinished: true });
    assert.equal(b.controller.state.error, null, JSON.stringify(backend.failures));
    assert.equal(readSessionFile(backend.storeDir).mode, 'assessment');
    assert.notEqual(readSessionFile(backend.storeDir).sessionId, finished.sessionId);
  } finally { await backend.close(); }
});

// #301: the test above failed once on Windows with CONNECTION. Same flow with its
// slow stretch made certain: after answerAll the loop stays blocked past the
// server's real idle close (keepAliveTimeout, 5s by default, plus Node's 1s
// buffer), as a slow answerAll does by itself, so the next POST is written on a
// socket whose overdue idle timer the server runs next.
test('a stale tab\'s next request survives the server closing its idle connection meanwhile', async () => {
  const backend = await realBackend();
  try {
    const a = tab(backend, 'a');
    const b = tab(backend, 'b');
    await a.controller.restore(); await b.controller.restore();
    await a.controller.start({ mode: 'free' });
    await answerAll(backend.storeDir);
    const idleCloseMs = backend.server.keepAliveTimeout + (backend.server.keepAliveTimeoutBuffer ?? 1_000);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, idleCloseMs + 250);
    await b.controller.start(planNextStep(base()).selectors, { protectUnfinished: true });
    assert.equal(b.controller.state.error, null, JSON.stringify(backend.failures));
    assert.equal(readSessionFile(backend.storeDir).mode, 'assessment');
  } finally { await backend.close(); }
});

test('a lost response to a protected start is retried idempotently and its own run is not "unfinished"', async () => {
  const backend = await realBackend();
  try {
    let dropped = false;
    const lossy = async (pathname, options) => {
      const response = await backend.call(pathname, options);
      if (pathname === '/api/start' && !dropped) { dropped = true; throw new Error('connection reset'); }
      return response;
    };
    const b = tab(backend, 'b', lossy);
    await b.controller.restore();
    await b.controller.start(planNextStep(base()).selectors, { protectUnfinished: true });
    assert.equal(b.controller.state.error.code, 'CONNECTION');
    assert.ok(b.controller.state.pending, 'the captured request is kept for an exact retry');
    const created = readSessionFile(backend.storeDir);
    assert.equal(created.idempotencyKey, b.controller.state.pending.body.idempotencyKey);

    await b.controller.retry();
    const [first, second] = backend.requests.filter((request) => request.pathname === '/api/start');
    assert.deepEqual(second.body, first.body, 'the retry is byte-for-byte the same request, guard included');
    assert.equal(first.body.protectUnfinished, true);
    assert.equal(b.controller.state.error, null, JSON.stringify(backend.failures)); assert.equal(b.controller.state.pending, null);
    assert.equal(readSessionFile(backend.storeDir).sessionId, created.sessionId, 'idempotent: no second run');
    assert.equal(b.controller.state.session.sessionId, created.sessionId);
  } finally { await backend.close(); }
});

test('the server refuses a protected start over an unfinished run and keeps ordinary replacement and retry semantics', async () => {
  const storeDir = tempStore();
  const first = await startDrill(storeDir, { ...PROTECTED, seed: 's1', idempotencyKey: 'k1' });
  await answerAll(storeDir, { upTo: 3 });
  const midRun = readSessionBytes(storeDir);
  assert.equal(readSessionFile(storeDir).index, 3);

  await assert.rejects(startDrill(storeDir, { mode: 'free', seed: 's2', idempotencyKey: 'k2', protectUnfinished: true }), rejectsWith('UNFINISHED_RUN'));
  assert.ok(readSessionBytes(storeDir).equals(midRun), 'a refused start leaves the session byte-identical');
  // The same request replayed is the same run, not a replacement.
  const replay = await startDrill(storeDir, { ...PROTECTED, seed: 's1', idempotencyKey: 'k1', protectUnfinished: true });
  assert.equal(replay.sessionId, first.sessionId); assert.equal(replay.index, 3);
  assert.ok(readSessionBytes(storeDir).equals(midRun));
  // An unset or false condition is the ordinary deliberate replacement.
  for (const options of [{}, { protectUnfinished: false }]) {
    await startDrill(storeDir, { ...PROTECTED, seed: 's3', idempotencyKey: `k-${JSON.stringify(options)}`, ...options });
    assert.notEqual(readSessionFile(storeDir).sessionId, first.sessionId);
    await startDrill(storeDir, { ...PROTECTED, seed: 's4', idempotencyKey: `k0-${JSON.stringify(options)}` });
  }
});

test('the server treats a finished or empty run as replaceable and the first start as unprotected', async () => {
  const storeDir = tempStore();
  const fresh = await startDrill(storeDir, { mode: 'free', seed: 's', idempotencyKey: 'k1', protectUnfinished: true });
  await answerAll(storeDir);
  assert.equal((await readDrillSession(storeDir)).done, true);
  const next = await startDrill(storeDir, { ...PROTECTED, seed: 's', idempotencyKey: 'k2', protectUnfinished: true });
  assert.notEqual(next.sessionId, fresh.sessionId);
  // A run with no questions has nothing to lose.
  const emptyStore = tempStore();
  const empty = await startDrill(emptyStore, { mode: 'transfer', seed: 's', idempotencyKey: 'e1' });
  assert.equal(empty.queue.length, 0);
  const replaced = await startDrill(emptyStore, { ...PROTECTED, seed: 's', idempotencyKey: 'e2', protectUnfinished: true });
  assert.notEqual(replaced.sessionId, empty.sessionId);
});

test('the server fails closed when an existing run cannot be proven finished', async () => {
  const mutations = {
    'unreadable session file': () => '{not json',
    'queue is not a list': (session) => ({ ...session, queue: 'x' }),
    'index is not an integer': (session) => ({ ...session, index: '0' }),
    'index beyond the queue': (session) => ({ ...session, index: session.queue.length + 1 }),
    'session is not an object': () => '[]',
    'source no longer verifiable': (session) => ({ ...session, sourceIdentity: { ...session.sourceIdentity, contentSha256: 'f'.repeat(64) } }),
    'legacy layout without a source': (session) => { const { sourceIdentity, studyRun, assistanceContractVersion, ...legacy } = session; return { ...legacy, schemaVersion: 1 }; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const storeDir = tempStore();
    const original = await startDrill(storeDir, { ...PROTECTED, seed: 's', idempotencyKey: 'k1' });
    const changed = mutate(original);
    fs.writeFileSync(sessionFileOf(storeDir), typeof changed === 'string' ? changed : JSON.stringify(changed));
    const before = readSessionBytes(storeDir);
    await assert.rejects(startDrill(storeDir, { mode: 'free', seed: 's2', idempotencyKey: 'k2', protectUnfinished: true }),
      (error) => ['UNFINISHED_RUN', 'PENDING_UNRESOLVED', 'SOURCE_CHANGED'].includes(error?.code), name);
    assert.ok(readSessionBytes(storeDir).equals(before), `${name}: the stored session is untouched`);
  }
  // A protected start over an unreadable file is the explicit refusal, not a generic failure.
  const storeDir = tempStore();
  await startDrill(storeDir, { ...PROTECTED, seed: 's', idempotencyKey: 'k1' });
  fs.writeFileSync(sessionFileOf(storeDir), '{not json');
  await assert.rejects(startDrill(storeDir, { mode: 'free', seed: 's2', idempotencyKey: 'k2', protectUnfinished: true }), rejectsWith('UNFINISHED_RUN'));
  // A retired-source question nobody answered stays replaceable by a deliberate start only.
  const obsolete = tempStore();
  const stale = await startDrill(obsolete, { ...PROTECTED, seed: 's', idempotencyKey: 'k1' });
  fs.writeFileSync(sessionFileOf(obsolete), JSON.stringify({ ...stale, sourceIdentity: { ...stale.sourceIdentity, contentSha256: 'f'.repeat(64) } }));
  const obsoleteBytes = readSessionBytes(obsolete);
  await assert.rejects(startDrill(obsolete, { mode: 'free', seed: 's2', idempotencyKey: 'k2', protectUnfinished: true }), rejectsWith('UNFINISHED_RUN'));
  assert.ok(readSessionBytes(obsolete).equals(obsoleteBytes));
  const deliberate = await startDrill(obsolete, { mode: 'free', seed: 's2', idempotencyKey: 'k3' });
  assert.notEqual(deliberate.sessionId, stale.sessionId);
});

test('the protected-start condition is a validated boolean on the wire and in the library', async () => {
  const backend = await realBackend();
  try {
    const post = (body) => backend.call('/api/start', { method: 'POST', body });
    await post({ mode: 'free', seed: 's', idempotencyKey: 'k1' });
    const before = readSessionBytes(backend.storeDir);
    for (const protectUnfinished of ['true', 'yes', 1, 0, null, [], {}, 'false']) {
      const response = await post({ mode: 'free', seed: 's', idempotencyKey: `bad-${JSON.stringify(protectUnfinished)}`, protectUnfinished });
      assert.equal(response.httpStatus, 400, JSON.stringify(protectUnfinished));
      assert.equal(response.code, 'USAGE');
      await assert.rejects(startDrill(backend.storeDir, { mode: 'free', seed: 's', idempotencyKey: 'x', protectUnfinished }), rejectsWith('USAGE'));
      assert.ok(readSessionBytes(backend.storeDir).equals(before), 'a malformed condition never replaces the run');
    }
    const refused = await post({ mode: 'free', seed: 's', idempotencyKey: 'k2', protectUnfinished: true });
    assert.deepEqual([refused.httpStatus, refused.code, refused.ok], [409, 'UNFINISHED_RUN', false]);
    assert.ok(readSessionBytes(backend.storeDir).equals(before));
    const explicit = await post({ mode: 'free', seed: 's', idempotencyKey: 'k3', protectUnfinished: false });
    assert.equal(explicit.ok, true);
  } finally { await backend.close(); }
});

test('the refused-start status is specific and explains what to do', () => {
  const text = formatStudyError({ code: 'UNFINISHED_RUN' });
  assert.match(text, /진행 중/);
  assert.notEqual(text, formatStudyError({ code: 'SOMETHING_ELSE' }));
});

test('sparse direct coverage is explained with a non-guaranteeing 100BB cash training suggestion', () => {
  const sparse = coverageGuidance(base({ game: { overall: {}, coverage: coverage({ evaluatedDecisions: 40, exactComparableDecisions: 3 }) } }));
  assert.equal(sparse.sparse, true);
  assert.match(sparse.text, /40/); assert.match(sparse.text, /3/); assert.match(sparse.text, /직접 비교/);
  assert.match(sparse.suggestion, /100BB/); assert.match(sparse.suggestion, /캐시 트레이닝/);
  assert.match(sparse.suggestion, /보장하지 않/);
  assert.doesNotMatch(sparse.text + sparse.suggestion, /실력이 (?:늘|향상)|반드시|보장합니다/);

  const none = coverageGuidance(base({ game: { overall: {}, coverage: coverage({ evaluatedDecisions: 0, exactComparableDecisions: 0 }) } }));
  assert.equal(none.sparse, true); assert.match(none.text, /게임 기록/);

  assert.equal(coverageGuidance(base({ game: { overall: {}, coverage: coverage({ evaluatedDecisions: 40, exactComparableDecisions: 30 }) } })), null);
  // Legacy coverage layouts and nonsense counts make no claim.
  assert.equal(coverageGuidance(base({ game: { overall: {}, coverage: { evaluatedDecisions: 40, supportedDecisions: 2 } } })), null);
  assert.equal(coverageGuidance(base({ game: { overall: {}, coverage: coverage({ evaluatedDecisions: 5, exactComparableDecisions: 9 }) } })), null);
  assert.equal(coverageGuidance(base({ game: undefined })), null);
  assert.equal(coverageGuidance({ game: { coverage: coverage({ evaluatedDecisions: '40', exactComparableDecisions: '3' }) } }), null);
  assert.equal(coverageGuidance({ game: { coverage: coverage({ evaluatedDecisions: 40.5, exactComparableDecisions: -1 }) } }), null);
});

test('the plan carries the sparse-coverage guidance next to the action', () => {
  const plan = planNextStep(base({ game: { overall: {}, coverage: coverage({ evaluatedDecisions: 30, exactComparableDecisions: 0 }) } }));
  assert.equal(plan.coverage.sparse, true);
  assert.equal(planNextStep(base()).coverage, null);
});

test('completion guidance suggests a variation and a delayed retest without starting anything', () => {
  const summary = base({ assessments: [assessment('run-1', { retest: { eligible: false, nextAvailableAt: iso(23) } })] });
  const guidance = completionGuidance(idle({ session: finishedSession('assessment') }), summary);
  assert.match(guidance.variation, /변형/); assert.match(guidance.variation, /없을 수 있/);
  assert.match(guidance.retest, /지연 재평가/); assert.match(guidance.retest, /24시간/);
  assert.deepEqual(guidance.choices.map((row) => row.mode), ['transfer', 'retest']);
  assert.ok(guidance.choices.every((row) => row.label.includes('모드 선택')));
  // Not shown for unfinished, acknowledging, busy, recovering or empty runs.
  assert.equal(completionGuidance(idle({ session: finishedSession('assessment', { done: false, index: 3 }) }), summary), null);
  assert.equal(completionGuidance(idle({ session: finishedSession('assessment'), awaitNext: true }), summary), null);
  assert.equal(completionGuidance(idle({ session: finishedSession('assessment'), busy: true }), summary), null);
  assert.equal(completionGuidance(idle({ session: finishedSession('assessment'), recovery: true }), summary), null);
  assert.equal(completionGuidance(idle({ session: finishedSession('assessment', { count: 0, index: 0 }) }), summary), null);
  assert.equal(completionGuidance(idle(), summary), null);
  const plain = completionGuidance(idle({ session: finishedSession('daily') }), base());
  assert.match(plain.retest, /새 문제 평가/);
});

test('lobby help states the policy river-raise limit and uncalibrated LLM bluff frequencies', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../server/public/lobby.js', import.meta.url)), 'utf8');
  const literal = /const OPPONENT_HELP = (\{[\s\S]*?\n\});/.exec(source)?.[1];
  assert.ok(literal, 'OPPONENT_HELP literal found');
  const help = new Function(`return (${literal});`)();
  assert.match(help.policy, /리버/); assert.match(help.policy, /밸류/); assert.match(help.policy, /블러프/);
  assert.match(help.llm, /블러프/); assert.match(help.llm, /보정되지 않/);
  assert.match(help.llm, /페르소나|성향/);
  // The existing speed/cost facts stay.
  assert.match(help.policy, /즉시/); assert.match(help.llm, /몇 초/); assert.match(help.jev, /API 키/);
});

// ---- Page contract and journey fixture (no browser is launched here) --------
import { spawnSync } from 'node:child_process';
import { startNextStepFixture, fixtureSummary, FIXTURE_SOURCE, requiredJourneyChecks } from './browser/coaching-study-journey.mjs';

test('every element the study page script looks up exists in drill.html', () => {
  const dir = fileURLToPath(new URL('../server/drill-public/', import.meta.url));
  const html = fs.readFileSync(path.join(dir, 'drill.html'), 'utf8');
  const script = fs.readFileSync(path.join(dir, 'drill.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
  const looked = new Set([...script.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((match) => match[1]));
  assert.ok(looked.has('next-step-start') && looked.has('next-step-gate'), 'the next-step controls are looked up');
  assert.deepEqual([...looked].filter((id) => !ids.has(id)), []);
  assert.equal(new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])).size, [...html.matchAll(/\sid="([^"]+)"/g)].length, 'ids are unique');
});

test('the focused browser journey fixture serves the real page and a scripted study API', async () => {
  const fixture = await startNextStepFixture();
  try {
    const origin = new URL(fixture.url).origin;
    const page = await (await fetch(`${origin}/`)).text();
    assert.match(page, /id="next-step-start"/);
    const get = (route, token = fixture.token) => fetch(`${origin}${route}`, { headers: { 'x-drill-token': token } }).then((r) => r.json());
    assert.equal((await get('/api/summary', 'wrong')).code, 'UNAUTHORIZED');
    assert.deepEqual((await get('/api/summary')).summary.source, FIXTURE_SOURCE);
    assert.equal((await get('/api/current')).sessionId, null);
    assert.deepEqual(fixture.posts, []);
    fixture.reset({ summary: fixtureSummary({ due: 2 }) });
    const started = await fetch(`${origin}/api/start`, { method: 'POST', headers: { 'x-drill-token': fixture.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'daily', source: FIXTURE_SOURCE, seed: 's', idempotencyKey: 'k' }) }).then((r) => r.json());
    assert.equal(started.ok, true);
    assert.equal(fixture.starts.length, 1);
    const current = await get('/api/current');
    assert.equal(current.done, false); assert.equal(current.mode, 'daily');
    // The scripted server mirrors the real guard: a protected start never replaces an open run.
    const post = (body) => fetch(`${origin}/api/start`, { method: 'POST', headers: { 'x-drill-token': fixture.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const refused = await post({ mode: 'assessment', source: FIXTURE_SOURCE, protectUnfinished: true, seed: 's', idempotencyKey: 'k2' });
    assert.equal(refused.status, 409); assert.equal((await refused.json()).code, 'UNFINISHED_RUN');
    assert.equal(fixture.starts.length, 1); assert.equal(fixture.refusedStarts.length, 1);
    assert.equal((await get('/api/current')).mode, 'daily', 'the open run was not replaced');
    assert.equal((await (await post({ mode: 'assessment', source: FIXTURE_SOURCE, seed: 's', idempotencyKey: 'k3' })).json()).ok, true);
    assert.equal(fixture.starts.length, 2, 'an ordinary start still replaces');
    // The scripted summaries are the server's shape: the planner reads them as real offers.
    assert.equal(planNextStep(fixtureSummary({ due: 2 })).kind, 'daily');
    assert.equal(planNextStep(fixtureSummary({ retestable: true })).kind, 'retest');
    assert.equal(planNextStep(fixtureSummary({ goal: true })).kind, 'practice');
    assert.equal(planNextStep(fixtureSummary({ source: { ...FIXTURE_SOURCE, contentSha256: 'f'.repeat(64) } })).kind, 'none');
    assert.equal(planNextStep(fixtureSummary({ sparse: true })).coverage.sparse, true);
    assert.equal(planNextStep(fixtureSummary()).coverage, null);
  } finally { await fixture.close(); }
  assert.equal(fs.existsSync(fixture.workspaceRoot), false, 'temp workspace removed');
});

test('the browser journey self-test enforces every required check without launching a browser', () => {
  const journey = fileURLToPath(new URL('./browser/coaching-study-journey.mjs', import.meta.url));
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const ok = spawnSync(process.execPath, [journey, '--self-test'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr); assert.match(ok.stdout, /JOURNEY_SELF_TEST_PASS/);
  const omitted = spawnSync(process.execPath, [journey, '--self-test', '--omit', 'next-step-busy-gate'], { env, encoding: 'utf8' });
  assert.notEqual(omitted.status, 0); assert.match(omitted.stderr, /MISSING_REQUIRED_CHECKS: next-step-busy-gate/);
  for (const name of ['next-step-busy-gate', 'next-step-unfinished-rerender-gate', 'next-step-retest-dispatch-exact', 'next-step-source-mismatch-disabled', 'next-step-recovery-gate', 'next-step-stale-tab-guard']) {
    assert.ok(requiredJourneyChecks.includes(name), name);
  }
});

// ── issue 335: the plan follows the learning-effect enrollment ────────────────

const slotRows = (...entries) => entries.map(([runId, status], i) => ({ slot: i + 1, runId, status }));
const enrolled = (overrides = {}) => ({ status: 'active', postOpen: false, consentedAt: iso(-100), postOpensAt: iso(100), postClosesAt: iso(300), baselineRuns: 2,
  baselines: slotRows(['b1', 'complete'], ['b2', 'complete']), post: [],
  retention: [{ slot: 1, assessmentId: 'b1', runId: null, status: 'NOT_STARTED', current: false },
    { slot: 2, assessmentId: 'b2', runId: null, status: 'NOT_STARTED', current: false }], ...overrides });
const withBaselines = (enrollment, overrides = {}) => base({ assessments: [assessment('b1', { completedAt: iso(-60) }), assessment('b2', { completedAt: iso(-55) })],
  enrollment, ...overrides });

test('enrollment: before the post window the enrolled baselines are withheld from the retest plan, with one note', () => {
  const plan = planNextStep(withBaselines(enrolled()));
  assert.notEqual(plan.kind, 'retest');
  assert.deepEqual(plan.notes, [`등록 기준 평가의 지연 재평가는 사후 기간(${formatWhen(iso(100))}부터)에 제안합니다.`]);
  // An assessment that is not an enrolled baseline is still offered, with no enrollment note.
  const other = planNextStep(withBaselines(enrolled(), { assessments: [assessment('b1', { completedAt: iso(-60) }), assessment('x', { completedAt: iso(-10) })] }));
  assert.equal(other.kind, 'retest'); assert.deepEqual(other.selectors, { mode: 'retest', assessmentId: 'x' });
  assert.deepEqual(other.notes, [`등록 기준 평가의 지연 재평가는 사후 기간(${formatWhen(iso(100))}부터)에 제안합니다.`]);
  // No enrollment, null, unavailable or an older service: unchanged behaviour.
  for (const enrollment of [undefined, null, { status: 'unavailable', reasons: ['X'] }]) {
    const plain = planNextStep(withBaselines(enrollment));
    assert.equal(plain.kind, 'retest'); assert.deepEqual(plain.selectors, { mode: 'retest', assessmentId: 'b2' }); assert.deepEqual(plain.notes, []);
  }
});

test('enrollment: in the post window an open measuring slot comes before today\'s review and the latest such baseline is chosen', () => {
  const summary = withBaselines(enrolled({ postOpen: true }), { bank: { totalCount: 5, dueCount: 3, graduatedCount: 0 } });
  const plan = planNextStep(summary);
  assert.equal(plan.kind, 'retest'); assert.equal(plan.measured, true);
  assert.deepEqual(plan.selectors, { mode: 'retest', assessmentId: 'b2' });
  assert.equal(plan.detail, `이번 등록의 지연 재평가 슬롯은 사후 기간에 이 평가를 처음 재평가한 실행으로 정해집니다. 시작하면 ${formatWhen(iso(300))} 전에 끝까지 풀어 주세요.`);
  // Without an enrollment the review is first, as before.
  assert.equal(planNextStep({ ...summary, enrollment: undefined }).kind, 'daily');
  // Once b2's slot is taken, b1 is next; once both are taken (or a baseline is incomplete) the old order returns.
  const takenB2 = enrolled({ postOpen: true, retention: [{ slot: 1, assessmentId: 'b1', runId: null, status: 'NOT_STARTED', current: false },
    { slot: 2, assessmentId: 'b2', runId: 'r2', status: 'UNANSWERED', current: true }] });
  assert.deepEqual(planNextStep({ ...summary, enrollment: takenB2 }).selectors, { mode: 'retest', assessmentId: 'b1' });
  const bothTaken = enrolled({ postOpen: true, retention: [{ slot: 1, assessmentId: 'b1', runId: 'r1', status: 'complete', current: false }, takenB2.retention[1]] });
  const fallback = planNextStep({ ...summary, enrollment: bothTaken });
  assert.equal(fallback.kind, 'daily');
  const noDue = planNextStep({ ...summary, bank: { totalCount: 0, dueCount: 0 }, enrollment: bothTaken });
  assert.equal(noDue.kind, 'retest'); assert.equal(noDue.notes.at(-1), '이 재평가는 이번 등록의 지연 재평가 슬롯으로 선택되지 않습니다.');
  // A baseline that did not complete before the window cannot anchor a measured retest.
  const incomplete = enrolled({ postOpen: true, baselines: slotRows(['b1', 'INCOMPLETE_RUN'], ['b2', 'INCOMPLETE_RUN']) });
  assert.equal(planNextStep({ ...summary, enrollment: incomplete }).kind, 'daily');
  // The 24-hour rule still applies.
  const early = withBaselines(enrolled({ postOpen: true }), { assessments: [assessment('b1', { retest: { eligible: false, nextAvailableAt: iso(5) } }), assessment('b2', { retest: { eligible: false, nextAvailableAt: iso(5) } })],
    bank: { totalCount: 5, dueCount: 3, graduatedCount: 0 } });
  assert.equal(planNextStep(early).kind, 'daily');
});

test('enrollment: completion guidance and the plan read the same enrollment only for an enrolled baseline before the window', () => {
  const summary = base({ assessments: [assessment('run-1', { retest: { eligible: false, nextAvailableAt: iso(23) } })], enrollment: enrolled({ baselines: slotRows(['run-1', 'complete']) }) });
  const done = completionGuidance(idle({ session: finishedSession('assessment') }), summary);
  assert.equal(done.retest, `지연 재평가: 이 평가는 학습 효과 평가의 등록 기준입니다. 지연 재평가는 사후 기간(${formatWhen(iso(100))} ~ ${formatWhen(iso(300))})에 하세요.`);
  const during = completionGuidance(idle({ session: finishedSession('assessment') }), { ...summary, enrollment: enrolled({ postOpen: true, baselines: slotRows(['run-1', 'complete']) }) });
  assert.match(during.retest, /24시간 뒤부터/);
  const notBaseline = completionGuidance(idle({ session: finishedSession('assessment') }), { ...summary, enrollment: enrolled({ baselines: slotRows(['other', 'complete']) }) });
  assert.match(notBaseline.retest, /24시간 뒤부터/);
  const noKey = completionGuidance(idle({ session: finishedSession('assessment') }), { ...summary, enrollment: undefined });
  assert.match(noKey.retest, /24시간 뒤부터/);
});

test('the refused-start wording keeps "진행 중인 연습이 있거나" and tells what Start does', () => {
  const text = formatStudyError({ code: 'UNFINISHED_RUN' });
  assert.equal(text, '진행 중인 연습이 있거나 상태를 확인할 수 없어 새 연습을 시작하지 않았습니다. 다른 창에서 시작한 연습일 수 있습니다. 표시된 연습을 끝낸 뒤 다시 시도하세요. 연습 시작을 누르면 진행 중인 연습을 버리고 새로 시작합니다.');
});

// ── issue 335: the card path over a real backend, in the two-tab structure ────

const runLogOf = (storeDir) => JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'study-run-log.json'), 'utf8')).rows;
const CARD_SHAPE = (assessmentId) => ({ mode: 'retest', assessmentId, protectUnfinished: true });

test('a card retest start is protected on the server: a second request, another tab and a replay leave one start row and no replace row', async () => {
  const backend = await realBackend();
  try {
    const a = tab(backend, 'a');
    const b = tab(backend, 'b');
    await a.controller.restore();
    const first = await a.controller.start({ mode: 'assessment', source: SOURCE });
    assert.equal(a.controller.state.error, null, JSON.stringify(backend.failures));
    const assessmentId = readSessionFile(backend.storeDir).studyRun.id;
    await answerAll(backend.storeDir);
    // Another run becomes the current session (an unprotected Start), so the finished assessment's events can be aged
    // without disturbing a live session: shift them back two days (events carry no time-bound hash).
    await startDrill(backend.storeDir, { mode: 'free', seed: 'between', idempotencyKey: 'between' });
    await answerAll(backend.storeDir);
    const eventsFile = path.join(backend.storeDir, '.training', 'profile-events.jsonl');
    const shifted = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((line) => {
      const row = JSON.parse(line);
      if (row.studyRun?.id !== assessmentId) return line;
      row.appliedAt = new Date(Date.parse(row.appliedAt) - 2 * 86_400_000).toISOString();
      row.studyRun.startedAt = new Date(Date.parse(row.studyRun.startedAt) - 2 * 86_400_000).toISOString();
      return JSON.stringify(row);
    });
    fs.rmSync(path.join(backend.storeDir, '.training', 'profile.json'), { force: true });
    fs.writeFileSync(eventsFile, `${shifted.join('\n')}\n`);
    await a.controller.restore(); await a.controller.next();
    await b.controller.restore(); await b.controller.next();
    assert.equal(unfinishedRun(a.controller.state), false);
    assert.equal(unfinishedRun(b.controller.state), false);
    const startsBefore = runLogOf(backend.storeDir).filter((row) => row.type === 'start' && row.mode === 'assessment').length;
    assert.equal(startsBefore, 1);
    assert.ok(first);

    // The card sends exactly this shape through the controller (plus seed and idempotencyKey).
    await a.controller.start({ mode: 'retest', assessmentId }, { protectUnfinished: true });
    assert.equal(a.controller.state.error, null, JSON.stringify(backend.failures));
    const sent = backend.requests.filter((request) => request.pathname === '/api/start').at(-1);
    assert.deepEqual(Object.keys(sent.body).sort(), ['assessmentId', 'idempotencyKey', 'mode', 'protectUnfinished', 'seed']);
    assert.deepEqual({ mode: sent.body.mode, assessmentId: sent.body.assessmentId, protectUnfinished: sent.body.protectUnfinished }, CARD_SHAPE(assessmentId));
    const original = readSessionFile(backend.storeDir);
    assert.equal(original.mode, 'retest');
    assert.equal(original.studyRun.assessmentId, assessmentId);
    const originalBytes = readSessionBytes(backend.storeDir);
    // The same tab now refuses locally; the card gate says why.
    assert.equal(cardGate(a.controller.state).code, 'UNFINISHED');

    // A second request of the same shape (a double click that got through) and another tab's request are refused by the server.
    const second = await backend.call('/api/start', { method: 'POST', body: { ...CARD_SHAPE(assessmentId), seed: 'again', idempotencyKey: 'second-click' } });
    assert.deepEqual([second.httpStatus, second.code, second.ok], [409, 'UNFINISHED_RUN', false]);
    await b.controller.start({ mode: 'retest', assessmentId }, { protectUnfinished: true });
    assert.equal(b.controller.state.error.code, 'UNFINISHED_RUN');
    assert.ok(readSessionBytes(backend.storeDir).equals(originalBytes), 'the session file is byte-identical');
    assert.equal(readSessionFile(backend.storeDir).sessionId, original.sessionId);
    assert.equal(readSessionFile(backend.storeDir).studyRun.id, original.studyRun.id, 'the run id is kept');

    // A retry with the same idempotency key returns the same run.
    const replay = await backend.call('/api/start', { method: 'POST', body: sent.body });
    assert.equal(replay.ok, true, JSON.stringify(replay));
    assert.equal(readSessionFile(backend.storeDir).studyRun.id, original.studyRun.id);

    // The ledger, read from the file: exactly one retest start for this run and no replacement at all.
    const rows = runLogOf(backend.storeDir);
    assert.equal(rows.filter((row) => row.type === 'start' && row.mode === 'retest').length, 1);
    assert.equal(rows.find((row) => row.type === 'start' && row.mode === 'retest').runId, original.studyRun.id);
    assert.equal(rows.filter((row) => row.type === 'replace').length, 0);
  } finally { await backend.close(); }
});
