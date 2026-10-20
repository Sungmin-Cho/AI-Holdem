// #292 B at the loop boundary: a coach note an earlier participant-card rule accepted and
// queued, then refused by the current rule, must not hold every later publication. The real
// loop, relay, publisher, coach control and engine run; only the player is a stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createGameLoop, initializePreparedSession } from '../tools/game-loop.js';
import { createCoachControl, UNAVAILABLE_TEXT } from '../tools/coach-control.js';
import {
  ROOT,
  WIN32_SCALE,
  TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES,
  cliJson,
  makeAdapter,
  putAiFirst,
  readJson,
  readLoopLog,
  resolverFor,
  startRun,
  tmpGame,
  waitFor,
} from './helpers/game-loop-fixtures.mjs';

const PUBLISH_CLI = path.join(ROOT, 'tools/publish.js');
const TIMEOUT = 60_000 * WIN32_SCALE;
const attemptFile = (dir) => path.join(dir, '.publish-attempt.json');

function runPublisher(dir, args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [PUBLISH_CLI, ...args, '--game-dir', dir], { encoding: 'utf8', timeout: 20_000 }, (error, stdout) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(Object.assign(new Error(envelope?.message ?? 'publisher failed'), { code: envelope?.code ?? 'CHILD_FAILED', envelope }));
        return;
      }
      resolve(envelope);
    });
  });
}

function newLoop(t, gameDir, extra = {}) {
  const loop = createGameLoop({
    gameDir,
    resolver: resolverFor(makeAdapter()),
    // A multiplayer session resumes only under the app's control protocol.
    opts: {
      port: 0, waitMs: 0, controlProtocolVersion: 1, scanCoachRuntimeProcesses: TEST_DEFAULT_SCAN_COACH_RUNTIME_PROCESSES, ...extra,
    },
  });
  t.after(() => loop.requestStop().catch(() => {}));
  return loop;
}

// A multiplayer game (host, h1, one AI) whose first hand h1 folded, so h1's cards stay hidden,
// with a coach note for that hand quoting one of them, accepted and queued as an earlier rule
// would have done. The loop is still running its relay when this returns.
async function multiGameWithQueuedLeak(t, { note = (hidden) => `핸드 1에서 h1이 버린 ${hidden}를 다시 봅니다.`, queue = true } = {}) {
  const gameDir = tmpGame();
  const first = newLoop(t, gameDir);
  const setup = { ai: 1, stack: 100, replayReveal: 'all' };
  const preinitialized = await initializePreparedSession(gameDir, {
    ...setup, participants: [{ playerId: 'h1', name: '민준', participantId: 'part-1' }],
  });
  await first.bootstrap({ ...setup, preinitialized });
  // From the user's button the deal moves it to h1: p1 posts the small blind, the user the big.
  putAiFirst(gameDir);
  await cliJson(gameDir, ['step', '--new-hand']);
  await cliJson(gameDir, ['apply', 'h1', 'fold']);
  await cliJson(gameDir, ['apply', 'p1', 'fold']);
  await cliJson(gameDir, ['step']);
  const record = readJson(path.join(gameDir, 'state.json')).lastHand;
  assert.equal(record?.handNo, 1);
  assert.ok(record.folded.includes('h1') && !record.showdown);
  const hidden = record.holes.h1[0];
  const leak = note(hidden);
  const cc = createCoachControl();
  if (!queue) return { gameDir, first, cc, leak, hidden, snapshotFile: path.join(gameDir, 'ui-snapshot.json') };
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const statsFile = path.join(gameDir, '.test-coach-stats.json');
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0 } } }));
  const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
  const begun = await cc.beginOwner({ gameDir, owner, completed: 1, statsFile, snapshotFile });
  const descriptor = begun.descriptors.find((row) => row.handNo === 1);
  fs.writeFileSync(descriptor.exactResultPath, `${JSON.stringify({ handNo: 1, text: leak })}\n`);
  const accepted = await cc.accept({ gameDir, owner, handNo: 1, generation: descriptor.generation });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const queued = cc.loadAuthority(gameDir).publishQueue['1'];
  return { gameDir, first, cc, queued, leak, hidden, snapshotFile };
}

function assertWithheld(gameDir, cc, queued, leak) {
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'], undefined);
  const [evidence] = auth.withheldPublications ?? [];
  assert.equal(evidence?.queueId, queued.queueId);
  assert.equal(evidence.reason, 'FORBIDDEN_LITERAL');
  assert.equal(auth.publishedSeals['1'].queueId, evidence.replacementQueueId);
  assert.equal(auth.publishedSeals['1'].noteKind, 'unavailable');
  // The refused text is kept on disk and never reached the relay, its file or its history.
  assert.ok(fs.readFileSync(queued.exactEnvelopePath, 'utf8').includes(leak));
  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(JSON.stringify(snapshot).includes(leak), false);
  assert.deepEqual(snapshot.coach.filter((note) => note.handNo === 1).map((note) => [note.text, note.unavailable]), [[UNAVAILABLE_TEXT, true]]);
  return evidence;
}

test('#292 재개는 현재 규칙이 거절할 큐 노트를 보내지 않고 보류한 뒤 같은 핸드의 unavailable 노트를 게시한다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, leak } = await multiGameWithQueuedLeak(t);
  await first.requestStop();
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  await restarted.resume();
  await restarted.requestStop();
  assertWithheld(gameDir, cc, queued, leak);
  // The publisher was never handed the refused envelope.
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
  const withheld = readLoopLog(gameDir).filter((row) => row.event === 'coach-publish-withheld');
  assert.deepEqual(withheld.map((row) => [row.handNo, row.outcome, row.reason]), [[1, 'withheld', 'FORBIDDEN_LITERAL']]);
});

test('#292 relay가 거절해 남은 기록 attempt는 보류 뒤 보내지 않고 지워지고 증거에 그 attempt가 남는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, leak } = await multiGameWithQueuedLeak(t);
  // The relay refuses the note, as it does once it runs the current rule, and the attempt stays.
  const refused = await runPublisher(gameDir, ['--from', queued.exactEnvelopePath]).then(() => null, (error) => error);
  assert.equal(refused?.code, 'PUBLISH_REJECTED');
  assert.equal(refused.envelope?.serverCode, 'FORBIDDEN_LITERAL');
  const recorded = readJson(attemptFile(gameDir));
  await first.requestStop();
  const restarted = newLoop(t, gameDir);
  await restarted.resume();
  await restarted.requestStop();
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const evidence = assertWithheld(gameDir, cc, queued, leak);
  assert.equal(evidence.attemptPublishId, recorded.body.publishId);
  assert.equal(evidence.attemptBodySha256, createHash('sha256').update(JSON.stringify(recorded.body)).digest('hex'));
  assert.deepEqual(JSON.parse(JSON.parse(fs.readFileSync(evidence.attemptEvidencePath, 'utf8')).raw), recorded);
});

test('#292 큐 메타데이터는 그대로이고 본문만 바뀐 노트는 보류하지도 보내지도 않는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, leak } = await multiGameWithQueuedLeak(t);
  // The envelope keeps its authority, but its note is not the one the item was queued with.
  const envelope = readJson(queued.exactEnvelopePath);
  envelope.coach[0].text = `${leak} 덧붙임`;
  fs.writeFileSync(queued.exactEnvelopePath, JSON.stringify(envelope));
  await first.requestStop();
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  const failure = await restarted.resume().then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure?.code, 'COACH_WITHHOLD_UNBOUND');
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'].queueId, queued.queueId);
  assert.equal(auth.withheldPublications, undefined);
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
  const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
  assert.equal(fs.existsSync(snapshotFile) && fs.readFileSync(snapshotFile, 'utf8').includes(leak), false);
});

for (const which of ['original', 'replacement']) {
  test(`#292 응답만 잃은 ${which === 'original' ? '원본' : '대체'} 노트는 reconcile로 seal하고 남은 기록은 보내지 않고 지운다`, { timeout: TIMEOUT }, async (t) => {
    const { gameDir, first, cc, queued, leak, snapshotFile } = await multiGameWithQueuedLeak(t);
    let item = queued;
    if (which === 'replacement') {
      // The note was withheld and its unavailable replacement queued, as a resume would.
      const out = await cc.withholdQueued({
        gameDir, handNo: 1, queueId: queued.queueId, payloadSha256: queued.payloadSha256,
        exactEnvelopePath: queued.exactEnvelopePath, reason: 'FORBIDDEN_LITERAL', snapshotFile,
      });
      item = cc.loadAuthority(gameDir).publishQueue['1'];
      assert.equal(item.queueId, out.replacementQueueId);
    }
    // A relay applied the note and the answer was lost: the snapshot holds the proof-bearing note
    // and the recorded attempt is still on disk.
    const envelope = readJson(item.exactEnvelopePath);
    const sessionToken = readJson(path.join(gameDir, 'state.json')).sessionToken;
    const { gameEpochOf } = await import('../publish-contract.js');
    await first.requestStop();
    const snapshot = fs.existsSync(snapshotFile) ? readJson(snapshotFile) : { revision: 0, publishId: 0, view: null, log: [], coach: [] };
    snapshot.coach = [...(snapshot.coach ?? []), ...envelope.coach];
    snapshot.publishId = (snapshot.publishId ?? 0) + 1;
    snapshot.revision = (snapshot.revision ?? 0) + 1;
    fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
    fs.writeFileSync(attemptFile(gameDir), JSON.stringify({
      expectedGameEpoch: gameEpochOf(sessionToken),
      body: { publishId: snapshot.publishId, coach: envelope.coach },
      coachAuthority: envelope.coachAuthority,
    }));
    const restarted = newLoop(t, gameDir);
    await restarted.resume();
    // The coach queue is reconciled at resume; the recorded body is settled where play resumes.
    const running = startRun(restarted);
    // The resume entry settles the recorded body first and checks the archive after it.
    await waitFor(
      () => readLoopLog(gameDir).some((row) => row.event === 'resume-archive-check'),
      'the resume entry did not get past the recorded attempt',
      20_000 * WIN32_SCALE,
    );
    await restarted.requestStop();
    const failure = await running.then(() => null, (error) => error);
    assert.equal(failure, null, failure?.code);
    const auth = cc.loadAuthority(gameDir);
    assert.equal(auth.publishedSeals['1'].queueId, item.queueId);
    assert.equal(fs.existsSync(attemptFile(gameDir)), false);
    if (which === 'original') {
      assert.equal(auth.withheldPublications, undefined);
      // The note stays in the file for the proof; the relay does not show it to the host.
      assert.ok(readJson(snapshotFile).coach.some((note) => note.text === leak));
      assert.equal(readLoopLog(gameDir).some((row) => row.event === 'coach-publish-withheld'), false);
    } else {
      assert.equal(auth.withheldPublications.length, 1);
      assert.equal(JSON.stringify(readJson(snapshotFile)).includes(leak), false);
    }
  });
}

test('#292 보류 전이를 저장한 뒤 기록 정리 전에 멈췄으면 재개가 그 기록을 보내지 않고 지우고 대체 노트를 게시한다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, leak, snapshotFile } = await multiGameWithQueuedLeak(t);
  const refused = await runPublisher(gameDir, ['--from', queued.exactEnvelopePath]).then(() => null, (error) => error);
  assert.equal(refused?.envelope?.serverCode, 'FORBIDDEN_LITERAL');
  const recorded = readJson(attemptFile(gameDir));
  // The transition the loop makes, then a stop before the publisher removed the record.
  await cc.withholdQueued({
    gameDir, handNo: 1, queueId: queued.queueId, payloadSha256: queued.payloadSha256,
    exactEnvelopePath: queued.exactEnvelopePath, reason: 'FORBIDDEN_LITERAL', snapshotFile,
    attemptBodySha256: createHash('sha256').update(JSON.stringify(recorded.body)).digest('hex'),
  });
  await first.requestStop();
  assert.equal(fs.existsSync(attemptFile(gameDir)), true);
  const restarted = newLoop(t, gameDir);
  await restarted.resume();
  await restarted.requestStop();
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const evidence = assertWithheld(gameDir, cc, queued, leak);
  assert.equal(evidence.attemptPublishId, recorded.body.publishId);
});

// A publisher that answers STALE_COACH_AUTHORITY to a bound resend without removing the record
// (its unlink failed): the loop must not report the record settled.
function staleWithoutUnlinkPublisher(dir) {
  const shim = path.join(dir, 'stale-publisher.mjs');
  fs.writeFileSync(shim, `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--expect-attempt-sha256')) {
  process.stdout.write(JSON.stringify({ ok: false, code: 'STALE_COACH_AUTHORITY' }) + '\\n');
  process.exit(1);
}
const real = spawnSync(process.execPath, [${JSON.stringify(PUBLISH_CLI)}, ...args], { encoding: 'utf8' });
process.stdout.write(real.stdout);
process.exit(real.status ?? 1);
`);
  return shim;
}

test('#292 publisher가 STALE로 답해도 그 기록이 남아 있으면 정리됐다고 보지 않는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, snapshotFile } = await multiGameWithQueuedLeak(t);
  const envelope = readJson(queued.exactEnvelopePath);
  const sessionToken = readJson(path.join(gameDir, 'state.json')).sessionToken;
  const { gameEpochOf } = await import('../publish-contract.js');
  await first.requestStop();
  // The note was published and the answer lost: the snapshot proves it, the record remains.
  const snapshot = fs.existsSync(snapshotFile) ? readJson(snapshotFile) : { revision: 0, publishId: 0, view: null, log: [], coach: [] };
  snapshot.coach = [...(snapshot.coach ?? []), ...envelope.coach];
  snapshot.publishId = (snapshot.publishId ?? 0) + 1;
  snapshot.revision = (snapshot.revision ?? 0) + 1;
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
  const record = { expectedGameEpoch: gameEpochOf(sessionToken), body: { publishId: snapshot.publishId, coach: envelope.coach }, coachAuthority: envelope.coachAuthority };
  fs.writeFileSync(attemptFile(gameDir), JSON.stringify(record));
  const shimDir = fs.mkdtempSync(path.join(path.dirname(gameDir), 'stale-shim-'));
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));
  const restarted = newLoop(t, gameDir, { publishCliPath: staleWithoutUnlinkPublisher(shimDir) });
  await restarted.resume();
  const failure = await startRun(restarted).then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure?.code, 'STALE_ATTEMPT_REMAINS');
  assert.deepEqual(readJson(attemptFile(gameDir)), record);
  assert.equal(cc.loadAuthority(gameDir).publishedSeals['1'].queueId, queued.queueId);
});

test('#292 digest가 덮지 않는 문자열로는 정상 노트를 보류하지 않는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, hidden } = await multiGameWithQueuedLeak(t, { note: () => '프리플랍 콜 범위를 다시 봅니다.' });
  // The note itself is clean; a field its digest does not cover names h1's hidden card.
  const envelope = readJson(queued.exactEnvelopePath);
  envelope.coach[0].debug = `h1 ${hidden}`;
  fs.writeFileSync(queued.exactEnvelopePath, JSON.stringify(envelope));
  await first.requestStop();
  const restarted = newLoop(t, gameDir);
  const failure = await restarted.resume().then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure?.code, 'COACH_WITHHOLD_UNBOUND');
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'].queueId, queued.queueId);
  assert.equal(auth.withheldPublications, undefined);
});

test('#292 proof 없는 legacy overfold 노트의 migration 보류는 relay의 sticky overfold를 지키며 대체 노트로 봉인된다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, leak, snapshotFile } = await multiGameWithQueuedLeak(t, { queue: false });
  await first.requestStop();
  // An earlier relay showed a proof-less overfold note for hand 1; no migration has run yet.
  const snapshot = fs.existsSync(snapshotFile) ? readJson(snapshotFile) : { revision: 0, publishId: 0, view: null, log: [], coach: [] };
  snapshot.coach = [{ handNo: 1, text: leak, overfold: true }];
  fs.writeFileSync(snapshotFile, JSON.stringify(snapshot));
  const { gameEpochOf } = await import('../publish-contract.js');
  const epoch = gameEpochOf(readJson(path.join(gameDir, 'state.json')).sessionToken);
  fs.writeFileSync(path.join(gameDir, '.coach-authority.json'), JSON.stringify({
    schemaVersion: 2, gameEpoch: epoch, activeOwnerSessionId: readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId,
    adapterState: 'enabled', legacyMigrationCompleted: false, overfoldLease: null, hands: {}, retiredAttempts: [],
    publishQueue: {}, publishedSeals: {}, deferred: {}, noNewPlayTimePublishers: false, finalization: null,
  }));
  const restarted = newLoop(t, gameDir);
  await restarted.resume();
  await restarted.requestStop();
  const auth = cc.loadAuthority(gameDir);
  const [evidence] = auth.withheldPublications ?? [];
  assert.match(evidence?.queueId ?? '', /:migration:1:/);
  assert.equal(evidence.overfold, true);
  assert.equal(auth.publishedSeals['1'].queueId, evidence.replacementQueueId);
  assert.equal(auth.publishedSeals['1'].overfold, true);
  assert.equal(auth.overfoldLease?.state, 'spent');
  const stored = readJson(snapshotFile);
  assert.deepEqual(stored.coach.filter((note) => note.handNo === 1).map((note) => [note.text, note.unavailable, note.overfold]), [[UNAVAILABLE_TEXT, true, true]]);
  assert.equal(JSON.stringify(stored).includes(leak), false);
  assert.ok(fs.readFileSync(evidence.exactEnvelopePath, 'utf8').includes(leak));
});

// The first send of a queued note reaches the relay and is applied, its answer is lost, and a
// reconcile seals the item before the loop's resend bound to that record runs.
function ackLostThenReconciledPublisher(dir, gameDir) {
  const shim = path.join(dir, 'ack-lost-publisher.mjs');
  const marker = path.join(dir, 'used');
  fs.writeFileSync(shim, `
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
const args = process.argv.slice(2);
const real = (argv) => spawnSync(process.execPath, [${JSON.stringify(PUBLISH_CLI)}, ...argv], { encoding: 'utf8' });
const from = args[args.indexOf('--from') + 1] ?? '';
if (!args.includes('--retry') && from.includes('.coach-') && !fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, '1');
  const sent = real(args);
  const out = JSON.parse(sent.stdout.trim());
  if (!out.ok) { process.stdout.write(sent.stdout); process.exit(1); }
  spawnSync(process.execPath, [${JSON.stringify(path.join(ROOT, 'tools/coach-control.js'))}, 'reconcile',
    '--snapshot-file', ${JSON.stringify(path.join(gameDir, 'ui-snapshot.json'))}, '--game-dir', ${JSON.stringify(gameDir)}], { encoding: 'utf8' });
  const envelope = JSON.parse(fs.readFileSync(from, 'utf8'));
  const body = { publishId: out.publishId, coach: envelope.coach };
  fs.writeFileSync(${JSON.stringify(path.join(gameDir, '.publish-attempt.json'))}, JSON.stringify({ body, expectedGameEpoch: envelope.coachAuthority.expectedGameEpoch, coachAuthority: envelope.coachAuthority }));
  const bodySha256 = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  process.stdout.write(JSON.stringify({ ok: false, code: 'PUBLISH_FAILED', message: 'lost', attempt: { bodySha256, publishId: out.publishId, expectedGameEpoch: envelope.coachAuthority.expectedGameEpoch } }) + '\\n');
  process.exit(1);
}
const passed = real(args);
process.stdout.write(passed.stdout);
process.exit(passed.status ?? 1);
`);
  return shim;
}

test('#292 응답을 잃은 첫 전송 뒤 reconcile이 먼저 봉인해도 그 기록에 결속된 자동 재전송은 정리 결과로 이어 간다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await multiGameWithQueuedLeak(t, { note: () => '프리플랍 콜 범위를 다시 봅니다.' });
  await first.requestStop();
  const shimDir = fs.mkdtempSync(path.join(path.dirname(gameDir), 'ack-lost-shim-'));
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));
  const restarted = newLoop(t, gameDir, { publishCliPath: ackLostThenReconciledPublisher(shimDir, gameDir) });
  const failure = await restarted.resume().then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure, null, `${failure?.code} ${failure?.message}`);
  assert.equal(fs.existsSync(path.join(shimDir, 'used')), true, 'the lost answer was staged');
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishedSeals['1'].queueId, queued.queueId);
  assert.equal(auth.withheldPublications, undefined);
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
});
