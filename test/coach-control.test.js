import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../engine/state.js';
import {
  MAX_PUBLISH_BODY_BYTES,
  payloadSha256,
  publicProofId,
  publishBodyByteLength,
} from '../publish-contract.js';
import { createCoachControl, UNAVAILABLE_TEXT, DEFAULT_ATTEMPT_MS } from '../tools/coach-control.js';

class FakeClock {
  constructor(start = 0n) {
    this.t = start;
  }

  now() {
    return this.t;
  }

  advanceMs(ms) {
    this.t += BigInt(ms) * 1_000_000n;
  }
}

function tmpGame() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-coach-'));
}

function writeLock(dir, token = 'tok-coach') {
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid,
    port: 8877,
    sessionToken: token,
    startedAt: new Date().toISOString(),
  }));
  return token;
}

function writeSnapshot(dir, coach = [], extra = {}) {
  const file = path.join(dir, 'ui-snapshot.json');
  writeJsonAtomic(file, { revision: extra.revision ?? 1, view: null, log: [], coach, ...extra });
  return file;
}

function writeStats(dir, { sample, vpip }) {
  const file = path.join(dir, 'stats.json');
  writeJsonAtomic(file, { perPlayer: { user: { sample, vpip } } });
  return file;
}

function setup({ owner = '11111111-1111-4111-8111-111111111111', token = 'tok-coach', clock } = {}) {
  const dir = tmpGame();
  writeLock(dir, token);
  const fakeClock = clock ?? new FakeClock();
  const cc = createCoachControl({ now: () => fakeClock.now() });
  const snapshotFile = writeSnapshot(dir, []);
  const statsFile = writeStats(dir, { sample: 0, vpip: 0 });
  return { dir, owner, token, clock: fakeClock, cc, snapshotFile, statsFile };
}

function writeResult(exactResultPath, note) {
  fs.mkdirSync(path.dirname(exactResultPath), { recursive: true });
  fs.writeFileSync(exactResultPath, `${JSON.stringify(note)}\n`);
}

function bodyTextForBytes(target, handNo = 1) {
  const measure = (text) => {
    const tuple = { handNo, text, overfold: false, unavailable: false };
    const digest = payloadSha256(tuple);
    return publishBodyByteLength(tuple, { id: publicProofId('dummy'), payloadSha256: digest });
  };
  let text = `한`.repeat(8) + 'x'.repeat(Math.max(8, target - 500));
  let bytes = measure(text);
  while (bytes < target) {
    text += (target - bytes >= 3) ? '한' : 'x';
    bytes = measure(text);
  }
  while (bytes > target && text.length > 0) {
    text = text.slice(0, -1);
    bytes = measure(text);
  }
  assert.equal(bytes, target, `body byte helper missed ${target}, got ${bytes}`);
  return text;
}

function publisherHost({ confirm = true, lockHeld = true } = {}) {
  const host = {
    stopped: false,
    live: [{ pid: 4242, group: 'pg-publish' }],
    lockHeld,
    terminated: [],
    confirm,
    stopNewPlayTimePublishers() { host.stopped = true; },
    listLivePublishers() { return host.live; },
    async terminateLive(live) {
      if (!host.confirm) return { confirmed: false, reason: 'termination_unconfirmed' };
      host.terminated.push(...live);
      host.live = [];
      host.lockHeld = false;
      return { confirmed: true };
    },
    hasLiveLockHolder() { return host.lockHeld; },
  };
  return host;
}

async function reserveAll(cc, { dir, owner, completed, statsFile, snapshotFile }) {
  return cc.beginOwner({
    gameDir: dir,
    owner,
    completed,
    statsFile,
    snapshotFile,
  });
}

test('cleanupState cancelled는 reclaimableHandles에서 영구 제외되는 terminal 상태다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0 } } }));
  const begun = await reserveAll(cc, { dir, owner, completed: 1, statsFile, snapshotFile });
  const descriptor = begun.descriptors[0];
  await cc.bindHandle({
    gameDir: dir,
    owner,
    handNo: 1,
    generation: descriptor.generation,
    handle: '4242:recorded-start',
  });
  await cc.fence({
    gameDir: dir,
    owner,
    handNo: 1,
    generation: descriptor.generation,
    reason: 'operator-cancel-test',
  });
  assert.equal(cc.reclaimableHandles(dir).length, 1);

  await cc.recordCleanup({
    gameDir: dir,
    owner,
    handNo: 1,
    generation: descriptor.generation,
    cleanupState: 'cancelled',
  });

  assert.deepEqual(cc.reclaimableHandles(dir), []);
  assert.equal(cc.loadAuthority(dir).retiredAttempts[0].cleanupState, 'cancelled');
});

test('Gate A: cutoff는 live publisher lock 해제 후 missing 전체를 한 transaction으로 unavailable Q seal', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 2, vpip: 0.3 } } }));
  const started = await reserveAll(cc, { dir, owner, completed: 2, statsFile, snapshotFile });
  const d1 = started.descriptors.find((d) => d.handNo === 1);
  const d2 = started.descriptors.find((d) => d.handNo === 2);
  writeResult(d1.exactResultPath, { handNo: 1, text: '무난한 폴드입니다.' });
  const accepted = await cc.accept({ gameDir: dir, owner, handNo: 1, generation: d1.generation });
  assert.equal(accepted.ok, true);
  await cc.bindHandle({
    gameDir: dir, owner, handNo: 2, generation: d2.generation, handle: 'coach-h2',
  });

  const host = publisherHost();
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner, completed: 2, snapshotFile, statsFile, host,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(host.stopped, true, '새 play-time publisher 중단이 없다');
  assert.equal(host.lockHeld, false, 'live lock holder가 남았다');
  assert.equal(host.terminated.length, 1);

  const auth = cc.loadAuthority(dir);
  assert.equal(auth.publishQueue['1'].noteKind, 'coach');
  assert.equal(auth.publishQueue['2'].noteKind, 'unavailable');
  assert.equal(auth.publishQueue['2'].text, undefined);
  const completeness = cc.completeness(dir, 2);
  assert.equal(completeness.ok, true);
  assert.deepEqual(completeness.publishQueueHandNos.sort((a, b) => a - b), [1, 2]);
  assert.deepEqual(completeness.publishedSealHandNos, []);
  assert.equal(completeness.reviewGateOpen, true);
});

test('Gate A: publisher termination 미확인은 FINALIZATION_ABORTED이고 missing을 숨기지 않는다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.4 } } }));
  await reserveAll(cc, { dir, owner, completed: 1, statsFile, snapshotFile });
  const host = publisherHost({ confirm: false });
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner, completed: 1, snapshotFile, statsFile, host,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'FINALIZATION_ABORTED');
  assert.equal(out.reviewGate, 'closed');
  const completeness = cc.completeness(dir, 1);
  assert.equal(completeness.ok, false, 'missing handNo를 성공처럼 숨겼다');
  assert.deepEqual(completeness.missing, [1]);
});

test('Gate A: cutoff authority commit 실패는 FINALIZATION_ABORTED, review gate closed', async () => {
  const { dir, owner, clock, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.4 } } }));
  const gate = { fail: false };
  const cc = createCoachControl({
    now: () => clock.now(),
    writeAuthority(file, obj) {
      if (gate.fail) throw new Error('ENOSPC');
      writeJsonAtomic(file, obj);
    },
  });
  await reserveAll(cc, { dir, owner, completed: 1, statsFile, snapshotFile });
  gate.fail = true;
  const host = publisherHost();
  const out = await cc.finalizeCutoff({
    gameDir: dir, owner, completed: 1, snapshotFile, statsFile, host,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'FINALIZATION_ABORTED');
  assert.equal(out.reviewGate, 'closed');
  const auth = cc.loadAuthority(dir);
  assert.equal(auth.publishQueue['1'], undefined, 'commit 실패인데 Q가 seal됐다');
  assert.equal(cc.completeness(dir, 1).ok, false);
});

test('Gate B: 유효한 pre-v2 proofless note는 generation 0 migration Q로 원자 seal되고 replacement spawn이 없다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  writeSnapshot(dir, [{ handNo: 1, text: '레거시 코치 노트' }], { revision: 4 });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.25 } } }));
  const out = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  assert.deepEqual(out.descriptors, []);
  assert.deepEqual(out.sealedSkipped, [1]);
  const auth = cc.loadAuthority(dir);
  assert.equal(auth.legacyMigrationCompleted, true);
  assert.equal(auth.publishQueue['1'].generation, 0);
  assert.match(auth.publishQueue['1'].queueId, /:migration:1:/);
  assert.equal(auth.hands['1'], undefined);
});

test('Gate B: pre-v2 overfold:true는 migration Q + queued lease로 두 번째 예약을 막는다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  writeSnapshot(dir, [{ handNo: 1, text: '과폴드 누수', overfold: true }]);
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 12, vpip: 0.08 } } }));
  const out = await cc.beginOwner({
    gameDir: dir, owner, completed: 2, statsFile, snapshotFile,
  });
  assert.deepEqual(out.sealedSkipped, [1]);
  assert.equal(out.descriptors.length, 1);
  assert.equal(out.descriptors[0].handNo, 2);
  assert.equal(out.descriptors[0].overfoldReserved, false);
  const auth = cc.loadAuthority(dir);
  assert.equal(auth.overfoldLease.state, 'queued');
  assert.equal(auth.overfoldLease.handNo, 1);
});

test('Gate B: invalid/oversize legacy note는 Published가 아니라 missing', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  writeSnapshot(dir, [{ handNo: 1, text: 'x'.repeat(80_000) }]);
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const out = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  assert.equal(out.descriptors.length, 1);
  assert.equal(out.descriptors[0].handNo, 1);
  const auth = cc.loadAuthority(dir);
  assert.equal(auth.publishQueue['1'], undefined);
  assert.equal(auth.publishedSeals['1'], undefined);
  assert.equal(auth.legacyMigrationCompleted, true);
});

test('Gate C: old-owner accept가 진단 missing 이후 Q를 seal하면 begin-owner는 sealed-skip', async () => {
  const oldOwner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const newOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const { dir, cc, snapshotFile, statsFile } = setup({ owner: oldOwner });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 2, vpip: 0.3 } } }));
  const first = await cc.beginOwner({
    gameDir: dir, owner: oldOwner, completed: 2, statsFile, snapshotFile,
  });
  const diagnosed = await cc.missing({ gameDir: dir, statsFile, snapshotFile });
  assert.deepEqual(diagnosed.missing, [1, 2]);
  const d1 = first.descriptors.find((d) => d.handNo === 1);
  writeResult(d1.exactResultPath, { handNo: 1, text: '늦게 도착한 노트' });
  const sealed = await cc.accept({
    gameDir: dir, owner: oldOwner, handNo: 1, generation: d1.generation,
  });
  assert.equal(sealed.ok, true);
  const queueId = cc.loadAuthority(dir).publishQueue['1'].queueId;

  const second = await cc.beginOwner({
    gameDir: dir, owner: newOwner, completed: 2, statsFile, snapshotFile,
  });
  assert.ok(second.sealedSkipped.includes(1));
  assert.equal(second.descriptors.length, 1);
  assert.equal(second.descriptors[0].handNo, 2);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].queueId, queueId);
});

test('Gate C: begin-owner empty / all-queued / mixed missing 집합', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 2, vpip: 0.3 } } }));

  const empty = await cc.beginOwner({
    gameDir: dir, owner, completed: 0, statsFile, snapshotFile,
  });
  assert.deepEqual(empty.descriptors, []);
  assert.deepEqual(empty.sealedSkipped, []);

  const mixedPrep = await cc.beginOwner({
    gameDir: dir, owner, completed: 2, statsFile, snapshotFile,
  });
  const d1 = mixedPrep.descriptors.find((d) => d.handNo === 1);
  writeResult(d1.exactResultPath, { handNo: 1, text: '첫 핸드 노트' });
  await cc.accept({ gameDir: dir, owner, handNo: 1, generation: d1.generation });

  const mixed = await cc.beginOwner({
    gameDir: dir,
    owner: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    completed: 2,
    statsFile,
    snapshotFile,
  });
  assert.deepEqual(mixed.sealedSkipped, [1]);
  assert.equal(mixed.descriptors.length, 1);
  assert.equal(mixed.descriptors[0].handNo, 2);

  writeResult(mixed.descriptors[0].exactResultPath, { handNo: 2, text: '둘째 노트' });
  await cc.accept({
    gameDir: dir,
    owner: mixed.owner ?? 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    handNo: 2,
    generation: mixed.descriptors[0].generation,
  });
  const allQueued = await cc.beginOwner({
    gameDir: dir,
    owner: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    completed: 2,
    statsFile,
    snapshotFile,
  });
  assert.deepEqual(allQueued.descriptors, []);
  assert.deepEqual(allQueued.sealedSkipped.sort((a, b) => a - b), [1, 2]);
});

test('Gate C: begin-owner overfold — short sample / eligible fresh 1회 / replacement transfer', async () => {
  const owner1 = '11111111-1111-4111-8111-111111111111';
  const owner2 = '22222222-2222-4222-8222-222222222222';
  const { dir, cc, snapshotFile, statsFile } = setup({ owner: owner1 });

  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 5, vpip: 0.05 } } }));
  const short = await cc.beginOwner({
    gameDir: dir, owner: owner1, completed: 1, statsFile, snapshotFile,
  });
  assert.equal(short.descriptors[0].overfoldReserved, false);
  assert.equal(cc.loadAuthority(dir).overfoldLease, null);

  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 12, vpip: 0.05 } } }));
  const eligible = await cc.beginOwner({
    gameDir: dir, owner: owner1, completed: 2, statsFile, snapshotFile,
  });
  const reserved = eligible.descriptors.filter((d) => d.overfoldReserved);
  assert.equal(reserved.length, 1, 'fresh overfold lease는 최대 하나');
  const leasedHand = reserved[0].handNo;
  assert.equal(cc.loadAuthority(dir).overfoldLease.state, 'active');
  assert.equal(cc.loadAuthority(dir).overfoldLease.handNo, leasedHand);

  const replaced = await cc.beginOwner({
    gameDir: dir, owner: owner2, completed: 2, statsFile, snapshotFile,
  });
  const transferred = replaced.descriptors.find((d) => d.handNo === leasedHand);
  assert.equal(transferred.overfoldReserved, true);
  assert.equal(replaced.descriptors.filter((d) => d.overfoldReserved).length, 1);
  const lease = cc.loadAuthority(dir).overfoldLease;
  assert.equal(lease.state, 'active');
  assert.equal(lease.ownerSessionId, owner2);
  assert.equal(lease.generation, transferred.generation);
});

test('Gate D: Published ∪ Pending = 1..sample 이고 교집합은 공집합', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 3, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 3, statsFile, snapshotFile,
  });
  const d1 = started.descriptors.find((d) => d.handNo === 1);
  writeResult(d1.exactResultPath, { handNo: 1, text: '실제 코치 노트' });
  await cc.accept({ gameDir: dir, owner, handNo: 1, generation: d1.generation });
  await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 2, generation: started.descriptors.find((d) => d.handNo === 2).generation,
    reason: 'attempts-exhausted',
  });
  const host = publisherHost();
  await cc.finalizeCutoff({
    gameDir: dir, owner, completed: 3, snapshotFile, statsFile, host,
  });

  const completeness = cc.completeness(dir, 3);
  assert.equal(completeness.ok, true);
  assert.deepEqual(completeness.union.sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(completeness.disjoint, true);
  const pendingKinds = Object.fromEntries(
    completeness.pending.map((p) => [p.handNo, p.noteKind]),
  );
  assert.equal(pendingKinds[1], 'coach');
  assert.equal(pendingKinds[2], 'unavailable');
  assert.equal(pendingKinds[3], 'unavailable');
  assert.equal(completeness.uiVisibilityClaimed, false);
  assert.ok(completeness.reviewDisclosure.every((row) => row.handNo && row.noteKind));
});

test('proof-bearing coach body 65535·65536은 seal, 65537은 queue 전 INVALID_COACH_OUTPUT', async () => {
  for (const [target, expectOk] of [[65_535, true], [65_536, true], [65_537, false]]) {
    const { dir, owner, cc, snapshotFile, statsFile } = setup();
    fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
    const started = await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    const d1 = started.descriptors[0];
    const text = bodyTextForBytes(target);
    assert.ok(text.includes('한'), '한글을 포함한 최악 본문이 아니다');
    writeResult(d1.exactResultPath, { handNo: 1, text });
    const out = await cc.accept({ gameDir: dir, owner, handNo: 1, generation: d1.generation });
    const auth = cc.loadAuthority(dir);
    if (expectOk) {
      assert.equal(out.ok, true, `bytes=${target} ${out.code}`);
      assert.ok(auth.publishQueue['1']);
      assert.equal(publishBodyByteLength(
        { handNo: 1, text, overfold: false, unavailable: false },
        { id: auth.publishQueue['1'].publicProofId, payloadSha256: auth.publishQueue['1'].payloadSha256 },
      ), target);
    } else {
      assert.equal(out.ok, false);
      assert.equal(out.code, 'INVALID_COACH_OUTPUT');
      assert.equal(auth.publishQueue['1'], undefined);
    }
    assert.ok(target === MAX_PUBLISH_BODY_BYTES || target === MAX_PUBLISH_BODY_BYTES - 1 || target === MAX_PUBLISH_BODY_BYTES + 1);
  }
});

test('accept는 deadline 직전 유효 파일을 승격한다', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const d1 = started.descriptors[0];
  writeResult(d1.exactResultPath, { handNo: 1, text: '경계 직전' });
  clock.advanceMs(DEFAULT_ATTEMPT_MS - 1);
  const ok = await cc.accept({ gameDir: dir, owner, handNo: 1, generation: d1.generation });
  assert.equal(ok.ok, true);
});

test('accept는 live generation의 유효 파일이 있으면 deadline 이후에도 승격한다', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '딜러가 늦은 accept' });
  clock.advanceMs(DEFAULT_ATTEMPT_MS);
  const late = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'coach');
});

test('accept는 파일이 없고 deadline이 지나면 ATTEMPT_TIMEOUT이다', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  clock.advanceMs(DEFAULT_ATTEMPT_MS);
  const expired = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'ATTEMPT_TIMEOUT');
  assert.equal(cc.loadAuthority(dir).publishQueue['1'], undefined);
  assert.equal(cc.loadAuthority(dir).hands['1'], undefined);
});

test('heartbeat는 deadline 이후 유효 파일이 있으면 fence하지 않고 result-ready를 반환한다', async () => {
  const clock = new FakeClock();
  const { dir, owner, cc, snapshotFile, statsFile } = setup({ clock });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  await cc.bindHandle({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation, handle: 'coach-late',
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '하트비트 전에 이미 씀' });
  clock.advanceMs(DEFAULT_ATTEMPT_MS + 1);
  const beat = await cc.heartbeat({ gameDir: dir, owner });
  assert.equal(beat.actions[0].action, 'result-ready');
  assert.equal(beat.actions[0].generation, started.descriptors[0].generation);
  assert.equal(beat.actions[0].exactResultPath, started.descriptors[0].exactResultPath);
  const auth = cc.loadAuthority(dir);
  assert.ok(auth.hands['1'], 'result-ready는 generation을 fence하지 않는다');
  assert.equal(auth.hands['1'].generation, started.descriptors[0].generation);
  const late = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(late.ok, true);
});

test('watch-accept는 파일이 생기는 즉시 accept하고 딜러 턴을 기다리지 않는다', async () => {
  const clock = new FakeClock();
  let ticks = 0;
  const { dir, owner, snapshotFile, statsFile } = setup({ clock });
  const cc = createCoachControl({
    now: () => clock.now(),
    sleep: async (ms) => {
      ticks += 1;
      clock.advanceMs(ms);
      if (ticks === 2) {
        const auth = JSON.parse(fs.readFileSync(path.join(dir, '.coach-authority.json'), 'utf8'));
        writeResult(auth.hands['1'].exactResultPath, { handNo: 1, text: '워처가 즉시 승격' });
      }
    },
  });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const out = await cc.watchAccept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation, pollMs: 100,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(ticks >= 2);
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].noteKind, 'coach');
});

test('watch-accept는 파일이 없이 deadline이 지나면 ATTEMPT_TIMEOUT이다', async () => {
  const clock = new FakeClock();
  const { dir, owner, snapshotFile, statsFile } = setup({ clock });
  const cc = createCoachControl({
    now: () => clock.now(),
    sleep: async (ms) => { clock.advanceMs(ms); },
  });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const reserved = await cc.reserve({
    gameDir: dir, owner, handNo: 1, attempt: 1, deadlineMs: 250,
  });
  const out = await cc.watchAccept({
    gameDir: dir, owner, handNo: 1, generation: reserved.generation, pollMs: 50,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'ATTEMPT_TIMEOUT');
});

test('accept occupied reject는 matching active를 persist하고 stale caller는 손을 대지 않는다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const authPath = path.join(dir, '.coach-authority.json');
  const auth = cc.loadAuthority(dir);
  auth.publishQueue['1'] = {
    queueId: 'pre-sealed',
    gameEpoch: auth.gameEpoch,
    handNo: 1,
    generation: 0,
    sourceOwnerSessionId: 'other',
    sourceAttempt: 0,
    noteKind: 'coach',
    exactEnvelopePath: started.descriptors[0].exactEnvelopePath,
    payloadSha256: 'a'.repeat(64),
    publicProofId: 'b'.repeat(64),
    publicationState: 'pending',
    overfold: false,
  };
  writeJsonAtomic(authPath, JSON.parse(JSON.stringify(auth, (_, v) => (
    typeof v === 'bigint' ? v.toString() : v
  ))));
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '늦은 결과' });
  const out = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'QUEUE_ALREADY_SEALED');
  const after = cc.loadAuthority(dir);
  assert.equal(after.publishQueue['1'].queueId, 'pre-sealed');
  assert.equal(after.hands['1'], undefined);
  assert.equal(after.retiredAttempts.at(-1).resultState, 'discarded');
});

test('accept CLI --forbidden-file이 literal을 거부한다', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const dir = tmpGame();
  writeLock(dir, 'tok-deny');
  const owner = '11111111-1111-4111-8111-111111111111';
  const cc = createCoachControl();
  const snapshotFile = writeSnapshot(dir, []);
  const statsFile = writeStats(dir, { sample: 1, vpip: 0.2 });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const deny = path.join(dir, '.coach-deny.json');
  fs.writeFileSync(deny, JSON.stringify(['Ah', 'tight-aggressive']));
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '상대 Ah tight-aggressive' });
  const { stdout } = await execFileAsync(process.execPath, [
    path.resolve('tools/coach-control.js'),
    'accept',
    '--game-dir', dir,
    '--owner', owner,
    '--hand', '1',
    '--generation', String(started.descriptors[0].generation),
    '--forbidden-file', deny,
  ], { encoding: 'utf8', timeout: 10000 });
  const json = JSON.parse(stdout.trim());
  assert.equal(json.ok, false);
  assert.equal(json.code, 'INVALID_COACH_OUTPUT');
});

test('accept CLI --forbidden-file이 배열이 아니면 BAD_FORBIDDEN_FILE', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const dir = tmpGame();
  writeLock(dir, 'tok-deny-bad');
  const deny = path.join(dir, '.coach-deny.json');
  fs.writeFileSync(deny, JSON.stringify({ no: true }));
  try {
    await execFileAsync(process.execPath, [
      path.resolve('tools/coach-control.js'),
      'accept',
      '--game-dir', dir,
      '--owner', '11111111-1111-4111-8111-111111111111',
      '--hand', '1',
      '--generation', '1',
      '--forbidden-file', deny,
    ], { encoding: 'utf8', timeout: 10000 });
    assert.fail('성공하면 안 된다');
  } catch (error) {
    const json = JSON.parse(String(error.stdout ?? '').trim());
    assert.equal(json.ok, false);
    assert.equal(json.code, 'BAD_FORBIDDEN_FILE');
  }
});

test('forbidden literal은 INVALID_COACH_OUTPUT이고 본문은 trace에 없다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '상대는 Ah Kh tight-aggressive' });
  const out = await cc.accept({
    gameDir: dir,
    owner,
    handNo: 1,
    generation: started.descriptors[0].generation,
    forbiddenLiterals: ['Ah', 'tight-aggressive'],
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'INVALID_COACH_OUTPUT');
  assert.equal(cc.loadAuthority(dir).publishQueue['1'], undefined);
  const tracePath = path.join(dir, '.coach-adapter-trace.jsonl');
  if (fs.existsSync(tracePath)) {
    const trace = fs.readFileSync(tracePath, 'utf8');
    assert.equal(trace.includes('Ah Kh'), false);
  }
});

test('generation-less unavailable은 snapshot-occupied hand를 거부한다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  writeSnapshot(dir, [{ handNo: 1, text: '이미 있는 레거시 노트' }]);
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const out = await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 1, reason: 'gate0', snapshotFile,
  });
  assert.equal(out.ok, false);
  assert.ok(['HAND_SNAPSHOT_OCCUPIED', 'QUEUE_ALREADY_SEALED'].includes(out.code), out.code);
  const queued = cc.loadAuthority(dir).publishQueue['1'];
  assert.equal(queued.noteKind, 'coach');
});

test('heartbeat는 다른 owner의 active를 fence하지 않는다', async () => {
  const owner1 = '11111111-1111-4111-8111-111111111111';
  const owner2 = '22222222-2222-4222-8222-222222222222';
  const clock = new FakeClock();
  const { dir, cc, snapshotFile, statsFile } = setup({ owner: owner1, clock });
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  await cc.beginOwner({
    gameDir: dir, owner: owner2, completed: 1, statsFile, snapshotFile,
  });
  clock.advanceMs(60_001);
  await assert.rejects(
    () => cc.heartbeat({ gameDir: dir, owner: owner1 }),
    (err) => err.code === 'STALE_OWNER',
  );
  assert.ok(cc.loadAuthority(dir).hands['1']);
});

test('queued/published occupied reject는 원본 seal을 유지하고 matching caller만 discarded', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const d1 = started.descriptors[0];
  writeResult(d1.exactResultPath, { handNo: 1, text: '원본' });
  await cc.accept({ gameDir: dir, owner, handNo: 1, generation: d1.generation });
  const queueId = cc.loadAuthority(dir).publishQueue['1'].queueId;
  const again = await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 1, generation: d1.generation, reason: 'late',
  });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'QUEUE_ALREADY_SEALED');
  assert.equal(cc.loadAuthority(dir).publishQueue['1'].queueId, queueId);
});

test('Gate 0 complete-unavailable은 generation 없이 Q를 만들고 spawn하지 않는다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  writeSnapshot(dir, []);
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const out = await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 1, reason: 'gate0',
  });
  assert.equal(out.ok, true);
  const item = cc.loadAuthority(dir).publishQueue['1'];
  assert.equal(item.noteKind, 'unavailable');
  assert.equal(cc.loadAuthority(dir).hands['1'], undefined);
});

test('exact reconcile는 Q를 같은 identity의 published tombstone으로 옮긴다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  writeResult(started.descriptors[0].exactResultPath, { handNo: 1, text: '확정 노트' });
  await cc.accept({ gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation });
  const queued = cc.loadAuthority(dir).publishQueue['1'];
  const envelope = JSON.parse(fs.readFileSync(queued.exactEnvelopePath, 'utf8'));
  writeSnapshot(dir, envelope.coach, { revision: 9 });
  const rec = await cc.reconcile({ gameDir: dir, snapshotFile });
  assert.deepEqual(rec.reconciled, [1]);
  const auth = cc.loadAuthority(dir);
  assert.equal(auth.publishQueue['1'], undefined);
  assert.equal(auth.publishedSeals['1'].queueId, queued.queueId);
  assert.equal(auth.publishedSeals['1'].publicProofId, queued.publicProofId);
  const late = await cc.accept({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation,
  });
  assert.equal(late.ok, false);
  assert.equal(late.code, 'HAND_ALREADY_PUBLISHED');
  assert.equal(cc.loadAuthority(dir).publishedSeals['1'].queueId, queued.queueId);
});

test('unavailable 노트는 고정 문구이며 overfold가 없다', async () => {
  const { dir, owner, cc, snapshotFile, statsFile } = setup();
  fs.writeFileSync(statsFile, JSON.stringify({ perPlayer: { user: { sample: 1, vpip: 0.2 } } }));
  const started = await cc.beginOwner({
    gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
  });
  const out = await cc.completeUnavailable({
    gameDir: dir, owner, handNo: 1, generation: started.descriptors[0].generation, reason: 'timeout',
  });
  assert.equal(out.ok, true);
  const item = cc.loadAuthority(dir).publishQueue['1'];
  const envelope = JSON.parse(fs.readFileSync(item.exactEnvelopePath, 'utf8'));
  assert.equal(envelope.coach[0].text, UNAVAILABLE_TEXT);
  assert.equal(envelope.coach[0].unavailable, true);
  assert.equal(envelope.coach[0].overfold, undefined);
});
