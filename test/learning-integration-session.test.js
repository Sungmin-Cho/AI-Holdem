import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFirstFixtureRecord } from './helpers/fixture-readiness.mjs';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { newDeck } from '../engine/cards.js';
import { ownedProcessStartTime } from '../engine/state.js';
import { engineInitFlags, createGameLoop } from '../tools/game-loop.js';
import { inspectStudyService, stopStudyService } from '../tools/study-service.js';
import { studyBudget } from './helpers/platform.js';
import {
  scaled,
  ROOT,
  STORE_ARGS,
  resolve,
  engine,
  failedCliFixtures,
  startCli,
  within,
  until,
  stopOwnedStudy,
  command,
  waitValue,
  relayRequest,
  studyRequest,
  captureCliRelay,
  cleanupCli,
  stopWaitingCli,
  snapshotForActiveGame,
} from './helpers/learning-integration-fixtures.mjs';

test('S8 driver releases the relay when the engine completes before loop finalization', async () => {
  const file = path.join(createOwnedTempDir('holdem-s8-terminal-fence'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ handNo: 20, gameOver: true, result: 'completed' }));
  let requests = 0;
  const snapshot = await snapshotForActiveGame(file, async () => { requests++; throw new Error('relay is closing'); });
  assert.equal(snapshot, null);
  assert.equal(requests, 0, 'engine completion releases HTTP polling before phase done');
});

test('S8 driver rechecks engine completion if relay loss races its state read', async () => {
  const file = path.join(createOwnedTempDir('holdem-s8-terminal-race'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ gameOver: false }));
  const snapshot = await snapshotForActiveGame(file, async () => {
    fs.writeFileSync(file, JSON.stringify({ handNo: 20, gameOver: true, result: 'completed' }));
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  });
  assert.equal(snapshot, null);
});

test('S8 driver preserves premature relay loss and unreadable engine state as failures', async () => {
  const file = path.join(createOwnedTempDir('holdem-s8-premature-loss'), 'state.json');
  fs.writeFileSync(file, JSON.stringify({ gameOver: false }));
  const original = new Error('premature relay loss');
  await assert.rejects(snapshotForActiveGame(file, async () => { throw original; }), error => error === original);
  fs.writeFileSync(file, '{');
  await assert.rejects(snapshotForActiveGame(file, async () => ({ status: 200 })), SyntaxError);
});

test('S8 full: default 20-hand production session records support then study remains usable and reusable', { timeout: scaled(240000) }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-default20');
  const fake = failedCliFixtures({ hold: true });
  const initialCli = startCli(['--store-dir', storeDir], fake.env);
  let loop;
  let gameDir;
  let nextCli;
  let nextGameDir;
  const diagnosticStarted = Date.now();
  let checkpoint = 'initial-probe';
  const phaseObservations = [];
  const errorDetail = (error, depth = 0) => {
    if (!error || depth > 3) return null;
    // CLI assertions can embed capabilities. Keep call sites and safe error
    // categories, while removing URLs and token-shaped values from messages.
    const redact = value => String(value ?? '').replace(/https?:\/\/[^\s"']+/g, '[url]')
      .replace(/[a-f0-9]{32,}/gi, '[opaque]')
      .replace(/(token["'\s:=]+)[^\s,}"']+/gi, '$1[redacted]');
    return { name: error.name, code: error.code, message: redact(error.message),
      stack: String(error.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6),
      cause: errorDetail(error.cause, depth + 1),
      errors: Array.from(error.errors ?? []).map(item => errorDetail(item, depth + 1)) };
  };
  const stateDiagnostic = dir => {
    if (!dir) return null;
    const read = file => { try { return JSON.parse(fs.readFileSync(path.join(dir, file))); } catch (error) { return { readCode: error.code ?? error.name }; } };
    const state = read('state.json');
    const persistedLoop = read('loop-state.json');
    const action = read('ui-action-receipt.json');
    return { handNo: state.handNo, gameOver: state.gameOver, result: state.result,
      phase: persistedLoop.phase, stopping: persistedLoop.stopping,
      haltCode: persistedLoop.halt?.code, stateReadCode: state.readCode, loopReadCode: persistedLoop.readCode,
      actionPhase: action.phase, decisionId: action.decisionId, actionCode: action.code };
  };
  const diagnostic = (event, error) => console.log(`S8_DEFAULT20_DIAGNOSTIC ${JSON.stringify({
    elapsedMs: Date.now() - diagnosticStarted, event, checkpoint,
    initial: stateDiagnostic(gameDir), next: stateDiagnostic(nextGameDir),
    error: errorDetail(error), phaseObservations,
  })}`);
  t.after(async () => {
    const failures = [];
    diagnostic('cleanup-start');
    for (const [label, cleanup] of [
      ['loop-stop', () => loop?.requestStop()],
      ['next-cli-stop', () => nextCli ? cleanupCli(nextCli, nextGameDir) : undefined],
      ['initial-cli-stop', () => cleanupCli(initialCli, null)],
      ['study-stop', () => stopOwnedStudy(storeDir)],
    ]) { try { await cleanup(); } catch (error) { diagnostic(`cleanup-failure:${label}`, error); failures.push(error); } }
    diagnostic('cleanup-end');
    if (failures.length) throw new AggregateError(failures, 'default20 fixture cleanup failed');
  });
  try {
    await until(() => readFirstFixtureRecord(fake.log, initialCli.child), initialCli);
    initialCli.requestStop();
    assert.equal((await within(initialCli.closed, 8000, 'default20 initialized CLI stop')).code, 0);
    const selected = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
    gameDir = path.join(storeDir, '.session-store', selected.sessionRel);
    const stateFile = path.join(gameDir, 'state.json');
    const initialized = JSON.parse(fs.readFileSync(stateFile));
    assert.equal(initialized.config.mode, 'cash-training');
    assert.equal(initialized.config.aiCount, 5);
    assert.equal(initialized.config.startStackBb, 100);
    assert.equal(initialized.config.handLimit, 20);
    assert.equal(initialized.handNo, 0);
    // Controlled initial input only. Later hands retain the production shuffle;
    // all observed deck state and actions are included in the audit transcript.
    initialized.button = 2; // next button3/SB4/BB5 makes user the first actor.
    fs.writeFileSync(stateFile, JSON.stringify(initialized));
    const firstDeck = newDeck();
    const first = await engine(['step', '--new-hand', '--deck', firstDeck.join(','), '--game-dir', gameDir]);
    assert.equal(first.code, 0, JSON.stringify(first));
    assert.equal(first.json.next.kind, 'user');
    loop = createGameLoop({ gameDir, lockDir: storeDir,
      resolver: async () => ({ player: null, upper: null, notices: ['LLM 코치·리뷰 피드백 불가'] }),
      opts: { port: 0, waitMs: 40, storeDir, trainingEnabled: true } });
    const resumed = await loop.resume();
    assert.equal(resumed.opponentRuntime, 'policy');
    const service = await inspectStudyService(storeDir);
    assert.equal(service.status, 'running');
    const relayPid = loop.serverPid;
    checkpoint = 'drive-20-hands';
    diagnostic('drive-start');
    const driveStarted = Date.now();
    const observedHands = new Map();
    const actions = [];
    const sent = new Set();
    let settled = false;
    const running = loop.run().finally(() => { settled = true; });
    running.catch(() => {});
    const driver = (async () => {
      // Isolated default20 took 68s; a full-suite run reached 117s. Preserve
      // all 20 random production hands and leave 40s for finalization/cleanup.
      const deadline = Date.now() + 200000;
      while (!settled && Date.now() < deadline) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        if (state.hand && !observedHands.has(state.handNo)) {
          observedHands.set(state.handNo, { handNo: state.handNo, button: state.button,
            holes: state.hand.holes, board: state.hand.board, remainingDeck: state.hand.deck });
        }
        const phase = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'))).phase;
        const previous = phaseObservations.at(-1);
        if (previous?.handNo !== state.handNo || previous?.phase !== phase) {
          phaseObservations.push({ elapsedMs: Date.now() - driveStarted, handNo: state.handNo, phase });
          diagnostic('drive-phase');
        }
        if (phase === 'done') break;
        let lock;
        const snapshot = await snapshotForActiveGame(stateFile, () => {
          lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'lock.json')));
          return relayRequest(lock, '/api/snapshot');
        });
        if (snapshot === null) { diagnostic('engine-complete-release-relay'); break; }
        assert.equal(snapshot.status, 200);
        const legal = snapshot.body.view?.legal;
        if (legal?.toAct === 'user' && !sent.has(legal.decisionId)) {
          if (actions.length === 0) {
            const invalid = { decisionId: legal.decisionId, requestId: randomUUID(), action: 'raise', amount: 1 };
            assert.equal((await relayRequest(lock, '/api/action', invalid)).status, 200);
            const rejected = await waitValue(async () => {
              const result = await relayRequest(lock, '/api/action-status');
              return result.body.requestId === invalid.requestId && result.body.phase === 'rejected' ? result : null;
            });
            assert.equal(rejected.body.decisionId, legal.decisionId);
            const replay = await relayRequest(lock, '/api/action', invalid);
            assert.equal(replay.status, 409);
            assert.equal(replay.body.code, 'ACTION_REJECTED');
            actions.push({ ...invalid, phase: 'rejected' });
          }
          const action = { decisionId: legal.decisionId, requestId: randomUUID(), action: legal.canCheck ? 'check' : 'fold' };
          const accepted = await relayRequest(lock, '/api/action', action);
          assert.equal(accepted.status, 200, JSON.stringify(accepted));
          actions.push(action);
          sent.add(legal.decisionId);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!settled) {
        const state = JSON.parse(fs.readFileSync(stateFile));
        const phase = JSON.parse(fs.readFileSync(path.join(gameDir, 'loop-state.json'))).phase;
        if (phase !== 'done' && !state.gameOver) {
          throw new Error(`default20 action driver deadline: ${JSON.stringify({ handNo: state.handNo, phase, actions: actions.length, phaseObservations })}`);
        }
        await within(running, 15000, `default20 finalization ${JSON.stringify({ handNo: state.handNo, phase, phaseObservations })}`);
      }
    })();
    driver.catch(() => loop.requestStop());
    const [finished] = await Promise.all([running, driver]);
    console.log(`S8_DEFAULT20_PHASES ${JSON.stringify(phaseObservations)}`);
    assert.equal(finished.phase, 'done', JSON.stringify(finished.halt));
    const finalBytes = fs.readFileSync(stateFile);
    const finalState = JSON.parse(finalBytes);
    assert.equal(finalState.handNo, 20);
    assert.equal(finalState.result, 'completed');
    assert.equal(finalState.gameOver, true);
    assert.throws(() => process.kill(relayPid, 0), (error) => error.code === 'ESRCH');
    const evaluations = fs.readFileSync(path.join(gameDir, 'training/evaluations.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(evaluations.some((row) => row.status === 'supported' && row.forced === false),
      'the default configuration must produce an actual supported user opportunity');
    assert.equal(new Set(evaluations.map((row) => row.evaluationId)).size, evaluations.length);
    checkpoint = 'postgame-study';
    diagnostic('postgame-start');
    const before = (await studyRequest(service, '/api/summary')).summary;
    assert.ok(before.game.overall.supportedDecisions >= 1);
    for (const [index, handClass] of ['AJo', '72o', 'KK'].entries()) {
      await studyRequest(service, '/api/start', { mode: 'free', spotKey: '6max-100bb-btn-rfi-v2',
        handClass, idempotencyKey: `postgame-practice-${index}` });
      const current = await studyRequest(service, '/api/current');
      await studyRequest(service, '/api/answer', { sessionId: current.sessionId,
        questionId: current.question.questionId, action: 'fold', attemptNo: 0 });
    }
    const after = (await studyRequest(service, '/api/summary')).summary;
    assert.deepEqual(after.game, before.game, 'practice must not change any game metric, candidate or calibration');
    assert.equal(after.practice.overall.supportedDecisions, before.practice.overall.supportedDecisions + 3);
    checkpoint = 'next-cli-bootstrap';
    diagnostic('next-cli-start');
    const nextFake = failedCliFixtures({ hold: true });
    nextCli = startCli(['--store-dir', storeDir], nextFake.env);
    await until(() => {
      const current = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
      if (current.gameId === selected.gameId) return null;
      nextGameDir = path.join(storeDir, '.session-store', current.sessionRel);
      return readFirstFixtureRecord(nextFake.log, nextCli.child);
    }, nextCli, 10000);
    const nextStateFile = path.join(nextGameDir, 'state.json');
    const nextInitial = JSON.parse(fs.readFileSync(nextStateFile));
    assert.equal(nextInitial.handNo, 0);
    nextInitial.button = 2;
    fs.writeFileSync(nextStateFile, JSON.stringify(nextInitial));
    nextFake.release();
    const next = await until(() => {
      const current = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
      if (current.gameId === selected.gameId) return null;
      const nextDir = path.join(storeDir, '.session-store', current.sessionRel);
      const loopFile = path.join(nextDir, 'loop-state.json');
      if (!fs.existsSync(loopFile)) return null;
      const nextState = JSON.parse(fs.readFileSync(loopFile));
      return nextState.phase === 'playing' ? { current, state: nextState } : null;
    }, nextCli, 10000);
    assert.equal((await inspectStudyService(storeDir)).instanceId, service.instanceId);
    assert.equal((await relayRequest({ port: next.state.port, sessionToken: next.state.sessionToken }, '/api/snapshot')).body.studyUrl, service.studyUrl);
    checkpoint = 'next-cli-stop';
    diagnostic('next-stop-start');
    const nextStop = await stopWaitingCli(nextCli, nextGameDir);
    checkpoint = 'delivered-action-recovery';
    diagnostic('recovery-start');
    const recoveredUserApplies = [];
    loop = createGameLoop({ gameDir: nextGameDir, lockDir: storeDir,
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      opts: { port: 0, waitMs: 40, storeDir, trainingEnabled: true,
        onEngineInvoke(args) { if (args[0] === 'step' && args[1] === 'user') recoveredUserApplies.push(args); } } });
    await loop.resume();
    const recovering = loop.run();
    recovering.catch(() => {});
    await waitValue(() => {
      const receipt = JSON.parse(fs.readFileSync(path.join(nextGameDir, 'ui-action-receipt.json')));
      return receipt.requestId === nextStop.requestId && receipt.phase === 'consumed';
    });
    await loop.requestStop();
    await within(recovering, 8000, 'default20 delivered-action recovery stop');
    assert.equal(recoveredUserApplies.length, 1, 'resume applies the delivered action exactly once');
    const recoveredState = JSON.parse(fs.readFileSync(nextStateFile));
    const applied = [recoveredState.hand, recoveredState.lastHand].filter(Boolean)
      .flatMap((hand) => hand.decisions ?? []).filter((row) => row.decisionId === nextStop.decisionId);
    assert.equal(applied.length, 1);
    assert.equal(applied[0].chosenAction.action, 'fold');
    nextStop.recoveredOnce = true;
    assert.deepEqual(fs.readFileSync(stateFile), finalBytes);
    assert.equal(observedHands.size, 20, 'retain every observed hand deck for the integration audit');
    console.log(`S8_DEFAULT20_EVIDENCE ${JSON.stringify({ policySeed: initialized.policySeed,
      controlledInitialButton: 2, firstDeck, hands: [...observedHands.values()], actions,
      completedHands: 20, supported: before.game.overall.supportedDecisions,
      unsupported: before.game.overall.unsupportedDecisions, studyReused: true, gameMetricsPreserved: true, nextStop })}`);
    diagnostic('main-complete');
  } catch (error) {
    diagnostic('main-failure', error);
    throw error;
  }
});

for (const scenario of ['limp', 'off-size', 'multiway', 'four-bet']) {
  test(`S8 full: actual engine decisions retain the ${scenario} exclusion`, async () => {
    const gameDir = createOwnedTempDir('holdem-s8-exclusion');
    const defaults = resolve(...STORE_ARGS);
    const initialized = await engine(['init', '--game-dir', gameDir, '--ai', String(defaults.ai), ...engineInitFlags(defaults)]);
    assert.equal(initialized.code, 0);
    const file = path.join(gameDir, 'state.json');
    const state = JSON.parse(fs.readFileSync(file));
    state.button = scenario === 'off-size' ? 2 : 3;
    fs.writeFileSync(file, JSON.stringify(state));
    let turn = await engine(['step', '--new-hand', '--deck', newDeck().join(','), '--game-dir', gameDir]);
    assert.equal(turn.code, 0);
    const transcript = [];
    const step = async (action, amount) => {
      const playerId = turn.json.next.toAct;
      transcript.push({ playerId, action, ...(amount === undefined ? {} : { amount }) });
      turn = await engine(['step', playerId, action, ...(amount === undefined ? [] : [String(amount)]),
        '--expect-version', String(turn.json.stateVersion), '--game-dir', gameDir]);
      assert.equal(turn.code, 0, JSON.stringify(turn));
    };
    if (scenario !== 'off-size') {
      assert.equal(turn.json.next.toAct, 'p1');
      await step(scenario === 'limp' ? 'call' : 'raise', scenario === 'limp' ? undefined : 125);
      if (scenario === 'multiway') await step('call');
      if (scenario === 'four-bet') await step('raise', 425);
      while (turn.json.next.toAct !== 'user') await step('fold');
    }
    const userDecisionId = turn.json.next.decisionId;
    if (scenario === 'off-size') await step('raise', 150);
    else if (scenario === 'four-bet') await step('raise', 1000);
    else await step(scenario === 'limp' ? 'check' : 'fold');
    for (let moves = 0; turn.json.next && moves < 30; moves += 1) await step('fold');
    assert.equal(turn.json.handOver, true);
    const evaluated = JSON.parse(await command(process.execPath,
      [path.join(ROOT, 'tools/evaluate-cli.js'), 'evaluate', '--game-dir', gameDir, '--hand', '1']));
    const row = evaluated.evaluations.find((item) => item.decisionId === userDecisionId);
    assert.equal(row.status, 'unsupported');
    assert.equal(row.grade, null);
    assert.equal(row.evLossBb, null);
    const reason = scenario === 'off-size' ? 'RFI size must be 2.5bb'
      : scenario === 'four-bet' ? 'multiway / 4bet tree unsupported' : 'limped/multiway tree';
    assert.equal(row.reason, reason);
    console.log(`S8_EXCLUSION_EVIDENCE ${JSON.stringify({ scenario, transcript, decisionId: userDecisionId,
      status: row.status, code: row.code, reason: row.reason })}`);
  });
}

test('S8 full: private CLI creation never relabels an existing live foreign loop lock', { timeout: scaled(15000) }, async () => {
  const storeDir = createOwnedTempDir('holdem-s8-foreign-loop');
  fs.chmodSync(storeDir, 0o755);
  const lock = path.join(storeDir, 'loop.lock.d');
  fs.mkdirSync(lock);
  fs.chmodSync(lock, 0o775);
  const pidFile = path.join(lock, 'pid');
  const bytes = `${process.pid}:${ownedProcessStartTime(process.pid)}`;
  fs.writeFileSync(pidFile, bytes);
  fs.chmodSync(pidFile, 0o664);
  const before = fs.statSync(lock);
  const priorModes = [lock, pidFile, storeDir].map(file => fs.statSync(file).mode);
  const cli = startCli(['--store-dir', storeDir], failedCliFixtures().env, { umask: 0o002 });
  const result = await within(cli.closed, 8000);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ACTIVE_GAME/);
  assert.equal(fs.statSync(lock).ino, before.ino);
  assert.deepEqual([lock, pidFile, storeDir].map(file => fs.statSync(file).mode), priorModes);
  assert.equal(fs.readFileSync(pidFile, 'utf8'), bytes);
});

test('S8 full: package study commands require an explicit store and own service start and stop', { timeout: studyBudget({ coldStarts: 1, warmCalls: 2 }) }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-study-command');
  t.after(() => stopOwnedStudy(storeDir));
  const npm = process.platform === 'win32' ? process.execPath : path.join(path.dirname(process.execPath), 'npm');
  const npmArgs = process.platform === 'win32' ? [path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')] : [];
  await assert.rejects(command(npm, [...npmArgs, 'run', '--silent', 'study'], { cwd: ROOT }), /usage:/);
  assert.equal(fs.existsSync(path.join(storeDir, '.training')), false);
  const output = await command(npm, [...npmArgs, 'run', '--silent', 'study', '--', storeDir], { cwd: ROOT, timeout: studyBudget({ coldStarts: 1 }) });
  const service = await inspectStudyService(storeDir);
  assert.equal(output.trim(), service.studyUrl);
  await command(npm, [...npmArgs, 'run', '--silent', 'study:stop', '--', storeDir], { cwd: ROOT });
  assert.throws(() => process.kill(service.pid, 0), (error) => error.code === 'ESRCH');
});

test('S8 full: relay recovery restarts a stopped study service and publishes its rotated URL', { timeout: studyBudget({ coldStarts: 2, warmCalls: 2 }) }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-rotation-heal');
  const gameDir = path.join(storeDir, 'session');
  fs.mkdirSync(gameDir, { mode: 0o700 });
  const loop = createGameLoop({ gameDir, lockDir: storeDir,
    resolver: async () => ({ player: null, upper: null, notices: [] }),
    opts: { port: 0, waitMs: 40, storeDir, trainingEnabled: true, opponentRuntime: 'policy' } });
  t.after(async () => { await loop.requestStop(); await stopOwnedStudy(storeDir); });
  await loop.bootstrap(resolve(...STORE_ARGS));
  const firstService = await inspectStudyService(storeDir);
  const oldPid = loop.serverPid;
  await stopStudyService(storeDir, { expectedInstanceId: firstService.instanceId });
  process.kill(oldPid, 'SIGTERM'); // This is the child just created by the owned loop.
  await waitValue(() => { try { process.kill(oldPid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } });
  const running = loop.run();
  running.catch(() => {});
  const healed = await waitValue(async () => {
    const file = path.join(gameDir, 'lock.json');
    if (!fs.existsSync(file)) return null; // verified stale-lock retirement precedes the new listener
    const lock = JSON.parse(fs.readFileSync(file));
    if (lock.serverPid === oldPid) return null;
    const snapshot = await relayRequest(lock, '/api/snapshot');
    return snapshot.body.view?.legal?.decisionId ? { lock, snapshot } : null;
  }, studyBudget({ coldStarts: 1 }));
  const service = await inspectStudyService(storeDir);
  assert.notEqual(service.instanceId, firstService.instanceId);
  assert.notEqual(service.studyUrl, firstService.studyUrl);
  assert.equal(healed.snapshot.body.studyUrl, service.studyUrl);
  assert.equal(JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json'))).handNo, 1);
  await loop.requestStop();
  await running;
  assert.equal((await inspectStudyService(storeDir)).instanceId, service.instanceId);
});

test('S8 full: actual store CLI forwards port zero to an ephemeral authenticated relay', { timeout: studyBudget({ coldStarts: 1, warmCalls: 2 }) }, async (t) => {
  const storeDir = createOwnedTempDir('holdem-s8-cli-port');
  const fake = failedCliFixtures({ hold: true });
  const cli = startCli(['--store-dir', storeDir, '--port', '0'], fake.env);
  let gameDir;
  t.after(async () => { await cleanupCli(cli, gameDir); await stopOwnedStudy(storeDir); });
  await until(() => readFirstFixtureRecord(fake.log, cli.child), cli, studyBudget({ coldStarts: 1 }));
  const current = JSON.parse(fs.readFileSync(path.join(storeDir, '.session-store/current.json')));
  gameDir = path.join(storeDir, '.session-store', current.sessionRel);
  const file = path.join(gameDir, 'state.json');
  const state = JSON.parse(fs.readFileSync(file));
  assert.equal(state.handNo, 0);
  state.button = 2;
  fs.writeFileSync(file, JSON.stringify(state));
  fake.release();
  const lock = await until(() => {
    const file = path.join(gameDir, 'lock.json');
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null;
  }, cli, studyBudget({ coldStarts: 1 }));
  assert.ok(lock.port > 0 && lock.port <= 65535);
  assert.match(captureCliRelay(gameDir).args, /--port 0(?: |$)/);
  assert.equal((await relayRequest(lock, '/api/snapshot')).status, 200);
  await waitValue(async () => (await relayRequest(lock, '/api/snapshot')).body.view?.legal?.toAct === 'user');
  // Deliberately leave the protected wait unresolved to exercise failure cleanup.
  // The default20 journey separately proves graceful delivery and once-only resume.
  await cleanupCli(cli, gameDir);
  assert.equal(cli.child.signalCode, 'SIGKILL');
  assert.throws(() => process.kill(lock.serverPid, 0), (error) => error.code === 'ESRCH');
  assert.equal((await inspectStudyService(storeDir)).status, 'running');
});
