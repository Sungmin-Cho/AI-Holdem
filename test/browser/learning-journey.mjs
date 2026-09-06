import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createLearningBrowserFixture,
  createReviewBrowserFixture,
  productionDependencies,
  runOwnedCommand,
  hashTree,
  NODE26,
} from '../helpers/learning-browser-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_USER_STORE = path.join(ROOT, 'game');

export const journeyScenarioPlan = Object.freeze({
  'desktop-layout': { stage: 'primary-table', viewports: ['1280x900'] },
  'mobile-layout': { stage: 'primary-table', viewports: ['390x844'] },
  'pot-sizing': { stage: 'primary-table', viewports: ['1280x900'] },
  'short-all-in': { stage: 'short-stack-table', viewports: ['390x844'] },
  'accepted-response-loss-before-delivery': { stage: 'action-recovery', viewports: ['1280x900'] },
  'accepted-response-loss-after-delivery': { stage: 'action-recovery', viewports: ['390x844'] },
  'stable-request-after-refresh': { stage: 'action-recovery', viewports: ['1280x900'] },
  'sse-reconnect-relay-restart': { stage: 'action-recovery', viewports: ['1280x900'] },
  'illegal-action-correction': { stage: 'action-recovery', viewports: ['1280x900'] },
  'training-detail-source': { stage: 'training', viewports: ['1280x900'] },
  'training-reading-context': { stage: 'training', viewports: ['1280x900'] },
  'review-reopen-unread': { stage: 'training-and-review', viewports: ['390x844', '1280x900'] },
  'study-fragment-header-auth': { stage: 'study', viewports: ['390x844'] },
  'study-explicit-modes': { stage: 'study', viewports: ['390x844', '1280x900'] },
  'study-feedback-refresh': { stage: 'study', viewports: ['390x844', '1280x900'] },
  'study-source-goal-retest': { stage: 'study', viewports: ['1280x900'] },
  'no-uncaught-errors': { stage: 'all-pages', viewports: ['1280x900', '390x844'] },
  'real-user-store-unchanged': { stage: 'cleanup', viewports: [] },
});
const REQUIRED = Object.freeze(Object.keys(journeyScenarioPlan));
export function browserCliEnabled(env = process.env) { return !env.NODE_TEST_CONTEXT; }
export const requiredJourneyChecks = REQUIRED;

export async function runLearningJourney({ outDir, userStoreDir = DEFAULT_USER_STORE }) {
  assert.ok(outDir, '--out-dir is required');
  assert.equal(process.version, 'v26.0.0', `use ${NODE26}`);
  const output = path.resolve(outDir);
  fs.mkdirSync(output, { recursive: true });
  assert.ok(fs.lstatSync(output).isDirectory() && !fs.lstatSync(output).isSymbolicLink());
  const result = { schemaVersion: 1, pass: false, checks: [], pending: [...REQUIRED], node: process.version, browser: 'agent-browser@0.36.0' };
  const trace = [];
  const session = `learning-${randomUUID()}`;
  const protectedBefore = inspectProtectedUserStore(userStoreDir);
  const fixtures = [];
  let fixture;
  let browserStarted = false;
  let viewport = null;
  const pageErrors = [];
  const secrets = new Set();
  function sanitize(value) {
    let text = String(value);
    for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
    return text.replace(/([?#&]token=)[^&\s"']+/g, '$1[redacted]');
  }
  async function browser(args, { json = true } = {}) {
    const receipt = await runOwnedCommand('npx', ['--yes', 'agent-browser@0.36.0', '--session', session, ...(json ? ['--json'] : []), ...args], { timeoutMs: 45000 });
    trace.push({ operation: args[0], args: args.slice(1).map(sanitize), viewport,
      exitCode: receipt.exitCode, signal: receipt.signal, timedOut: receipt.timedOut,
      stdoutSha256: createHash('sha256').update(sanitize(receipt.stdout)).digest('hex'), stderr: sanitize(receipt.stderr) });
    assert.equal(receipt.exitCode, 0, `agent-browser ${args[0]} failed`);
    assert.equal(receipt.timedOut, false); assert.equal(receipt.signal, null);
    if (!json) return receipt.stdout;
    const response = JSON.parse(receipt.stdout);
    assert.notEqual(response.success, false, 'browser command rejected');
    return response.data;
  }
  const evaluate = async (expression) => {
    const data = await browser(['eval', expression]);
    return data?.result ?? data;
  };
  async function setViewport(width, height) {
    await browser(['set', 'viewport', String(width), String(height)]);
    viewport = `${width}x${height}`;
  }
  async function waitFor(getValue, accept, label, timeoutMs = 12_000) {
    const deadline = Date.now() + timeoutMs;
    let value;
    while (Date.now() < deadline) {
      try { value = await getValue(); } catch { value = undefined; }
      if (accept(value)) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label} timed out`);
  }
  const waitForExpression = (expression, label, timeoutMs) => waitFor(
    () => evaluate(expression), Boolean, label, timeoutMs,
  );
  const check = (name, passed, evidence = {}) => {
    assert.ok(Object.hasOwn(journeyScenarioPlan, name), `unknown journey check: ${name}`);
    assert.equal(result.checks.some((row) => row.name === name), false, `duplicate journey check: ${name}`);
    assert.equal(passed, true, name);
    result.checks.push({ name, pass: true, stage: journeyScenarioPlan[name].stage,
      requiredViewports: journeyScenarioPlan[name].viewports,
      observedViewports: evidence.observedViewports ?? (viewport ? [viewport] : []), ...evidence });
    result.pending = REQUIRED.filter((required) => !result.checks.some((row) => row.name === required));
  };
  const registerFixture = (value) => { fixtures.push(value); return value; };
  const requestIdInStorage = () => evaluate(`Object.keys(sessionStorage)
    .filter((key) => key.startsWith('holdem.action.v1.'))
    .map((key) => JSON.parse(sessionStorage.getItem(key))).find((row) => row.requestId)?.requestId ?? null`);
  const beginDelivery = async (target) => {
    const promise = target.receiveAction();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { promise };
  };
  async function recordBrowserErrors(stage) {
    const value = await browser(['errors']);
    assert.ok(Array.isArray(value?.errors), `${stage} browser errors unavailable`);
    pageErrors.push(...value.errors.map((error) => ({ stage, error: sanitize(JSON.stringify(error)) })));
  }
  try {
    if (!protectedBefore.exists || !protectedBefore.directory) {
      result.error = 'protected user store must be an existing directory';
      return result;
    }
    const deps = await productionDependencies();
    if (!deps.ready) { result.blocked = deps.reason; return result; }
    const version = await browser(['--version'], { json: false });
    assert.match(version, /0\.36\.0/);

    fixture = registerFixture(await createLearningBrowserFixture());
    secrets.add(fixture.token); secrets.add(new URLSearchParams(new URL(fixture.studyUrl).hash.slice(1)).get('token'));
    await fixture.reachUserTurn();
    browserStarted = true;
    await setViewport(1280, 900);
    await browser(['open', fixture.tableUrl]);
    await browser(['wait', '#btn-fold:not([disabled])']);
    await browser(['snapshot', '-i']);
    check('desktop-layout', await evaluate('document.documentElement.scrollWidth <= 1280 && document.querySelector("#table").getBoundingClientRect().width > 200'));
    const firstSnapshot = await fixture.snapshot();
    const firstLegal = firstSnapshot.view.legal;
    const actorBet = firstSnapshot.view.seats.find((row) => row.playerId === 'user').bet;
    assert.equal(firstLegal.canRaise && firstLegal.minRaiseTo <= firstLegal.maxRaiseTo, true);
    await browser(['click', '[data-preset="pot"]']);
    const amount = await evaluate('Number(document.querySelector("#raise-amount").value.replaceAll(",", ""))');
    check('pot-sizing', amount === Math.max(firstLegal.minRaiseTo, Math.min(firstLegal.maxRaiseTo,
      actorBet + firstLegal.callAmount + firstLegal.potTotal + firstLegal.callAmount)));
    await browser(['screenshot', path.join(output, 'table-desktop.png')]);

    fixture.proxy.arm({ path: '/api/action', kind: 'drop' });
    await browser(['click', '#btn-fold']);
    await browser(['wait', '#btn-fold[disabled]']);
    const accepted = await waitFor(fixture.actionStatus, (value) => value?.phase === 'accepted', 'accepted receipt');
    check('accepted-response-loss-before-delivery', accepted.requestId != null);
    await browser(['reload']);
    await browser(['wait', '#btn-fold[disabled]']);
    check('stable-request-after-refresh', await requestIdInStorage() === accepted.requestId);
    await fixture.restartRelay();
    await browser(['wait', '#conn.on']);
    check('sse-reconnect-relay-restart', (await fixture.actionStatus()).requestId === accepted.requestId);
    const firstReceived = await fixture.receiveAction();
    assert.equal(firstReceived.requestId, accepted.requestId);
    await fixture.applyReceivedAction(firstReceived);
    await fixture.finishHandAndPublishTraining();

    await fixture.startNextHand();
    await fixture.reachUserTurn();
    await setViewport(390, 844);
    await browser(['wait', '#btn-fold:not([disabled])']);
    await browser(['snapshot', '-i']);
    check('mobile-layout', await evaluate('document.documentElement.scrollWidth <= 390 && document.querySelector("#action-status").textContent.length > 5'));
    await browser(['screenshot', path.join(output, 'table-mobile.png')]);
    const { promise: delivery } = await beginDelivery(fixture);
    fixture.proxy.arm({ path: '/api/action', kind: 'drop' });
    await browser(['click', '#btn-fold']);
    const delivered = await delivery;
    const deliveredStatus = await waitFor(fixture.actionStatus, (value) => value?.phase === 'delivered', 'delivered receipt');
    check('accepted-response-loss-after-delivery', delivered.requestId === deliveredStatus.requestId
      && await evaluate('document.querySelector("#btn-fold").disabled'));
    await fixture.applyReceivedAction(delivered);
    await fixture.finishHandAndPublishTraining();

    await fixture.startNextHand();
    await fixture.reachUserTurn();
    await setViewport(1280, 900);
    await browser(['wait', '#btn-fold:not([disabled])']);
    const { promise: rejectedDelivery } = await beginDelivery(fixture);
    await browser(['click', '#btn-fold']);
    const rejected = await rejectedDelivery;
    await fixture.rejectReceivedAction(rejected);
    await waitForExpression(`document.querySelector('#action-status').textContent.includes('거부')
      && !document.querySelector('#btn-fold').disabled`, 'authoritative action rejection');
    await browser(['click', '#btn-fold']);
    const correctedStatus = await waitFor(fixture.actionStatus,
      (value) => value?.phase === 'accepted' && value.requestId !== rejected.requestId, 'corrected action receipt');
    check('illegal-action-correction', correctedStatus.requestId !== rejected.requestId);
    const corrected = await fixture.receiveAction();
    await fixture.applyReceivedAction(corrected);
    await fixture.finishHandAndPublishTraining();

    for (let hand = 0; hand < 5; hand += 1) {
      const snapshot = await fixture.snapshot();
      if ((snapshot.training ?? []).length >= 6) break;
      await fixture.startNextHand();
      const turn = await fixture.reachUserTurn();
      assert.ok(turn.view.legal?.decisionId);
      await fixture.engineStep(['user', 'fold']);
      await fixture.finishHandAndPublishTraining();
    }
    await setViewport(390, 844);
    await waitForExpression('!document.querySelector("#unread-training").hidden', 'training unread badge');
    const unreadMobile = await evaluate(`document.querySelector('#unread-training').textContent.length > 0
      && document.documentElement.scrollWidth <= 390`);
    await browser(['screenshot', path.join(output, 'training-unread-mobile.png')]);
    await setViewport(1280, 900);
    const unreadObserved = await evaluate('document.querySelector("#unread-training").textContent.length > 0');
    await browser(['click', '#tab-training']);
    await browser(['wait', '#training-list details summary']);
    await browser(['snapshot', '-i']);
    await browser(['click', '#training-list details summary']);
    await waitForExpression('document.querySelector(".training-source")?.textContent.includes("휴리스틱 참고 자료")', 'verified training detail');
    const sourceEvidence = await evaluate(`(() => {
      const card = document.querySelector('#training-list details');
      return card.open && card.querySelector('.training-source').textContent.includes('휴리스틱 참고 자료')
        && !card.querySelector('.training-source').textContent.includes('GTO 정답');
    })()`);
    check('training-detail-source', sourceEvidence);
    const reading = await evaluate(`(() => {
      const panel = document.querySelector('#panel-training');
      const card = document.querySelector('#training-list details');
      card.open = true;
      panel.scrollTop = Math.min(60, Math.max(0, panel.scrollHeight - panel.clientHeight));
      const focus = card.querySelector('[data-focus="practice"]');
      focus?.focus();
      return { scroll: panel.scrollTop, focused: document.activeElement === focus };
    })()`);
    assert.equal(reading.scroll > 0 && reading.focused, true, 'training panel needs real scroll and focus evidence');
    await fixture.engineStep([], { viewOnly: true });
    await browser(['wait', '300']);
    check('training-reading-context', await evaluate(`(() => {
      const panel = document.querySelector('#panel-training');
      const card = document.querySelector('#training-list details');
      return card.open && panel.scrollTop === ${Number(reading.scroll)}
        && card.contains(document.activeElement) && document.activeElement.dataset.focus === 'practice';
    })()`));
    await recordBrowserErrors('primary-table');

    const shortFixture = registerFixture(await createLearningBrowserFixture({ stackChips: 175, hands: 12 }));
    secrets.add(shortFixture.token); secrets.add(new URLSearchParams(new URL(shortFixture.studyUrl).hash.slice(1)).get('token'));
    const shortSnapshot = await shortFixture.reachShortAllIn();
    await setViewport(390, 844);
    await browser(['open', shortFixture.tableUrl]);
    await browser(['wait', '#btn-allin-only:not([hidden]):not([disabled])']);
    await browser(['snapshot', '-i']);
    const shortLegal = shortSnapshot.view.legal;
    const shortUi = await evaluate(`(() => ({
      normalHidden: document.querySelector('#btn-raise').hidden,
      allInHidden: document.querySelector('#btn-allin-only').hidden,
      amount: Number(document.querySelector('#btn-allin-only .num').textContent.replaceAll(',', '')),
    }))()`);
    check('short-all-in', shortLegal.minRaiseTo > shortLegal.maxRaiseTo && shortUi.normalHidden
      && !shortUi.allInHidden && shortUi.amount === shortLegal.maxRaiseTo);
    await browser(['screenshot', path.join(output, 'short-all-in-mobile.png')]);
    const { promise: shortDelivery } = await beginDelivery(shortFixture);
    await browser(['click', '#btn-allin-only']);
    await shortFixture.applyReceivedAction(await shortDelivery);
    await recordBrowserErrors('short-stack-table');

    await setViewport(390, 844);
    await browser(['open', fixture.tableUrl]);
    await browser(['wait', '#study-open:not([hidden])']);
    const renderedStudyUrl = await evaluate('document.querySelector("#study-open")?.getAttribute("href") ?? null');
    assert.equal(renderedStudyUrl, fixture.studyUrl, 'study navigation must come from the authenticated rendered link');
    await browser(['open', renderedStudyUrl]);
    await browser(['wait', '#start:not([disabled])']);
    await browser(['snapshot', '-i']);
    await waitForExpression('document.querySelector("#source").textContent.includes("휴리스틱")', 'study summary');
    const authEvidence = await evaluate(`(async () => {
      const denied = await fetch('/api/summary');
      const apiUrls = performance.getEntriesByType('resource').map((entry) => entry.name)
        .filter((value) => new URL(value).pathname.startsWith('/api/'));
      return /^#token=[0-9a-f]{64}$/.test(location.hash) && denied.status === 401
        && apiUrls.length > 0 && apiUrls.every((value) => !new URL(value).searchParams.has('token'));
    })()`);
    check('study-fragment-header-auth', authEvidence);
    assert.equal(await evaluate('document.querySelector("#mode").options.length'), 6);
    await browser(['select', '#mode', 'assessment']);
    await browser(['click', '#start']);
    await browser(['wait', '#actions button:not([disabled])']);
    await browser(['snapshot', '-i']);
    const assessmentStarted = await evaluate('document.querySelector("#run-progress").textContent.includes("새 문제 평가")');
    await browser(['click', '#actions button:not([disabled])']);
    await browser(['wait', '#next:not([hidden])']);
    await browser(['reload']);
    await browser(['wait', '#feedback:not([hidden])']);
    const mobileFeedback = await evaluate('!document.querySelector("#next").hidden && !document.querySelector("#feedback").hidden');

    await setViewport(1280, 900);
    await browser(['click', '#next']);
    await browser(['wait', '#actions button:not([disabled])']);
    await browser(['snapshot', '-i']);
    await browser(['click', '#actions button:not([disabled])']);
    await browser(['wait', '#next:not([hidden])']);
    await browser(['reload']);
    await browser(['wait', '#feedback:not([hidden])']);
    const desktopFeedback = await evaluate('!document.querySelector("#next").hidden && !document.querySelector("#feedback").hidden');
    check('study-feedback-refresh', mobileFeedback && desktopFeedback,
      { observedViewports: ['390x844', '1280x900'] });

    let terminalAfterFinalAnswer = false;
    let completedSummaryBeforeFinish = false;
    for (let question = 0; question < 12; question += 1) {
      terminalAfterFinalAnswer = await evaluate(`document.querySelector('#run-progress').textContent.includes('10 / 10')
        && document.querySelector('#prompt').textContent.includes('마지막 답안')
        && document.querySelector('#context').textContent.includes('연습을 마무리')
        && document.querySelector('#next').textContent === '연습 마무리'`);
      if (terminalAfterFinalAnswer) {
        await waitForExpression(`document.querySelector('#run-progress').textContent.includes('10 / 10')
          && document.querySelector('#prompt').textContent.includes('마지막 답안')
          && [...document.querySelectorAll('#assessments .assessment')].some((card) =>
            card.textContent.includes('10 / 10문항') && card.textContent.includes('완료 · 기준표 참고 측정치'))`,
        'authoritative completed assessment summary before finish');
        completedSummaryBeforeFinish = true;
        break;
      }
      const hasNext = await evaluate('!document.querySelector("#next").hidden');
      if (!hasNext) break;
      await browser(['click', '#next']);
      await waitForExpression(`document.querySelector('#actions button:not([disabled])')
        || document.querySelector('#prompt').textContent.includes('완료했습니다')`, 'next study question');
      const hasAnswer = await evaluate('Boolean(document.querySelector("#actions button:not([disabled])"))');
      if (!hasAnswer) break;
      await browser(['click', '#actions button:not([disabled])']);
      await browser(['wait', '#next:not([hidden])']);
    }
    assert.equal(terminalAfterFinalAnswer && completedSummaryBeforeFinish, true,
      'the final answer must bind authoritative completion and summary before finish or retest');
    await browser(['screenshot', path.join(output, 'study-final-answer-desktop.png')]);
    await browser(['click', '#next']);
    await waitForExpression('document.querySelector("#prompt").textContent.includes("완료했습니다")', 'explicit assessment finish');
    await waitForExpression('document.querySelector("#assessments button")?.disabled === true', 'assessment retest summary');
    const summaryEvidence = await evaluate(`document.querySelector('#source').textContent.includes('휴리스틱')
      && document.querySelector('#goal').textContent.length > 10
      && document.querySelector('#assessments').textContent.includes('재평가 가능 시각')
      && document.querySelector('#assessments button').disabled`);
    await browser(['select', '#mode', 'retest']);
    await browser(['click', '#start']);
    await waitForExpression('document.querySelector("#status").textContent.includes("24시간")', 'early retest rejection');
    const retestRejected = await evaluate('document.querySelector("#status").textContent.includes("24시간")');
    const terminalAfterRetest = await evaluate(`document.querySelector('#run-progress').textContent.includes('10 / 10')
      && document.querySelector('#prompt').textContent.includes('마지막 답안')
      && document.querySelector('#context').textContent.includes('연습을 마무리')
      && document.querySelector('#next').textContent === '연습 마무리'`);
    check('study-explicit-modes', assessmentStarted && retestRejected,
      { observedViewports: ['390x844', '1280x900'] });
    check('study-source-goal-retest', summaryEvidence
      && retestRejected && terminalAfterFinalAnswer && completedSummaryBeforeFinish && terminalAfterRetest);
    await browser(['screenshot', path.join(output, 'study-desktop.png')]);
    await setViewport(390, 844);
    await browser(['screenshot', path.join(output, 'study-mobile.png')]);
    await recordBrowserErrors('study');

    const reviewFixture = registerFixture(await createReviewBrowserFixture());
    const reviewRun = reviewFixture.start();
    await setViewport(390, 844);
    await browser(['open', reviewFixture.tableUrl]);
    await browser(['wait', '#btn-fold:not([disabled])']);
    await browser(['snapshot', '-i']);
    await browser(['click', '#btn-fold']);
    await reviewFixture.waitDone();
    await reviewRun;
    await browser(['wait', '#review-overlay:not([hidden])']);
    const mobileGeometry = await evaluate(`(() => {
      const card = document.querySelector('#review-overlay .review-card').getBoundingClientRect();
      return { documentWidth: document.documentElement.scrollWidth, cardLeft: card.left,
        cardRight: card.right, cardWidth: card.width, viewportWidth: innerWidth };
    })()`);
    const mobileLayout = mobileGeometry.documentWidth <= 390 && mobileGeometry.cardWidth <= 370
      && mobileGeometry.cardLeft >= 0 && mobileGeometry.cardRight <= mobileGeometry.viewportWidth;
    await browser(['focus', '#review-close']);
    await browser(['press', 'Enter']);
    await browser(['wait', '750']);
    const mobileClosed = await evaluate(`document.querySelector('#review-overlay').hidden
      && document.querySelector('#review-overlay').dataset.dismissed === 'true'
      && !document.querySelector('#review-reopen').hidden
      && document.activeElement.id === 'review-reopen'`);
    await browser(['press', 'Enter']);
    const mobileReopened = await evaluate('!document.querySelector("#review-overlay").hidden && document.activeElement.id === "review-close"');
    await browser(['screenshot', path.join(output, 'review-reopened-mobile.png')]);
    await setViewport(1280, 900);
    await browser(['focus', '#review-close']);
    await browser(['press', 'Enter']);
    const desktopClosed = await evaluate(`document.querySelector('#review-overlay').hidden
      && !document.querySelector('#review-reopen').hidden
      && document.activeElement.id === 'review-reopen'`);
    await browser(['press', 'Enter']);
    const desktopReopened = await evaluate('!document.querySelector("#review-overlay").hidden && document.activeElement.id === "review-close"');
    check('review-reopen-unread', unreadMobile && unreadObserved && mobileLayout && mobileClosed
      && mobileReopened && desktopClosed && desktopReopened,
    { observedViewports: ['390x844', '1280x900'], mobileGeometry });
    await browser(['screenshot', path.join(output, 'review-reopened.png')]);
    await recordBrowserErrors('review');
    check('no-uncaught-errors', pageErrors.length === 0,
      { observedViewports: ['1280x900', '390x844'] });
    if (result.pending.some((name) => name !== 'real-user-store-unchanged')) result.blocked = 'COMBINED_BACKEND_SCENARIOS_PENDING';
  } catch (error) {
    result.error = sanitize(error.message);
  } finally {
    const cleanupErrors = [];
    if (browserStarted) try { await browser(['close']); } catch (error) { cleanupErrors.push(sanitize(error.message)); }
    for (const owned of fixtures.reverse()) {
      try { await owned.close(); } catch (error) { cleanupErrors.push(sanitize(error.message)); }
    }
    const protectedAfter = inspectProtectedUserStore(protectedBefore.path);
    result.userStore = protectedUserStoreResult(protectedBefore, protectedAfter);
    if (result.userStore.unchanged) check('real-user-store-unchanged', true, { observedViewports: [] });
    result.cleanup = { pass: cleanupErrors.length === 0, errors: cleanupErrors };
    result.pass = !result.blocked && !result.error && result.pending.length === 0 && result.cleanup.pass && result.userStore.unchanged;
    fs.writeFileSync(path.join(output, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return result;
}

function canonicalPath(value) {
  let current = path.resolve(value);
  const suffix = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current)); current = parent;
    }
  }
}

export function inspectProtectedUserStore(value = DEFAULT_USER_STORE) {
  const canonical = canonicalPath(value);
  try {
    const stat = fs.lstatSync(canonical);
    const directory = stat.isDirectory() && !stat.isSymbolicLink();
    return { path: canonical, exists: true, directory, digest: directory ? hashTree(canonical) : null };
  } catch (error) {
    if (error.code === 'ENOENT') return { path: canonical, exists: false, directory: false, digest: null };
    throw error;
  }
}

export function protectedUserStoreResult(before, after) {
  return {
    path: before.path,
    beforeExists: before.exists,
    afterExists: after.exists,
    before: before.digest,
    after: after.digest,
    unchanged: before.exists && after.exists && before.directory && after.directory
      && before.path === after.path && before.digest === after.digest,
  };
}

export function parseJourneyArgs(argv) {
  const parsed = { outDir: null, userStoreDir: DEFAULT_USER_STORE };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--out-dir', '--user-store-dir'].includes(option)) throw new Error(`unknown browser journey option: ${option}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`${option} requires a value`);
    parsed[option === '--out-dir' ? 'outDir' : 'userStoreDir'] = value;
    index += 1;
  }
  return parsed;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !browserCliEnabled()) process.stdout.write('BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT\n');
else if (direct) {
  const args = parseJourneyArgs(process.argv.slice(2));
  const result = await runLearningJourney(args);
  process.stdout.write(`${JSON.stringify({ pass: result.pass, pending: result.pending, blocked: result.blocked, error: result.error })}\n`);
  if (!result.pass) process.exitCode = 1;
}
