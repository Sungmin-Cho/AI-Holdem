import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startServer } from '../server/server.js';
import { evaluationIdOf } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import { createTrainingControl } from '../tools/training-control.js';
import { gameEpochOf } from '../publish-contract.js';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tools/publish.js');
const execFileAsync = promisify(execFile);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-tpub-'));
}

async function run(dir, args) {
  const { stdout } = await execFileAsync(process.execPath, [TOOL, ...args, '--game-dir', dir], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim());
}

async function runFailing(dir, args) {
  try {
    await execFileAsync(process.execPath, [TOOL, ...args, '--game-dir', dir], {
      encoding: 'utf8',
      timeout: 20_000,
    });
  } catch (error) {
    return { json: JSON.parse(String(error.stdout ?? '').trim() || 'null') };
  }
  throw new Error('실패했어야 하는 호출이 성공했습니다');
}

function summaryOf(overrides = {}) {
  const evaluation = {
    schemaVersion: 1,
    evaluationId: evaluationIdOf({
      gameEpoch: gameEpochOf('tok'),
      decisionId: 'd-1-preflop-0',
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    decisionId: 'd-1-preflop-0',
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    bestEvBb: null,
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    ...overrides,
  };
  return toPublicSummary(evaluation, { handNo: 1, detailSha256: 'ab'.repeat(32) });
}

test('publish: view 없는 training-only envelope를 수락하고 buildBody가 training을 복사한다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const summary = summaryOf();
    const file = path.join(dir, 'training.json');
    fs.writeFileSync(file, JSON.stringify({ training: [summary] }));
    const out = await run(dir, ['--from', file]);
    assert.equal(out.ok, true);
    const snap = await (await fetch(`http://127.0.0.1:${started.port}/api/snapshot?token=tok`)).json();
    assert.equal(snap.training.length, 1);
    assert.equal(snap.training[0].evaluationId, summary.evaluationId);
    assert.equal(snap.training[0].grade, 'preferred');
    assert.equal(JSON.stringify(snap).includes('Apache-2.0'), false);
  } finally {
    await started.close();
  }
});

test('server merge: same digest is a no-op, different digest fail-closed; restart restores training', async () => {
  const dir = tmpDir();
  const token = 'tok';
  let a = await startServer({ gameDir: dir, port: 0, token });
  let b;
  try {
    const summary = summaryOf();
    const publish = (port, body) => fetch(`http://127.0.0.1:${port}/api/publish?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((res) => res.json().then((json) => ({ status: res.status, json })));
    const first = await publish(a.port, { publishId: 1, training: [summary] });
    assert.equal(first.json.ok, true);
    const again = await publish(a.port, { publishId: 2, training: [summary] });
    assert.equal(again.json.ok, true);
    const snap = await (await fetch(`http://127.0.0.1:${a.port}/api/snapshot?token=${token}`)).json();
    assert.equal(snap.training.length, 1);
    const conflict = await publish(a.port, {
      publishId: 3,
      training: [{ ...summary, grade: 'off-policy', payloadSha256: 'ff'.repeat(32) }],
    });
    assert.equal(conflict.json.ok, false);
    assert.equal(conflict.json.code, 'TRAINING_CONFLICT');
    await a.close();
    a = null;
    b = await startServer({ gameDir: dir, port: 0, token });
    const restored = await (await fetch(`http://127.0.0.1:${b.port}/api/snapshot?token=${token}`)).json();
    assert.equal(restored.training.length, 1);
    assert.equal(restored.training[0].evaluationId, summary.evaluationId);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
  }
});

test('cutoff 이후 training authority가 있으면 게시되고 play-time은 막힌다', async () => {
  const dir = tmpDir();
  const started = await startServer({ gameDir: dir, port: 0, token: 'tok' });
  try {
    const evaluation = {
      schemaVersion: 1,
      evaluationId: evaluationIdOf({
        gameEpoch: gameEpochOf('tok'),
        decisionId: 'd-1-preflop-0',
        providerId: 'local-preflop-baseline',
        providerVersion: '1.0.0',
      }),
      decisionId: 'd-1-preflop-0',
      status: 'supported',
      street: 'preflop',
      spotKey: '6max-100bb-btn-rfi-unopened',
      handClass: 'AA',
      recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
      chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
      bestEvBb: null,
      evLossBb: null,
      grade: 'preferred',
      forced: false,
      source: { id: 'local-preflop-baseline', version: '1.0.0' },
    };
    const tc = createTrainingControl();
    await tc.acceptEvaluations(dir, {
      gameEpoch: gameEpochOf('tok'),
      owner: 'owner-1',
      handNo: 1,
      evaluations: [evaluation],
    });
    const auth = tc.loadAuthority(dir);
    const queued = auth.publishQueue[evaluation.evaluationId];
    const summary = JSON.parse(fs.readFileSync(path.join(dir, 'training', 'evaluations.jsonl'), 'utf8').trim());
    const authPath = path.join(dir, '.coach-authority.json');
    fs.writeFileSync(authPath, JSON.stringify({
      schemaVersion: 2,
      gameEpoch: gameEpochOf('tok'),
      noNewPlayTimePublishers: true,
      hands: {},
      publishQueue: {},
      publishedSeals: {},
      retiredAttempts: [],
    }));
    const trainingFile = path.join(dir, 'training-env.json');
    fs.writeFileSync(trainingFile, JSON.stringify({
      training: [summary],
      trainingAuthority: {
        expectedGameEpoch: gameEpochOf('tok'),
        evaluationId: summary.evaluationId,
        payloadSha256: summary.payloadSha256,
      },
    }));
    const published = await run(dir, ['--from', trainingFile]);
    assert.equal(published.ok, true);
    const turn = path.join(dir, 'turn.json');
    fs.writeFileSync(turn, JSON.stringify({
      ok: true,
      stateVersion: 3,
      events: [],
      handOver: false,
      gameOver: false,
      view: { handNo: 1, toAct: 'user', seats: [] },
      viewFor: 'user',
      next: { toAct: 'user', kind: 'user', decisionId: 'd-1-preflop-1' },
    }));
    const blocked = await runFailing(dir, ['--from', turn]);
    assert.equal(blocked.json.code, 'PLAYTIME_PUBLISH_STOPPED');
  } finally {
    await started.close();
  }
});
