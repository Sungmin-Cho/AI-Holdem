import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  annotationValueSha256,
  detailRefOf,
  projectTrainingAnnotation,
  projectTrainingSummary,
  publicProofId,
  trainingPayloadSha256,
} from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import { startServer } from '../server/server.js';
import {
  FIXTURE_CONFIG_DIGEST,
  FIXTURE_POLICY_ID,
  FIXTURE_POLICY_SEED,
  handFilePath,
  handRecordFixture,
  writeSecurityFixtures,
} from './helpers/security-fixtures.js';

const EPOCH = 'ab'.repeat(32);
const TOKEN = 'tok';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-secgate-'));
}

function evaluationId(decisionId = 'd-1-preflop-0', gameEpoch = EPOCH) {
  return evaluationIdOf({
    gameEpoch,
    decisionId,
    providerId: 'local-preflop-baseline',
    providerVersion: '1.0.0',
  });
}

function summaryOf({ decisionId = 'd-1-preflop-0', handNo = 1, gameEpoch = EPOCH } = {}) {
  const id = evaluationId(decisionId, gameEpoch);
  return toPublicSummary({
    schemaVersion: 1,
    evaluationId: id,
    decisionId,
    status: 'supported',
    street: 'preflop',
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AA',
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null }],
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null },
    evLossBb: null,
    grade: 'preferred',
    forced: false,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  }, { handNo, detailSha256: 'ab'.repeat(32) });
}

// 서버가 계산하는 canonical을 테스트가 직접 흉내 낸다. 투영 함수를 그대로 부르면
// "투영이 거부해야 하는 값"의 proof를 만들 수 없어 RED가 다른 이유로 통과한다.
function exploitCanonicalValue(value) {
  return {
    opponents: (value.opponents ?? []).map((row) => {
      const out = { opponentId: row.opponentId, policyId: row.policyId, adjustment: row.adjustment };
      if (row.comparison) out.comparison = { summaryCode: row.comparison.summaryCode };
      return out;
    }),
    primary: value.primary,
  };
}

function annotationRow(summary, field, value, { status = 'ready' } = {}) {
  const canonicalValue = field === 'exploit' && status === 'ready'
    ? exploitCanonicalValue(value)
    : (status === 'unavailable' ? null : value);
  const valueSha256 = annotationValueSha256({ field, status, value: canonicalValue });
  return {
    evaluationId: summary.evaluationId,
    payloadSha256: summary.payloadSha256,
    field,
    status,
    value: canonicalValue,
    valueSha256,
    annotationProof: {
      id: publicProofId(`${summary.evaluationId}:${field}`),
      valueSha256,
    },
  };
}

function exploitValue({ opponentId = 'p1', policyId = 'tight-v1', adjustment = { bluff: 'increase' }, primary = 'p1' } = {}) {
  return {
    opponents: [{
      opponentId,
      policyId,
      adjustment,
      comparison: { summaryCode: 'GTO_OK_EXPLOIT_MISSED' },
    }],
    primary,
  };
}

async function post(port, body, token = TOKEN) {
  const res = await fetch(`http://127.0.0.1:${port}/api/publish?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function snapshotOf(port, token = TOKEN) {
  return (await fetch(`http://127.0.0.1:${port}/api/snapshot?token=${token}`)).json();
}

function collectSse(port, token = TOKEN, windowMs = 250) {
  return new Promise((resolve) => {
    let body = '';
    let settled = false;
    let request;
    const finish = () => {
      if (settled) return;
      settled = true;
      request?.destroy();
      resolve(body);
    };
    const timer = setTimeout(finish, windowMs);
    request = http.get(`http://127.0.0.1:${port}/api/events?token=${token}&after=0`, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
    });
    request.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

async function withServer(dir, fn) {
  const started = await startServer({ gameDir: dir, port: 0, token: TOKEN });
  try {
    return await fn(started);
  } finally {
    await started.close();
  }
}

// --- C2: exploit 게이트의 권위는 엔진 state.json이다 (S1) ---

test('C2: a published view cannot open the exploit gate — one POST or two', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { gameOver: false });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    assert.equal((await post(port, { publishId: 1, training: [summary] })).status, 200);

    const exploit = annotationRow(summary, 'exploit', exploitValue());
    const sameRequest = await post(port, {
      publishId: 2,
      view: { handNo: 1, gameOver: true, toAct: null, seats: [] },
      trainingAnnotations: [exploit],
    });
    assert.equal(sameRequest.status, 409);
    assert.equal(sameRequest.json.code, 'EXPLOIT_BEFORE_GAMEOVER');

    const viewOnly = await post(port, {
      publishId: 2,
      view: { handNo: 1, gameOver: true, toAct: null, seats: [] },
    });
    assert.equal(viewOnly.status, 200);
    const afterView = await post(port, { publishId: 3, trainingAnnotations: [exploit] });
    assert.equal(afterView.status, 409);
    assert.equal(afterView.json.code, 'EXPLOIT_BEFORE_GAMEOVER');

    const snap = await snapshotOf(port);
    assert.equal((snap.trainingAnnotations ?? []).some((row) => row.field === 'exploit'), false);
  });
});

test('C2: an unreadable engine state fails closed — absent, directory, symlink', async () => {
  const summary = summaryOf();
  const exploit = annotationRow(summary, 'exploit', exploitValue());

  const absent = tmpDir();
  writeSecurityFixtures(absent, { gameOver: true });
  fs.rmSync(path.join(absent, 'state.json'));

  const asDirectory = tmpDir();
  writeSecurityFixtures(asDirectory, { gameOver: true });
  fs.rmSync(path.join(asDirectory, 'state.json'));
  fs.mkdirSync(path.join(asDirectory, 'state.json'));

  const viaSymlink = tmpDir();
  writeSecurityFixtures(viaSymlink, { gameOver: true });
  const outside = tmpDir();
  const target = path.join(outside, 'state.json');
  fs.writeFileSync(target, JSON.stringify({ gameOver: true }));
  fs.rmSync(path.join(viaSymlink, 'state.json'));
  fs.symlinkSync(target, path.join(viaSymlink, 'state.json'));

  const corrupt = tmpDir();
  writeSecurityFixtures(corrupt, { gameOver: true });
  fs.writeFileSync(path.join(corrupt, 'state.json'), '{not json');

  for (const dir of [absent, asDirectory, viaSymlink, corrupt]) {
    await withServer(dir, async ({ port }) => {
      assert.equal((await post(port, { publishId: 1, training: [summary] })).status, 200);
      const denied = await post(port, { publishId: 2, trainingAnnotations: [exploit] });
      assert.equal(denied.status, 409, dir);
      assert.equal(denied.json.code, 'EXPLOIT_BEFORE_GAMEOVER', dir);
    });
  }
});

test('C2: the engine gameOver flag alone opens the gate — no view needed', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { gameOver: true });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    assert.equal((await post(port, { publishId: 1, training: [summary] })).status, 200);
    const accepted = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'exploit', exploitValue())],
    });
    assert.equal(accepted.status, 200);
    const snap = await snapshotOf(port);
    assert.equal(snap.view, null);
    assert.equal((snap.trainingAnnotations ?? []).some((row) => row.field === 'exploit'), true);
  });
});

test('C2: a persisted exploit annotation is dropped while the engine is not over', async () => {
  const summary = summaryOf();
  const stored = annotationRow(summary, 'exploit', exploitValue());
  delete stored.annotationProof;

  const running = tmpDir();
  writeSecurityFixtures(running, { gameOver: false });
  fs.writeFileSync(path.join(running, 'ui-snapshot.json'), JSON.stringify({
    revision: 2,
    publishId: 2,
    view: { handNo: 1, gameOver: true, toAct: null, seats: [] },
    training: [summary],
    trainingAnnotations: [stored],
    history: [],
  }));
  await withServer(running, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal((snap.trainingAnnotations ?? []).length, 0);
  });

  const over = tmpDir();
  writeSecurityFixtures(over, { gameOver: true });
  fs.writeFileSync(path.join(over, 'ui-snapshot.json'), JSON.stringify({
    revision: 2,
    publishId: 2,
    view: null,
    training: [summary],
    trainingAnnotations: [stored],
    history: [],
  }));
  await withServer(over, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal((snap.trainingAnnotations ?? []).length, 1);
  });
});

// --- C1: deny 목록은 게시자 입력에 의존하지 않는다 ---

test('C1: nested policy literals are denied', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } })] });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    for (const leak of [FIXTURE_POLICY_ID, FIXTURE_CONFIG_DIGEST]) {
      const denied = await post(port, {
        publishId: 2,
        trainingAnnotations: [annotationRow(summary, 'explanation', `상대 정책은 ${leak} 이다`)],
      });
      assert.equal(denied.status, 400, leak);
      assert.equal(denied.json.code, 'FORBIDDEN_LITERAL', leak);
    }
    const snap = await snapshotOf(port);
    assert.equal((snap.trainingAnnotations ?? []).length, 0);
  });
});

test('C1: the deny list is the union over every hand, and ignores the publisher handNo', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, {
    hands: [
      handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } }),
      handRecordFixture(2, {
        holes: { user: ['Qs', 'Qd'], p1: ['9s', '9h'] },
        reveals: [{ playerId: 'p1', cards: ['9s', '9h'] }],
      }),
      handRecordFixture(3, { holes: { user: ['3c', '4c'], p1: ['Td', 'Jd'] } }),
    ],
  });
  const first = summaryOf({ decisionId: 'd-1-preflop-0', handNo: 1 });
  const second = summaryOf({ decisionId: 'd-2-preflop-0', handNo: 2 });
  const third = summaryOf({ decisionId: 'd-3-preflop-0', handNo: 3 });
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [first, second, third] });

    const late = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(first, 'explanation', '상대는 7c를 들고 있었다')],
    });
    assert.equal(late.status, 400);
    assert.equal(late.json.code, 'FORBIDDEN_LITERAL');

    // 같은 POST에 handNo 3을 주장하는 machine item을 실어도 결과는 같다.
    const forgedHandNo = summaryOf({ decisionId: 'd-4-preflop-0', handNo: 3 });
    const withForgedItem = await post(port, {
      publishId: 2,
      training: [forgedHandNo],
      trainingAnnotations: [annotationRow(forgedHandNo, 'explanation', '상대는 7c를 들고 있었다')],
    });
    assert.equal(withForgedItem.status, 400);
    assert.equal(withForgedItem.json.code, 'FORBIDDEN_LITERAL');

    // showdown으로 공개된 카드는 오탐이 아니다.
    const revealed = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(second, 'explanation', '보여준 9s는 공개 정보다')],
    });
    assert.equal(revealed.status, 200);
  });
});

test('C1: engine seed, absolute paths and store markers are denied', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } })] });
  const summary = summaryOf();
  const other = summaryOf({ decisionId: 'd-2-preflop-0', handNo: 1 });
  const third = summaryOf({ decisionId: 'd-3-preflop-0', handNo: 1 });
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary, other, third] });
    const cases = [
      [summary, `시드 ${FIXTURE_POLICY_SEED} 유출`],
      [other, '경로 /Users/tester/game/state.json 유출'],
      [third, '.session-store/sessions/s-1 유출'],
    ];
    for (const [item, text] of cases) {
      const denied = await post(port, {
        publishId: 2,
        trainingAnnotations: [annotationRow(item, 'explanation', text)],
      });
      assert.equal(denied.status, 400, text);
      assert.equal(denied.json.code, 'FORBIDDEN_LITERAL', text);
    }
  });
});

test('C1: missing or unreadable security material fails closed with 500', async () => {
  const summary = summaryOf();
  const build = () => {
    const dir = tmpDir();
    writeSecurityFixtures(dir, {
      hands: [
        handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } }),
        handRecordFixture(2, { holes: { user: ['Qs', 'Qd'], p1: ['9s', '9h'] } }),
        handRecordFixture(3, { holes: { user: ['3c', '4c'], p1: ['Td', 'Jd'] } }),
      ],
    });
    return dir;
  };

  const noPlayers = build();
  fs.rmSync(path.join(noPlayers, 'players.json'));
  const badPlayers = build();
  fs.writeFileSync(path.join(badPlayers, 'players.json'), '{broken');
  const noState = build();
  fs.rmSync(path.join(noState, 'state.json'));
  const missingHand = build();
  fs.rmSync(handFilePath(missingHand, 1));
  const brokenHand = build();
  fs.writeFileSync(handFilePath(brokenHand, 2), 'not json');
  const emptyPlayers = build();
  fs.writeFileSync(path.join(emptyPlayers, 'players.json'), JSON.stringify([{ playerId: 'user' }]));
  fs.writeFileSync(path.join(emptyPlayers, 'state.json'), JSON.stringify({ gameOver: false }));
  for (const record of [1, 2, 3]) fs.rmSync(handFilePath(emptyPlayers, record));

  for (const dir of [noPlayers, badPlayers, noState, missingHand, brokenHand, emptyPlayers]) {
    await withServer(dir, async ({ port }) => {
      await post(port, { publishId: 1, training: [summary] });
      const denied = await post(port, {
        publishId: 2,
        trainingAnnotations: [annotationRow(summary, 'explanation', '아무 문제 없는 해설')],
      });
      assert.equal(denied.status, 500, dir);
      assert.equal(denied.json.code, 'FORBIDDEN_LITERAL_UNAVAILABLE', dir);
    });
  }
});

test('C1: the deny list is never cached — a new in-progress hole card is denied at once', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } })] });
  const first = summaryOf({ decisionId: 'd-1-preflop-0', handNo: 1 });
  const second = summaryOf({ decisionId: 'd-2-preflop-0', handNo: 2 });
  const handsMtime = fs.statSync(path.join(dir, 'hands')).mtimeMs;
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [first, second] });
    const clean = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(first, 'explanation', 'Qd는 아직 아무 데도 없다')],
    });
    assert.equal(clean.status, 200);

    // hands/는 그대로 두고 state.json의 진행 중 핸드만 바꾼다.
    writeSecurityFixtures(dir, {
      hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } })],
      handInProgress: { handNo: 2, holes: { user: ['2h', '3h'], p1: ['Qd', 'Js'] } },
    });
    assert.equal(fs.statSync(path.join(dir, 'hands')).mtimeMs, handsMtime);

    const denied = await post(port, {
      publishId: 3,
      trainingAnnotations: [annotationRow(second, 'explanation', '상대가 Qd를 들고 있다')],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'FORBIDDEN_LITERAL');
  });
});

test('C1: a clean explanation with every material present is accepted', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } })] });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const accepted = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '레인지 상단으로 밸류를 뽑는 스팟이다')],
    });
    assert.equal(accepted.status, 200);
    const snap = await snapshotOf(port);
    assert.equal(snap.trainingAnnotations.length, 1);
  });
});

// --- M1: 투영은 identity·detail·adjustment를 검사한다 ---

test('M1: evaluationId grammar and detail proofs are contract-checked in the projection', () => {
  const summary = summaryOf();
  const other = summaryOf({ decisionId: 'd-9-preflop-0' });
  const throwsMismatch = (item, label) => assert.throws(
    () => projectTrainingSummary(item),
    (error) => error.code === 'TRAINING_PROOF_MISMATCH',
    label,
  );
  throwsMismatch({ ...summary, evaluationId: '__proto__' }, '__proto__');
  throwsMismatch({ ...summary, evaluationId: 'not-an-evaluation-id' }, 'grammar');
  throwsMismatch({ ...summary, detailRef: { policySeed: 'x' } }, 'object detailRef');
  throwsMismatch({ ...summary, detailSha256: { configDigest: 'x' } }, 'object detailSha256');
  throwsMismatch({ ...summary, detailRef: 'zz'.repeat(32) }, 'non-hex detailRef');
  throwsMismatch(
    { ...summary, detailRef: detailRefOf(other.evaluationId) },
    'detailRef bound to another evaluation',
  );
  assert.equal(projectTrainingSummary(summary).detailRef, detailRefOf(summary.evaluationId));
});

test('M1: the exploit adjustment vocabulary is closed and prototype-free', () => {
  const summary = summaryOf();
  const rowFor = (adjustment, primary = 'p1') => ({
    evaluationId: summary.evaluationId,
    payloadSha256: summary.payloadSha256,
    field: 'exploit',
    status: 'ready',
    value: exploitValue({ adjustment, primary }),
  });
  const throwsMismatch = (row, label) => assert.throws(
    () => projectTrainingAnnotation(row),
    (error) => error.code === 'ANNOTATION_PROOF_MISMATCH',
    label,
  );
  throwsMismatch(rowFor({ configDigest: 'x', bluff: 'increase' }), 'unknown key');
  throwsMismatch(rowFor({ bluff: 'lots' }), 'unknown level');
  throwsMismatch(rowFor({ bluff: null }), 'null level');
  throwsMismatch(rowFor(JSON.parse('{"__proto__":"increase"}')), '__proto__ key');
  throwsMismatch(rowFor({ bluff: 'increase' }, 'ghost'), 'primary outside opponents');

  const projected = projectTrainingAnnotation(rowFor({ bluff: 'increase', thinValue: 'hold', defense: 'decrease' }));
  assert.equal(projected.value.opponents[0].adjustment.bluff, 'increase');
  assert.equal(Object.getPrototypeOf(projected.value.opponents[0].adjustment), null);
  assert.equal(Object.prototype.explanation, undefined);
  assert.equal({}.increase, undefined);
});

test('M1: forged identity and detail leaves are rejected at the server, snapshot and SSE', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { gameOver: true, hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } })] });
  const summary = summaryOf();
  const other = summaryOf({ decisionId: 'd-9-preflop-0' });
  const forge = (patch) => {
    const item = { ...summary, ...patch };
    delete item.payloadSha256;
    return { ...item, payloadSha256: trainingPayloadSha256(item) };
  };
  await withServer(dir, async ({ port }) => {
    const cases = [
      forge({ detailRef: { policySeed: 'x' } }),
      forge({ detailSha256: { configDigest: 'x' } }),
      forge({ evaluationId: '__proto__' }),
      forge({ evaluationId: 'not-an-evaluation-id' }),
      forge({ detailRef: detailRefOf(other.evaluationId), detailSha256: 'cd'.repeat(32) }),
    ];
    let publishId = 1;
    for (const item of cases) {
      publishId += 1;
      const denied = await post(port, { publishId, training: [item] });
      assert.equal(denied.status, 400, JSON.stringify(item.evaluationId));
      assert.equal(denied.json.code, 'TRAINING_PROOF_MISMATCH', JSON.stringify(item.evaluationId));
    }
    const snap = await snapshotOf(port);
    assert.equal((snap.training ?? []).length, 0);
    assert.equal(JSON.stringify(snap).includes('policySeed'), false);

    await post(port, { publishId: 20, training: [summary] });
    const badAdjustment = await post(port, {
      publishId: 21,
      trainingAnnotations: [annotationRow(summary, 'exploit', exploitValue({
        adjustment: { configDigest: 'x', bluff: 'increase' },
      }))],
    });
    assert.equal(badAdjustment.status, 400);
    assert.equal(badAdjustment.json.code, 'ANNOTATION_PROOF_MISMATCH');

    const badPrimary = await post(port, {
      publishId: 21,
      trainingAnnotations: [annotationRow(summary, 'exploit', exploitValue({ primary: 'ghost' }))],
    });
    assert.equal(badPrimary.status, 400);
    assert.equal(badPrimary.json.code, 'ANNOTATION_PROOF_MISMATCH');

    const sse = await collectSse(port);
    assert.equal(sse.includes('policySeed'), false);
    assert.equal(sse.includes('configDigest'), false);
    assert.equal(Object.prototype.explanation, undefined);
  });
});

// --- M4: 복원된 history는 live merge와 같은 다섯 술어를 통과한 재투영이다 ---

function seedSnapshot(dir, { training = [], trainingAnnotations = [], history = [], view = null }) {
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify({
    revision: history.length + 1,
    publishId: history.length + 1,
    view,
    log: [],
    coach: [],
    training,
    trainingAnnotations,
    history,
  }));
}

function storedRow(summary, field, value, options) {
  const row = annotationRow(summary, field, value, options);
  delete row.annotationProof;
  return row;
}

test('M4: a v1 history payload is reprojected before it is replayed', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } })] });
  const summary = summaryOf();
  const legacyItem = {
    ...summary,
    chosen: { action: 'raise', sizeBb: 2.5, frequency: 1, evBb: null, policySeed: 'LEAKED-SEED' },
    source: { id: 'local-preflop-baseline', version: '1.0.0', path: '/Users/tester/secret.json' },
    explanation: '구 스냅샷 해설',
  };
  seedSnapshot(dir, {
    training: [summary],
    history: [
      { revision: 1, at: '2026-01-01T00:00:00.000Z', payload: { training: [legacyItem] } },
    ],
  });
  await withServer(dir, async ({ port }) => {
    const sse = await collectSse(port);
    assert.equal(sse.includes('LEAKED-SEED'), false);
    assert.equal(sse.includes('/Users/tester/secret.json'), false);
    assert.equal(sse.includes(summary.evaluationId), true);
  });
});

test('M4: history annotations must clear all five predicates to be replayed', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, {
    hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } })],
  });
  const summary = summaryOf();
  const kept = storedRow(summary, 'explanation', '남아야 하는 해설');

  const deniedLiteral = storedRow(summary, 'explanation', `정책 ${FIXTURE_POLICY_ID} 유출`);
  const exploitRow = storedRow(summary, 'exploit', exploitValue());
  const missingPayload = { ...storedRow(summary, 'explanation', '결박 없는 해설') };
  delete missingPayload.payloadSha256;
  const wrongPayload = { ...storedRow(summary, 'explanation', '다른 결박'), payloadSha256: 'ff'.repeat(32) };
  const forgedValueSha = { ...storedRow(summary, 'explanation', '위조된 digest'), valueSha256: 'ff'.repeat(32) };
  const staleValue = storedRow(summary, 'explanation', '최종 상태에 없는 과거 값');
  const orphanRow = storedRow({ ...summary, evaluationId: evaluationId('d-8-preflop-0') }, 'explanation', '고아 해설');

  seedSnapshot(dir, {
    training: [summary],
    trainingAnnotations: [kept],
    history: [
      { revision: 1, at: '2026-01-01T00:00:00.000Z', payload: { trainingAnnotations: [kept] } },
      {
        revision: 2,
        at: '2026-01-01T00:00:01.000Z',
        payload: {
          trainingAnnotations: [
            deniedLiteral, exploitRow, missingPayload, wrongPayload,
            forgedValueSha, staleValue, orphanRow,
          ],
        },
      },
    ],
  });

  await withServer(dir, async ({ port }) => {
    const sse = await collectSse(port);
    assert.equal(sse.includes('남아야 하는 해설'), true);
    for (const leak of [
      FIXTURE_POLICY_ID, 'exploit', '결박 없는 해설', '다른 결박',
      '위조된 digest', '최종 상태에 없는 과거 값', '고아 해설',
    ]) {
      assert.equal(sse.includes(leak), false, leak);
    }
    const snap = await snapshotOf(port);
    assert.equal(snap.trainingAnnotations.length, 1);
    assert.equal(snap.trainingAnnotations[0].value, '남아야 하는 해설');
  });
});

test('M4: a history machine item absent from the final training list is dropped', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } })] });
  const summary = summaryOf();
  const ghost = summaryOf({ decisionId: 'd-7-preflop-0', handNo: 7 });
  const rewritten = { ...summary, grade: 'off-policy' };
  rewritten.payloadSha256 = trainingPayloadSha256(rewritten);
  seedSnapshot(dir, {
    training: [summary],
    history: [
      { revision: 1, at: '2026-01-01T00:00:00.000Z', payload: { training: [summary] } },
      { revision: 2, at: '2026-01-01T00:00:01.000Z', payload: { training: [ghost, rewritten] } },
    ],
  });
  await withServer(dir, async ({ port }) => {
    const sse = await collectSse(port);
    assert.equal(sse.includes(summary.evaluationId), true);
    assert.equal(sse.includes(ghost.evaluationId), false);
    assert.equal(sse.includes('off-policy'), false);
  });
});
