// #274 at the loop boundary: a relay that refuses a recorded explanatory annotation must
// neither be restarted as if it were down, nor hold the next game action hostage, nor let an
// applied engine step be repeated or published out of order. The real loop, real relay, real
// publisher and real engine run; only the LLM player is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createGameLoop } from '../tools/game-loop.js';
import { gameEpochOf, recheckRejectionTupleOf, rejectionTupleOf } from '../publish-contract.js';
import { serverProcessStartTime } from '../engine/state.js';
import { createTrainingControl } from '../tools/training-control.js';
import * as pipeline from '../tools/training-pipeline.js';
import { q3Evaluation } from './helpers/q3-fixtures.js';
import {
  ROOT,
  WIN32_SCALE,
  TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES,
  makeAdapter,
  putAiFirst,
  readJson,
  readLoopLog,
  resolverFor,
  startRun,
  stopRun,
  tmpGame,
  waitFor,
  waitForUserSnapshot,
} from './helpers/game-loop-fixtures.mjs';

const PUBLISH_CLI = path.join(ROOT, 'tools/publish.js');
const TIMEOUT = 40_000 * WIN32_SCALE;
const EXPLANATION = '이 스팟에서는 레이즈가 주력입니다.';
const DRIFTED_DIGEST = 'ab'.repeat(32);
const attemptFile = (dir) => path.join(dir, '.publish-attempt.json');
const rejectionLog = (dir) => path.join(dir, '.publish-rejections.jsonl');

function runPublisher(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PUBLISH_CLI, ...args, '--game-dir', dir], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(Object.assign(new Error(envelope?.message ?? 'publisher failed'), {
          code: envelope?.code ?? error?.code ?? 'CHILD_FAILED', envelope,
        }));
        return;
      }
      resolve(envelope);
    });
  });
}

// A sealed explanation waiting in the queue. With `publishMachine` the relay holds the machine
// row, but the local item then names a different payload digest than the relay's: the relay
// refuses the annotation as a proof mismatch (400), a verdict on the exact body alone.
// Without it the relay has no machine row and refuses the annotation as an orphan (409) — a
// refusal that may still change once that row arrives.
async function seedExplanation(gameDir, { publishMachine, drift = true }) {
  const sessionToken = readJson(path.join(gameDir, 'state.json')).sessionToken;
  const epoch = gameEpochOf(sessionToken);
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const tc = createTrainingControl();
  const evaluation = q3Evaluation(epoch);
  await tc.acceptEvaluations(gameDir, { gameEpoch: epoch, owner, handNo: 1, evaluations: [evaluation] });
  if (publishMachine) {
    await pipeline.flushMachinePublish(gameDir, {
      gameEpoch: epoch, executePublish: (args) => runPublisher(gameDir, args), trainingControl: tc,
    });
  }
  const sealed = await tc.sealAnnotation(gameDir, evaluation.evaluationId, 'explanation', EXPLANATION);
  assert.equal(sealed.ok, true);
  if (publishMachine && drift) {
    const authFile = path.join(gameDir, 'training', '.training-authority.json');
    const drifted = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    drifted.items[evaluation.evaluationId].payloadSha256 = DRIFTED_DIGEST;
    fs.writeFileSync(authFile, JSON.stringify(drifted));
  }
  return { tc, evaluation, epoch };
}

// Leaves exactly what a rejected first publish leaves: a recorded attempt and no ack.
async function leavePendingAttempt(gameDir, tc, epoch) {
  await pipeline.flushAnnotationPublish(gameDir, {
    gameEpoch: epoch, executePublish: (args) => runPublisher(gameDir, args), trainingControl: tc,
  }).then(() => assert.fail('the annotation must have been refused'), (error) => {
    assert.equal(error.code, 'PUBLISH_REJECTED');
    return error;
  });
  assert.equal(fs.existsSync(attemptFile(gameDir)), true);
}

function newLoop(t, gameDir, adapter, extra = {}) {
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(adapter),
    opts: {
      port: 0, waitMs: 0, trainingEnabled: true,
      scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES, ...extra,
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  return loop;
}

const logEvents = (gameDir, name) => readLoopLog(gameDir).filter((row) => row.event === name);

test('a refused explanation pending when the AI acts is retired: relay kept, action applied and published once, in order', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  let armed = null;
  const engineCalls = [];
  const invocations = [];
  let retired = false;
  let actionPublished = false;
  let publishedAtDecision = null;
  const adapter = makeAdapter({
    onDecide: async (input) => {
      // The incident's shape: the refused attempt is on disk when the AI's action is published.
      publishedAtDecision = readJson(path.join(gameDir, 'ui-snapshot.json')).publishId;
      if (armed) await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    onEngineInvoke: (args) => engineCalls.push(args.slice(0, 3).join(' ')),
    // Stops the run at the first publish after the AI's action, so what the relay holds is
    // exactly that action and nothing later.
    onPublishInvoke: (args) => {
      invocations.push(args.filter((arg) => arg.startsWith('--')).join(' '));
      if (actionPublished) throw Object.assign(new Error('halt after the action'), { code: 'TEST_HALT' });
      if (args.includes('--retire-rejected')) retired = true;
      else if (retired && !args.includes('--retry')) actionPublished = true;
    },
  });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  armed = await seedExplanation(gameDir, { publishMachine: true });
  const lockBefore = readJson(path.join(gameDir, 'lock.json'));

  const failure = await startRun(loop).then(() => null, (error) => error);
  assert.equal(failure?.code, 'TEST_HALT', 'the run should reach the first publish after the action');
  const lockAfter = readJson(path.join(gameDir, 'lock.json'));
  await loop.requestStop();

  const retiredEvent = logEvents(gameDir, 'training-annotation-retired')[0];
  assert.deepEqual([retiredEvent.httpStatus, retiredEvent.serverCode, retiredEvent.dropped], [400, 'ANNOTATION_PROOF_MISMATCH', 1]);
  assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'a semantic refusal must not restart the relay');
  assert.equal(logEvents(gameDir, 'server-recovery-verified').length >= 1, true, 'the relay must be re-verified before retiring');
  assert.equal(lockAfter.serverPid, lockBefore.serverPid, 'the same relay process served both publishes');
  assert.equal(lockAfter.port, lockBefore.port);
  assert.equal(adapter.decideCalls.length, 1, 'the model is not asked again');
  const state = readJson(path.join(gameDir, 'state.json'));
  const folds = [...(state.hand?.actions ?? []), ...(state.lastHand?.actions ?? [])].filter((a) => a.playerId !== 'user' && a.action === 'fold');
  assert.equal(folds.length, 1, 'an applied engine action must not be repeated');
  assert.equal(engineCalls.filter((call) => call === 'step p1 fold').length, 1, 'the engine step ran once');
  // Order of publisher calls: the action's publish meets the pending body, that body is
  // retried and retired, and only then does the action's own publish go out.
  const at = invocations.findIndex((row) => row.includes('--retire-rejected'));
  assert.ok(at >= 2, JSON.stringify(invocations));
  assert.equal(invocations[at - 1].includes('--retry'), true, 'the pending body was retried first');
  assert.equal(invocations[at + 1].includes('--retry') || invocations[at + 1].includes('--retire-rejected'), false,
    'the action then publishes as itself, not as another retry');
  assert.equal(invocations.filter((row) => row.includes('--retire-rejected')).length, 1, 'retired exactly once');
  const audit = fs.readFileSync(rejectionLog(gameDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].expectedGameEpoch, armed.epoch);
  assert.equal(audit[0].publishId, publishedAtDecision + 1);
  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(snapshot.publishId, audit[0].publishId, 'the refused body never consumed its id; the action took it');
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).lastPublishId, audit[0].publishId);
  assert.deepEqual(Object.keys(snapshot.trainingAnnotations ?? {}), [], 'the refused annotation never reached the relay state');
  const auth = armed.tc.loadAuthority(gameDir);
  assert.equal(auth.annotationQueue[armed.evaluation.evaluationId], undefined);
  assert.equal(auth.items[armed.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
});

test('a refusal that may still change blocks explicitly, keeps everything, and stays explicit after a restart', { timeout: TIMEOUT * 2 }, async (t) => {
  const gameDir = tmpGame();
  let armed = null;
  const adapter = makeAdapter({
    onDecide: async (input) => {
      if (armed) await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter);
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  armed = await seedExplanation(gameDir, { publishMachine: false });

  const failure = await startRun(loop).then(() => null, (error) => error);

  assert.equal(failure?.code, 'PENDING_ANNOTATION_BLOCKED');
  assert.deepEqual(
    { httpStatus: failure.details.httpStatus, serverCode: failure.details.serverCode, pending: failure.details.pending },
    { httpStatus: 409, serverCode: 'ANNOTATION_ORPHAN', pending: 'annotation' },
  );
  assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'ordering is not a transport failure');
  assert.equal(fs.existsSync(attemptFile(gameDir)), true, 'the pending attempt must be kept');
  assert.equal(fs.existsSync(rejectionLog(gameDir)), false, 'nothing was retired');
  assert.ok(armed.tc.loadAuthority(gameDir).annotationQueue[armed.evaluation.evaluationId]?.explanation, 'the queue entry must be kept');
  // The applied AI action is on disk and recorded as an applied-but-unpublished sample with
  // the relay's answer attached — neither hidden nor repeated.
  const state = readJson(path.join(gameDir, 'state.json'));
  const folds = [...(state.hand?.actions ?? []), ...(state.lastHand?.actions ?? [])].filter((a) => a.playerId !== 'user' && a.action === 'fold');
  assert.equal(folds.length, 1);
  const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics.at(-1);
  assert.equal(metric.publishError, 'PENDING_ANNOTATION_BLOCKED');
  assert.deepEqual(metric.publishRejection, { httpStatus: 409, serverCode: 'ANNOTATION_ORPHAN' });
  await loop.requestStop();
  assert.equal(readJson(path.join(gameDir, 'loop-state.json')).cleanupError, undefined, 'a clean stop records no cleanup failure');
});

test('after a restart a refusal that may still change blocks the same explicit way and touches nothing', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const first = newLoop(t, gameDir, makeAdapter());
  await first.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const armed = await seedExplanation(gameDir, { publishMachine: false });
  await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
  await first.requestStop();
  const attemptBytes = fs.readFileSync(attemptFile(gameDir), 'utf8');

  const adapter = makeAdapter();
  const restarted = newLoop(t, gameDir, adapter);
  await restarted.resume();
  const failure = await startRun(restarted).then(() => null, (error) => error);

  assert.equal(failure?.code, 'PENDING_ANNOTATION_BLOCKED');
  assert.equal(fs.readFileSync(attemptFile(gameDir), 'utf8'), attemptBytes, 'the recorded body is untouched');
  const retryError = logEvents(gameDir, 'training-attempt-retry-error').at(-1);
  assert.equal(retryError.code, 'PENDING_ANNOTATION_BLOCKED');
  assert.deepEqual(retryError.rejection, { httpStatus: 409, serverCode: 'ANNOTATION_ORPHAN' });
  assert.equal(adapter.decideCalls.length, 0);
  assert.equal(fs.existsSync(rejectionLog(gameDir)), false);
  assert.ok(armed.tc.loadAuthority(gameDir).annotationQueue[armed.evaluation.evaluationId]?.explanation);
});

test('after a restart the recorded refusal is retired at the first publish and play reaches the user', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const first = newLoop(t, gameDir, makeAdapter());
  await first.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  const armed = await seedExplanation(gameDir, { publishMachine: true });
  await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
  const recorded = readJson(attemptFile(gameDir));
  await first.requestStop();

  const adapter = makeAdapter();
  const restarted = newLoop(t, gameDir, adapter);
  await restarted.resume();
  const running = startRun(restarted);
  await waitForUserSnapshot(gameDir, 25_000 * WIN32_SCALE);
  await restarted.requestStop();
  await running.catch(() => {});

  assert.equal(logEvents(gameDir, 'training-attempt-retry-error').length, 0, 'resume must not log a retry error for a retired attempt');
  assert.equal(logEvents(gameDir, 'server-recovered').length, 0);
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const audit = fs.readFileSync(rejectionLog(gameDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(audit.length, 1);
  assert.equal(audit[0].publishId, recorded.body.publishId);
  assert.equal(armed.tc.loadAuthority(gameDir).annotationQueue[armed.evaluation.evaluationId], undefined);
});

// #274 lifetime contract (5) at the loop boundary: the relay refuses the recorded explanation
// (400 ANNOTATION_PROOF_MISMATCH) when the AI's action is published, and the re-verification
// of the relay that the retirement requires then fails (the OS pid↔port check cannot be
// completed). That failure ends the run under its own code — but the first refusal's closed
// status/code stays beside it in the run failure, the applied-action metric and the error
// itself, nothing is resent or retired, and no text reaches any of them.
test('a relay verification failure during the retirement keeps the first refusal beside its own code in the run failure, the metric and the error, and sends nothing', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  let armed = null;
  let failVerification = false;
  let verificationFailures = 0;
  const invocations = [];
  const adapter = makeAdapter({
    onDecide: async (input) => {
      if (armed) {
        await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
        failVerification = true; // from here on the OS check behind the relay re-verification fails
      }
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    onPublishInvoke: (args) => invocations.push(args.filter((arg) => arg.startsWith('--')).join(' ')),
    listenerOwnedBy: async () => {
      if (!failVerification) return true;
      verificationFailures += 1;
      throw Object.assign(new Error('os verification unavailable'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
    },
  });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  armed = await seedExplanation(gameDir, { publishMachine: true });
  const lockBefore = readJson(path.join(gameDir, 'lock.json'));

  const failure = await startRun(loop).then(() => null, (error) => error);
  const runFailure = loop.runFailure;
  const attemptBytes = fs.readFileSync(attemptFile(gameDir), 'utf8');

  assert.equal(failure?.code, 'SERVER_LISTENER_UNAVAILABLE', 'the verification failure is the failure');
  assert.ok(verificationFailures >= 1, 'the retirement re-verified the relay and that failed');
  const first = { httpStatus: 400, serverCode: 'ANNOTATION_PROOF_MISMATCH' };
  assert.deepEqual(rejectionTupleOf(failure), first, 'the error carries the first refusal');
  assert.equal(recheckRejectionTupleOf(failure), null);
  assert.deepEqual(runFailure, { code: 'SERVER_LISTENER_UNAVAILABLE', rejection: first }, 'the run failure keeps both');
  const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics.at(-1);
  assert.equal(metric.publishError, 'SERVER_LISTENER_UNAVAILABLE');
  assert.deepEqual(metric.publishRejection, first, 'the applied action\'s metric keeps the first refusal');
  assert.equal(metric.publishRecheckRejection, undefined);
  assert.equal(invocations.some((row) => row.includes('--retire-rejected')), false, 'nothing was retired or resent');
  assert.equal(invocations.some((row) => row.includes('--retry')), true, 'the recorded body was retried and refused first');
  assert.equal(fs.existsSync(rejectionLog(gameDir)), false);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-retirement.json')), false);
  assert.ok(JSON.parse(attemptBytes).body.trainingAnnotations.length === 1, 'the refused attempt is kept');
  assert.ok(armed.tc.loadAuthority(gameDir).annotationQueue[armed.evaluation.evaluationId]?.explanation, 'the queue entry is kept');
  assert.equal(logEvents(gameDir, 'training-annotation-retired').length, 0);
  assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'a semantic refusal still never restarts the relay');
  assert.deepEqual([readJson(path.join(gameDir, 'lock.json')).serverPid, readJson(path.join(gameDir, 'lock.json')).port], [lockBefore.serverPid, lockBefore.port]);
  for (const object of [failure.rejection, runFailure, metric]) {
    assert.equal(JSON.stringify(object).includes(EXPLANATION), false, 'no annotation text in any diagnostic');
  }
  failVerification = false; // the OS check is back for the stop's own relay verification
  await loop.requestStop();
});

// #274 lifetime contract (2): a NONSEMANTIC refusal (500 FORBIDDEN_LITERAL_UNAVAILABLE, for
// example) enters the loop's automatic recovery — relay verification, then a retry. Whatever
// ends that recovery keeps the first closed status/code beside its own code, and a different
// answer from the retry is kept as the one recheck tuple: in the error, the run failure, the
// applied-action metric and the cleanup diagnostics. The relay's answers are scripted through
// the publish CLI seam; the loop, engine and relay are real.
const shimReply = (httpStatus, serverCode) => ({ ok: false, code: 'PUBLISH_REJECTED', httpStatus, serverCode, message: 'PRIVATE_As_Kh_shim_text' });

// The shim and its plan live in their own owned directory, never inside the game directory
// the loop is about to initialize. The generated script is syntax-checked by node itself.
function scriptedPublisher(shimDir) {
  const plan = path.join(shimDir, '.publish-shim-plan.json');
  const last = path.join(shimDir, '.publish-shim-last.json');
  const shim = path.join(shimDir, '.publish-shim.cjs');
  fs.writeFileSync(shim, [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    `const REAL = ${JSON.stringify(PUBLISH_CLI)};`,
    `const PLAN = ${JSON.stringify(plan)};`,
    `const LAST = ${JSON.stringify(last)};`,
    'const args = process.argv.slice(2);',
    'fs.writeFileSync(LAST, JSON.stringify(args));',
    "const kind = args.includes('--retire-rejected') ? 'retire' : args.includes('--retry') ? 'retry' : 'fresh';",
    "let steps = []; try { steps = JSON.parse(fs.readFileSync(PLAN, 'utf8')); } catch {}",
    'if (steps.length && steps[0].when === kind) {',
    '  const step = steps.shift(); fs.writeFileSync(PLAN, JSON.stringify(steps));',
    "  process.stdout.write(JSON.stringify(step.reply) + '\\n'); process.exitCode = 1;",
    '} else {',
    "  const run = spawnSync(process.execPath, [REAL, ...args], { stdio: 'inherit' });",
    '  process.exitCode = run.status ?? 1;',
    '}',
    '',
  ].join('\n'));
  const generated = fs.readFileSync(shim, 'utf8');
  assert.ok(generated.split('\n').length >= 12, 'the generated script has real code newlines');
  assert.equal(generated.includes("+ '\\n'"), true, 'the scripted reply ends with a real stdout newline');
  execFileSync(process.execPath, ['--check', shim], { stdio: 'ignore' });
  return {
    shim,
    arm: (steps) => fs.writeFileSync(plan, JSON.stringify(steps)),
    remaining: () => { try { return JSON.parse(fs.readFileSync(plan, 'utf8')); } catch { return null; } },
    lastArgs: () => JSON.parse(fs.readFileSync(last, 'utf8')),
  };
}

// The closed identity a failed publisher request reports for the record it carried.
const SCRIPTED_ATTEMPT = Object.freeze({ bodySha256: 'cd'.repeat(32), publishId: 7, expectedGameEpoch: 'ef'.repeat(32) });
const bindingOf = (args) => {
  const sha = args.indexOf('--expect-attempt-sha256');
  const epoch = args.indexOf('--expect-game-epoch');
  return sha >= 0 && epoch >= 0 ? { bodySha256: args[sha + 1], expectedGameEpoch: args[epoch + 1] } : null;
};

for (const scenario of [
  {
    name: 'relay verification fails after the first refusal',
    steps: [{ when: 'fresh', reply: { ...shimReply(500, 'FORBIDDEN_LITERAL_UNAVAILABLE'), attempt: SCRIPTED_ATTEMPT } }],
    failVerification: true,
    code: 'SERVER_LISTENER_UNAVAILABLE',
    recheck: null,
    retried: false,
  },
  {
    name: 'the retry answers with a different refusal',
    steps: [{ when: 'fresh', reply: { ...shimReply(500, 'FORBIDDEN_LITERAL_UNAVAILABLE'), attempt: SCRIPTED_ATTEMPT } }, { when: 'retry', reply: shimReply(400, 'FORBIDDEN_LITERAL') }],
    failVerification: false,
    code: 'PUBLISH_REJECTED',
    recheck: { httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL' },
    retried: true,
  },
  {
    // A failed request that reported no record identity cannot be resent safely: the loop
    // fails closed with its own code, keeps the first refusal, and sends nothing.
    name: 'the failed request reported no record identity',
    steps: [{ when: 'fresh', reply: shimReply(500, 'FORBIDDEN_LITERAL_UNAVAILABLE') }],
    failVerification: false,
    code: 'RETRY_BINDING_REQUIRED',
    recheck: null,
    retried: false,
  },
]) {
  test(`a nonsemantic first refusal keeps its closed tuple across automatic recovery (${scenario.name}): error, run failure, metric and cleanup diagnostics`, { timeout: TIMEOUT }, async (t) => {
    const gameDir = tmpGame();
    const scripted = scriptedPublisher(tmpGame());
    let armed = false;
    let failVerification = false;
    const invocations = [];
    const closeState = { closes: false, disposals: 0 };
    const adapter = makeAdapter({
      onDecide: async (input) => {
        // The AI's action: its publication is the next fresh publish, answered as scripted.
        scripted.arm(scenario.steps);
        armed = true;
        if (scenario.failVerification) failVerification = true;
        const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
        return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
      },
    });
    adapter.dispose = async () => {
      closeState.disposals += 1;
      if (!closeState.closes) throw Object.assign(new Error('close'), { code: 'CHILD_CLOSE_UNCONFIRMED', details: { pid: 4242 } });
    };
    const loop = newLoop(t, gameDir, adapter, {
      publishCliPath: scripted.shim,
      onPublishInvoke: (args) => invocations.push([...args]),
      listenerOwnedBy: async () => {
        if (failVerification) throw Object.assign(new Error('os verification unavailable'), { code: 'SERVER_LISTENER_UNAVAILABLE' });
        return true;
      },
    });
    t.after(() => { closeState.closes = true; });
    await loop.bootstrap({ ai: 1, stack: 100 });
    putAiFirst(gameDir);

    const failure = await startRun(loop).then(() => null, (error) => error);
    const runFailure = loop.runFailure;
    const first = { httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' };

    assert.ok(armed, 'the AI acted');
    assert.deepEqual(scripted.remaining(), [], 'every scripted answer was consumed');
    assert.equal(failure?.code, scenario.code, `the later failure is the failure: ${failure?.code}`);
    const retries = invocations.filter((args) => args.includes('--retry'));
    assert.equal(retries.length, scenario.retried ? 1 : 0, 'the automatic resend happens once, or not at all');
    if (scenario.retried) {
      assert.deepEqual(bindingOf(retries[0]), { bodySha256: SCRIPTED_ATTEMPT.bodySha256, expectedGameEpoch: SCRIPTED_ATTEMPT.expectedGameEpoch },
        'the automatic resend is bound to exactly the record the failed request reported');
    }
    assert.deepEqual(rejectionTupleOf(failure), first, 'the first nonsemantic refusal travels on the error');
    assert.deepEqual(recheckRejectionTupleOf(failure), scenario.recheck);
    assert.deepEqual(runFailure, { code: scenario.code, rejection: first, ...(scenario.recheck ? { recheckRejection: scenario.recheck } : {}) });
    const metric = readJson(path.join(gameDir, 'loop-state.json')).metrics.at(-1);
    assert.equal(metric.publishError, scenario.code);
    assert.deepEqual(metric.publishRejection, first, 'the applied action\'s metric keeps the first refusal');
    assert.deepEqual(metric.publishRecheckRejection, scenario.recheck ?? undefined);
    assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'a verified live relay is not restarted');
    const state = readJson(path.join(gameDir, 'state.json'));
    const folds = [...(state.hand?.actions ?? []), ...(state.lastHand?.actions ?? [])].filter((a) => a.playerId !== 'user' && a.action === 'fold');
    assert.equal(folds.length, 1, 'the applied action is applied once');
    // Cleanup fails to confirm: the persisted cleanup diagnostics keep the run failure with both tuples.
    failVerification = false;
    await assert.rejects(loop.requestStop(), { code: 'CHILD_CLOSE_UNCONFIRMED' });
    const persisted = readJson(path.join(gameDir, 'loop-state.json')).cleanupError;
    assert.equal(persisted.code, 'CHILD_CLOSE_UNCONFIRMED');
    assert.deepEqual(persisted.runError, runFailure, 'the cleanup diagnostics keep the run failure, first refusal and recheck included');
    for (const object of [failure.rejection, failure.recheckRejection ?? null, runFailure, metric, persisted.runError]) {
      assert.equal(JSON.stringify(object).includes('As_Kh'), false, 'no relay text in any diagnostic');
    }
    closeState.closes = true;
    await loop.requestStop();
  });
}

// #274 lifetime contract (3): the automatic resend after a nonsemantic refusal is bound to the
// exact record the failed request carried, never to whichever record exists when the recovery
// resumes. While the loop awaits its relay verification, the refused record A is gone and
// another publisher has recorded B — an actual transport failure with a real record. The resend
// is refused unsent under the publisher lock (ATTEMPT_CHANGED): nothing is marked from B, A's
// run fails explicitly with its first refusal kept, B's record is untouched, and B's own bound
// retry still publishes B. The loop, engine, relay and publisher are real; only A's refusal is
// scripted.
test('an automatic resend is bound to the refused record: a record replaced during recovery is left unsent, nothing is marked from it, and it keeps its own path', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const scripted = scriptedPublisher(tmpGame());
  const A = { bodySha256: 'cd'.repeat(32), publishId: 7, expectedGameEpoch: null };
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  let gateReached;
  const reached = new Promise((resolve) => { gateReached = resolve; });
  let armed = false;
  let baseline = null; // the last accepted publication id, read at the recovery gate
  const invocations = [];
  const adapter = makeAdapter({
    onDecide: async (input) => {
      A.expectedGameEpoch = gameEpochOf(readJson(path.join(gameDir, 'state.json')).sessionToken);
      scripted.arm([{ when: 'fresh', reply: { ...shimReply(500, 'FORBIDDEN_LITERAL_UNAVAILABLE'), attempt: { ...A } } }]);
      armed = true;
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    publishCliPath: scripted.shim,
    onPublishInvoke: (args) => invocations.push([...args]),
    listenerOwnedBy: async () => {
      // The automatic recovery verifies the live relay here, before any resend: hold it. The
      // publications accepted so far (the run's initial one included) are on record by now.
      if (armed) {
        baseline = readJson(path.join(gameDir, 'loop-state.json')).lastPublishId ?? null;
        gateReached();
        await paused;
      }
      return true;
    },
  });
  t.after(() => release());
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);

  const running = startRun(loop).then(() => null, (error) => error);
  await reached;
  assert.ok(Number.isInteger(baseline) && baseline >= 1, 'the run\'s accepted publication is on record at the gate');
  assert.equal(fs.existsSync(attemptFile(gameDir)), false, 'A was refused and is gone before the recovery resumes');

  // Another publisher records B: the real publisher, an actual transport failure (the relay
  // port of the lock is a closed port for exactly this request), the record kept.
  const lastArgs = scripted.lastArgs();
  const fromPath = lastArgs[lastArgs.indexOf('--from') + 1];
  const lockPath = path.join(gameDir, 'lock.json');
  const liveLock = fs.readFileSync(lockPath, 'utf8');
  const down = http.createServer();
  await new Promise((resolve) => down.listen(0, '127.0.0.1', resolve));
  const deadPort = down.address().port;
  await new Promise((resolve) => down.close(resolve));
  fs.writeFileSync(lockPath, JSON.stringify({ ...JSON.parse(liveLock), port: deadPort }));
  let bFailure;
  try {
    bFailure = await runPublisher(gameDir, ['--from', fromPath]).then(() => null, (error) => error);
  } finally {
    fs.writeFileSync(lockPath, liveLock);
  }
  assert.equal(bFailure?.code, 'PUBLISH_FAILED', `B fails on transport: ${bFailure?.code}`);
  const B = bFailure.envelope.attempt;
  assert.match(B?.bodySha256 ?? '', /^[0-9a-f]{64}$/, 'the failed request reports the identity of the record it carried');
  assert.equal(B.expectedGameEpoch, A.expectedGameEpoch);
  assert.notEqual(B.bodySha256, A.bodySha256);
  assert.ok(Number.isInteger(B.publishId) && B.publishId !== A.publishId);
  const recordedB = fs.readFileSync(attemptFile(gameDir), 'utf8');
  assert.equal(JSON.parse(recordedB).body.publishId, B.publishId, 'B is the recorded pending attempt');

  release();
  const failure = await running;
  const runFailure = loop.runFailure;
  const first = { httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE' };

  assert.equal(failure?.code, 'ATTEMPT_CHANGED', `the resend is refused unsent: ${failure?.code}`);
  assert.deepEqual(rejectionTupleOf(failure), first, 'the first refusal travels on the error');
  assert.equal(recheckRejectionTupleOf(failure), null);
  assert.deepEqual(runFailure, { code: 'ATTEMPT_CHANGED', rejection: first });
  const retries = invocations.filter((args) => args.includes('--retry'));
  assert.equal(retries.length, 1);
  assert.deepEqual(bindingOf(retries[0]), { bodySha256: A.bodySha256, expectedGameEpoch: A.expectedGameEpoch }, 'the resend was bound to A, captured before the recovery awaited');
  assert.equal(fs.readFileSync(attemptFile(gameDir), 'utf8'), recordedB, 'B is left exactly as recorded, unsent');
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.equal(loopState.lastPublishId, baseline, 'nothing was marked as published from B: the last accepted id is the one read at the gate');
  assert.ok(baseline < B.publishId, 'B was allocated after the last accepted publication');
  assert.notEqual(loopState.lastPublishId, B.publishId);
  assert.notEqual(loopState.lastPublishId, A.publishId);
  const metric = loopState.metrics.at(-1);
  assert.equal(metric.publishError, 'ATTEMPT_CHANGED');
  assert.deepEqual(metric.publishRejection, first);
  assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'the verified live relay is not restarted');
  const state = readJson(path.join(gameDir, 'state.json'));
  const folds = [...(state.hand?.actions ?? []), ...(state.lastHand?.actions ?? [])].filter((a) => a.playerId !== 'user' && a.action === 'fold');
  assert.equal(folds.length, 1, 'the applied action is applied once');

  // B's own path: its caller resends it bound to B, and the accepted reply names B.
  const published = await runPublisher(gameDir, ['--from', fromPath, '--retry', '--expect-attempt-sha256', B.bodySha256, '--expect-game-epoch', B.expectedGameEpoch]);
  assert.equal(published.bodySha256, B.bodySha256);
  assert.equal(published.publishId, B.publishId);
  assert.equal(fs.existsSync(attemptFile(gameDir)), false, 'B was consumed by its own bound retry');
  for (const object of [failure.rejection, runFailure, metric]) {
    assert.equal(JSON.stringify(object).includes('As_Kh'), false, 'no relay text in any diagnostic');
  }
  await loop.requestStop();
});

// ---- R12 fixtures: a closed port for exactly one real publisher request, and a relay stand-in
// that refuses exactly one request with a nonsemantic 500 and hands the lock back before answering.
async function closedPort() {
  const down = http.createServer();
  await new Promise((resolve) => down.listen(0, '127.0.0.1', resolve));
  const port = down.address().port;
  await new Promise((resolve) => down.close(resolve));
  return port;
}
const lockPathOf = (gameDir) => path.join(gameDir, 'lock.json');
function swapLockPort(gameDir, port) {
  const live = fs.readFileSync(lockPathOf(gameDir), 'utf8');
  fs.writeFileSync(lockPathOf(gameDir), JSON.stringify({ ...JSON.parse(live), port }));
  return () => fs.writeFileSync(lockPathOf(gameDir), live);
}
// The real publisher, synchronously — for a seam the loop calls without awaiting. Its request
// goes to a closed port, never to a server of this process, so nothing here can deadlock.
function recordWithClosedPort(gameDir, deadPort, args) {
  const restore = swapLockPort(gameDir, deadPort);
  try {
    const run = spawnSync(process.execPath, [PUBLISH_CLI, ...args, '--game-dir', gameDir], { encoding: 'utf8', timeout: 20_000 });
    let envelope = null;
    try { envelope = JSON.parse(String(run.stdout).trim()); } catch { /* classified by the caller */ }
    return envelope;
  } finally {
    restore();
  }
}
// Refuses exactly the publisher's POST /api/publish, once, and hands the lock back to the real
// relay before that answer is read. Everything else that arrives while the lock names this
// stand-in (the test's own snapshot polling, for one) is forwarded to the real relay untouched —
// it neither consumes the refusal nor restores the lock.
// A scripted stand-in: each POST /api/publish consumes the next step of the script — a closed
// refusal {status, code}, or 'destroy' (the connection is torn down unanswered: an actual
// transport failure) — and hands the lock back to the real relay first. Steps are consumed by
// the publisher's POSTs only; once the script is spent, POSTs are forwarded like anything else.
function standInRelay(t, state, script) {
  const steps = [...script];
  const hits = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'POST' && pathname === '/api/publish' && steps.length) {
        const step = steps.shift();
        state.refused = true;
        state.restore?.(); // the lock names the real relay again before this answer is read
        state.restore = null;
        if (step === 'destroy') {
          hits.push({ method: req.method, pathname, refused: true, answer: 'destroyed', bytes: raw.length });
          req.socket.destroy();
          return;
        }
        hits.push({ method: req.method, pathname, refused: true, answer: step.status, bytes: raw.length });
        res.writeHead(step.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, code: step.code, message: 'PRIVATE_As_Kh_relay_text' }));
        return;
      }
      hits.push({ method: req.method, pathname, refused: false, bytes: raw.length });
      const upstream = http.request({ host: '127.0.0.1', port: state.realPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${state.realPort}` } }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"code":"STANDIN_FORWARD_FAILED"}'); });
      upstream.end(raw);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise((done) => server.close(done)));
      resolve({ port: server.address().port, hits, remaining: () => steps.length });
    });
  });
}
const refusingRelayOnce = (t, state) => standInRelay(t, state, [{ status: 500, code: 'FORBIDDEN_LITERAL_UNAVAILABLE' }]);
const metricOf = (gameDir, playerId) => readJson(path.join(gameDir, 'loop-state.json')).metrics.find((entry) => entry.playerId === playerId);
const foldsOf = (gameDir) => {
  const state = readJson(path.join(gameDir, 'state.json'));
  return [...(state.hand?.actions ?? []), ...(state.lastHand?.actions ?? [])].filter((a) => a.playerId !== 'user' && a.action === 'fold').length;
};

// R10 (Sol): the pending drain. After ATTEMPT_PENDING the loop drains the recorded body with an
// unbound --retry: whatever record the publisher finds under its own lock. The record the loop
// met (A) is settled by its owner before the loop looks again, and another publisher records a
// different body (B) before the loop's queued retry takes the publish lock — an actual
// transport failure, a real record. The drain publishes B. That is never the current
// transition's publication: the current turn is published next, in order, the engine step
// happens once, and the relay — not the publisher's progression fields — exposes the correct
// next decision. The loop, engine, relay and publisher are real.
test('pending drain race: A is settled before the loop looks and B is recorded before its retry — the drain publishes B, then the current turn is still published once, in order, and the relay shows the right next decision', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const preActionPath = path.join(gameDir, 'pre-action-envelope.json');
  const turnPath = path.join(gameDir, '.turn.json');
  let deadPort = null;
  let A = null;
  let B = null;
  let checkpoints = 0;
  const invocations = [];
  const adapter = makeAdapter({
    onDecide: async (input) => {
      if (!A) {
        // A: the pre-action turn, recorded by the real publisher on an actual transport failure.
        fs.copyFileSync(turnPath, preActionPath);
        const failed = recordWithClosedPort(gameDir, deadPort, ['--from', preActionPath]);
        assert.equal(failed?.code, 'PUBLISH_FAILED', `A is recorded on transport failure: ${failed?.code}`);
        A = failed.attempt;
        assert.match(A?.bodySha256 ?? '', /^[0-9a-f]{64}$/);
      }
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    async attemptPendingCheckpoint() {
      checkpoints += 1;
      // A's owner settles A before the loop looks again: the bound resend, accepted by the relay.
      const settled = await runPublisher(gameDir, ['--from', preActionPath, '--retry', '--expect-attempt-sha256', A.bodySha256, '--expect-game-epoch', A.expectedGameEpoch]);
      assert.equal(settled.publishId, A.publishId);
      assert.equal(fs.existsSync(attemptFile(gameDir)), false, 'A is settled and gone');
    },
    onPublishInvoke: (args) => {
      invocations.push([...args]);
      // Between the loop's look and its queued retry taking the publish lock: another publisher
      // records B (the same pre-action body, a new id) — an actual transport failure, kept.
      if (A && !B && checkpoints === 1 && args.includes('--retry')) {
        const failed = recordWithClosedPort(gameDir, deadPort, ['--from', preActionPath]);
        assert.equal(failed?.code, 'PUBLISH_FAILED', `B is recorded on transport failure: ${failed?.code}`);
        B = failed.attempt;
        assert.equal(fs.existsSync(attemptFile(gameDir)), true, 'B is the recorded pending attempt');
      }
    },
  });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  deadPort = await closedPort();

  const running = startRun(loop);
  const { snapshot } = await waitForUserSnapshot(gameDir, 27_000);
  await stopRun(loop, running).catch(() => {});

  assert.ok(A && B, 'A was recorded and B replaced it');
  assert.equal(checkpoints, 1, 'the pending drain happened once');
  assert.ok(A.publishId < B.publishId, 'B was allocated after A was accepted');
  const turnInvocations = invocations.filter((args) => args[args.indexOf('--from') + 1] === turnPath && !args.includes('--view-only') && !args.includes('--wait-only'));
  const drainAt = turnInvocations.findIndex((args) => args.includes('--retry'));
  assert.ok(drainAt >= 1, 'the current turn was first offered fresh (ATTEMPT_PENDING), then the record was drained');
  assert.equal(turnInvocations[drainAt].includes('--expect-attempt-sha256'), false, 'the drain is the unbound pending drain');
  const after = turnInvocations.slice(drainAt + 1);
  assert.equal(after.length >= 1 && !after[0].includes('--retry'), true, 'the current turn is published fresh right after the drain');
  const loopState = readJson(path.join(gameDir, 'loop-state.json'));
  assert.ok(loopState.lastPublishId > B.publishId, 'the current turn\'s own publication is the last accepted one, after B');
  // The relay's own state: what it serves over HTTP (the next decision) and what it persists
  // itself (the latest applied publication id and revision) — never the publisher's reply.
  assert.equal(snapshot.view?.legal?.toAct, 'user', 'the relay exposes the correct next decision');
  const persisted = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(persisted.publishId, loopState.lastPublishId, 'the relay holds the current turn as the latest applied publication');
  assert.equal(persisted.revision, snapshot.revision, 'the served state is the persisted one');
  assert.equal(persisted.view?.legal?.toAct, 'user');
  assert.equal(foldsOf(gameDir), 1, 'the engine step happened once');
  const metric = metricOf(gameDir, 'p1');
  assert.equal(metric?.outcome, 'accepted');
  assert.equal(Object.hasOwn(metric, 'publishError'), false, 'the applied action\'s metric is truthful: its publication succeeded');
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
});

// R10 (Astra): the FIRST HTTP answer of a publication is recorded whatever follows it — an
// accepted retry, or a retirement whose recheck answers differently. The relay stand-in refuses
// exactly one request with a nonsemantic 500 and hands the lock back to the real relay; the
// recovery, the bound retry, the retirement and the engine are real.
for (const scenario of [
  {
    name: 'accepted retry',
    pendingExplanation: false,
    swapOn: (args) => !args.includes('--retry') && !args.includes('--view-only') && !args.includes('--wait-only') && !args.includes('--retire-rejected'),
    retry: false,
  },
  {
    name: 'retirement with a different recheck',
    pendingExplanation: true,
    swapOn: (args) => args.includes('--retry') && !args.includes('--expect-attempt-sha256') && !args.includes('--retire-rejected'),
    retry: true,
  },
]) {
  test(`the first HTTP refusal is persisted even when the recovery succeeds (${scenario.name}): sanitized status and code in the loop log, no raw relay text, the recheck kept apart`, { timeout: TIMEOUT }, async (t) => {
    const gameDir = tmpGame();
    const turnPath = path.join(gameDir, '.turn.json');
    const relayState = { restore: null, realPort: null, refused: false };
    const refusing = await refusingRelayOnce(t, relayState);
    let armed = null;
    let swapped = false;
    const invocations = [];
    const adapter = makeAdapter({
      onDecide: async (input) => {
        if (scenario.pendingExplanation && armed && !armed.left) {
          await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
          armed.left = true;
        }
        if (!armed) armed = { left: false };
        armed.acted = true;
        const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
        return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
      },
    });
    const loop = newLoop(t, gameDir, adapter, {
      listenerOwnedBy: async () => true,
      onPublishInvoke: (args) => {
        invocations.push([...args]);
        if (armed?.acted && !swapped && args[args.indexOf('--from') + 1] === turnPath && scenario.swapOn(args)) {
          swapped = true;
          relayState.realPort = readJson(lockPathOf(gameDir)).port;
          relayState.restore = swapLockPort(gameDir, refusing.port);
        }
      },
    });
    t.after(() => { relayState.restore?.(); });
    await loop.bootstrap({ ai: 1, stack: 100 });
    putAiFirst(gameDir);
    if (scenario.pendingExplanation) armed = { ...(await seedExplanation(gameDir, { publishMachine: true })), left: false, acted: false };

    const running = startRun(loop);
    const { snapshot } = await waitForUserSnapshot(gameDir, 27_000);
    await stopRun(loop, running).catch(() => {});

    assert.equal(swapped, true, 'the scripted request was issued');
    assert.deepEqual(refusing.hits.filter((hit) => hit.refused).map((hit) => [hit.method, hit.pathname]), [['POST', '/api/publish']], 'exactly the publisher\'s POST was refused, once');
    assert.equal(refusing.hits.some((hit) => !hit.refused && hit.method === 'POST'), false, 'no other POST reached the stand-in');
    assert.equal(relayState.restore, null, 'the lock named the real relay again before the refusal was read');
    const log = readLoopLog(gameDir);
    const refused = log.filter((row) => row.event === 'publish-refused');
    // Ordered closed tuples, one per invocation that was answered: the first 500 always comes
    // first; the bound resend's own different answer, when there is one, follows it.
    assert.deepEqual(refused.map(({ at, ...rest }) => rest), [
      { event: 'publish-refused', code: 'PUBLISH_REJECTED', httpStatus: 500, serverCode: 'FORBIDDEN_LITERAL_UNAVAILABLE', retry: scenario.retry, bound: false, retire: false },
      ...(scenario.pendingExplanation
        ? [{ event: 'publish-refused', code: 'PUBLISH_REJECTED', httpStatus: 400, serverCode: 'ANNOTATION_PROOF_MISMATCH', retry: true, bound: true, retire: false }]
        : []),
    ], 'the first refusal is on record after a successful recovery, before the resend\'s own answer');
    assert.equal(JSON.stringify(log).includes('As_Kh'), false, 'no relay text reaches the loop log');
    assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'a verified live relay is not restarted');
    const bound = invocations.filter((args) => args.includes('--expect-attempt-sha256') && !args.includes('--retire-rejected'));
    assert.equal(bound.length, 1, 'the recovery resent the refused record once, bound');
    const retirements = logEvents(gameDir, 'training-annotation-retired');
    if (scenario.pendingExplanation) {
      assert.equal(retirements.length, 1);
      assert.equal(retirements[0].httpStatus, 400);
      assert.equal(retirements[0].serverCode, 'ANNOTATION_PROOF_MISMATCH');
      const audit = fs.readFileSync(rejectionLog(gameDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0].httpStatus, audit[0].serverCode], [400, 'ANNOTATION_PROOF_MISMATCH'], 'the retirement evidence is bound to the actual recheck, not to the first answer');
      assert.equal(armed.tc.loadAuthority(gameDir).items[armed.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
      assert.equal(fs.existsSync(path.join(gameDir, '.publish-retirement.json')), false);
    } else {
      assert.equal(retirements.length, 0);
      assert.equal(fs.existsSync(rejectionLog(gameDir)), false);
    }
    assert.equal(snapshot.view?.legal?.toAct, 'user', 'play reached the user');
    assert.equal(foldsOf(gameDir), 1, 'the engine step happened once');
    const metric = metricOf(gameDir, 'p1');
    assert.equal(metric?.outcome, 'accepted');
    assert.equal(Object.hasOwn(metric, 'publishError'), false, 'the applied action\'s publication succeeded in the end');
    assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  });
}

// R11 review (Astra F2): the first HTTP answer can come from the automatic bound resend — when
// the failure that started the recovery was a transport failure, which has no answer of its
// own. A healthy explanation is recorded pending by an actual transport failure; the loop's
// drain of it is torn down unanswered (transport again), the bound resend is refused 400
// FORBIDDEN_LITERAL by the stand-in, and the retirement's own bound resend then goes to the
// real relay, which accepts it: the note is marked published, no audit row is written — and
// that first 400 still stands in the loop log. The loop, engine, relay, publisher and
// retirement are real; only two answers are scripted.
test('the first HTTP refusal of an automatic resend after a transport failure is persisted: 400 on the bound resend, then the retirement resend is accepted — the 400 stands in the loop log, nothing is audited, the note is published once', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  const turnPath = path.join(gameDir, '.turn.json');
  const relayState = { restore: null, realPort: null, refused: false };
  const standIn = await standInRelay(t, relayState, ['destroy', { status: 400, code: 'FORBIDDEN_LITERAL' }]);
  let armed = null;
  let deadPort = null;
  const swaps = [];
  const invocations = [];
  const adapter = makeAdapter({
    onDecide: async (input) => {
      if (armed && !armed.left) {
        // The healthy explanation is recorded pending by an actual transport failure.
        const restore = swapLockPort(gameDir, deadPort);
        try {
          await pipeline.flushAnnotationPublish(gameDir, {
            gameEpoch: armed.epoch, executePublish: (args) => runPublisher(gameDir, args), trainingControl: armed.tc,
          }).then(() => assert.fail('the record must fail on transport'), (error) => assert.equal(error.code, 'PUBLISH_FAILED'));
        } finally {
          restore();
        }
        assert.equal(fs.existsSync(attemptFile(gameDir)), true, 'the healthy explanation is the recorded pending attempt');
        armed.left = true;
        armed.acted = true;
      }
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    listenerOwnedBy: async () => true,
    onPublishInvoke: (args) => {
      invocations.push([...args]);
      if (!armed?.acted || args[args.indexOf('--from') + 1] !== turnPath || args.includes('--retire-rejected')) return;
      // The drain of the pending record, then the automatic bound resend: each goes to the stand-in.
      const drain = args.includes('--retry') && !args.includes('--expect-attempt-sha256') && swaps.length === 0;
      const bound = args.includes('--expect-attempt-sha256') && swaps.length === 1;
      if (drain || bound) {
        swaps.push(drain ? 'drain' : 'bound');
        relayState.realPort = readJson(lockPathOf(gameDir)).port;
        relayState.restore = swapLockPort(gameDir, standIn.port);
      }
    },
  });
  t.after(() => { relayState.restore?.(); });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  deadPort = await closedPort();
  armed = { ...(await seedExplanation(gameDir, { publishMachine: true, drift: false })), left: false, acted: false };

  const running = startRun(loop);
  const { snapshot } = await waitForUserSnapshot(gameDir, 27_000);
  await stopRun(loop, running).catch(() => {});

  assert.deepEqual(swaps, ['drain', 'bound'], 'the drain and the bound resend were the scripted requests');
  assert.deepEqual(standIn.hits.filter((hit) => hit.refused).map((hit) => [hit.method, hit.pathname, hit.answer]), [['POST', '/api/publish', 'destroyed'], ['POST', '/api/publish', 400]]);
  assert.equal(standIn.remaining(), 0);
  assert.equal(relayState.restore, null, 'the lock named the real relay again before each answer was read');
  const log = readLoopLog(gameDir);
  const refused = log.filter((row) => row.event === 'publish-refused');
  assert.deepEqual(refused.map(({ at, ...rest }) => rest), [
    { event: 'publish-refused', code: 'PUBLISH_REJECTED', httpStatus: 400, serverCode: 'FORBIDDEN_LITERAL', retry: true, bound: true, retire: false },
  ], 'the first HTTP answer — the bound resend\'s 400 — stands in the loop log after the accepted retirement resend');
  assert.equal(JSON.stringify(log).includes('As_Kh'), false, 'no relay text reaches the loop log');
  assert.equal(JSON.stringify(log).includes(EXPLANATION), false, 'no annotation text reaches the loop log');
  assert.equal(logEvents(gameDir, 'server-recovered').length, 0, 'a verified live relay is not restarted');
  assert.equal(logEvents(gameDir, 'training-annotation-retired').length, 0, 'nothing was retired: the retirement resend was accepted');
  assert.equal(invocations.filter((args) => args.includes('--retire-rejected')).length, 1, 'the retirement resent the exact record once, bound');
  assert.equal(fs.existsSync(rejectionLog(gameDir)), false, 'no audit row for an accepted resend');
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-retirement.json')), false);
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const auth = armed.tc.loadAuthority(gameDir);
  assert.equal(auth.items[armed.evaluation.evaluationId].annotations.explanation.published, true, 'the note is marked published');
  assert.equal(auth.annotationQueue[armed.evaluation.evaluationId], undefined, 'the queue is settled');
  assert.ok((snapshot.trainingAnnotations ?? []).some((note) => note.evaluationId === armed.evaluation.evaluationId), 'the relay holds the note');
  assert.equal(snapshot.view?.legal?.toAct, 'user', 'play reached the user');
  assert.equal(foldsOf(gameDir), 1, 'the engine step happened once');
  const metric = metricOf(gameDir, 'p1');
  assert.equal(metric?.outcome, 'accepted');
  assert.equal(Object.hasOwn(metric, 'publishError'), false, 'the applied action\'s publication succeeded in the end');
});

// The relay identity a verifying caller hands the publisher: the process named by lock.json,
// its start time, its port and the token it was proved with.
function relayBindingOf(gameDir) {
  const lock = readJson(lockPathOf(gameDir));
  return { pid: lock.serverPid, startTime: serverProcessStartTime(lock.serverPid), port: lock.port, sessionToken: lock.sessionToken };
}

// R12 review (Astra F2) at the loop: the refused explanation's retirement is COMPLETED by another
// caller — attempt removed, evidence consumed, queue disposed — in the instant before the loop
// first reads the record (a deterministic seam stands for that instant). The loop proves it
// from the exact identity its own refused request reported, sends nothing, and still publishes
// the current transition: one engine action, one retirement (the competitor's), a clean queue.
test('loop: a competing retirement completed before the loop\'s first read is proven from the refused request\'s identity — nothing resent, the current transition still publishes, one engine action, one retirement', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  let armed = null;
  let competed = false;
  const invocations = [];
  const adapter = makeAdapter({
    onDecide: async (input) => {
      if (armed && !armed.left) {
        await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
        armed.left = true;
      }
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    onPublishInvoke: (args) => invocations.push([...args]),
    beforeRetirementRead: async () => {
      if (competed) return;
      competed = true;
      // The competitor completes the whole retirement of exactly the pending record.
      const settled = await pipeline.retireRejectedAnnotationAttempt(gameDir, {
        executePublish: (args) => runPublisher(gameDir, args), trainingControl: armed.tc, relayBinding: () => relayBindingOf(gameDir),
      });
      assert.equal(settled.retired, true, 'the competitor retired the refused explanation');
      assert.equal(fs.existsSync(attemptFile(gameDir)), false, 'the attempt is gone before the loop reads');
      assert.equal(fs.existsSync(path.join(gameDir, '.publish-retirement.json')), false, 'the evidence was consumed');
    },
  });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  armed = { ...(await seedExplanation(gameDir, { publishMachine: true })), left: false };

  const running = startRun(loop);
  const { snapshot } = await waitForUserSnapshot(gameDir, 27_000);
  await stopRun(loop, running).catch(() => {});

  assert.equal(competed, true, 'the seam ran before the loop\'s first read');
  assert.equal(invocations.filter((args) => args.includes('--retire-rejected')).length, 0, 'the loop resent nothing');
  const recovered = logEvents(gameDir, 'publish-recovery').filter((row) => row.mode === 'retire-rejected-annotation');
  assert.equal(recovered.length, 1, 'the loop settled the refusal and went on');
  assert.equal(logEvents(gameDir, 'training-annotation-retired').length, 0, 'the loop retired nothing itself');
  const refused = readLoopLog(gameDir).filter((row) => row.event === 'publish-refused').map(({ at, ...rest }) => rest);
  assert.deepEqual(refused, [{ event: 'publish-refused', code: 'PUBLISH_REJECTED', httpStatus: 400, serverCode: 'ANNOTATION_PROOF_MISMATCH', retry: true, bound: false, retire: false }]);
  assert.equal(fs.readFileSync(rejectionLog(gameDir), 'utf8').trim().split('\n').length, 1, 'exactly one retirement was audited');
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  assert.equal(fs.existsSync(path.join(gameDir, '.publish-retirement.json')), false);
  const auth = armed.tc.loadAuthority(gameDir);
  assert.equal(auth.annotationQueue[armed.evaluation.evaluationId], undefined, 'the queue is clean');
  assert.equal(auth.items[armed.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(snapshot.view?.legal?.toAct, 'user', 'the current transition reached the relay');
  assert.equal(foldsOf(gameDir), 1, 'the engine step happened once');
  const metric = metricOf(gameDir, 'p1');
  assert.equal(metric?.outcome, 'accepted');
  assert.equal(Object.hasOwn(metric, 'publishError'), false, 'the applied action\'s publication succeeded');
  for (const object of [refused, auth.items[armed.evaluation.evaluationId].annotations.explanation]) {
    assert.equal(JSON.stringify(object).includes(EXPLANATION), false, 'no annotation text in diagnostics');
  }
});

// R14 review (Sol F2) at the loop: the record is PRESENT when the loop reads it; only between
// that read and the helper's own read does a competitor complete the retirement (attempt and
// evidence both gone). The identity the loop captured from its own refused request travels into
// the helper in this branch too, so the completed retirement is proven from the durable audit
// and disposition — nothing resent, the current transition still publishes, one engine action,
// one retirement (the competitor's), no false error.
test('loop: a competing retirement completed between the loop\'s presence read and the helper\'s read is proven from the refused request\'s identity — nothing resent, the current transition still publishes, one engine action, one retirement', { timeout: TIMEOUT }, async (t) => {
  const gameDir = tmpGame();
  let armed = null;
  let competed = false;
  let presentAtSeam = null;
  const invocations = [];
  const adapter = makeAdapter({
    onDecide: async (input) => {
      if (armed && !armed.left) {
        await leavePendingAttempt(gameDir, armed.tc, armed.epoch);
        armed.left = true;
      }
      const decisionId = /decisionId:\s*([^\s]+)/.exec(input.message)?.[1];
      return { raw: JSON.stringify({ decisionId, action: 'fold' }) };
    },
  });
  const loop = newLoop(t, gameDir, adapter, {
    onPublishInvoke: (args) => invocations.push([...args]),
    beforeRetirementHelper: async () => {
      if (competed) return;
      competed = true;
      presentAtSeam = fs.existsSync(attemptFile(gameDir));
      // After the loop's presence read, before the helper's: the competitor completes the retirement.
      const settled = await pipeline.retireRejectedAnnotationAttempt(gameDir, {
        executePublish: (args) => runPublisher(gameDir, args), trainingControl: armed.tc, relayBinding: () => relayBindingOf(gameDir),
      });
      assert.equal(settled.retired, true, 'the competitor retired the refused explanation');
      assert.equal(fs.existsSync(attemptFile(gameDir)), false, 'the attempt is gone before the helper reads');
      assert.equal(fs.existsSync(path.join(gameDir, '.publish-retirement.json')), false, 'the evidence was consumed');
    },
  });
  await loop.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  armed = { ...(await seedExplanation(gameDir, { publishMachine: true })), left: false };

  const running = startRun(loop);
  const { snapshot } = await waitForUserSnapshot(gameDir, 27_000);
  await stopRun(loop, running).catch(() => {});

  assert.equal(competed, true, 'the seam ran between the two reads');
  assert.equal(presentAtSeam, true, 'the record was present when the loop read it');
  assert.equal(invocations.filter((args) => args.includes('--retire-rejected')).length, 0, 'the loop resent nothing');
  assert.equal(logEvents(gameDir, 'publish-recovery').filter((row) => row.mode === 'retire-rejected-annotation').length, 1, 'the loop settled the refusal and went on');
  assert.equal(logEvents(gameDir, 'training-annotation-retired').length, 0, 'the loop retired nothing itself');
  const refused = readLoopLog(gameDir).filter((row) => row.event === 'publish-refused').map(({ at, ...rest }) => rest);
  assert.deepEqual(refused, [{ event: 'publish-refused', code: 'PUBLISH_REJECTED', httpStatus: 400, serverCode: 'ANNOTATION_PROOF_MISMATCH', retry: true, bound: false, retire: false }]);
  assert.equal(fs.readFileSync(rejectionLog(gameDir), 'utf8').trim().split('\n').length, 1, 'exactly one retirement was audited');
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const auth = armed.tc.loadAuthority(gameDir);
  assert.equal(auth.annotationQueue[armed.evaluation.evaluationId], undefined, 'the queue is clean');
  assert.equal(auth.items[armed.evaluation.evaluationId].annotations.explanation.publishFailed, 'rejected');
  assert.equal(snapshot.view?.legal?.toAct, 'user', 'the current transition reached the relay');
  assert.equal(foldsOf(gameDir), 1, 'the engine step happened once');
  const metric = metricOf(gameDir, 'p1');
  assert.equal(metric?.outcome, 'accepted');
  assert.equal(Object.hasOwn(metric, 'publishError'), false, 'no false error: the publication succeeded');
});
