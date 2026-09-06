import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createPrivateDirectory } from '../../shared/platform-files.js';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { prependPath, stopOwnedProcessTree, spawnOwnedCommand } from './platform.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// Qualification is checked at the journey entrypoint, not by a machine-local path.
export const NODE26 = process.execPath;

export function createBrowserWorkspace() {
  const root = process.platform === 'win32' ? path.join(os.tmpdir(), `holdem-learning-browser-${randomUUID()}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-learning-browser-'));
  if (process.platform === 'win32') createPrivateDirectory(root);
  const identity = fs.lstatSync(root);
  assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
  let closed = false;
  return { root, close() {
    if (closed) return;
    const current = fs.lstatSync(root);
    assert.ok(current.isDirectory() && current.ino === identity.ino && current.dev === identity.dev, 'refuse replacement workspace cleanup');
    fs.rmSync(root, { recursive: true }); closed = true;
    assert.equal(fs.existsSync(root), false);
  } };
}

export async function runOwnedCommand(command, args, { cwd = ROOT, timeoutMs = 30000, env = {}, maxBytes = 4 * 1024 * 1024 } = {}) {
  const started = Date.now();
  const child = spawnOwnedCommand(command, args, { cwd, env: { ...prependPath(path.dirname(process.execPath)), ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = ''; let timedOut = false; let overflow = false; let spawnError;
  const stop = () => stopOwnedProcessTree(child);
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  for (const [stream, output] of [[child.stdout, true], [child.stderr, false]]) stream.on('data', (chunk) => {
    if (output) stdout += chunk; else stderr += chunk;
    if (stdout.length + stderr.length > maxBytes) { overflow = true; stop(); }
  });
  child.on('error', (error) => { spawnError = error.code; });
  const [exitCode, signal] = await new Promise((resolve) => child.once('close', (...values) => resolve(values)));
  clearTimeout(timer);
  return { exitCode, signal, timedOut, overflow, spawnError, stdout, stderr, durationMs: Date.now() - started };
}

export function hashTree(root) {
  const digest = createHash('sha256');
  function visit(file, relative) {
    const stat = fs.lstatSync(file);
    digest.update(relative); digest.update(String(stat.mode));
    if (stat.isSymbolicLink()) { digest.update('symlink:'); digest.update(fs.readlinkSync(file)); return; }
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${relative}/${name}`);
    else if (stat.isFile()) digest.update(fs.readFileSync(file));
    else digest.update('special-file');
  }
  if (fs.existsSync(root)) visit(root, '.'); else digest.update('absent');
  return digest.digest('hex');
}

export function buildActionAck(received, phase, reason) {
  assert.ok(received && typeof received === 'object');
  assert.ok(['consumed', 'rejected'].includes(phase));
  assert.match(reason, /^[A-Z][A-Z0-9_]{0,63}$/);
  for (const key of ['gameEpoch', 'decisionId', 'requestId', 'digest']) {
    assert.equal(typeof received[key], 'string', `${key} is required for an action acknowledgement`);
  }
  return { gameEpoch: received.gameEpoch, decisionId: received.decisionId,
    requestId: received.requestId, digest: received.digest, phase, reason };
}

/** Only transport faults: requests always reach the actual upstream handler.
 * No response body or game/learning state is fabricated or rewritten. */
export async function startResponseProxy(targetPort, { onRequest = () => {} } = {}) {
  let nextFault = null;
  const sockets = new Set();
  const active = new Set();
  const timers = new Set();
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url, 'http://127.0.0.1');
    onRequest({ path: requestUrl.pathname, queryKeys: [...requestUrl.searchParams.keys()], method: req.method, hasDrillHeader: typeof req.headers['x-drill-token'] === 'string' });
    const fault = nextFault?.path === requestUrl.pathname ? nextFault : null;
    if (fault) nextFault = null;
    const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: req.url, method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${targetPort}` } }, (response) => {
      // Preserve stream semantics for SSE. Faults are only armed on finite HTTP responses.
      if (!fault) { res.writeHead(response.statusCode, response.headers); response.pipe(res); return; }
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (fault.kind === 'drop') { res.destroy(); return; }
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (!res.destroyed) { res.writeHead(response.statusCode, response.headers); res.end(Buffer.concat(chunks)); }
        }, fault.delayMs);
        timers.add(timer);
      });
    });
    active.add(upstream); upstream.once('close', () => active.delete(upstream));
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
    res.once('close', () => { if (!res.writableEnded) upstream.destroy(); });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: server.address().port,
    arm({ path: pathname, kind, delayMs = 0 }) {
      assert.ok(pathname.startsWith('/api/') && pathname !== '/api/events');
      assert.ok(['drop', 'delay'].includes(kind));
      assert.ok(Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 15000);
      nextFault = { path: pathname, kind, delayMs };
    },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const request of active) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(server.listening, false);
    },
  };
}

export async function productionDependencies() {
  const servicePath = path.join(ROOT, 'tools/study-service.js');
  if (!fs.existsSync(servicePath)) return { ready: false, reason: 'S7_PRODUCTION_STUDY_NOT_INTEGRATED' };
  const [service, relay] = await Promise.all([import(pathToFileURL(servicePath).href), import(pathToFileURL(path.join(ROOT, 'server/server.js')).href)]);
  if (typeof service.ensureStudyService !== 'function' || typeof service.stopStudyService !== 'function' || typeof service.inspectStudyService !== 'function') return { ready: false, reason: 'S7_PRODUCTION_HELPER_CONTRACT_UNAVAILABLE' };
  return { ready: true, service, relay };
}

export async function createLearningBrowserFixture({ stackBb = 100, stackChips = null, hands = 20 } = {}) {
  const dependencies = await productionDependencies();
  assert.equal(dependencies.ready, true, dependencies.reason);
  const workspace = createBrowserWorkspace();
  const storeDir = path.join(workspace.root, 'store');
  const receipts = [];
  const trainingOwner = randomUUID();
  let relay; let study; let proxy; let sessionDir; let token;
  async function commandResult(script, args) {
    const result = await runOwnedCommand(NODE26, [path.join(ROOT, script), ...args]);
    receipts.push({ script, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, durationMs: result.durationMs,
      stdoutSha256: createHash('sha256').update(result.stdout).digest('hex'), stderrSha256: createHash('sha256').update(result.stderr).digest('hex') });
    return result;
  }
  async function command(script, args) {
    const result = await commandResult(script, args);
    assert.equal(result.exitCode, 0, `${script} failed; inspect the private fixture`);
    assert.equal(result.signal, null); assert.equal(result.timedOut, false); assert.equal(result.overflow, false);
    return JSON.parse(result.stdout.trim());
  }
  async function publishEnvelopeFile(file, options = []) {
    assert.ok(path.resolve(file).startsWith(`${workspace.root}${path.sep}`));
    return command('tools/publish.js', ['--game-dir', sessionDir, '--from', file, ...options]);
  }
  async function publishEnvelope(envelope, { viewOnly = false, actionAck = null } = {}) {
    const file = path.join(workspace.root, `step-${randomUUID()}.json`);
    fs.writeFileSync(file, JSON.stringify(actionAck ? { ...envelope, actionAck } : envelope), { flag: 'wx', mode: 0o600 });
    await publishEnvelopeFile(file, viewOnly ? ['--view-only'] : []);
    return envelope;
  }
  async function engineStep(args = [], { publish = true, viewOnly = false, actionAck = null } = {}) {
    const envelope = await command('engine/cli.js', ['step', '--game-dir', sessionDir, ...args]);
    if (publish) await publishEnvelope(envelope, { viewOnly, actionAck });
    return envelope;
  }
  const engineLegal = () => command('engine/cli.js', ['legal', '--game-dir', sessionDir]);
  async function startRelay(port = 0) {
    relay = await dependencies.relay.startServer({ gameDir: sessionDir, port, token, studyUrl: study.studyUrl });
    const url = `http://127.0.0.1:${relay.port}/api/health?${new URLSearchParams({ token })}`;
    const deadline = Date.now() + 2_000;
    let response;
    for (;;) {
      try { response = await fetch(url); break; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.equal(response.status, 200, 'authenticated relay health is required');
    const health = await response.json();
    assert.equal(health.protocolVersion, 2, 'S4/S7 production relay capabilities are required');
    return relay;
  }
  async function close() {
    const failures = [];
    if (proxy) try { await proxy.close(); } catch (error) { failures.push(error); }
    if (relay) try { await relay.close(); } catch (error) { failures.push(error); }
    if (study) try {
      await dependencies.service.stopStudyService(storeDir, { expectedInstanceId: study.instanceId });
      const inspected = await dependencies.service.inspectStudyService(storeDir);
      assert.ok(!inspected || ['absent', 'stopped'].includes(inspected.status)
        || inspected.alive === false || inspected.stopped === true, 'study stop must have terminal confirmation');
    } catch (error) { failures.push(error); }
    if (!failures.length) workspace.close();
    if (failures.length) throw new AggregateError(failures, 'owned browser fixture cleanup failed');
  }
  try {
    const { prepareSession, commitSession } = await import(pathToFileURL(path.join(ROOT, 'engine/session-catalog.js')).href);
    const prepared = prepareSession(storeDir);
    assert.ok(Number.isSafeInteger(hands) && hands > 0);
    assert.ok(stackChips === null || (Number.isSafeInteger(stackChips) && stackChips > 0));
    assert.ok(Number.isSafeInteger(stackBb) && stackBb > 0);
    const stackArgs = stackChips === null ? ['--stack-bb', String(stackBb)] : ['--stack', String(stackChips)];
    const initialized = await command('engine/cli.js', ['init', '--game-dir', prepared.stagingDir, '--ai', '5', '--mode', 'cash-training', ...stackArgs, '--hands', String(hands), '--opponent-runtime', 'policy']);
    token = initialized.sessionToken;
    sessionDir = commitSession(storeDir, prepared).sessionDir;
    study = await dependencies.service.ensureStudyService(storeDir, { port: 0 });
    await startRelay();
    proxy = await startResponseProxy(relay.port);
    await engineStep(['--new-hand']);
    return { workspace: workspace.root, storeDir, sessionDir, receipts, token,
      get tableUrl() { return `http://127.0.0.1:${proxy.port}/?${new URLSearchParams({ token })}`; },
      studyUrl: study.studyUrl, proxy, engineStep, engineLegal, publishEnvelopeFile,
      async snapshot() { return (await fetch(`http://127.0.0.1:${relay.port}/api/snapshot?${new URLSearchParams({ token })}`)).json(); },
      async actionStatus() { return (await fetch(`http://127.0.0.1:${relay.port}/api/action-status?${new URLSearchParams({ token })}`)).json(); },
      async receiveAction() {
        const snapshot = await this.snapshot();
        return (await fetch(`http://127.0.0.1:${relay.port}/api/wait-action?${new URLSearchParams({ token, expectDecisionId: snapshot.view.legal.decisionId, timeoutMs: '20000' })}`)).json();
      },
      async applyReceivedAction(received) {
        const legal = await engineLegal();
        assert.equal(legal.decisionId, received.decisionId);
        const args = ['user', received.action];
        if (received.amount !== undefined) args.push(String(received.amount));
        args.push('--expect-version', String(legal.stateVersion));
        return engineStep(args, { actionAck: buildActionAck(received, 'consumed', 'ACTION_APPLIED') });
      },
      async rejectReceivedAction(received) {
        const legal = await engineLegal();
        assert.equal(legal.decisionId, received.decisionId);
        const args = ['step', '--game-dir', sessionDir, 'user', received.action];
        if (received.amount !== undefined) args.push(String(received.amount));
        args.push('--expect-version', String(legal.stateVersion + 1));
        const failed = await commandResult('engine/cli.js', args);
        assert.equal(failed.exitCode, 1); assert.equal(failed.signal, null); assert.equal(failed.timedOut, false);
        const rejection = JSON.parse(failed.stdout.trim());
        assert.equal(rejection.code, 'VERSION_MISMATCH');
        const synchronized = await command('engine/cli.js', ['step', '--game-dir', sessionDir]);
        assert.equal(synchronized.view.legal.decisionId, received.decisionId);
        await publishEnvelope(synchronized, { actionAck: buildActionAck(received, 'rejected', rejection.code) });
        return rejection;
      },
      async finishHandAndPublishTraining() {
        let legal;
        for (let step = 0; step < 100; step += 1) {
          legal = await engineLegal();
          if (legal.handOver) break;
          await engineStep([legal.toAct, legal.canCheck ? 'check' : 'fold']);
        }
        assert.equal(legal?.handOver, true, 'could not finish the production hand');
        const pipeline = await import(pathToFileURL(path.join(ROOT, 'tools/training-pipeline.js')).href);
        const { createTrainingControl } = await import(pathToFileURL(path.join(ROOT, 'tools/training-control.js')).href);
        const { gameEpochOf } = await import(pathToFileURL(path.join(ROOT, 'publish-contract.js')).href);
        const executePublish = (args) => command('tools/publish.js', ['--game-dir', sessionDir, ...args]);
        const training = await pipeline.runHandPipeline({ sessionDir, handNo: legal.handNo,
          gameEpoch: gameEpochOf(token), owner: trainingOwner, storeDir,
          publish: async (kind) => {
            if (kind === 'machine') await pipeline.flushMachinePublish(sessionDir, { gameEpoch: gameEpochOf(token), storeDir, executePublish });
          },
          consume: () => createTrainingControl({ storeDir }).consumeTrainingItems(sessionDir, { storeDir }) });
        assert.equal(training.ok, true, 'production training evaluation failed');
        return training;
      },
      async startNextHand() {
        const legal = await engineLegal();
        assert.equal(legal.handOver, true); assert.equal(legal.gameOver, false);
        return engineStep(['--new-hand']);
      },
      async reachUserTurn() {
        for (let round = 0; round < 100; round += 1) {
          const step = await engineStep([], { viewOnly: true });
          if (step.view.legal || step.gameOver) return step;
          if (step.handOver) await engineStep(['--new-hand']);
          else await engineStep([step.next.toAct, 'fold']);
        }
        throw new Error('could not reach a real user decision');
      },
      async reachShortAllIn({ openRaiseTo = 125 } = {}) {
        for (let hand = 0; hand < 12; hand += 1) {
          let opened = false;
          for (let step = 0; step < 100; step += 1) {
            const legal = await engineLegal();
            if (legal.handOver) break;
            if (legal.toAct === 'user' && legal.canRaise && legal.minRaiseTo > legal.maxRaiseTo) {
              return this.snapshot();
            }
            if (legal.street === 'preflop' && legal.toAct !== 'user' && !opened && legal.canRaise
              && legal.minRaiseTo <= openRaiseTo && openRaiseTo <= legal.maxRaiseTo) {
              await engineStep([legal.toAct, 'raise', String(openRaiseTo)]); opened = true;
            } else {
              await engineStep([legal.toAct, legal.canCheck ? 'check' : 'fold']);
            }
          }
          const ended = await engineLegal();
          if (ended.gameOver) break;
          await engineStep(['--new-hand']);
        }
        throw new Error('could not reach a production short all-in decision');
      },
      async restartRelay() {
        const port = relay.port;
        try { await relay.close(); } catch (error) { throw new Error('relay restart close failed', { cause: error }); }
        relay = null;
        try { await startRelay(port); } catch (error) { throw new Error('relay restart startup failed', { cause: error }); }
        try { await engineStep([], { viewOnly: true }); } catch (error) { throw new Error('relay restart resync failed', { cause: error }); }
      }, close,
    };
  } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup]); } throw error; }
}

export async function createReviewBrowserFixture() {
  const workspace = createBrowserWorkspace();
  const gameDir = path.join(workspace.root, 'review-game');
  let loop; let runPromise = null;
  try {
    fs.mkdirSync(gameDir, { mode: 0o700 });
    const { createGameLoop } = await import(pathToFileURL(path.join(ROOT, 'tools/game-loop.js')).href);
    loop = createGameLoop({ gameDir,
      resolver: async ({ need }) => {
        assert.equal(need, 'upper-only');
        return { player: null, upper: null, notices: ['상위 모델 런타임 없음 — production machine review'] };
      },
      opts: { port: 0, opponentRuntime: 'policy', trainingEnabled: false, waitMs: 5_000 } });
    const state = await loop.bootstrap({ ai: 5, mode: 'cash-training', stackBb: 100,
      hands: 1, opponentRuntime: 'policy' });
    const engine = JSON.parse(fs.readFileSync(path.join(gameDir, 'state.json'), 'utf8'));
    assert.ok(Number.isSafeInteger(state.port) && state.port > 0);
    return { gameDir,
      tableUrl: `http://127.0.0.1:${state.port}/?${new URLSearchParams({ token: engine.sessionToken })}`,
      start() {
        assert.equal(runPromise, null);
        runPromise = loop.run();
        runPromise.catch(() => {});
        return runPromise;
      },
      async waitDone() {
        assert.ok(runPromise);
        let timer;
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('review loop timeout')), 30_000); });
        const done = await Promise.race([runPromise, timeout]).finally(() => clearTimeout(timer));
        assert.equal(done.phase, 'done'); return done;
      },
      async close() {
        await loop.requestStop();
        let runError = null;
        if (runPromise) try { await runPromise; } catch (error) { runError = error; }
        workspace.close();
        if (runError) throw runError;
      },
    };
  } catch (error) {
    let cleanup = null;
    if (loop) try { await loop.requestStop(); } catch (failure) { cleanup = failure; }
    if (!cleanup) workspace.close();
    if (cleanup) throw new AggregateError([error, cleanup], 'review fixture cleanup failed');
    throw error;
  }
}
