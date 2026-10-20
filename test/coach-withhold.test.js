import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeJsonAtomic } from '../engine/state.js';
import { payloadSha256 } from '../publish-contract.js';
import { createCoachControl, runCoachControlCli, UNAVAILABLE_TEXT } from '../tools/coach-control.js';

// #292: a queued coach note the current participant-card rule refuses is withheld for good —
// its identity kept as evidence, its envelope left on disk — and the hand's unavailable note is
// queued in its place. A note the snapshot already proves published is sealed instead.

const OWNER = '11111111-1111-4111-8111-111111111111';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-withhold-'));
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid, port: 8877, sessionToken: 'tok-withhold', startedAt: new Date().toISOString(),
  }));
  const snapshotFile = path.join(dir, 'ui-snapshot.json');
  writeJsonAtomic(snapshotFile, { revision: 1, view: null, log: [], coach: [] });
  const statsFile = path.join(dir, 'stats.json');
  writeJsonAtomic(statsFile, { perPlayer: { user: { sample: 2, vpip: 0.2 } } });
  return { dir, snapshotFile, statsFile, cc: createCoachControl() };
}

async function queueNote({ dir, snapshotFile, statsFile, cc }, note = { handNo: 1, text: '상대는 10♥를 버렸다' }) {
  const started = await cc.beginOwner({ gameDir: dir, owner: OWNER, completed: note.handNo, statsFile, snapshotFile });
  const descriptor = started.descriptors.find((row) => row.handNo === note.handNo);
  fs.writeFileSync(descriptor.exactResultPath, `${JSON.stringify(note)}\n`);
  await cc.accept({ gameDir: dir, owner: OWNER, handNo: note.handNo, generation: descriptor.generation });
  return cc.loadAuthority(dir).publishQueue[String(note.handNo)];
}

const withholdArgs = (ctx, item, extra = {}) => ({
  gameDir: ctx.dir, handNo: item.handNo, queueId: item.queueId, payloadSha256: item.payloadSha256,
  exactEnvelopePath: item.exactEnvelopePath, reason: 'FORBIDDEN_LITERAL', snapshotFile: ctx.snapshotFile, ...extra,
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// What the publisher records before it sends the queued envelope.
function recordAttempt(ctx, item, publishId = 7) {
  const envelope = JSON.parse(fs.readFileSync(item.exactEnvelopePath, 'utf8'));
  const record = {
    expectedGameEpoch: envelope.coachAuthority.expectedGameEpoch,
    body: { publishId, coach: envelope.coach },
    coachAuthority: envelope.coachAuthority,
  };
  const raw = JSON.stringify(record);
  fs.writeFileSync(path.join(ctx.dir, '.publish-attempt.json'), raw);
  return { record, raw, bodySha256: sha256(JSON.stringify(record.body)) };
}

test('#292 withhold-queued는 증거를 남기고 같은 핸드의 unavailable 노트를 새 세대로 큐에 넣는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const original = fs.readFileSync(item.exactEnvelopePath, 'utf8');
  const recorded = recordAttempt(ctx, item);
  const out = await ctx.cc.withholdQueued(withholdArgs(ctx, item, { attemptBodySha256: recorded.bodySha256 }));
  assert.equal(out.outcome, 'withheld');
  const auth = ctx.cc.loadAuthority(ctx.dir);
  const [evidence] = auth.withheldPublications;
  assert.deepEqual(
    [evidence.queueId, evidence.handNo, evidence.generation, evidence.payloadSha256, evidence.publicProofId, evidence.exactEnvelopePath],
    [item.queueId, 1, item.generation, item.payloadSha256, item.publicProofId, item.exactEnvelopePath],
  );
  assert.deepEqual([evidence.reason, evidence.attemptPublishId, evidence.attemptBodySha256], ['FORBIDDEN_LITERAL', 7, recorded.bodySha256]);
  // The recorded attempt is kept byte for byte beside the note; the attempt slot is the
  // publisher's to clear.
  assert.equal(JSON.parse(fs.readFileSync(evidence.attemptEvidencePath, 'utf8')).raw, recorded.raw);
  assert.equal(evidence.attemptRecordSha256, sha256(recorded.raw));
  assert.equal(fs.readFileSync(path.join(ctx.dir, '.publish-attempt.json'), 'utf8'), recorded.raw);
  assert.equal(evidence.replacementQueueId, out.replacementQueueId);
  // The refused note stays on disk, byte for byte, and no row makes it eligible for cleanup.
  assert.equal(fs.readFileSync(item.exactEnvelopePath, 'utf8'), original);
  assert.equal(auth.retiredAttempts.some((row) => row.exactEnvelopePath === item.exactEnvelopePath && row.cleanupEligible), false);
  const replacement = auth.publishQueue['1'];
  assert.equal(replacement.queueId, out.replacementQueueId);
  assert.equal(replacement.noteKind, 'unavailable');
  assert.equal(replacement.overfold, false);
  assert.ok(replacement.generation > item.generation);
  assert.notEqual(replacement.exactEnvelopePath, item.exactEnvelopePath);
  const envelope = JSON.parse(fs.readFileSync(replacement.exactEnvelopePath, 'utf8'));
  assert.deepEqual(envelope.coach.map((note) => [note.handNo, note.text, note.unavailable]), [[1, UNAVAILABLE_TEXT, true]]);
  assert.equal(envelope.coachAuthority.queueId, replacement.queueId);
  assert.equal(envelope.coachAuthority.payloadSha256, payloadSha256({ handNo: 1, text: UNAVAILABLE_TEXT, unavailable: true }));
  // Published and reconciled like any unavailable note: the hand is complete.
  writeJsonAtomic(ctx.snapshotFile, { revision: 2, view: null, log: [], coach: envelope.coach });
  assert.deepEqual((await ctx.cc.reconcile({ gameDir: ctx.dir, snapshotFile: ctx.snapshotFile })).reconciled, [1]);
  assert.equal(ctx.cc.loadAuthority(ctx.dir).publishedSeals['1'].queueId, replacement.queueId);
});

test('#292 withhold-queued는 멱등이다 — 같은 queueId는 처음 결과를 돌려주고 권한을 바꾸지 않는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const first = await ctx.cc.withholdQueued(withholdArgs(ctx, item));
  const before = fs.readFileSync(path.join(ctx.dir, '.coach-authority.json'), 'utf8');
  const again = await ctx.cc.withholdQueued(withholdArgs(ctx, item));
  assert.deepEqual([again.outcome, again.replacementQueueId], ['already-withheld', first.replacementQueueId]);
  assert.equal(fs.readFileSync(path.join(ctx.dir, '.coach-authority.json'), 'utf8'), before);
  // A different digest under the same queueId is not the same request.
  await assert.rejects(
    ctx.cc.withholdQueued(withholdArgs(ctx, item, { payloadSha256: 'd'.repeat(64) })),
    { code: 'WITHHOLD_TARGET_CHANGED' },
  );
});

test('#292 withhold-queued는 reconcile을 먼저 한다 — 이미 게시된 노트는 보류하지 않고 seal한다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const envelope = JSON.parse(fs.readFileSync(item.exactEnvelopePath, 'utf8'));
  writeJsonAtomic(ctx.snapshotFile, { revision: 3, view: null, log: [], coach: envelope.coach });
  const out = await ctx.cc.withholdQueued(withholdArgs(ctx, item));
  assert.equal(out.outcome, 'published');
  const auth = ctx.cc.loadAuthority(ctx.dir);
  assert.equal(auth.publishedSeals['1'].queueId, item.queueId);
  assert.equal(auth.publishQueue['1'], undefined);
  assert.equal(auth.withheldPublications, undefined);
});

test('#292 withhold-queued는 큐 항목이 정확히 같지 않거나 unavailable이면 거부하고 아무것도 바꾸지 않는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const authFile = path.join(ctx.dir, '.coach-authority.json');
  const before = fs.readFileSync(authFile, 'utf8');
  for (const change of [
    { queueId: `${item.queueId}x` }, { payloadSha256: 'e'.repeat(64) }, { handNo: 2 },
    { exactEnvelopePath: `${item.exactEnvelopePath}.other` },
    // A recorded attempt that is absent, or is not this note's, is not withheld on.
    { attemptBodySha256: 'f'.repeat(64) },
  ]) {
    await assert.rejects(ctx.cc.withholdQueued(withholdArgs(ctx, item, change)), { code: 'WITHHOLD_TARGET_CHANGED' }, JSON.stringify(change));
  }
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
  const replaced = await ctx.cc.withholdQueued(withholdArgs(ctx, item));
  const unavailable = ctx.cc.loadAuthority(ctx.dir).publishQueue['1'];
  assert.equal(unavailable.queueId, replaced.replacementQueueId);
  await assert.rejects(ctx.cc.withholdQueued(withholdArgs(ctx, unavailable)), { code: 'WITHHOLD_NOT_ALLOWED' });
  for (const bad of [
    { reason: 'COACH_PROOF_MISMATCH' }, { payloadSha256: 'xyz' }, { snapshotFile: undefined }, { handNo: 0 },
    { exactEnvelopePath: undefined }, { attemptBodySha256: 'nothex' },
  ]) {
    await assert.rejects(ctx.cc.withholdQueued(withholdArgs(ctx, item, bad)), { code: 'USAGE' }, JSON.stringify(bad));
  }
});

test('#292 코치 노트 말고 다른 것도 실은 기록 attempt는 증거로 잡지 않고 보류하지 않는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const authFile = path.join(ctx.dir, '.coach-authority.json');
  const before = fs.readFileSync(authFile, 'utf8');
  const { record } = recordAttempt(ctx, item);
  for (const mixed of [
    { ...record, body: { ...record.body, view: { handNo: 2 } } },
    { ...record, trainingAuthority: { items: [] } },
    { ...record, body: { ...record.body, coach: [...record.body.coach, ...record.body.coach] } },
  ]) {
    fs.writeFileSync(path.join(ctx.dir, '.publish-attempt.json'), JSON.stringify(mixed));
    // Named or not, a record of this item with more than its note in it is left as it is.
    for (const extra of [{ attemptBodySha256: sha256(JSON.stringify(mixed.body)) }, {}]) {
      await assert.rejects(ctx.cc.withholdQueued(withholdArgs(ctx, item, extra)), { code: 'WITHHOLD_NOT_ALLOWED' });
    }
  }
  // So is a note with a string its digest does not cover (an extra field).
  const extraField = { ...record, body: { ...record.body, coach: [{ ...record.body.coach[0], debug: '7c' }] } };
  fs.writeFileSync(path.join(ctx.dir, '.publish-attempt.json'), JSON.stringify(extraField));
  await assert.rejects(ctx.cc.withholdQueued(withholdArgs(ctx, item)), { code: 'WITHHOLD_NOT_ALLOWED' });
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
});

test('#292 이름을 대지 않은 보류도 슬롯에 남은 그 노트의 기록을 원문 그대로 보존하고 다른 항목의 기록은 건드리지 않는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const recorded = recordAttempt(ctx, item, 11);
  const out = await ctx.cc.withholdQueued(withholdArgs(ctx, item));
  assert.equal(out.outcome, 'withheld');
  const [evidence] = ctx.cc.loadAuthority(ctx.dir).withheldPublications;
  assert.equal(evidence.attemptPublishId, 11);
  assert.equal(JSON.parse(fs.readFileSync(evidence.attemptEvidencePath, 'utf8')).raw, recorded.raw);
  // A record of another item is not this withholding's: nothing of it is kept or required.
  const other = setup();
  const otherItem = await queueNote(other);
  const foreign = recordAttempt(other, otherItem, 12);
  foreign.record.coachAuthority = { ...foreign.record.coachAuthority, queueId: `${otherItem.queueId}:other` };
  fs.writeFileSync(path.join(other.dir, '.publish-attempt.json'), JSON.stringify(foreign.record));
  assert.equal((await other.cc.withholdQueued(withholdArgs(other, otherItem))).outcome, 'withheld');
  const [plain] = other.cc.loadAuthority(other.dir).withheldPublications;
  assert.equal(plain.attemptEvidencePath, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(other.dir, '.publish-attempt.json'), 'utf8')), foreign.record);
});

test('#292 보류한 overfold 노트의 대체 노트는 overfold 표식과 lease를 이어받는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  // The queue item stands for an overfold note holding the game's one overfold lease.
  const authFile = path.join(ctx.dir, '.coach-authority.json');
  const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  auth.publishQueue['1'].overfold = true;
  auth.overfoldLease = { handNo: 1, generation: item.generation, ownerSessionId: OWNER, state: 'queued', queueId: item.queueId };
  fs.writeFileSync(authFile, JSON.stringify(auth));
  const out = await ctx.cc.withholdQueued(withholdArgs(ctx, item));
  const after = ctx.cc.loadAuthority(ctx.dir);
  // The hand's one overfold note is spent either way: its replacement keeps the claim (a relay
  // that already shows a legacy overfold note keeps that mark), and the lease follows it.
  assert.deepEqual([after.overfoldLease.queueId, after.overfoldLease.state], [out.replacementQueueId, 'queued']);
  assert.equal(after.publishQueue['1'].overfold, true);
  assert.equal(after.withheldPublications[0].overfold, true);
  const envelope = JSON.parse(fs.readFileSync(after.publishQueue['1'].exactEnvelopePath, 'utf8'));
  assert.deepEqual([envelope.coach[0].text, envelope.coach[0].unavailable, envelope.coach[0].overfold], [UNAVAILABLE_TEXT, true, true]);
  writeJsonAtomic(ctx.snapshotFile, { revision: 2, view: null, log: [], coach: envelope.coach });
  await ctx.cc.reconcile({ gameDir: ctx.dir, snapshotFile: ctx.snapshotFile });
  assert.equal(ctx.cc.loadAuthority(ctx.dir).overfoldLease.state, 'spent');
});

test('#292 snapshot이 있는데 읽히지 않으면 게시 여부를 알 수 없으므로 보류하지 않는다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const authFile = path.join(ctx.dir, '.coach-authority.json');
  const before = fs.readFileSync(authFile, 'utf8');
  fs.writeFileSync(ctx.snapshotFile, '{not json');
  await assert.rejects(ctx.cc.withholdQueued(withholdArgs(ctx, item)), { code: 'WITHHOLD_SNAPSHOT_UNREADABLE' });
  assert.equal(fs.readFileSync(authFile, 'utf8'), before);
  // A snapshot that does not exist holds no note the relay could show: the withholding goes on.
  fs.rmSync(ctx.snapshotFile);
  assert.equal((await ctx.cc.withholdQueued(withholdArgs(ctx, item))).outcome, 'withheld');
});

test('#292 withhold-queued CLI는 결과를 JSON으로 쓰고 인자가 모자라면 USAGE다', async () => {
  const ctx = setup();
  const item = await queueNote(ctx);
  const recorded = recordAttempt(ctx, item, 3);
  const lines = [];
  const write = fs.writeSync;
  fs.writeSync = (fd, text) => { if (fd === 1) { lines.push(String(text)); return String(text).length; } return write(fd, text); };
  try {
    await runCoachControlCli([
      'withhold-queued', '--game-dir', ctx.dir, '--hand', '1', '--queue-id', item.queueId,
      '--payload-sha256', item.payloadSha256, '--envelope-path', item.exactEnvelopePath,
      '--reason', 'FORBIDDEN_LITERAL', '--snapshot-file', ctx.snapshotFile,
      '--attempt-body-sha256', recorded.bodySha256,
    ]);
    await assert.rejects(runCoachControlCli([
      'withhold-queued', '--game-dir', ctx.dir, '--hand', '1', '--queue-id', item.queueId, '--reason', 'FORBIDDEN_LITERAL',
      '--snapshot-file', ctx.snapshotFile,
    ]), { code: 'USAGE' });
  } finally {
    fs.writeSync = write;
  }
  const out = JSON.parse(lines[0]);
  assert.deepEqual([out.ok, out.outcome], [true, 'withheld']);
  assert.equal(ctx.cc.loadAuthority(ctx.dir).withheldPublications[0].attemptPublishId, 3);
});
