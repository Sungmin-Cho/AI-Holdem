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
import { payloadSha256, proofBearingCoachNote, publicProofId } from '../publish-contract.js';
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

// The engine state the loop judges by must be this game's, complete, as the relay requires: an
// absent, null, partial or other game's state judges nothing, and nothing is withheld or sent.
for (const [name, spoil] of [
  ['absent', (file) => fs.rmSync(file)],
  ['null', (file) => fs.writeFileSync(file, 'null')],
  ['partial', (file) => fs.writeFileSync(file, JSON.stringify({ sessionToken: readJson(file).sessionToken, seats: readJson(file).seats }))],
  ['another game', (file) => fs.writeFileSync(file, JSON.stringify({ ...readJson(file), sessionToken: 'another-game-token' }))],
]) {
  test(`#292 엔진 상태가 ${name}이면 코치 노트를 판정하지 않고 보류하지도 보내지도 않는다`, { timeout: TIMEOUT }, async (t) => {
    const { gameDir, first, cc, queued } = await multiGameWithQueuedLeak(t);
    await first.requestStop();
    const sent = [];
    let spoiled = false;
    const restarted = newLoop(t, gameDir, {
      onPublishInvoke: (args) => sent.push(args),
      // The drain reconciles first, then judges the queued note: the state changes in between.
      onCoachInvoke: (args) => {
        if (args[0] !== 'reconcile' || spoiled) return;
        spoiled = true;
        spoil(path.join(gameDir, 'state.json'));
      },
    });
    const failure = await restarted.resume().then(() => null, (error) => error);
    await restarted.requestStop();
    assert.equal(spoiled, true, 'the drain was reached');
    assert.equal(failure?.code, 'FORBIDDEN_LITERAL_UNAVAILABLE', `${name}: ${failure?.code}`);
    const auth = cc.loadAuthority(gameDir);
    assert.equal(auth.publishQueue['1'].queueId, queued.queueId);
    assert.equal(auth.withheldPublications, undefined);
    assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
  });
}

// #310: the claim rule a fresh note is held to (coachingClaimAllowed) can change between
// versions too. The relay applies it to decision strings only, never to the text. A queued note
// it refuses now is a stored, proof-bound body that is never rewritten: withheld whole (text kept
// on disk, never sent) and the hand's unavailable note published in its place. The
// participant-card rule decides first.
const CLAIM = '이 콜은 EV 손실이 1.5bb입니다.';

// A solo game (user and one AI) whose first hand is over, with a coach note for it accepted
// and queued as an earlier claim rule would have done.
async function soloGameWithQueuedNote(t, text = CLAIM) {
  const gameDir = tmpGame();
  const first = newLoop(t, gameDir);
  await first.bootstrap({ ai: 1, stack: 100 });
  putAiFirst(gameDir);
  await cliJson(gameDir, ['step', '--new-hand']);
  await cliJson(gameDir, ['apply', 'p1', 'fold']);
  await cliJson(gameDir, ['step']);
  assert.equal(readJson(path.join(gameDir, 'state.json')).lastHand?.handNo, 1);
  const cc = createCoachControl();
  const owner = readJson(path.join(gameDir, 'loop-state.json')).ownerSessionId;
  const statsFile = path.join(gameDir, '.test-coach-stats.json');
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0 } } }));
  const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
  const begun = await cc.beginOwner({ gameDir, owner, completed: 1, statsFile, snapshotFile });
  const descriptor = begun.descriptors.find((row) => row.handNo === 1);
  fs.writeFileSync(descriptor.exactResultPath, `${JSON.stringify({ handNo: 1, text })}\n`);
  const accepted = await cc.accept({ gameDir, owner, handNo: 1, generation: descriptor.generation });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  return { gameDir, first, cc, queued: cc.loadAuthority(gameDir).publishQueue['1'], snapshotFile };
}

function assertClaimWithheld(gameDir, cc, queued, text = CLAIM) {
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'], undefined);
  const [evidence] = auth.withheldPublications ?? [];
  assert.deepEqual([evidence?.queueId, evidence?.reason], [queued.queueId, 'REFERENCE_AUTHORITY_CLAIM']);
  assert.equal(auth.publishedSeals['1'].queueId, evidence.replacementQueueId);
  assert.equal(auth.publishedSeals['1'].noteKind, 'unavailable');
  assert.ok(fs.readFileSync(queued.exactEnvelopePath, 'utf8').includes(text));
  const snapshot = readJson(path.join(gameDir, 'ui-snapshot.json'));
  assert.equal(JSON.stringify(snapshot).includes(text), false);
  assert.deepEqual(snapshot.coach.filter((note) => note.handNo === 1).map((note) => [note.text, note.unavailable]), [[UNAVAILABLE_TEXT, true]]);
  return evidence;
}

test('#310 재개는 현재 문구 규칙이 거절할 큐 노트를 보내지 않고 보류한 뒤 unavailable 노트를 게시한다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await soloGameWithQueuedNote(t);
  await first.requestStop();
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  await restarted.resume();
  await restarted.requestStop();
  assertClaimWithheld(gameDir, cc, queued);
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
  const withheld = readLoopLog(gameDir).filter((row) => row.event === 'coach-publish-withheld');
  assert.deepEqual(withheld.map((row) => [row.handNo, row.outcome, row.reason]), [[1, 'withheld', 'REFERENCE_AUTHORITY_CLAIM']]);
});

// What the publisher records before it sends a queued envelope, left behind when the answer is lost.
async function recordAttemptOf(gameDir, item, publishId = 41) {
  const { gameEpochOf } = await import('../publish-contract.js');
  const envelope = readJson(item.exactEnvelopePath);
  const record = {
    expectedGameEpoch: gameEpochOf(readJson(path.join(gameDir, 'state.json')).sessionToken),
    body: { publishId, coach: envelope.coach },
    coachAuthority: envelope.coachAuthority,
  };
  fs.writeFileSync(attemptFile(gameDir), JSON.stringify(record));
  return record;
}

test('#310 문구 규칙에 걸리는 노트의 기록 attempt는 보류 뒤 보내지 않고 지워지고 증거에 그 attempt가 남는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await soloGameWithQueuedNote(t);
  await first.requestStop();
  const recorded = await recordAttemptOf(gameDir, queued);
  const restarted = newLoop(t, gameDir);
  await restarted.resume();
  const running = startRun(restarted);
  await waitFor(
    () => readLoopLog(gameDir).some((row) => row.event === 'resume-archive-check'),
    'the resume entry did not get past the recorded attempt',
    20_000 * WIN32_SCALE,
  );
  await restarted.requestStop();
  const failure = await running.then(() => null, (error) => error);
  assert.equal(failure, null, failure?.code);
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const evidence = assertClaimWithheld(gameDir, cc, queued);
  assert.equal(evidence.attemptPublishId, recorded.body.publishId);
  assert.deepEqual(JSON.parse(JSON.parse(fs.readFileSync(evidence.attemptEvidencePath, 'utf8')).raw), recorded);
});

test('#310 큐 항목에 묶이지 않은 문구 위반 노트는 지금처럼 REFERENCE_AUTHORITY_CLAIM으로 멈추고 아무것도 바꾸거나 보내지 않는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await soloGameWithQueuedNote(t, '핸드 1의 폴드는 무난했습니다.');
  // The envelope keeps its authority, but its note is not the one the item was queued with.
  const envelope = readJson(queued.exactEnvelopePath);
  envelope.coach[0].text = CLAIM;
  fs.writeFileSync(queued.exactEnvelopePath, JSON.stringify(envelope));
  await first.requestStop();
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  const failure = await restarted.resume().then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure?.code, 'REFERENCE_AUTHORITY_CLAIM');
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'].queueId, queued.queueId);
  assert.equal(auth.withheldPublications, undefined);
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
  const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
  assert.equal(fs.existsSync(snapshotFile) && fs.readFileSync(snapshotFile, 'utf8').includes(CLAIM), false);
});

test('#310 두 규칙에 모두 걸리는 노트는 참가자 카드 사유(FORBIDDEN_LITERAL)로 보류한다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued, leak } = await multiGameWithQueuedLeak(t, {
    note: (hidden) => `h1이 버린 ${hidden}로는 이 콜의 EV 손실이 1.5bb입니다.`,
  });
  await first.requestStop();
  const restarted = newLoop(t, gameDir);
  await restarted.resume();
  await restarted.requestStop();
  assertWithheld(gameDir, cc, queued, leak);
});

test('#310 큐가 이미 지나간(stale) 문구 위반 기록은 지금처럼 보내지 않고 기록을 그대로 둔 채 REFERENCE_AUTHORITY_CLAIM으로 멈춘다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await soloGameWithQueuedNote(t);
  await first.requestStop();
  const recorded = await recordAttemptOf(gameDir, queued);
  // The queue moved past the recorded item without sealing or withholding it (within a game only
  // a seal or a withholding of that item does, and coachAttemptSettled settles both): the hand is
  // sealed as another item, so nothing coaches it again and only the record's resend is left.
  const authPath = path.join(gameDir, '.coach-authority.json');
  const auth = readJson(authPath);
  delete auth.publishQueue['1'];
  auth.publishedSeals['1'] = {
    queueId: `${auth.gameEpoch}:1:99:${'0'.repeat(64)}`, handNo: 1, noteKind: 'unavailable', payloadSha256: '0'.repeat(64),
    publicProofId: '1'.repeat(64), overfold: false, publishedAtRevision: null,
  };
  fs.writeFileSync(authPath, JSON.stringify(auth));
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  const failure = await restarted.resume().then(() => startRun(restarted)).then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure?.code, 'REFERENCE_AUTHORITY_CLAIM');
  assert.deepEqual(readJson(attemptFile(gameDir)), recorded, 'the record stays as it was');
  assert.equal(sent.some((args) => args.includes('--retry')), false, 'nothing handed the record to the publisher');
  const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
  assert.equal(fs.existsSync(snapshotFile) && fs.readFileSync(snapshotFile, 'utf8').includes(CLAIM), false);
  assert.equal(cc.loadAuthority(gameDir).withheldPublications, undefined);
});

// Re-queues the hand's item as the note an earlier rule accepted: the same generation and paths, a
// new digest and proof, as accept would have written them (the current accept refuses this note).
function requeueAs(gameDir, queued, note) {
  const authPath = path.join(gameDir, '.coach-authority.json');
  const auth = readJson(authPath);
  const digest = payloadSha256(note);
  const queueId = `${auth.gameEpoch}:${note.handNo}:${queued.generation}:${digest}`;
  const proof = { id: publicProofId(queueId), payloadSha256: digest };
  const envelope = readJson(queued.exactEnvelopePath);
  envelope.coach = [proofBearingCoachNote(note, proof)];
  envelope.coachAuthority = { ...envelope.coachAuthority, queueId, payloadSha256: digest };
  fs.writeFileSync(queued.exactEnvelopePath, JSON.stringify(envelope));
  auth.publishQueue[String(note.handNo)] = { ...auth.publishQueue[String(note.handNo)], queueId, payloadSha256: digest, publicProofId: proof.id };
  fs.writeFileSync(authPath, JSON.stringify(auth));
  return auth.publishQueue[String(note.handNo)];
}

test('#310 text는 정상이고 decisions 문자열만 현재 문구 규칙에 걸리는 노트도 REFERENCE_AUTHORITY_CLAIM으로 보류한다', { timeout: TIMEOUT }, async (t) => {
  const clean = '핸드 1의 폴드는 무난했습니다.';
  const { gameDir, first, cc, queued: accepted } = await soloGameWithQueuedNote(t, clean);
  const decisionId = readJson(path.join(gameDir, 'state.json')).lastHand.decisions?.find((row) => row.actorId === 'user')?.decisionId ?? 'd-1-preflop-0';
  const why = '이 폴드의 EV 손실은 1.5bb입니다.';
  const queued = requeueAs(gameDir, accepted, {
    handNo: 1, text: clean, decisions: [{ decisionId, why, outcome: '상대가 폴드해 팟을 가져갔습니다.', alternative: '레이즈도 검토할 수 있었습니다.' }],
  });
  await first.requestStop();
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  await restarted.resume();
  await restarted.requestStop();
  assertClaimWithheld(gameDir, cc, queued, why);
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
});

test('#310 참가자 카드를 판정할 수 없으면 문구 규칙에 걸려도 지금처럼 FORBIDDEN_LITERAL_UNAVAILABLE로 멈추고 아무것도 바꾸지 않는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await multiGameWithQueuedLeak(t, { note: () => CLAIM });
  await first.requestStop();
  const sent = [];
  let spoiled = false;
  const restarted = newLoop(t, gameDir, {
    onPublishInvoke: (args) => sent.push(args),
    onCoachInvoke: (args) => {
      if (args[0] !== 'reconcile' || spoiled) return;
      spoiled = true;
      fs.rmSync(path.join(gameDir, 'state.json'));
    },
  });
  const failure = await restarted.resume().then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(spoiled, true, 'the drain was reached');
  assert.equal(failure?.code, 'FORBIDDEN_LITERAL_UNAVAILABLE');
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'].queueId, queued.queueId);
  assert.equal(auth.withheldPublications, undefined);
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
});

test('#310 decisions 문자열만 문구 위반인 노트의 기록 attempt도 보류 뒤 보내지 않고 지워지고 증거에 남는다', { timeout: TIMEOUT }, async (t) => {
  const clean = '핸드 1의 폴드는 무난했습니다.';
  const { gameDir, first, cc, queued: accepted } = await soloGameWithQueuedNote(t, clean);
  const why = '이 폴드의 EV 손실은 1.5bb입니다.';
  const queued = requeueAs(gameDir, accepted, {
    handNo: 1, text: clean, decisions: [{ decisionId: 'd-1-preflop-0', why, outcome: '상대가 폴드했습니다.', alternative: '레이즈도 검토할 수 있었습니다.' }],
  });
  await first.requestStop();
  const recorded = await recordAttemptOf(gameDir, queued);
  const restarted = newLoop(t, gameDir);
  await restarted.resume();
  const running = startRun(restarted);
  await waitFor(
    () => readLoopLog(gameDir).some((row) => row.event === 'resume-archive-check'),
    'the resume entry did not get past the recorded attempt',
    20_000 * WIN32_SCALE,
  );
  await restarted.requestStop();
  const failure = await running.then(() => null, (error) => error);
  assert.equal(failure, null, failure?.code);
  assert.equal(fs.existsSync(attemptFile(gameDir)), false);
  const evidence = assertClaimWithheld(gameDir, cc, queued, why);
  assert.deepEqual(JSON.parse(JSON.parse(fs.readFileSync(evidence.attemptEvidencePath, 'utf8')).raw), recorded);
});

test('#310 decisions가 행이 아닌([null]) 문구 위반 본문은 결속되지 않아 지금처럼 REFERENCE_AUTHORITY_CLAIM으로 멈추고 아무것도 바꾸지 않는다', { timeout: TIMEOUT }, async (t) => {
  const { gameDir, first, cc, queued } = await soloGameWithQueuedNote(t, '핸드 1의 폴드는 무난했습니다.');
  const envelope = readJson(queued.exactEnvelopePath);
  envelope.coach[0].text = CLAIM;
  envelope.coach[0].decisions = [null];
  fs.writeFileSync(queued.exactEnvelopePath, JSON.stringify(envelope));
  await first.requestStop();
  const sent = [];
  const restarted = newLoop(t, gameDir, { onPublishInvoke: (args) => sent.push(args) });
  const failure = await restarted.resume().then(() => null, (error) => error);
  await restarted.requestStop();
  assert.equal(failure?.code, 'REFERENCE_AUTHORITY_CLAIM');
  const auth = cc.loadAuthority(gameDir);
  assert.equal(auth.publishQueue['1'].queueId, queued.queueId);
  assert.equal(auth.withheldPublications, undefined);
  assert.equal(sent.some((args) => args.includes(queued.exactEnvelopePath)), false);
});
