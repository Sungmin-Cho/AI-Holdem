import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuestion, formatFeedback, formatFeedbackStep, formatSummary, formatStudyError, drillRequest, readStudyEntry, formatSource, formatSourceShort, spotDiagram, handCards, feedbackBars, runProgress, modeAvailability, STUDY_MODE_HELP, STUDY_MODES } from '../server/drill-public/study-format.js';
import { LEGACY_REFERENCE_SOURCE as source } from '../shared/reference.js';
import { createOwnedTempDir, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { startDrillServer } from '../tools/drill-server.js';
import * as drillUi from '../server/drill-public/drill.js';

const question = { prompt: { position: 'btn', handClass: 'AJo', stackBb: 100, actionHistory: ['raise'], legalActions: ['fold', 'call', 'raise:8.5'] } };
test('Korean question retains context and exact offered action sizes', () => {
  const out = formatQuestion(question);
  assert.match(out.title, /BTN.*AJo/); assert.match(out.context, /100BB.*레이즈/);
  assert.deepEqual(out.actions.map(({ action, sizeBb }) => ({ action, sizeBb })), [{ action: 'fold', sizeBb: undefined }, { action: 'call', sizeBb: undefined }, { action: 'raise', sizeBb: 8.5 }]);
  assert.match(out.actions[2].label, /총액 8.5BB/);
});
test('malformed offered actions never become actionable', () => {
  const out = formatQuestion({ prompt: { ...question.prompt, legalActions: ['raise:NaN', 'raise:-2', 'raise:8.5:1', 'bogus', 'fold'] } });
  assert.deepEqual(out.actions.map((row) => row.action), ['fold']);
});
test('feedback describes reference adherence without claiming poker skill', () => {
  const out = formatFeedback({ status: 'reference-adherence', grade: 'off-policy', frequency: 0, recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.8 }, { action: 'fold', frequency: 0.2 }] }, source);
  assert.match(out.title, /기준표와 다른 선택/); assert.match(out.detail, /한 번/);
  assert.match(out.actions.join(' '), /80%/); assert.doesNotMatch(JSON.stringify(out), /EV 손실|실력 향상|GTO 정답/);
});
test('terminal feedback copy uses server completion rather than matching local counts', () => {
  assert.deepEqual(formatFeedbackStep({ done: true, index: 10, count: 10 }), {
    title: '마지막 답안을 확인하세요',
    context: '마지막 답안을 확인한 뒤 연습을 마무리해 결과를 확인합니다.',
    nextLabel: '연습 마무리',
  });
  assert.equal(formatFeedbackStep({ done: false, index: 10, count: 10 }).nextLabel, '다음 문제');
});
test('unverified and synthetic source suppress result scores and recommendations', () => {
  const result = { status: 'reference-adherence', grade: 'preferred', frequency: 1, recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1 }] };
  for (const identity of [null, { ...source, contentSha256: '0'.repeat(64) }, { id: 'fake-solver', version: '1.0.0' }]) {
    const out = formatFeedback(result, identity); assert.equal(out.actions.length, 0); assert.doesNotMatch(out.title + out.detail, /100%|주력/);
  }
});
test('game and practice metrics remain independent and zero samples unavailable', () => {
  const out = formatSummary({ source, game: { overall: { supportedDecisions: 0, evaluatedDecisions: 4, allowedActionRate: 1, sampleWeight: 0 } }, practice: { overall: { supportedDecisions: 10, evaluatedDecisions: 10, allowedActionRate: 0.7, sampleWeight: 3 } } });
  assert.equal(out.game.rate, '측정 자료 없음'); assert.equal(out.practice.rate, '70%');
  assert.match(out.game.coverage, /0.*4/); assert.match(out.practice.samples, /10.*3/);
});
test('calibration requires eligible samples and unavailable reasons remain explicit', () => {
  const out = formatSummary({ source, game: { overall: { supportedDecisions: 10 }, calibration: { distributionAgreement: 0.99, eligibleObservations: 0, totalObservations: 10, reason: 'insufficient-observations' } } });
  assert.match(out.game.calibration, /표본 부족/); assert.doesNotMatch(out.game.calibration, /99%/);
});
test('future evidence cannot display assessment score or enable retest', () => {
  const out = formatSummary({ source, assessments: [{ id: 'run', complete: true, reason: 'FUTURE_EVIDENCE', sourceIdentity: source, result: { allowedActionRate: 1, total: 10 }, retest: { eligible: true } }] });
  assert.equal(out.assessments[0].rate, '측정 자료 없음'); assert.equal(out.assessments[0].canRetest, false); assert.match(out.assessments[0].status, /시각/);
});
test('source mismatch prevents assessment and retest comparison', () => {
  const out = formatSummary({ source, assessments: [{ id: 'a', complete: true, sourceIdentity: source, result: { total: 10, allowedActionRate: 0.6 } }], retests: [{ id: 'b', assessmentId: 'a', complete: true, sourceIdentity: { ...source, version: '9.0.0' }, result: { total: 10, allowedActionRate: 1 } }] });
  assert.equal(out.retests[0].rate, '측정 자료 없음');
});
test('errors and source caveats never expose server paths or raw codes', () => {
  for (const code of ['PENDING_UNRESOLVED', 'SOURCE_CHANGED', 'FUTURE_OR_INCONSISTENT_EVIDENCE', 'UNKNOWN']) {
    const value = formatStudyError({ code, message: '/Users/private/token=secret' });
    assert.doesNotMatch(value, /\/Users|secret|UNKNOWN|PENDING_UNRESOLVED/); assert.ok(value.length > 10);
  }
  assert.doesNotMatch(formatSource({ id: '/Users/private', version: 'token=secret' }), /private|secret/);
});
test('fragment wins over legacy query and all API requests use header only', () => {
  const entry = readStudyEntry({ hash: '#token=fragment', search: '?token=query&mode=assessment' });
  assert.equal(entry.token, 'fragment'); assert.equal(entry.mode, 'assessment');
  assert.equal(readStudyEntry({ hash: '', search: '?token=legacy' }).token, 'legacy');
  const [url, init] = drillRequest('/api/start', entry.token, { method: 'POST', body: { mode: 'assessment' } });
  assert.equal(url, '/api/start'); assert.equal(init.headers['x-drill-token'], 'fragment'); assert.doesNotMatch(init.body, /fragment|query/);
});

import { createStudyController } from '../server/drill-public/drill.js';
function studyFixture(options = {}) {
  let current = { ok: true, sessionId: 'session', question: { ...question, questionId: 'q1' }, index: 0, count: 2, attemptNo: 0, sourceIdentity: source, mode: 'free', lastResult: null };
  const calls = []; const memory = options.memory ?? new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  const controller = createStudyController({ storage, storageKey: 'hashed-capability', uuid: () => 'stable-start',
    api: async (url, init = {}) => { calls.push({ url, ...init }); if (options.api) { const value = await options.api(url, init); if (value !== undefined) return value; } return current; } });
  return { controller, calls, memory, setCurrent: (value) => { current = value; } };
}
test('refresh restores confirmed feedback without implicitly starting a run', async () => {
  const f = studyFixture(); f.setCurrent({ ok: true, sessionId: 'session', question, index: 1, count: 2, attemptNo: 1, sourceIdentity: source, lastResult: { status: 'reference-adherence', grade: 'mixed' } });
  await f.controller.restore(); assert.equal(f.controller.state.awaitNext, true); assert.equal(f.controller.state.feedback.grade, 'mixed'); assert.equal(f.calls.some((call) => call.url === '/api/start'), false);
});
test('rapid answer clicks send one exact offered action and wait for explicit next', async () => {
  let finish;
  const f = studyFixture({ api: (url) => url === '/api/answer' ? new Promise((resolve) => { finish = resolve; }) : undefined });
  await f.controller.restore(); const first = f.controller.answer('raise', 8.5); await f.controller.answer('call');
  assert.equal(f.controller.state.busy, true); assert.equal(f.calls.filter((call) => call.url === '/api/answer').length, 1);
  const result = { grade: 'mixed', status: 'reference-adherence' };
  f.setCurrent({ ok: true, sessionId: 'session', question: { ...question, questionId: 'q2' }, index: 1, count: 2,
    attemptNo: 1, sourceIdentity: source, mode: 'free', lastResult: result });
  finish({ ok: true, result }); await first;
  assert.equal(f.controller.state.awaitNext, true);
  assert.deepEqual(f.calls.find((call) => call.url === '/api/answer').body, { action: 'raise', sizeBb: 8.5, sessionId: 'session', questionId: 'q1', attemptNo: 0 });
});
test('unoffered amount is not sent and network failure preserves exact answer for recovery', async () => {
  const f = studyFixture({ api: (url) => { if (url === '/api/answer') throw new Error('lost'); } });
  await f.controller.restore(); await f.controller.answer('raise', 9);
  assert.equal(f.calls.filter((call) => call.url === '/api/answer').length, 0);
  await f.controller.answer('raise', 8.5); assert.equal(f.controller.state.recovery, true);
  assert.match([...f.memory.values()][0], /8.5/);
  assert.equal(f.controller.state.pending.body.questionId, 'q1');
});
test('pending-unresolved blocks new starts until current-state recovery succeeds', async () => {
  let blocked = true;
  const f = studyFixture({ api: () => blocked ? { ok: false, httpStatus: 409, code: 'PENDING_UNRESOLVED' } : undefined });
  await f.controller.restore(); await f.controller.start({ mode: 'assessment' });
  assert.equal(f.calls.some((call) => call.url === '/api/start'), false);
  blocked = false; await f.controller.restore(); assert.equal(f.controller.state.recovery, false);
});
test('restored pending answer is never resent automatically', async () => {
  const memory = new Map([['hashed-capability', JSON.stringify({ kind: 'answer', body: { action: 'call', sessionId: 'session', questionId: 'q1', attemptNo: 0 } })]]);
  const f = studyFixture({ memory }); await f.controller.restore();
  assert.equal(f.controller.state.recovery, true); assert.equal(f.calls.some((call) => call.url === '/api/answer'), false);
});

test('authoritative unsupported start releases the invalid capture and accepts a corrected default start', async () => {
  let rejected = true;
  const f = studyFixture({ api: (url) => url === '/api/start' && rejected ? { ok: false, httpStatus: 400, code: 'UNSUPPORTED_SPOT' } : undefined });
  await f.controller.restore();
  await f.controller.start({ mode: 'free', spotKey: 'heads-up-river-unsupported', handClass: 'AJo' });
  assert.equal(f.controller.state.pending, null, 'a definitively rejected start must not remain the only retry forever');
  assert.equal(f.controller.state.recovery, false);
  rejected = false; await f.controller.start({ mode: 'free' });
  const starts = f.calls.filter((call) => call.url === '/api/start');
  assert.equal(starts.length, 2); assert.equal(starts[1].body.spotKey, undefined);
});

test('known noncommitting start rejection codes release correction only after current-state confirmation', async () => {
  for (const [code, httpStatus] of [['UNSUPPORTED_HAND', 400], ['INVALID_DRILL_MODE', 400], ['INVALID_DRILL_LIMIT', 400], ['SOURCE_CHANGED', 409], ['RETEST_NOT_DUE', 409], ['INCOMPLETE_ASSESSMENT', 409]]) {
    let restoring = false;
    const f = studyFixture({ api: (url) => {
      if (url === '/api/start') { restoring = true; return { ok: false, httpStatus, code }; }
      if (restoring) return { ok: false, httpStatus: 503, code: 'ERROR' };
    } });
    await f.controller.restore(); await f.controller.start({ mode: 'free' });
    assert.equal(f.controller.state.pending, null, code);
    assert.equal(f.controller.state.recovery, true, 'unavailable current-state proof does not unlock a new start');
    const calls = f.calls.length; await f.controller.start({ mode: 'free' }); assert.equal(f.calls.length, calls);
  }
});

test('unknown start response failure retains exact idempotency capture', async () => {
  const f = studyFixture({ api: (url) => url === '/api/start' ? { ok: false, httpStatus: 500, code: 'ERROR' } : undefined });
  await f.controller.restore(); await f.controller.start({ mode: 'assessment' });
  const captured = f.controller.state.pending;
  assert.ok(captured); await f.controller.restore();
  assert.deepEqual(f.controller.state.pending, captured); assert.equal(f.controller.state.recovery, true);
});

import { readFileSync } from 'node:fs';
test('brand navigation keeps fragment authentication before JavaScript initialization', () => {
  const html = readFileSync(new URL('../server/drill-public/drill.html', import.meta.url), 'utf8');
  const brand = html.match(/<(a|span)\b([^>]*\bclass="brand"[^>]*)>/);
  assert.ok(brand, 'the study brand must be present');
  const href = brand[2].match(/\bhref="([^"]*)"/)?.[1];
  const before = new URL('http://127.0.0.1:1234/?mode=assessment#token=study-capability');
  const afterClick = brand[1] === 'a' && href !== undefined ? new URL(href, before) : before;
  const reloaded = readStudyEntry(afterClick);
  assert.equal(reloaded.token, 'study-capability', 'native brand activation must preserve the refresh credential');
  assert.equal(reloaded.mode, 'assessment');
});

test('rejected URL practice target is removed before the next explicit free start', async () => {
  const starts = [];
  let serial = 0;
  const memory = new Map();
  const c = createStudyController({
    initialTarget: { spotKey: 'unsupported-but-syntactic', handClass: 'JAs' }, storageKey: 'target-test', uuid: () => `request-${++serial}`,
    storage: { getItem: () => null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) },
    api: async (url, init) => {
      if (url === '/api/start') {
        starts.push(init.body);
        return starts.length === 1 ? { ok: false, httpStatus: 400, code: 'UNSUPPORTED_SPOT' } : { ok: true };
      }
      return { ok: true, sessionId: null, question: null, index: 0, count: 0 };
    },
  });
  await c.restore(); await c.start({ mode: 'free' });
  assert.equal(starts[0].spotKey, 'unsupported-but-syntactic');
  assert.equal(c.state.target, null);
  await c.start({ mode: 'free' });
  assert.equal(starts.length, 2); assert.equal(starts[1].spotKey, undefined); assert.equal(starts[1].handClass, undefined);
  assert.notEqual(starts[1].idempotencyKey, starts[0].idempotencyKey);
});

for (const code of ['SOURCE_CHANGED']) {
  test(`${code} answer plus matching current rejection permits only a replacement start`, async () => {
    let invalid = false;
    const f = studyFixture({ api: (url) => {
      if (url === '/api/answer') { invalid = true; return { ok: false, httpStatus: 409, code }; }
      if (url === '/api/current' && invalid) return { ok: false, httpStatus: 409, code };
    } });
    await f.controller.restore(); await f.controller.answer('raise', 8.5);
    assert.equal(f.controller.state.pending, null);
    assert.equal(f.controller.state.recovery, false);
    assert.equal(f.controller.state.replacementOnly, true);
    const answerCalls = f.calls.filter((call) => call.url === '/api/answer').length;
    await f.controller.answer('raise', 8.5);
    assert.equal(f.calls.filter((call) => call.url === '/api/answer').length, answerCalls, 'old question actions remain disabled');
  });
}

test('source answer rejection keeps the exact capture when current-state reconciliation is unavailable', async () => {
  let reads = 0;
  const f = studyFixture({ api: (url) => {
    if (url === '/api/current') return ++reads === 1 ? undefined : { ok: false, httpStatus: 503, code: 'ERROR' };
    if (url === '/api/answer') return { ok: false, httpStatus: 409, code: 'SOURCE_CHANGED' };
  } });
  await f.controller.restore(); await f.controller.answer('raise', 8.5);
  assert.equal(f.controller.state.pending?.kind, 'answer');
  assert.deepEqual(f.controller.state.pending.body, { action: 'raise', sizeBb: 8.5, sessionId: 'session', questionId: 'q1', attemptNo: 0 });
  assert.equal(f.controller.state.recovery, true);
});

test('unknown and pending-unresolved answer outcomes retain the exact captured answer', async () => {
  for (const response of [
    { ok: false, httpStatus: 409, code: 'PENDING_UNRESOLVED' },
    { ok: false, httpStatus: 500, code: 'ERROR' },
  ]) {
    const f = studyFixture({ api: (url) => url === '/api/answer' ? response : undefined });
    await f.controller.restore(); await f.controller.answer('raise', 8.5);
    assert.equal(f.controller.state.pending?.kind, 'answer', response.code);
    assert.equal(f.controller.state.recovery, true, response.code);
  }
});

test('the tenth answer binds authoritative completion before terminal copy while retaining feedback', async () => {
  const finalResult = { status: 'reference-adherence', grade: 'mixed', frequency: 0.25, recommended: [] };
  let f;
  f = studyFixture({ api: (url) => {
    if (url !== '/api/answer') return undefined;
    f.setCurrent({ ok: true, done: true, sessionId: 'session', question: null, index: 10, count: 10,
      attemptNo: null, sourceIdentity: source, mode: 'assessment', lastResult: finalResult });
    return { ok: true, result: finalResult, next: null };
  } });
  f.setCurrent({ ok: true, done: false, sessionId: 'session', question: { ...question, questionId: 'q10' },
    index: 9, count: 10, attemptNo: 9, sourceIdentity: source, mode: 'assessment', lastResult: null });
  await f.controller.restore(); await f.controller.answer('raise', 8.5);
  assert.equal(f.calls.filter((call) => call.url === '/api/current').length, 2);
  assert.equal(f.controller.state.session.done, true);
  assert.equal(f.controller.state.session.index, 10);
  assert.deepEqual(f.controller.state.feedback, finalResult);
  assert.equal(f.controller.state.awaitNext, true);
  assert.equal(formatFeedbackStep(f.controller.state.session).nextLabel, '연습 마무리');
});

test('actual drill backend source mismatch survives refresh and allows only an explicit fresh run', async (t) => {
  const storeDir = createOwnedTempDir('holdem-study-source-replacement');
  const token = 'b'.repeat(64);
  const backend = await startDrillServer({ storeDir, token });
  registerOwnedServer(backend.server, 'source replacement drill backend');
  t.after(async () => { if (backend.server.listening) await backend.close(); });
  const calls = [];
  const api = async (url, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${url}`, {
      method: init.method ?? 'GET', headers: { 'x-drill-token': token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const body = await response.json();
    const result = { ...body, httpStatus: response.status, ok: response.ok && body.ok === true };
    calls.push({ url, httpStatus: response.status, code: body.code ?? null });
    return result;
  };
  assert.equal((await api('/api/start', { method: 'POST', body: {
    mode: 'free', seed: 'initial-seed', idempotencyKey: 'initial-key', source,
  } })).ok, true);
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  let serial = 0;
  const controller = createStudyController({ api, storage, storageKey: 'source-replacement', uuid: () => `fresh-${++serial}` });
  await controller.restore();
  const previousSessionId = controller.state.session.sessionId;
  const offered = formatQuestion(controller.state.session.question).actions[0];
  const sessionPath = `${storeDir}/.training/drill-session.json`;
  const persisted = JSON.parse((await import('node:fs')).readFileSync(sessionPath, 'utf8'));
  persisted.sourceIdentity.contentSha256 = 'f'.repeat(64);
  (await import('node:fs')).writeFileSync(sessionPath, JSON.stringify(persisted));
  await controller.answer(offered.action, offered.sizeBb);
  assert.deepEqual(calls.slice(-2).map(({ url, httpStatus, code }) => ({ url, httpStatus, code })), [
    { url: '/api/answer', httpStatus: 409, code: 'SOURCE_CHANGED' },
    { url: '/api/current', httpStatus: 409, code: 'SOURCE_CHANGED' },
  ]);
  assert.equal(controller.state.replacementOnly, true);
  assert.equal(controller.state.pending, null);
  assert.equal(controller.state.recovery, false);

  const refreshed = createStudyController({ api, storage, storageKey: 'source-replacement', uuid: () => `refresh-${++serial}` });
  await refreshed.restore();
  assert.equal(refreshed.state.replacementOnly, true);
  assert.equal(refreshed.state.pending, null);
  assert.equal(refreshed.state.recovery, false);
  const answerCalls = calls.filter((call) => call.url === '/api/answer').length;
  await refreshed.answer(offered.action, offered.sizeBb);
  assert.equal(calls.filter((call) => call.url === '/api/answer').length, answerCalls);
  await refreshed.start({ mode: 'free' });
  assert.equal(refreshed.state.replacementOnly, false);
  assert.equal(refreshed.state.recovery, false);
  assert.notEqual(refreshed.state.session.sessionId, previousSessionId);
  assert.ok(refreshed.state.session.question);
});

test('actual drill backend legacy source rejection survives refresh and allows only an explicit fresh run', async (t) => {
  const storeDir = createOwnedTempDir('holdem-study-source-replacement');
  const token = 'b'.repeat(64);
  const backend = await startDrillServer({ storeDir, token });
  registerOwnedServer(backend.server, 'source replacement drill backend');
  t.after(async () => { if (backend.server.listening) await backend.close(); });
  const calls = [];
  const api = async (url, init = {}) => {
    const response = await fetch(`http://127.0.0.1:${backend.port}${url}`, {
      method: init.method ?? 'GET', headers: { 'x-drill-token': token, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const body = await response.json();
    const result = { ...body, httpStatus: response.status, ok: response.ok && body.ok === true };
    calls.push({ url, httpStatus: response.status, code: body.code ?? null });
    return result;
  };
  assert.equal((await api('/api/start', { method: 'POST', body: {
    mode: 'free', seed: 'initial-seed', idempotencyKey: 'initial-key', source,
  } })).ok, true);
  const memory = new Map();
  const storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  let serial = 0;
  const controller = createStudyController({ api, storage, storageKey: 'source-replacement', uuid: () => `fresh-${++serial}` });
  await controller.restore();
  const previousSessionId = controller.state.session.sessionId;
  const offered = formatQuestion(controller.state.session.question).actions[0];
  const sessionPath = `${storeDir}/.training/drill-session.json`;
  const persisted = JSON.parse((await import('node:fs')).readFileSync(sessionPath, 'utf8'));
  persisted.schemaVersion = 1;
  delete persisted.assistanceContractVersion;
  delete persisted.sourceIdentity; delete persisted.studyRun;
  for (const q of persisted.queue) { delete q.sourceIdentity; delete q.candidateMistakeId; delete q.answerPolicy.contentSha256; }
  (await import('node:fs')).writeFileSync(sessionPath, JSON.stringify(persisted));
  await controller.answer(offered.action, offered.sizeBb);
  assert.deepEqual(calls.slice(-2).map(({ url, httpStatus, code }) => ({ url, httpStatus, code })), [
    { url: '/api/answer', httpStatus: 409, code: 'SOURCE_UNVERIFIED' },
    { url: '/api/current', httpStatus: 200, code: null },
  ]);
  assert.equal(controller.state.replacementOnly, true);
  assert.equal(controller.state.pending, null);
  assert.equal(controller.state.recovery, false);

  const refreshed = createStudyController({ api, storage, storageKey: 'source-replacement', uuid: () => `refresh-${++serial}` });
  await refreshed.restore();
  assert.equal(refreshed.state.replacementOnly, true);
  assert.equal(refreshed.state.pending, null);
  assert.equal(refreshed.state.recovery, false);
  const answerCalls = calls.filter((call) => call.url === '/api/answer').length;
  await refreshed.answer(offered.action, offered.sizeBb);
  assert.equal(calls.filter((call) => call.url === '/api/answer').length, answerCalls);
  await refreshed.start({ mode: 'free' });
  assert.equal(refreshed.state.replacementOnly, false);
  assert.equal(refreshed.state.recovery, false);
  assert.notEqual(refreshed.state.session.sessionId, previousSessionId);
  assert.ok(refreshed.state.session.question);
});

test('overlapping summary requests apply only the latest response and suppress stale failure', async () => {
  assert.equal(typeof drillUi.createLatestRequest, 'function');
  const latest = drillUi.createLatestRequest();
  let resolveOld;
  const old = latest(() => new Promise((resolve) => { resolveOld = resolve; }));
  const current = latest(async () => 'new');
  assert.deepEqual(await current, { current: true, value: 'new' });
  resolveOld('old');
  assert.deepEqual(await old, { current: false });

  let rejectOld;
  const staleFailure = latest(() => new Promise((_, reject) => { rejectOld = reject; }));
  assert.deepEqual(await latest(async () => 'newer'), { current: true, value: 'newer' });
  rejectOld(new Error('stale failure'));
  assert.deepEqual(await staleFailure, { current: false });
});

for (const mismatch of ['session', 'question', 'index', 'source', 'unavailable', 'pending']) {
  test(`legacy rejection preserves captured intent when reconciliation is ${mismatch}`, async () => {
    let rejected = false;
    const f = studyFixture({ api: (url) => {
      if (url === '/api/answer') { rejected = true; return { ok: false, httpStatus: 409, code: 'SOURCE_UNVERIFIED' }; }
      if (url !== '/api/current' || !rejected) return undefined;
      if (mismatch === 'unavailable') return { ok: false, httpStatus: 503, code: 'ERROR' };
      if (mismatch === 'pending') return { ok: false, httpStatus: 409, code: 'PENDING_UNRESOLVED' };
      return { ok: true, sessionId: mismatch === 'session' ? 'other' : 'session',
        question: { ...question, questionId: mismatch === 'question' ? 'other' : 'q1' },
        index: mismatch === 'index' ? 1 : 0, attemptNo: 0, count: 2,
        sourceIdentity: mismatch === 'source' ? source : null };
    } });
    await f.controller.restore(); await f.controller.answer('raise', 8.5);
    assert.deepEqual(f.controller.state.pending.body, { action: 'raise', sizeBb: 8.5, sessionId: 'session', questionId: 'q1', attemptNo: 0 });
    assert.equal(f.controller.state.recovery, true); assert.equal(f.controller.state.replacementOnly, false);
    await f.controller.start({ mode: 'free' });
    assert.equal(f.calls.some((c) => c.url === '/api/start'), false);
  });
}

test('legacy rejection storage failure cannot authorize a replacement', async () => {
  let rejected = false;
  let saved;
  const c = createStudyController({ storageKey: 'legacy-storage', storage: {
    getItem: () => saved ?? null, setItem: (_key, value) => { saved = value; },
    removeItem: () => { throw new Error('storage unavailable'); },
  }, api: async (url) => {
    if (url === '/api/answer') { rejected = true; return { ok: false, httpStatus: 409, code: 'SOURCE_UNVERIFIED' }; }
    return { ok: true, sessionId: 'session', question: { ...question, questionId: 'q1' },
      index: 0, attemptNo: 0, count: 2, sourceIdentity: rejected ? null : source };
  } });
  await c.restore(); await c.answer('raise', 8.5);
  assert.equal(c.state.pending.kind, 'answer'); assert.equal(c.state.recovery, true);
  assert.equal(c.state.replacementOnly, false); assert.equal(c.state.error.code, 'STORAGE');
  assert.equal(JSON.parse(saved).kind, 'answer');
});

test('position diagram draws only what the spot states', () => {
  const rfi = spotDiagram({ position: 'CO', spotKey: '6max-100bb-co-rfi-unopened', actionHistory: [] });
  assert.equal(rfi.seated, 6, 'a legacy spot key still names its six-handed table');
  assert.deepEqual(rfi.seats.map((seat) => seat.role), ['folded', 'folded', 'hero', 'waiting', 'waiting', 'waiting']);
  assert.match(rfi.label, /6인.*CO.*모두 폴드/);
  const defend = spotDiagram({ position: 'CO', seated: 9, openerPosition: 'UTG1', spotKey: '9max-100bb-co-vs-utg1-open25-v2', actionHistory: ['raise'] });
  assert.deepEqual(defend.seats.map((seat) => seat.role), ['folded', 'opener', 'folded', 'folded', 'folded', 'hero', 'waiting', 'waiting', 'waiting']);
  assert.match(defend.label, /9인.*CO.*UTG1 오픈/);
  const unknownOpener = spotDiagram({ position: 'BB', spotKey: '6max-100bb-bb-vs-single-raise', actionHistory: ['raise'] });
  assert.ok(unknownOpener.seats.every((seat) => seat.role === 'hero' || seat.role === 'waiting'), 'an unnamed opener draws no folds');
  assert.match(unknownOpener.label, /앞에서 레이즈/);
  assert.equal(spotDiagram({ position: 'BTN', actionHistory: [] }), null, 'no table size, no diagram');
  assert.equal(spotDiagram({ position: 'CO', seated: 6, openerPosition: 'BTN', actionHistory: ['raise'] }), null, 'an opener after the hero is inconsistent');
});

test('hand-class cards show ranks and suitedness without inventing suits', () => {
  assert.deepEqual(handCards({ handClass: 'T9s' }), { ranks: ['10', '9'], kind: 'suited', label: '같은 무늬', name: '10 9 같은 무늬' });
  assert.equal(handCards({ handClass: 'AJo' }).label, '다른 무늬');
  assert.equal(handCards({ handClass: '77' }).kind, 'pair');
  assert.equal(handCards({ handClass: 'bogus' }), null);
});

test('feedback bars mark the graded row only for the same question', () => {
  const result = { questionId: 'q1', status: 'reference-adherence', grade: 'mixed', frequency: 0.3,
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.7 }, { action: 'fold', frequency: 0.3 }] };
  const bars = feedbackBars(result, source, { questionId: 'q1', action: 'fold' });
  assert.deepEqual(bars.rows.map((row) => [row.label, row.percent, row.width, row.mine]), [['레이즈 2.5BB', '70%', 70, false], ['폴드', '30%', 30, true]]);
  assert.equal(bars.mineLabel, '내 선택: 폴드');
  assert.equal(feedbackBars(result, source, { questionId: 'other', action: 'fold' }).rows.some((row) => row.mine), false, 'a stale choice marks nothing');
  assert.equal(feedbackBars(result, source, null).mineLabel, null);
  assert.equal(feedbackBars({ ...result, grade: 'off-policy' }, source, { questionId: 'q1', action: 'raise', sizeBb: 8.5 }).rows.some((row) => row.mine), false);
  assert.deepEqual(feedbackBars(result, { id: 'x', version: '9' }, null).rows, [], 'no verified source, no bars');
});

test('progress, mode help and the short source tag', () => {
  assert.equal(runProgress(null), null);
  assert.deepEqual(runProgress({ sessionId: 's', index: 3, count: 10 }), { index: 3, count: 10, width: 30 });
  assert.deepEqual(Object.keys(STUDY_MODE_HELP), Object.keys(STUDY_MODES), 'every mode has a description');
  const summary = formatSummary({ source, bank: { dueCount: 2, totalCount: 5 } });
  assert.match(modeAvailability('daily', summary), /2개 오늘 복습/);
  assert.match(modeAvailability('retest', summary), /완료한 새 문제 평가가 없어/);
  // The start button retests the latest completed run, so the note follows that run.
  const later = new Date(Date.now() + 3600e3).toISOString();
  const runs = formatSummary({ source, assessments: [
    { id: 'old', complete: true, sourceIdentity: source, result: { total: 10, allowedActionRate: 0.5 }, retest: { eligible: true } },
    { id: 'new', complete: true, sourceIdentity: source, result: { total: 10, allowedActionRate: 0.6 }, retest: { eligible: false, nextAvailableAt: later } },
  ] });
  assert.match(modeAvailability('retest', runs), /가장 최근 평가의 재평가 가능 시각/, 'an older eligible run does not make the start button work');
  const capped = formatSummary({ source, assessments: Array.from({ length: 100 }, (_, index) => ({ id: `open-${index}`, complete: false, sourceIdentity: source, result: { total: 3 } })) });
  assert.match(modeAvailability('retest', capped), /최근 100건에 완료한 평가가 없습니다/, 'a full summary window does not claim no completed run exists');
  assert.equal(modeAvailability('free', summary), '');
  assert.match(formatSourceShort(source), /휴리스틱/);
  assert.doesNotMatch(formatSourceShort({ id: '/Users/private', version: 'token=secret' }), /private|secret/);
});

test('the study page keeps one honesty statement and its help entry', () => {
  const html = readFileSync(new URL('../server/drill-public/drill.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /REFERENCE PRACTICE|class="eyebrow"/, 'no English eyebrows');
  assert.equal((html.match(/id="source"/g) ?? []).length, 1);
  // The honesty statement is in the page itself, not waiting on the summary request.
  assert.match(html, /class="study-honesty"><span>학습 수치는 로컬 휴리스틱 기준표와 비교한 참고값이며, 실제 포커 실력·수익·GTO 정답을 증명하지 않습니다\.<\/span>/);
  assert.match(formatSummary({ source }).sourceShort, /휴리스틱/);
  assert.match(html, /id="mode"[^>]*>(?:<option [^>]+>[^<]+<\/option>){7}<\/select>/, 'the mode select keeps its seven options');
  for (const id of ['start', 'actions', 'next', 'feedback', 'run-progress', 'prompt', 'context', 'goal', 'assessments', 'status', 'reference-source', 'open-help', 'source-help']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
});
