import { finishJourney, selfTestJourney, cleanupJourney } from './journey-exit.mjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDrillHandler } from '../../tools/drill-server.js';
import { V3_REFERENCE_SOURCE } from '../../shared/reference.js';
import { createBrowserWorkspace, runOwnedCommand } from '../helpers/learning-browser-fixture.mjs';

// The next-step card of the study page, driven in a real browser against a
// scripted study API. The page's own static assets are served by the production
// drill handler; /api/* is scripted so each state is exact and no store is read.
export const requiredJourneyChecks = Object.freeze([
  'next-step-renders-without-mutation',
  'sparse-coverage-guidance',
  'next-step-mobile-layout',
  'next-step-busy-gate',
  'next-step-daily-dispatch-exact',
  'next-step-unfinished-rerender-gate',
  'next-step-completion-guidance',
  'completion-choice-selects-mode-only',
  'next-step-retest-dispatch-exact',
  'next-step-targeted-practice-dispatch',
  'next-step-source-mismatch-disabled',
  'next-step-recovery-gate',
  'next-step-stale-tab-guard',
  'no-uncaught-errors',
  'owned-cleanup',
]);

export const FIXTURE_SOURCE = Object.freeze({ ...V3_REFERENCE_SOURCE });
const iso = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
const coverage = (evaluated, exact) => ({ evaluatedDecisions: evaluated, supportedDecisions: evaluated, unsupportedDecisions: 0, unverifiedDecisions: 0,
  referenceAvailableDecisions: evaluated, exactComparableDecisions: exact, assistedDecisions: 0, projectedReferenceDecisions: 0, comparisonUnavailableDecisions: 0 });

/** A raw /api/summary payload in the server's shape (tools/study-summary.js). */
export function fixtureSummary({ due = 0, retestable = false, goal = false, sparse = false, source = FIXTURE_SOURCE } = {}) {
  const overall = { evaluatedDecisions: 0, supportedDecisions: 0, allowedActionRate: null, sampleWeight: 0 };
  const calibration = { distributionAgreement: null, eligibleObservations: 0, totalObservations: 0, reason: 'insufficient-observations' };
  const origin = (name, evaluated, exact) => ({ origin: name, overall: { ...overall, evaluatedDecisions: evaluated, supportedDecisions: evaluated },
    coverage: coverage(evaluated, exact), calibration, candidates: [] });
  return {
    schemaVersion: 1, source: { ...source },
    game: origin('game', 40, sparse ? 3 : 36), practice: origin('practice', 0, 0),
    bank: { totalCount: due, dueCount: due, graduatedCount: 0 },
    goal: goal
      ? { origin: 'game', sourceIdentity: { ...FIXTURE_SOURCE }, spotKey: '6max-100bb-bb-vs-single-raise-btn-v3', handClass: 'KJo', reason: 'reference-deviation' }
      : { origin: 'default', sourceIdentity: null, spotKey: '6max-100bb-btn-rfi-v3', handClass: 'AJo', reason: 'default-supported-spot' },
    assessments: retestable ? [{ id: 'a1', mode: 'assessment', total: 10, startedAt: iso(-50), complete: true, completedAt: iso(-49), reason: undefined,
      sourceIdentity: { ...FIXTURE_SOURCE }, result: { allowed: 7, total: 10, allowedActionRate: 0.7, foldBaselineRate: 0.4 },
      retest: { eligible: true, nextAvailableAt: iso(-25) } }] : [],
    retests: [], trends: { practice: [], game: [] },
  };
}

const EMPTY_SESSION = Object.freeze({ done: true, question: null, count: 0, index: 0, mode: null, lastFeedback: null, sessionId: null, attemptNo: null });
function openSession(mode, id) {
  return { done: false, count: 1, index: 0, mode, lastFeedback: null, lastResult: null, sessionId: id, attemptNo: 0,
    sourceIdentity: { ...FIXTURE_SOURCE }, studyRun: { id: `run-${id}`, mode, total: 1, startedAt: iso(0) }, notices: [],
    question: { questionId: `q-${id}`, prompt: { position: 'btn', handClass: 'AJo', stackBb: 100, actionHistory: [],
      legalActions: ['fold', 'raise:2.5'], spotKey: '6max-100bb-btn-rfi-v3', seated: 6 } } };
}

/** Scripted study server. State is mutated from the journey (same process). */
export async function startNextStepFixture() {
  const workspace = createBrowserWorkspace();
  const token = randomBytes(16).toString('hex');
  const staticHandler = createDrillHandler({ storeDir: workspace.root, token });
  const fixture = {
    token, summary: fixtureSummary(), session: null, starts: [], refusedStarts: [], answers: [], posts: [], currentFails: false,
    holding: null, pendingStarts: 0, sequence: 0,
    reset(overrides = {}) { Object.assign(fixture, { summary: fixtureSummary(), session: null, starts: [], refusedStarts: [], answers: [], posts: [], currentFails: false, holding: null, pendingStarts: 0 }, overrides); },
    hold() { let release; fixture.holding = { promise: new Promise((resolve) => { release = resolve; }), release }; },
    release() { fixture.holding?.release(); fixture.holding = null; },
  };
  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
    res.end(text);
  };
  const readBody = (req) => new Promise((resolve) => { const chunks = []; req.on('data', (chunk) => chunks.push(chunk)); req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { resolve({}); } }); });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/')) { await staticHandler(req, res); return; }
    if (req.headers['x-drill-token'] !== token) { json(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return; }
    if (req.method === 'POST') fixture.posts.push(url.pathname);
    if (url.pathname === '/api/summary') { json(res, 200, { ok: true, summary: fixture.summary }); return; }
    if (url.pathname === '/api/current' || url.pathname === '/api/next') {
      if (fixture.currentFails) { json(res, 500, { ok: false, code: 'ERROR' }); return; }
      json(res, 200, { ok: true, ...(fixture.session ?? EMPTY_SESSION) }); return;
    }
    if (url.pathname === '/api/heartbeat') { json(res, 200, { ok: true }); return; }
    if (url.pathname === '/api/start') {
      const body = await readBody(req);
      // Mirrors the server: a protected start never replaces a run that is not finished.
      if (body.protectUnfinished === true && fixture.session && fixture.session.done !== true) {
        fixture.refusedStarts.push({ body });
        json(res, 409, { ok: false, code: 'UNFINISHED_RUN' }); return;
      }
      fixture.starts.push({ body }); fixture.pendingStarts += 1;
      if (fixture.holding) await fixture.holding.promise;
      fixture.pendingStarts -= 1;
      fixture.session = openSession(body.mode, `s${++fixture.sequence}`);
      json(res, 200, { ok: true, count: 1, sessionId: fixture.session.sessionId }); return;
    }
    if (url.pathname === '/api/answer') {
      const body = await readBody(req);
      fixture.answers.push({ body });
      const result = { questionId: fixture.session.question.questionId, status: 'reference-adherence', grade: 'mixed', frequency: 0.5,
        recommended: [{ action: 'fold', frequency: 0.5 }, { action: 'raise', sizeBb: 2.5, frequency: 0.5 }] };
      fixture.session = { ...fixture.session, done: true, question: null, index: 1, attemptNo: null, lastResult: result, summary: [result] };
      json(res, 200, { ok: true, result, next: null }); return;
    }
    json(res, 404, { ok: false, code: 'NOT_FOUND' });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  fixture.url = `http://127.0.0.1:${port}/#token=${token}`;
  fixture.close = async () => {
    fixture.release();
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    workspace.close();
  };
  fixture.workspaceRoot = workspace.root;
  return fixture;
}

// One read of everything the journey asserts about the rendered card.
const UI_EXPRESSION = `JSON.stringify((() => {
  const q = (selector) => document.querySelector(selector);
  const start = q('#next-step-start');
  const rect = start.getBoundingClientRect();
  return { kind: q('#next-step').dataset.state, label: start.textContent, disabled: start.disabled, status: q('#status').textContent,
    title: q('#next-step-title').textContent, detail: q('#next-step-detail').textContent, gate: q('#next-step-gate').textContent,
    coverageHidden: q('#next-step-coverage').hidden, coverage: q('#next-step-coverage').textContent,
    afterHidden: q('#next-step-after').hidden, after: q('#next-step-after').textContent,
    choices: [...document.querySelectorAll('#next-step-choices button')].map((node) => node.textContent),
    mode: q('#mode').value, nextHidden: q('#next').hidden, answers: document.querySelectorAll('#actions .answer').length,
    overflow: document.documentElement.scrollWidth - innerWidth, buttonRight: rect.right, innerWidth };
})())`;

export async function runCoachingStudyJourney(outDir) {
  assert.ok(outDir, '--out-dir is required');
  const output = path.resolve(outDir);
  fs.mkdirSync(output, { recursive: true });
  const checks = [];
  const evidence = {};
  const session = `coaching-study-${randomUUID()}`;
  let fixture; let browserStarted = false; let failure;
  async function browser(args, { json = true } = {}) {
    const receipt = await runOwnedCommand('npx', ['--yes', 'agent-browser@0.36.0', '--session', session, ...(json ? ['--json'] : []), ...args], { timeoutMs: 45000 });
    assert.equal(receipt.exitCode, 0, `agent-browser ${args[0]} failed: ${String(receipt.stdout).replaceAll(fixture?.token ?? '\0', '[redacted]').slice(0, 2000)}`);
    assert.equal(receipt.timedOut, false); assert.equal(receipt.signal, null);
    if (!json) return receipt.stdout;
    const response = JSON.parse(receipt.stdout);
    assert.notEqual(response.success, false, 'browser command rejected');
    return response.data;
  }
  const evaluate = async (expression) => { const data = await browser(['eval', expression]); return data?.result ?? data; };
  const ui = async () => { const value = await evaluate(UI_EXPRESSION); return typeof value === 'string' ? JSON.parse(value) : value; };
  async function waitFor(read, accept, label, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
      try { value = await read(); } catch { value = undefined; }
      if (accept(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label} timed out: ${JSON.stringify(value)?.slice(0, 600)}`);
  }
  const waitUi = (accept, label) => waitFor(ui, (value) => value && accept(value), label);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
  const check = (name, passed, details = {}) => {
    assert.ok(requiredJourneyChecks.includes(name), `unknown journey check: ${name}`);
    assert.equal(checks.includes(name), false, `duplicate journey check: ${name}`);
    assert.equal(passed, true, name);
    checks.push(name); evidence[name] = details;
  };
  const sortedKeys = (value) => Object.keys(value).sort();
  // Same URL (token in the fragment) on later pages: reload, because a repeated open of an
  // identical fragment URL is not guaranteed to be a fresh load.
  let opened = false;
  const freshPage = async (overrides) => {
    fixture.reset(overrides);
    if (opened) await browser(['reload']); else { await browser(['open', fixture.url]); opened = true; }
  };

  try {
    fixture = await startNextStepFixture();
    assert.match(fixture.workspaceRoot, /holdem-learning-browser-/);
    browserStarted = true;
    await browser(['set', 'viewport', '1280', '900']);

    // 1. Due review with sparse direct coverage: the card loads and offers, never starts.
    await freshPage({ summary: fixtureSummary({ due: 2, sparse: true, goal: true, retestable: true }) });
    let state = await waitUi((value) => value.kind === 'daily' && !value.disabled, 'daily suggestion enabled');
    await pause(700);
    check('next-step-renders-without-mutation', /오늘 복습/.test(state.label) && fixture.starts.length === 0
      && !fixture.posts.some((pathname) => pathname !== '/api/heartbeat'), { label: state.label, posts: fixture.posts.length });
    check('sparse-coverage-guidance', state.coverageHidden === false && /100BB/.test(state.coverage) && /보장하지 않/.test(state.coverage)
      && /직접 비교/.test(state.coverage));
    await browser(['screenshot', path.join(output, 'next-step-desktop.png')]);
    await browser(['set', 'viewport', '390', '844']);
    state = await waitUi((value) => value.innerWidth === 390, 'mobile viewport');
    check('next-step-mobile-layout', state.overflow <= 1 && state.buttonRight <= state.innerWidth + 1, { overflow: state.overflow });
    await browser(['screenshot', path.join(output, 'next-step-mobile.png')]);
    await browser(['set', 'viewport', '1280', '900']);

    // 2. Busy start: the card is disabled while the request is in flight and a forced click is a no-op.
    fixture.hold();
    await click('#next-step-start');
    await waitFor(() => fixture.pendingStarts, (value) => value === 1, 'start reached the server');
    state = await waitUi((value) => value.disabled && /확인하고 있습니다/.test(value.gate), 'busy gate');
    await click('#next-step-start'); await pause(300);
    check('next-step-busy-gate', state.disabled === true && fixture.starts.length === 1, { gate: state.gate });
    fixture.release();
    state = await waitUi((value) => value.disabled && /진행 중인 연습/.test(value.gate), 'unfinished gate after start');
    const daily = fixture.starts[0].body;
    // The protected-start condition travels with every next-step request so the server enforces it.
    check('next-step-daily-dispatch-exact', sortedKeys(daily).join() === 'idempotencyKey,mode,protectUnfinished,seed,source' && daily.mode === 'daily'
      && daily.protectUnfinished === true && JSON.stringify(daily.source) === JSON.stringify(FIXTURE_SOURCE), { keys: sortedKeys(daily) });

    // 3. A summary rerender with a different offer cannot re-enable it during the open run.
    fixture.summary = fixtureSummary({ retestable: true });
    await click('#recover');
    state = await waitUi((value) => value.kind === 'retest', 'rerendered suggestion');
    await pause(300);
    state = await ui();
    check('next-step-unfinished-rerender-gate', state.disabled === true && /진행 중인 연습/.test(state.gate) && fixture.starts.length === 1,
      { kind: state.kind, gate: state.gate });

    // 4. Finish the run: still gated until acknowledged, then guidance appears and the card opens up.
    await waitUi((value) => value.answers > 0, 'question shown');
    await click('#actions .answer');
    state = await waitUi((value) => value.nextHidden === false, 'answer feedback');
    assert.equal(state.disabled, true, 'gated while the last answer is unacknowledged');
    await click('#next');
    state = await waitUi((value) => value.afterHidden === false && value.disabled === false, 'completion guidance and enabled card');
    check('next-step-completion-guidance', /변형/.test(state.after) && /지연 재평가/.test(state.after) && fixture.starts.length === 1, { after: state.after.slice(0, 120) });
    await click('#next-step-choices button:last-child');
    state = await ui();
    check('completion-choice-selects-mode-only', state.mode === 'retest' && fixture.starts.length === 1 && state.choices.length === 2, { mode: state.mode });
    await browser(['screenshot', path.join(output, 'next-step-complete.png')]);

    // 5. The offered retest sends the assessment id and no source selector.
    assert.equal(state.kind, 'retest');
    await click('#next-step-start');
    await waitFor(() => fixture.starts.length, (value) => value === 2, 'retest start');
    const retest = fixture.starts[1].body;
    check('next-step-retest-dispatch-exact', sortedKeys(retest).join() === 'assessmentId,idempotencyKey,mode,protectUnfinished,seed' && retest.mode === 'retest'
      && retest.protectUnfinished === true && retest.assessmentId === 'a1', { keys: sortedKeys(retest) });

    // 6. Targeted practice from an observed, source-matched goal.
    await freshPage({ summary: fixtureSummary({ goal: true }) });
    await waitUi((value) => value.kind === 'practice' && !value.disabled, 'practice suggestion');
    await click('#next-step-start');
    await waitFor(() => fixture.starts.length, (value) => value === 1, 'practice start');
    const practice = fixture.starts[0].body;
    check('next-step-targeted-practice-dispatch', practice.mode === 'free' && practice.spotKey === '6max-100bb-bb-vs-single-raise-btn-v3'
      && practice.protectUnfinished === true && practice.handClass === 'KJo' && JSON.stringify(practice.source) === JSON.stringify(FIXTURE_SOURCE), { keys: sortedKeys(practice) });

    // 7. A source that is not a known reference offers nothing.
    await freshPage({ summary: fixtureSummary({ due: 3, goal: true, source: { ...FIXTURE_SOURCE, contentSha256: 'f'.repeat(64) } }) });
    state = await waitUi((value) => value.kind === 'none', 'unverified source suggestion');
    await click('#next-step-start'); await pause(500);
    check('next-step-source-mismatch-disabled', state.disabled === true && /출처/.test(state.detail) && fixture.starts.length === 0, { title: state.title });

    // 8. A failed state read is a recovery state: disabled until the user checks the status.
    await freshPage({ summary: fixtureSummary({ due: 2 }), currentFails: true });
    state = await waitUi((value) => value.disabled && /현재 상태 확인/.test(value.gate), 'recovery gate');
    fixture.currentFails = false;
    await click('#recover');
    const recovered = await waitUi((value) => value.kind === 'daily' && !value.disabled, 'recovered suggestion');
    check('next-step-recovery-gate', state.disabled === true && recovered.disabled === false && fixture.starts.length === 0, { gate: state.gate });

    // 9. Another tab starts a run after this page loaded. The page still shows an enabled card
    //    (its own state is idle), but the server refuses the protected start, the page clears
    //    the rejected request and shows the other tab's run, and nothing was replaced.
    await freshPage({ summary: fixtureSummary({ due: 2 }) });
    await waitUi((value) => value.kind === 'daily' && !value.disabled && value.answers === 0, 'idle page with an enabled card');
    fixture.session = openSession('assessment', 'other-tab');
    await click('#next-step-start');
    state = await waitUi((value) => value.answers > 0 && value.disabled && /진행 중인 연습/.test(value.gate) && /진행 중인 연습이 있거나/.test(value.status),
      'refused start shows the other tab\'s run');
    await pause(300);
    state = await ui();
    check('next-step-stale-tab-guard', fixture.refusedStarts.length === 1 && fixture.refusedStarts[0].body.protectUnfinished === true
      && fixture.starts.length === 0 && fixture.session.sessionId === 'other-tab' && state.disabled === true && state.answers > 0,
    { refused: fixture.refusedStarts.length, status: state.status.slice(0, 80) });

    const errors = await browser(['errors']);
    check('no-uncaught-errors', Array.isArray(errors?.errors) && errors.errors.length === 0, { count: errors?.errors?.length });
  } catch (error) { failure = error; }
  finally {
    const cleanup = await cleanupJourney({ failure, steps: [
      async () => { if (browserStarted) await browser(['close']); },
      async () => { if (fixture) await fixture.close(); },
      () => { assert.equal(fixture ? fs.existsSync(fixture.workspaceRoot) : false, false); },
    ] });
    failure = cleanup.failure;
    if (!cleanup.errors.length) checks.push('owned-cleanup');
    try { finishJourney({ required: requiredJourneyChecks, recorded: checks, failure }); }
    catch (error) { failure = error; }
    const redact = (text) => String(text ?? '').replaceAll(fixture?.token ?? '\0', '[redacted]');
    fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify({ schemaVersion: 1, pass: !failure, checks, evidence,
      cleanupErrors: cleanup.errors.map((error) => redact(error.message)), error: failure ? redact(failure.message) : undefined,
      node: process.version, browser: 'agent-browser@0.36.0' }, null, 2)}\n`, { mode: 0o600 });
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}

export function parseJourneyArgs(argv) {
  const parsed = { outDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--out-dir') throw new Error(`unknown browser journey option: ${argv[index]}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error('--out-dir requires a value');
    parsed.outDir = value; index += 1;
  }
  return parsed;
}

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!selfTestJourney(requiredJourneyChecks)) {
    const { outDir } = parseJourneyArgs(process.argv.slice(2));
    if (!outDir) throw new Error('--out-dir required');
    await runCoachingStudyJourney(path.resolve(outDir));
    console.log('Coaching study next-step browser journey PASS');
  }
}
