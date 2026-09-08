import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  annotationValueSha256,
  canonicalHandReplayJson,
  detailRefOf,
  projectTrainingAnnotation,
  projectTrainingSummary,
  publicProofId,
  replayRecord,
  trainingPayloadSha256,
} from '../publish-contract.js';
import { evaluationIdOf } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import { startServer } from '../server/server.js';
import {
  FIXTURE_ARCHETYPE,
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
  return createOwnedTempDir('holdem-secgate');
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

function legacySummaryDigest(summary) {
  const keys = [
    'evaluationId', 'handNo', 'decisionId', 'status', 'street', 'spotKey', 'handClass',
    'chosen', 'recommended', 'evLossBb', 'grade', 'forced', 'source', 'explanation',
    'detailRef', 'detailSha256', 'code', 'reason',
  ];
  const canonical = {};
  for (const key of keys) if (summary[key] !== undefined) canonical[key] = summary[key];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function exploitValue({
  opponentId = 'p1',
  policyId = 'tight-v1',
  adjustment = { bluff: 'increase', thinValue: 'hold', defense: 'decrease' },
  primary = 'p1',
} = {}) {
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

  const partial = tmpDir();
  writeSecurityFixtures(partial, { gameOver: true });
  fs.writeFileSync(path.join(partial, 'state.json'), JSON.stringify({ gameOver: true }));

  const staleSession = tmpDir();
  writeSecurityFixtures(staleSession, { gameOver: true, state: { sessionToken: 'other-session' } });

  for (const dir of [absent, asDirectory, viaSymlink, corrupt, partial, staleSession]) {
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

test('C2: canonical engine abort is a terminal gameOver state', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, {
    gameOver: true,
    hands: [],
    state: { handNo: 0, lastHand: null, result: 'abort' },
  });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const accepted = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'exploit', exploitValue())],
    });
    assert.equal(accepted.status, 200);
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
      [third, 'path=(/Users/tester/game/state.json) 및 .session-store/sessions/s-1 유출'],
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
  const noHands = build();
  fs.rmSync(path.join(noHands, 'hands'), { recursive: true });
  const missingHand = build();
  fs.rmSync(handFilePath(missingHand, 1));
  const brokenHand = build();
  fs.writeFileSync(handFilePath(brokenHand, 2), 'not json');
  const emptyPlayers = build();
  fs.writeFileSync(path.join(emptyPlayers, 'players.json'), JSON.stringify([{ playerId: 'user' }]));
  fs.writeFileSync(path.join(emptyPlayers, 'state.json'), JSON.stringify({ gameOver: false }));
  for (const record of [1, 2, 3]) fs.rmSync(handFilePath(emptyPlayers, record));

  for (const dir of [noPlayers, badPlayers, noState, noHands, missingHand, brokenHand, emptyPlayers]) {
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

test('C1: parseable but incomplete security schemas fail closed', async () => {
  const summary = summaryOf();
  const cases = [];

  const stringCards = tmpDir();
  writeSecurityFixtures(stringCards, {
    handInProgress: { handNo: 2, holes: { user: ['Ah', 'Kh'], p1: 'Qs' } },
  });
  cases.push(stringCards);

  const nestedPolicy = tmpDir();
  writeSecurityFixtures(nestedPolicy, {
    players: [
      { playerId: 'user' },
      { playerId: 'p1', policy: { policyId: { nested: 'secret-policy' } } },
    ],
  });
  cases.push(nestedPolicy);

  const archiveMismatch = tmpDir();
  writeSecurityFixtures(archiveMismatch, {
    hands: [
      handRecordFixture(1, { holes: { user: ['Ah', 'Kh'] } }),
      handRecordFixture(2, { holes: { user: ['Qs', 'Qd'], p1: ['9s', '9h'] } }),
    ],
  });
  fs.writeFileSync(handFilePath(archiveMismatch, 2), JSON.stringify(
    handRecordFixture(3, { holes: { user: ['Qs', 'Qd'], p1: ['9s', '9h'] } }),
  ));
  cases.push(archiveMismatch);

  const forgedReveal = tmpDir();
  writeSecurityFixtures(forgedReveal, {
    hands: [handRecordFixture(1, {
      holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] },
      reveals: [{ playerId: 'user', cards: ['7c', '2d'] }],
    })],
  });
  cases.push(forgedReveal);

  const duplicateCards = tmpDir();
  writeSecurityFixtures(duplicateCards, {
    hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['Ah', '2d'] } })],
  });
  cases.push(duplicateCards);

  const ghostParticipant = tmpDir();
  writeSecurityFixtures(ghostParticipant, {
    handInProgress: { handNo: 2, holes: { user: ['Ah', 'Kh'], ghost: ['Qs', 'Qd'] } },
  });
  cases.push(ghostParticipant);

  const boardOverlap = tmpDir();
  writeSecurityFixtures(boardOverlap, {
    handInProgress: {
      handNo: 2,
      holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] },
      board: ['7c'],
      deck: [],
    },
  });
  cases.push(boardOverlap);

  const deckOverlap = tmpDir();
  writeSecurityFixtures(deckOverlap, {
    handInProgress: {
      handNo: 2,
      holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] },
      board: [],
      deck: ['7c'],
    },
  });
  cases.push(deckOverlap);

  const phaseMismatch = tmpDir();
  writeSecurityFixtures(phaseMismatch, {
    handInProgress: { handNo: 2, holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } },
    state: { phase: 'idle' },
  });
  cases.push(phaseMismatch);

  const handNoMismatch = tmpDir();
  writeSecurityFixtures(handNoMismatch, {
    hands: [handRecordFixture(1)],
    state: { handNo: 2 },
  });
  cases.push(handNoMismatch);

  const tokenMismatch = tmpDir();
  writeSecurityFixtures(tokenMismatch, { state: { sessionToken: 'other-session' } });
  cases.push(tokenMismatch);

  for (const dir of cases) {
    await withServer(dir, async ({ port }) => {
      await post(port, { publishId: 1, training: [summary] });
      const denied = await post(port, {
        publishId: 2,
        trainingAnnotations: [annotationRow(summary, 'explanation', 'schema 누락을 통과하면 안 된다')],
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

test('C1: hand-10000.json remains a canonical security source', { timeout: 20_000 }, async () => {
  const dir = tmpDir();
  const hands = Array.from({ length: 10_000 }, (_, index) => handRecordFixture(index + 1, {
    holes: index === 9_999
      ? { user: ['Ah', 'Kh'], p1: ['As', 'Ks'] }
      : { user: ['Ah', 'Kh'] },
  }));
  writeSecurityFixtures(dir, { hands });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const denied = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '마지막 상대 카드는 As다')],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'FORBIDDEN_LITERAL');
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
  throwsMismatch({ ...summary, detailSha256: null }, 'null detailSha256');
  throwsMismatch({ ...summary, detailRef: 'zz'.repeat(32) }, 'non-hex detailRef');
  throwsMismatch(
    { ...summary, detailRef: detailRefOf(other.evaluationId) },
    'detailRef bound to another evaluation',
  );
  const evaluationWithoutDetail = { ...summary };
  for (const key of ['handNo', 'detailRef', 'detailSha256', 'payloadSha256', 'recommendedTruncated']) {
    delete evaluationWithoutDetail[key];
  }
  const withoutDigest = toPublicSummary(evaluationWithoutDetail, { handNo: 1 });
  assert.equal(Object.hasOwn(withoutDigest, 'detailSha256'), false);
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
  throwsMismatch(rowFor({ bluff: 'increase' }), 'incomplete adjustment');
  throwsMismatch(rowFor(JSON.parse('{"__proto__":"increase"}')), '__proto__ key');
  throwsMismatch(rowFor({ bluff: 'increase' }, 'ghost'), 'primary outside opponents');
  throwsMismatch({ ...rowFor({ bluff: 'increase' }), value: { opponents: null, primary: null } }, 'null opponents');
  throwsMismatch({ ...rowFor({ bluff: 'increase' }), value: { opponents: [], primary: null } }, 'empty opponents');
  throwsMismatch({
    ...rowFor({ bluff: 'increase' }),
    value: { opponents: [{ opponentId: 'p1', policyId: null, adjustment: null }], primary: 'p1' },
  }, 'null exploit leaves');

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

test('M4: forged final digests and conflicting duplicate set-once rows are dropped', async () => {
  const summary = summaryOf();
  const forged = { ...summary, grade: 'off-policy', payloadSha256: summary.payloadSha256 };
  const conflicting = { ...summary, grade: 'mixed' };
  conflicting.payloadSha256 = trainingPayloadSha256(conflicting);

  const forgedDir = tmpDir();
  writeSecurityFixtures(forgedDir);
  seedSnapshot(forgedDir, {
    training: [forged],
    history: [{ revision: 1, payload: { training: [forged] } }],
  });
  await withServer(forgedDir, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal(snap.training.length, 0);
    const sse = await collectSse(port);
    assert.equal(sse.includes('off-policy'), false);
  });

  const duplicateDir = tmpDir();
  writeSecurityFixtures(duplicateDir);
  const ready = storedRow(summary, 'explanation', '첫 값');
  const conflict = storedRow(summary, 'explanation', '둘째 값');
  seedSnapshot(duplicateDir, {
    training: [summary, conflicting],
    trainingAnnotations: [ready, conflict],
    history: [{ revision: 1, payload: { training: [summary], trainingAnnotations: [ready] } }],
  });
  await withServer(duplicateDir, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal(snap.training.length, 0);
    assert.equal(snap.trainingAnnotations.length, 0);
    const sse = await collectSse(port);
    assert.equal(sse.includes('첫 값'), false);
  });

  const outerMismatchDir = tmpDir();
  writeSecurityFixtures(outerMismatchDir);
  const otherId = evaluationId('d-9-preflop-0');
  seedSnapshot(outerMismatchDir, { training: [summary] });
  const raw = JSON.parse(fs.readFileSync(path.join(outerMismatchDir, 'ui-snapshot.json'), 'utf8'));
  raw.trainingAnnotations = { [otherId]: { explanation: ready } };
  fs.writeFileSync(path.join(outerMismatchDir, 'ui-snapshot.json'), JSON.stringify(raw));
  await withServer(outerMismatchDir, async ({ port }) => {
    assert.equal((await snapshotOf(port)).trainingAnnotations.length, 0);
  });
});

test('M4: unsigned legacy text and every duplicate final authority key are dropped', async () => {
  const summary = summaryOf();

  const unsignedLegacyDir = tmpDir();
  writeSecurityFixtures(unsignedLegacyDir);
  seedSnapshot(unsignedLegacyDir, { training: [{ ...summary, explanation: 'digest에 없는 해설' }] });
  await withServer(unsignedLegacyDir, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal(snap.training.length, 1);
    assert.equal(snap.trainingAnnotations.length, 0);
  });

  const forgedLegacyDir = tmpDir();
  writeSecurityFixtures(forgedLegacyDir);
  const forgedLegacy = { ...summary, explanation: '공식 provenance 없는 legacy 해설' };
  forgedLegacy.payloadSha256 = legacySummaryDigest(forgedLegacy);
  seedSnapshot(forgedLegacyDir, { training: [forgedLegacy] });
  await withServer(forgedLegacyDir, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal(snap.training.length, 0);
    assert.equal(snap.trainingAnnotations.length, 0);
  });

  const invalidFirstDir = tmpDir();
  writeSecurityFixtures(invalidFirstDir);
  const invalid = { ...summary, payloadSha256: 'ff'.repeat(32) };
  seedSnapshot(invalidFirstDir, { training: [invalid, summary] });
  await withServer(invalidFirstDir, async ({ port }) => {
    assert.equal((await snapshotOf(port)).training.length, 0);
  });

  const validFirstDir = tmpDir();
  writeSecurityFixtures(validFirstDir);
  seedSnapshot(validFirstDir, { training: [summary, invalid] });
  await withServer(validFirstDir, async ({ port }) => {
    assert.equal((await snapshotOf(port)).training.length, 0);
  });

  const duplicateAnnotationDir = tmpDir();
  writeSecurityFixtures(duplicateAnnotationDir);
  const ready = storedRow(summary, 'explanation', '동일 값');
  seedSnapshot(duplicateAnnotationDir, {
    training: [summary],
    trainingAnnotations: [ready, { ...ready }],
  });
  await withServer(duplicateAnnotationDir, async ({ port }) => {
    assert.equal((await snapshotOf(port)).trainingAnnotations.length, 0);
  });

  const malformedOuterDir = tmpDir();
  writeSecurityFixtures(malformedOuterDir);
  const legacy = { ...summary, explanation: 'authority가 증명한 구 해설' };
  legacy.payloadSha256 = legacySummaryDigest(legacy);
  fs.mkdirSync(path.join(malformedOuterDir, 'training'), { recursive: true });
  fs.writeFileSync(
    path.join(malformedOuterDir, 'training', '.training-authority.json'),
    JSON.stringify({ schemaVersion: 1 }),
  );
  seedSnapshot(malformedOuterDir, { training: [legacy] });
  const raw = JSON.parse(fs.readFileSync(path.join(malformedOuterDir, 'ui-snapshot.json'), 'utf8'));
  raw.trainingAnnotations = { [summary.evaluationId]: { explanation: null } };
  fs.writeFileSync(path.join(malformedOuterDir, 'ui-snapshot.json'), JSON.stringify(raw));
  await withServer(malformedOuterDir, async ({ port }) => {
    assert.equal((await snapshotOf(port)).trainingAnnotations.length, 0);
  });
});

function replaySha(replay) {
  return createHash('sha256').update(canonicalHandReplayJson(replay)).digest('hex');
}

function foldAction(playerId, reason) {
  return {
    decisionId: `d-1-preflop-${playerId}`,
    playerId,
    action: 'fold',
    amount: null,
    street: 'preflop',
    potTotal: 150,
    callAmount: 100,
    minRaiseTo: 200,
    maxRaiseTo: 10_000,
    board: [],
    currentBet: 100,
    reason,
  };
}

function findReplay(snap, handNo) {
  return (snap.handReplays ?? []).find((row) => row.handNo === handNo);
}

test('server recomputes a completed-hand trigger from the archive', async () => {
  const dir = tmpDir();
  const record = handRecordFixture(1, {
    positions: { user: 'BTN', p1: 'SB' },
    actions: [foldAction('p1', 'secret-fold')],
    folded: ['p1'],
  });
  writeSecurityFixtures(dir, { hands: [record], config: { replayReveal: 'all' } });
  await withServer(dir, async ({ port }) => {
    const posted = await post(port, {
      publishId: 1,
      view: { handNo: 1 },
      handReplay: { handNos: [1] },
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.handReplay.stored, [1]);
    const snap = await snapshotOf(port);
    const stored = findReplay(snap, 1);
    const expected = replayRecord(record, { reveal: 'all' });
    assert.equal(replaySha(stored), replaySha(expected));
  });
});

test('in-progress, abort and future handNos mark NOT_COMPLETED and still commit the body', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, {
    hands: [handRecordFixture(1)],
    handInProgress: { handNo: 2, holes: { user: ['2h', '3h'], p1: ['4c', '5d'] } },
  });
  await withServer(dir, async ({ port }) => {
    await post(port, {
      publishId: 1,
      view: { handNo: 2, toAct: 'user', legal: { decisionId: 'd-2-preflop-0' } },
    });
    const actionRes = await fetch(`http://127.0.0.1:${port}/api/action?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decisionId: 'd-2-preflop-0', requestId: 'ack-1', action: 'call' }),
    });
    assert.equal(actionRes.status, 200);
    await actionRes.text();
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'ui-action-receipt.json'), 'utf8'));
    const posted = await post(port, {
      publishId: 2,
      view: { handNo: 2, toAct: 'p1', legal: { decisionId: 'd-2-preflop-0' } },
      events: [{ seq: 9, visibility: 'public', type: 'street', street: 'flop' }],
      actionAck: {
        gameEpoch: receipt.gameEpoch,
        decisionId: receipt.decisionId,
        requestId: receipt.requestId,
        digest: receipt.digest,
        phase: 'rejected',
        reason: 'ILLEGAL_ACTION',
      },
      handReplay: { handNos: [2] },
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.handReplay.markers, [{ handNo: 2, reason: 'REPLAY_NOT_COMPLETED' }]);
    const snap = await snapshotOf(port);
    assert.equal(snap.view.toAct, 'p1');
    assert.equal(snap.log.some((entry) => entry.type === 'street'), true);
    assert.equal(findReplay(snap, 2).unavailable, true);
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
    assert.equal(persisted.lastActionAck.requestId, 'ack-1');
  });

  const aborted = tmpDir();
  writeSecurityFixtures(aborted, {
    gameOver: true,
    hands: [handRecordFixture(1)],
    state: { result: 'abort', handNo: 2, hand: null, phase: 'idle' },
  });
  await withServer(aborted, async ({ port }) => {
    const posted = await post(port, {
      publishId: 1,
      view: { aborted: true },
      events: [{ seq: 1, visibility: 'public', type: 'hand_start', handNo: 1 }],
      handReplay: { handNos: [2, 99] },
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(
      posted.json.handReplay.markers.map((row) => row.handNo).sort((a, b) => a - b),
      [2, 99],
    );
    assert.ok(posted.json.handReplay.markers.every((row) => row.reason === 'REPLAY_NOT_COMPLETED'));
    const snap = await snapshotOf(port);
    assert.equal(snap.view.aborted, true);
    assert.equal(snap.log[0].type, 'hand_start');
  });
});

test('{handNos:[]} is a 200 no-op', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1)] });
  await withServer(dir, async ({ port }) => {
    const posted = await post(port, {
      publishId: 1,
      view: { idle: true },
      handReplay: { handNos: [] },
    });
    assert.equal(posted.status, 200);
    const snap = await snapshotOf(port);
    assert.equal(snap.view.idle, true);
    assert.equal((snap.handReplays ?? []).length, 0);
  });
});

test('corrupt state.json marks every trigger UNAVAILABLE without rejecting the body', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1)] });
  fs.writeFileSync(path.join(dir, 'state.json'), '{broken');
  await withServer(dir, async ({ port }) => {
    const posted = await post(port, {
      publishId: 1,
      view: { kept: true },
      handReplay: { handNos: [1, 2] },
    });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.handReplay.markers.map((row) => row.reason), [
      'REPLAY_UNAVAILABLE',
      'REPLAY_UNAVAILABLE',
    ]);
    assert.equal((await snapshotOf(port)).view.kept, true);
  });
});

test('archive parse failure and handNo mismatch are UNAVAILABLE', async () => {
  const parseFail = tmpDir();
  writeSecurityFixtures(parseFail, { hands: [handRecordFixture(1), handRecordFixture(2)] });
  fs.mkdirSync(path.join(parseFail, 'hands'), { recursive: true });
  fs.writeFileSync(handFilePath(parseFail, 3), 'not json');
  await withServer(parseFail, async ({ port }) => {
    const posted = await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [3] } });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.handReplay.markers, [{ handNo: 3, reason: 'REPLAY_UNAVAILABLE' }]);
  });

  const mismatch = tmpDir();
  writeSecurityFixtures(mismatch, { hands: [handRecordFixture(1), handRecordFixture(2)] });
  fs.writeFileSync(handFilePath(mismatch, 3), JSON.stringify(handRecordFixture(4)));
  await withServer(mismatch, async ({ port }) => {
    const posted = await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [3] } });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.handReplay.markers, [{ handNo: 3, reason: 'REPLAY_UNAVAILABLE' }]);
  });
});

test('archivePending lastHand-only hands are stored', async () => {
  const dir = tmpDir();
  const record = handRecordFixture(1);
  writeSecurityFixtures(dir, { hands: [record], config: { replayReveal: 'all' } });
  fs.rmSync(handFilePath(dir, 1));
  await withServer(dir, async ({ port }) => {
    const posted = await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [1] } });
    assert.equal(posted.status, 200);
    assert.deepEqual(posted.json.handReplay.stored, [1]);
    assert.equal(replaySha(findReplay(await snapshotOf(port), 1)), replaySha(replayRecord(record, { reveal: 'all' })));
  });
});

test('legacy store without replayReveal projects showdown', async () => {
  const dir = tmpDir();
  const record = handRecordFixture(1, { folded: ['p1'], actions: [foldAction('p1', 'hidden-reason')] });
  writeSecurityFixtures(dir, { hands: [record] });
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [1] } });
    const stored = findReplay(await snapshotOf(port), 1);
    assert.equal(stored.reveal, 'showdown');
    assert.equal(replaySha(stored), replaySha(replayRecord(record, { reveal: 'showdown' })));
  });
});

test('17 handNos are BAD_HAND_REPLAY 400', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, { hands: [handRecordFixture(1)] });
  await withServer(dir, async ({ port }) => {
    const posted = await post(port, {
      publishId: 1,
      view: { shouldNotCommit: true },
      handReplay: { handNos: Array.from({ length: 17 }, (_, i) => i + 1) },
    });
    assert.equal(posted.status, 400);
    assert.equal(posted.json.code, 'BAD_HAND_REPLAY');
    const snap = await snapshotOf(port);
    assert.equal(snap.view, null);
  });
});

test('set-once: no-op, marker replacement, archive conflict', async () => {
  const dir = tmpDir();
  const first = handRecordFixture(1, { folded: ['p1'] });
  const second = handRecordFixture(2);
  writeSecurityFixtures(dir, { hands: [first, second], config: { replayReveal: 'all' } });
  await withServer(dir, async ({ port }) => {
    const stored = await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [1] } });
    assert.deepEqual(stored.json.handReplay.stored, [1]);
    const again = await post(port, { publishId: 2, view: { n: 2 }, handReplay: { handNos: [1] } });
    assert.deepEqual(again.json.handReplay.stored, []);
    assert.deepEqual(again.json.handReplay.conflicts, []);
    const firstSha = replaySha(findReplay(await snapshotOf(port), 1));

    const marked = await post(port, { publishId: 3, view: { n: 3 }, handReplay: { handNos: [3] } });
    assert.deepEqual(marked.json.handReplay.markers, [{ handNo: 3, reason: 'REPLAY_NOT_COMPLETED' }]);
    const third = handRecordFixture(3);
    fs.writeFileSync(handFilePath(dir, 3), JSON.stringify(third));
    const engine = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    engine.lastHand = third;
    engine.handNo = 3;
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(engine));
    const replaced = await post(port, { publishId: 4, view: { n: 4 }, handReplay: { handNos: [3] } });
    assert.deepEqual(replaced.json.handReplay.stored, [3]);
    assert.equal(findReplay(await snapshotOf(port), 3).unavailable, undefined);

    const mutated = JSON.parse(fs.readFileSync(handFilePath(dir, 1), 'utf8'));
    mutated.board = ['2c', '3d', '4h'];
    fs.writeFileSync(handFilePath(dir, 1), JSON.stringify(mutated));
    const conflicted = await post(port, { publishId: 5, view: { n: 5 }, handReplay: { handNos: [1] } });
    assert.deepEqual(conflicted.json.handReplay.conflicts, [1]);
    assert.equal(replaySha(findReplay(await snapshotOf(port), 1)), firstSha);
  });
});

test('showdown projection hides folded opponent holes and reasons; posted holes are ignored', async () => {
  const dir = tmpDir();
  const record = handRecordFixture(1, {
    folded: ['p1'],
    actions: [foldAction('p1', 'secret-reason')],
  });
  writeSecurityFixtures(dir, { hands: [record], config: { replayReveal: 'showdown' } });
  await withServer(dir, async ({ port }) => {
    await post(port, {
      publishId: 1,
      view: { n: 1 },
      handReplay: { handNos: [1], holes: { p1: ['As', 'Ah'] } },
    });
    const stored = findReplay(await snapshotOf(port), 1);
    assert.equal(stored.holes.p1, undefined);
    assert.deepEqual(stored.holes.user, ['Ah', 'Kh']);
    const hidden = stored.actions.find((row) => row.playerId === 'p1');
    assert.equal(hidden.reasonKind, 'hidden');
    assert.equal('reason' in hidden, false);
    assert.equal(JSON.stringify(stored).includes('As'), false);
  });
});

test('loadUiState and history reproject: tamper replaced, lastHand-only kept, missing dropped, markers kept', async () => {
  const dir = tmpDir();
  const first = handRecordFixture(1);
  const second = handRecordFixture(2);
  writeSecurityFixtures(dir, { hands: [first, second], config: { replayReveal: 'all' } });
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [1, 2, 99] } });
  });

  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
  const list = Array.isArray(raw.handReplays)
    ? raw.handReplays
    : Object.values(raw.handReplays ?? {});
  const one = list.find((row) => row.handNo === 1);
  one.holes = { ...one.holes, p1: ['As', 'Ah'] };
  fs.writeFileSync(path.join(dir, 'ui-snapshot.json'), JSON.stringify(raw));
  fs.rmSync(handFilePath(dir, 2));

  await withServer(dir, async ({ port }) => {
    const snap = await snapshotOf(port);
    const restoredOne = findReplay(snap, 1);
    assert.equal(replaySha(restoredOne), replaySha(replayRecord(first, { reveal: 'all' })));
    assert.equal(JSON.stringify(restoredOne.holes).includes('As'), false);
    assert.equal(findReplay(snap, 2)?.handNo, 2);
    assert.equal(findReplay(snap, 99)?.unavailable, true);
    const sse = await collectSse(port, TOKEN, 400);
    assert.equal(sse.includes('As'), false);
  });

  fs.rmSync(handFilePath(dir, 1));
  const engine = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  engine.lastHand = second;
  engine.handNo = 2;
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(engine));
  await withServer(dir, async ({ port }) => {
    const snap = await snapshotOf(port);
    assert.equal(findReplay(snap, 1), undefined);
    assert.equal(findReplay(snap, 2)?.handNo, 2);
    assert.equal(findReplay(snap, 99)?.unavailable, true);
  });
});

test('deny list is policy-aware: all completed fold cards 200, in-progress 400, no subject-hand exemption', async () => {
  const completed = tmpDir();
  writeSecurityFixtures(completed, {
    hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] } })],
    config: { replayReveal: 'all' },
  });
  const summary = summaryOf();
  await withServer(completed, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const allowed = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '상대는 7c를 들고 있었다')],
    });
    assert.equal(allowed.status, 200);
  });

  const inProgress = tmpDir();
  writeSecurityFixtures(inProgress, {
    hands: [handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['9s', '9h'] } })],
    handInProgress: { handNo: 2, holes: { user: ['2h', '3h'], p1: ['7c', '2d'] } },
    config: { replayReveal: 'all' },
  });
  await withServer(inProgress, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const denied = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '상대는 7c를 들고 있었다')],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'FORBIDDEN_LITERAL');
  });

  const overlap = tmpDir();
  writeSecurityFixtures(overlap, {
    players: [
      { playerId: 'user' },
      {
        playerId: 'p1',
        archetype: FIXTURE_ARCHETYPE,
        policy: { policyId: FIXTURE_POLICY_ID, configDigest: FIXTURE_CONFIG_DIGEST },
      },
      { playerId: 'p2', archetype: 'P2_ARCHETYPE', personality: 'p2-person' },
    ],
    hands: [
      handRecordFixture(1, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'], p2: ['Qs', 'Qd'] } }),
      handRecordFixture(2, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'], p2: ['Qs', 'Qd'] } }),
      handRecordFixture(3, {
        holes: { user: ['Ah', 'Ac'], p1: ['7c', '2d'], p2: ['Kh', '7s'] },
        folded: ['p2'],
      }),
      handRecordFixture(4, { holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'], p2: ['Qs', 'Qd'] } }),
    ],
    handInProgress: {
      handNo: 5,
      holes: { user: ['2h', '3h'], p1: ['4c', '5d'], p2: ['Kh', '9c'] },
    },
    config: { replayReveal: 'all' },
  });
  await withServer(overlap, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const denied = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '핸드 3에서 p2는 Kh')],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'FORBIDDEN_LITERAL');
  });
});

test('deny list is never empty under all for policy and llm runtimes', async () => {
  const summary = summaryOf();
  const policyDir = tmpDir();
  writeSecurityFixtures(policyDir, {
    hands: [handRecordFixture(1)],
    config: { replayReveal: 'all' },
  });
  await withServer(policyDir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const denied = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', `정책 ${FIXTURE_POLICY_ID}`)],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'FORBIDDEN_LITERAL');
  });

  const llmDir = tmpDir();
  writeSecurityFixtures(llmDir, {
    players: [
      { playerId: 'user' },
      { playerId: 'p1', archetype: FIXTURE_ARCHETYPE, personality: 'FIXTURE_PERSONALITY_SENTINEL' },
    ],
    hands: [handRecordFixture(1)],
    config: { replayReveal: 'all' },
    state: { policySeed: null },
  });
  await withServer(llmDir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const denied = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', `아키타입 ${FIXTURE_ARCHETYPE}`)],
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, 'FORBIDDEN_LITERAL');
    const personality = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '성격 FIXTURE_PERSONALITY_SENTINEL')],
    });
    assert.equal(personality.status, 400);
  });
});

test('open showdown archive may quote a former muck-target AI card', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, {
    hands: [handRecordFixture(1, {
      holes: { user: ['Ah', 'Kh'], p1: ['7c', '2d'] },
      reveals: [{ playerId: 'p1', cards: ['7c', '2d'] }],
    })],
    config: { showdownPolicy: 'open', replayReveal: 'showdown' },
  });
  const summary = summaryOf();
  await withServer(dir, async ({ port }) => {
    await post(port, { publishId: 1, training: [summary] });
    const allowed = await post(port, {
      publishId: 2,
      trainingAnnotations: [annotationRow(summary, 'explanation', '오픈 쇼다운의 7c')],
    });
    assert.equal(allowed.status, 200);
  });
});

test('handReplays keep the latest 200 hands', async () => {
  const dir = tmpDir();
  const hands = Array.from({ length: 201 }, (_, i) => handRecordFixture(i + 1));
  writeSecurityFixtures(dir, { hands, config: { replayReveal: 'showdown' } });
  await withServer(dir, async ({ port }) => {
    let publishId = 1;
    for (let start = 1; start <= 201; start += 16) {
      const handNos = [];
      for (let n = start; n < start + 16 && n <= 201; n += 1) handNos.push(n);
      const posted = await post(port, { publishId, view: { handNo: 201 }, handReplay: { handNos } });
      assert.equal(posted.status, 200, `batch ${start}`);
      publishId += 1;
    }
    const snap = await snapshotOf(port);
    assert.equal(snap.handReplays.length, 200);
    assert.equal(snap.handReplays[0].handNo, 2);
    assert.equal(snap.handReplays.at(-1).handNo, 201);
    assert.equal(snap.handReplays.some((row) => row.handNo === 1), false);
  });
});

test('SSE deltas include only this publish\'s stored or replaced replays', async () => {
  const dir = tmpDir();
  writeSecurityFixtures(dir, {
    hands: [handRecordFixture(1), handRecordFixture(2)],
    config: { replayReveal: 'all' },
  });
  await withServer(dir, async ({ port }) => {
    const pending = collectSse(port, TOKEN, 800);
    await post(port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [1] } });
    await post(port, { publishId: 2, view: { n: 2 }, handReplay: { handNos: [2] } });
    const body = await pending;
    const blocks = body.split('\n\n').filter((block) => block.includes('data:'));
    const payloads = blocks.map((block) => JSON.parse(block.split('data: ').pop()));
    const lastWithReplay = [...payloads].reverse().find((row) => Array.isArray(row.handReplays));
    assert.deepEqual(lastWithReplay.handReplays.map((row) => row.handNo), [2]);
  });
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createOwnedTempDir, registerOwnedProcess, registerOwnedServer } from './helpers/owned-fixtures.mjs';
import { ensureStudyService, stopStudyService } from '../tools/study-service.js';

const STUDY_TOKEN = 'd'.repeat(64);
const STUDY_URL = `http://127.0.0.1:45678/#token=${STUDY_TOKEN}`;

async function linkedRelay(t, studyUrl, gameDir = createOwnedTempDir('holdem-study-relay')) {
  const relay = await startServer({ gameDir, port: 0, token: TOKEN, studyUrl });
  registerOwnedServer(relay.server, 'study-linked relay');
  t.after(async () => { if (relay.server.listening) await relay.close(); });
  return { ...relay, gameDir };
}
function persistedFiles(dir) {
  const result=[];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file=path.join(dir,item.name);
    if (item.isDirectory()) result.push(...persistedFiles(file));
    else if (item.isFile()) result.push({ file, bytes: fs.readFileSync(file, 'utf8') });
  }
  return result;
}

test('P3 F1: study-capability literal in a replay note becomes a marker, not a FORBIDDEN_LITERAL boot-loop', async (t) => {
  const dir = tmpDir();
  const record = handRecordFixture(1, {
    actions: [{
      decisionId: 'd-1-preflop-0',
      playerId: 'user',
      action: 'call',
      street: 'preflop',
      potTotal: 150,
      note: `study ${STUDY_TOKEN}`,
    }],
  });
  writeSecurityFixtures(dir, { hands: [record], config: { replayReveal: 'all' } });
  const first = await startServer({ gameDir: dir, port: 0, token: TOKEN, studyUrl: STUDY_URL });
  registerOwnedServer(first.server, 'p3-f1-first');
  t.after(async () => { if (first.server.listening) await first.close(); });
  const posted = await post(first.port, { publishId: 1, view: { n: 1 }, handReplay: { handNos: [1] } });
  assert.equal(posted.status, 200);
  assert.equal(posted.json.code, undefined);
  assert.notEqual(posted.json.code, 'FORBIDDEN_LITERAL');
  const snap = await snapshotOf(first.port);
  const row = snap.handReplays.find((entry) => entry.handNo === 1);
  assert.ok(row);
  assert.equal(row.unavailable, true);
  assert.equal(JSON.stringify(snap).includes(STUDY_TOKEN), false);
  await first.close();

  const restarted = await startServer({ gameDir: dir, port: 0, token: TOKEN, studyUrl: STUDY_URL });
  registerOwnedServer(restarted.server, 'p3-f1-restart');
  t.after(async () => { if (restarted.server.listening) await restarted.close(); });
  const again = await snapshotOf(restarted.port);
  const restored = again.handReplays.find((entry) => entry.handNo === 1);
  assert.ok(restored);
  assert.equal(restored.unavailable, true);
  assert.equal(JSON.stringify(again).includes(STUDY_TOKEN), false);
});

test('REQ-010: only authenticated snapshots synthesize the trusted startup study link', async (t) => {
  const relay = await linkedRelay(t, STUDY_URL);
  assert.equal((await snapshotOf(relay.port)).studyUrl, STUDY_URL);
  for (const suffix of ['', '?token=wrong', `?token=${STUDY_TOKEN}`]) {
    const response = await fetch(`http://127.0.0.1:${relay.port}/api/snapshot${suffix}`);
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes(STUDY_TOKEN), false);
  }
  const before = await snapshotOf(relay.port);
  assert.equal((await post(relay.port, { publishId: 1, studyUrl: 'http://attacker.invalid/#token=spoof',
    view: { handNo: 1, legal: { decisionId: null } }, review: 'Completed local fixture.' })).status, 200);
  assert.equal((await snapshotOf(relay.port)).studyUrl, before.studyUrl);
  const stream = await collectSse(relay.port);
  assert.equal(stream.includes(STUDY_URL), false); assert.equal(stream.includes(STUDY_TOKEN), false);
  for (const row of persistedFiles(relay.gameDir)) {
    assert.equal(row.bytes.includes(STUDY_TOKEN), false, path.basename(row.file));
    assert.equal(row.bytes.includes(STUDY_URL), false, path.basename(row.file));
    assert.equal(row.bytes.includes('attacker.invalid'), false, path.basename(row.file));
  }
});

test('REQ-010: invalid startup study URLs fail before any relay store creation', () => {
  for (const url of [null, {}, '', `https://127.0.0.1:1234/#token=${STUDY_TOKEN}`,
    `http://localhost:1234/#token=${STUDY_TOKEN}`, `http://127.1:1234/#token=${STUDY_TOKEN}`,
    `http://127.0.0.1:0/#token=${STUDY_TOKEN}`, `http://127.0.0.1:65536/#token=${STUDY_TOKEN}`,
    `http://127.0.0.1:01234/#token=${STUDY_TOKEN}`, `http://127.0.0.1:1234/path#token=${STUDY_TOKEN}`,
    `http://127.0.0.1:1234/?token=${STUDY_TOKEN}`, `http://127.0.0.1:1234/#token=${STUDY_TOKEN}&control=x`,
    `http://user@127.0.0.1:1234/#token=${STUDY_TOKEN}`, `http://127.0.0.1:1234/#token=short`,
    ` http://127.0.0.1:1234/#token=${STUDY_TOKEN}`, `${STUDY_URL}\n`]) {
    const root = createOwnedTempDir('holdem-study-bad-url');
    const gameDir = path.join(root, 'uncreated');
    assert.throws(() => startServer({ gameDir, port: 0, token: TOKEN, studyUrl: url }), { code: 'STUDY_URL_INVALID' });
    assert.equal(fs.existsSync(gameDir), false);
  }
});

test('REQ-010: persisted studyUrl cannot restore capability and an unlinked legacy relay stays unlinked', async (t) => {
  const root = createOwnedTempDir('holdem-study-stale-link');
  fs.writeFileSync(path.join(root, 'ui-snapshot.json'), JSON.stringify({ revision: 1, publishId: 1,
    history: [], studyUrl: STUDY_URL, view: null, log: [], coach: [] }));
  const relay = await linkedRelay(t, undefined, root);
  assert.equal('studyUrl' in await snapshotOf(relay.port), false);
  assert.equal((await post(relay.port, { publishId: 2 })).status, 200);
  assert.equal(fs.readFileSync(path.join(root, 'ui-snapshot.json'), 'utf8').includes(STUDY_TOKEN), false);
});

test('REQ-010: study outlives relay completion and another relay reuses the same private service', async (t) => {
  const storeDir = createOwnedTempDir('holdem-study-after-relay');
  const handle = await ensureStudyService(storeDir, { onChild(child) { child.ref(); registerOwnedProcess(child, 'independent study lifetime'); } });
  t.after(() => stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }));
  const descriptor = JSON.parse(fs.readFileSync(path.join(storeDir, '.training', 'study-service.json'), 'utf8'));
  let relay = await linkedRelay(t, handle.studyUrl);
  const gameDir = relay.gameDir;
  assert.equal((await post(relay.port, { publishId: 1, view: { gameOver: true, toAct: null, legal: null },
    review: 'Game completed.' })).status, 200);
  const linked = (await snapshotOf(relay.port)).studyUrl;
  await relay.close();
  const token = new URL(linked).hash.slice(7);
  const summary = await fetch(`http://127.0.0.1:${handle.port}/api/summary`, { headers: { 'x-drill-token': token } });
  assert.equal(summary.status, 200); await summary.json();
  const current = await ensureStudyService(storeDir);
  assert.equal(current.instanceId, handle.instanceId);
  relay = await linkedRelay(t, current.studyUrl, gameDir);
  assert.equal((await snapshotOf(relay.port)).studyUrl, linked);
  for (const row of persistedFiles(gameDir)) {
    for (const secret of [descriptor.drillToken, descriptor.controlToken, linked]) {
      assert.equal(row.bytes.includes(secret), false, path.basename(row.file));
    }
  }
  for (const endpoint of ['/.training/study-service.json','/study-service.json','/shared/study-service.js','/shared/study-contract.js']) {
    for (const port of [handle.port, relay.port]) {
      const response = await fetch(`http://127.0.0.1:${port}${endpoint}`);
      assert.equal(response.status, 404); await response.text();
    }
  }
  const shared = await fetch(`http://127.0.0.1:${relay.port}/shared/reference.js`);
  assert.equal(shared.status, 200); assert.ok((await shared.text()).includes('referenceQuality'));
});

test('REQ-010: the relay CLI accepts a trusted study link without printing or persisting its capability', async () => {
  const dir = createOwnedTempDir('holdem-study-cli');
  const child = registerOwnedProcess(spawn(process.execPath, [path.resolve('server/server.js'),
    '--game-dir',dir,'--port','0','--token',TOKEN,'--study-url',STUDY_URL], { stdio:['ignore','pipe','pipe'] }), 'study relay CLI');
  let output='', error='';
  child.stdout.on('data', chunk=>{output+=chunk;}); child.stderr.on('data', chunk=>{error+=chunk;});
  try {
    const deadline=Date.now()+4000;
    while(!/listening 127\.0\.0\.1:(\d+)/.test(output)) {
      assert.equal(child.exitCode,null);
      assert.ok(Date.now()<deadline,'relay did not start');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    const port=Number(/listening 127\.0\.0\.1:(\d+)/.exec(output)[1]);
    assert.equal((await snapshotOf(port)).studyUrl,STUDY_URL);
    assert.equal(output.includes(STUDY_TOKEN),false); assert.equal(error.includes(STUDY_TOKEN),false);
    assert.equal(persistedFiles(dir).some(row=>row.bytes.includes(STUDY_TOKEN)),false);
  } finally {
    child.kill('SIGTERM'); if(child.exitCode===null && child.signalCode===null) await once(child,'exit');
  }
});

test('REQ-010: known study capabilities cannot be published into view, log, coach or review sinks', async (t) => {
  const relay = await linkedRelay(t, STUDY_URL);
  await post(relay.port, { publishId: 1, view: { legal: null } });
  const before = fs.readFileSync(path.join(relay.gameDir, 'ui-snapshot.json'));
  for (const content of [{ view: { legal: null, note: STUDY_URL } }, { log: [STUDY_TOKEN] },
    { coach: [STUDY_URL] }, { review: STUDY_TOKEN }]) {
    const result = await post(relay.port, { publishId: 2, ...content });
    assert.equal(result.status, 400);
    assert.equal(result.json.code, 'FORBIDDEN_LITERAL');
    assert.deepEqual(fs.readFileSync(path.join(relay.gameDir, 'ui-snapshot.json')), before);
  }
});

test('REQ-010: preexisting study capabilities in persisted public state block startup without rewriting evidence', async (t) => {
  const root = createOwnedTempDir('holdem-study-persisted-secret');
  const raw = JSON.stringify({ revision: 1, publishId: 1, history: [], view: { legal: null, note: STUDY_TOKEN } });
  fs.writeFileSync(path.join(root, 'ui-snapshot.json'), raw);
  let relay;
  t.after(async () => { if(relay?.server.listening) await relay.close(); });
  await assert.rejects(async () => {
    relay = await startServer({ gameDir: root, port: 0, token: TOKEN, studyUrl: STUDY_URL });
    registerOwnedServer(relay.server, 'persisted capability negative');
  }, { code: 'FORBIDDEN_LITERAL' });
  assert.equal(fs.readFileSync(path.join(root, 'ui-snapshot.json'), 'utf8'), raw);
  assert.equal(fs.existsSync(path.join(root, 'lock.json')), false);
});

for(const [field,value] of [['studyUrl',STUDY_URL],['unknown',{nested:STUDY_TOKEN}]]) {
  test(`S7 repair: active capability in raw ${field} blocks startup before projection`,async(t)=>{
    const dir=createOwnedTempDir('holdem-study-raw-capability');
    const raw=JSON.stringify({revision:0,history:[],[field]:value});
    fs.writeFileSync(path.join(dir,'ui-snapshot.json'),raw);
    let relay;
    t.after(async()=>{if(relay?.server.listening)await relay.close();});
    await assert.rejects(async()=>{
      relay=await startServer({gameDir:dir,port:0,token:TOKEN,studyUrl:STUDY_URL});
      registerOwnedServer(relay.server,'raw capability negative');
    },{code:'FORBIDDEN_LITERAL'});
    assert.equal(fs.readFileSync(path.join(dir,'ui-snapshot.json'),'utf8'),raw);
    assert.equal(fs.existsSync(path.join(dir,'lock.json')),false);
  });
}
