import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeJsonAtomic } from '../engine/state.js';
import {
  canonicalPayloadJson,
  payloadSha256,
  proofBearingCoachNote,
} from '../publish-contract.js';
import { createCoachControl } from '../tools/coach-control.js';
import { startServer } from '../server/server.js';
import { createOwnedTempDir, registerOwnedProcess, registerOwnedServer } from './helpers/owned-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISH = path.join(ROOT, 'tools/publish.js');
const execFilePromise = promisify(execFile);

const FOUR_KEY_JSON = '{"handNo":1,"text":"무난한 폴드입니다.","overfold":false,"unavailable":false}';
const FOUR_KEY_SHA = 'a57a6c2a9d2e6a4d1191a88f257117f2c4b9094590cef7af25fe369471daf483';

const DECISION = {
  decisionId: 'd-1-preflop-0',
  why: '포지션이 불리해 폴드했다.',
  outcome: '상대가 폴드해서 작은 팟을 잃었다.',
  alternative: '콜을 검토할 만했다.',
};

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function expectedCanonical(note) {
  const payload = {
    handNo: note.handNo,
    text: note.text,
    overfold: Boolean(note.overfold),
    unavailable: Boolean(note.unavailable),
  };
  if (Array.isArray(note.decisions) && note.decisions.length > 0) {
    payload.decisions = note.decisions.map((row) => ({
      decisionId: row.decisionId,
      why: row.why,
      outcome: row.outcome,
      alternative: row.alternative,
    }));
  }
  return JSON.stringify(payload);
}

function tmpGame() {
  return createOwnedTempDir('holdem-coach-decisions');
}

function writeLock(dir, token = 'tok-coach-decisions') {
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid,
    port: 8877,
    sessionToken: token,
    startedAt: new Date().toISOString(),
  }));
  return token;
}

function setupControl(token = 'tok-coach-decisions') {
  const dir = tmpGame();
  writeLock(dir, token);
  const owner = '11111111-1111-4111-8111-111111111111';
  const cc = createCoachControl();
  const snapshotFile = path.join(dir, 'ui-snapshot.json');
  writeJsonAtomic(snapshotFile, { revision: 1, view: null, log: [], coach: [] });
  const statsFile = path.join(dir, 'stats.json');
  writeJsonAtomic(statsFile, { perPlayer: { user: { sample: 1, vpip: 0.2 } } });
  return { dir, owner, token, cc, snapshotFile, statsFile };
}

test('canonicalPayloadJson 부재·빈 배열은 현행 4키 JSON 바이트 동일(픽스처 sha)', () => {
  assert.equal(FOUR_KEY_JSON, JSON.stringify({
    handNo: 1, text: '무난한 폴드입니다.', overfold: false, unavailable: false,
  }));
  assert.equal(sha256Hex(FOUR_KEY_JSON), FOUR_KEY_SHA);
  assert.equal(canonicalPayloadJson({ handNo: 1, text: '무난한 폴드입니다.' }), FOUR_KEY_JSON);
  assert.equal(canonicalPayloadJson({
    handNo: 1, text: '무난한 폴드입니다.', overfold: false, unavailable: false,
  }), FOUR_KEY_JSON);
  assert.equal(canonicalPayloadJson({
    handNo: 1, text: '무난한 폴드입니다.', decisions: [],
  }), FOUR_KEY_JSON);
  assert.equal(payloadSha256({ handNo: 1, text: '무난한 폴드입니다.' }), FOUR_KEY_SHA);
  assert.equal(payloadSha256({
    handNo: 1, text: '무난한 폴드입니다.', decisions: [],
  }), FOUR_KEY_SHA);
});

test('canonicalPayloadJson은 비어 있지 않은 decisions를 키 순서 보존으로 추가한다', () => {
  const note = {
    handNo: 1,
    text: '무난한 폴드입니다.',
    decisions: [
      { alternative: 'ignored-order', why: DECISION.why, outcome: DECISION.outcome, decisionId: DECISION.decisionId },
      { ...DECISION, decisionId: 'd-1-flop-0' },
    ],
  };
  const json = canonicalPayloadJson(note);
  assert.equal(json, expectedCanonical({
    handNo: 1,
    text: '무난한 폴드입니다.',
    decisions: [
      {
        decisionId: DECISION.decisionId,
        why: DECISION.why,
        outcome: DECISION.outcome,
        alternative: 'ignored-order',
      },
      { ...DECISION, decisionId: 'd-1-flop-0' },
    ],
  }));
  assert.notEqual(json, FOUR_KEY_JSON);
  assert.equal(json.includes('"decisions":['), true);
  assert.equal(json.indexOf('"handNo"') < json.indexOf('"text"'), true);
  assert.equal(json.indexOf('"unavailable"') < json.indexOf('"decisions"'), true);
  const first = json.indexOf('"decisionId":"d-1-preflop-0"');
  const second = json.indexOf('"decisionId":"d-1-flop-0"');
  assert.equal(first >= 0 && second > first, true);
});

test('validateCoachDecisions는 문법·중복·길이·제어문자·referenceClaim을 거부한다', async () => {
  const { COACH_DECISION_LIMITS, validateCoachDecisions } = await import('../publish-contract.js');
  assert.equal(COACH_DECISION_LIMITS.entries, 12);
  assert.equal(COACH_DECISION_LIMITS.chars, 300);
  assert.equal(typeof validateCoachDecisions, 'function');
  assert.equal(validateCoachDecisions(undefined, 1), null);
  assert.equal(validateCoachDecisions([], 1), null);
  assert.equal(validateCoachDecisions([DECISION], 1), null);

  const rejects = [
    ['not-array', { why: 'x' }, 1],
    ['too-many', Array.from({ length: 13 }, (_, i) => ({ ...DECISION, decisionId: `d-1-preflop-${i}` })), 1],
    ['duplicate', [DECISION, { ...DECISION }], 1],
    ['missing-field', [{ decisionId: 'd-1-preflop-0', why: '왜', outcome: '결과' }], 1],
    ['empty-why', [{ ...DECISION, why: '   ' }], 1],
    ['non-string', [{ ...DECISION, outcome: 12 }], 1],
    ['too-long', [{ ...DECISION, alternative: '한'.repeat(301) }], 1],
    ['control', [{ ...DECISION, why: '왜\u0001폴드' }], 1],
    ['reference', [{ ...DECISION, outcome: 'GTO 정답입니다.' }], 1],
    ['extra-key', [{ ...DECISION, extra: 'nope' }], 1],
  ];
  for (const [label, decisions, handNo] of rejects) {
    assert.notEqual(validateCoachDecisions(decisions, handNo), null, label);
  }
});

test('4키 payload 리터럴이 tools·server·publish-contract 호출부에 없다', () => {
  const files = [
    'publish-contract.js',
    'tools/coach-control.js',
    'tools/publish.js',
    'server/server.js',
  ].map((rel) => path.join(ROOT, rel));
  const digestLiteral = /payloadSha256\(\s*\{[\s\S]*?overfold:[\s\S]*?unavailable:/;
  const tupleLiteral = /handNo:\s*note\.handNo,\s*text:\s*note\.text,\s*overfold:\s*note\.overfold === true,\s*unavailable:\s*note\.unavailable === true/;
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (digestLiteral.test(source)) offenders.push(`${path.relative(ROOT, file)} payloadSha256({4-key})`);
    if (tupleLiteral.test(source)) offenders.push(`${path.relative(ROOT, file)} tupleOf 4-key`);
  }
  assert.deepEqual(offenders, []);
});

test('세 지점(coach-control·publish.js·server)이 decisions 노트에 같은 sha를 낸다', async () => {
  const note = {
    handNo: 1,
    text: '결정 단위 피드백입니다.',
    decisions: [DECISION],
  };
  const expectedSha = sha256Hex(expectedCanonical(note));
  assert.equal(payloadSha256(note), expectedSha);

  const { dir, owner, token, cc, snapshotFile, statsFile } = setupControl();
  const srv = await startServer({ gameDir: dir, port: 0, token });
  registerOwnedServer(srv.server, 'coach-decisions');
  fs.writeFileSync(path.join(dir, 'lock.json'), JSON.stringify({
    serverPid: process.pid,
    port: srv.port,
    sessionToken: token,
    startedAt: new Date().toISOString(),
  }));
  try {
    const started = await cc.beginOwner({
      gameDir: dir, owner, completed: 1, statsFile, snapshotFile,
    });
    const desc = started.descriptors[0];
    fs.writeFileSync(desc.exactResultPath, `${JSON.stringify(note)}\n`);
    const accepted = await cc.accept({
      gameDir: dir, owner, handNo: 1, generation: desc.generation,
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const queued = cc.loadAuthority(dir).publishQueue['1'];
    assert.equal(queued.payloadSha256, expectedSha);
    const envelope = JSON.parse(fs.readFileSync(desc.exactEnvelopePath, 'utf8'));
    assert.deepEqual(envelope.coach[0].decisions, [DECISION]);
    assert.equal(envelope.coach[0].coachProof.payloadSha256, expectedSha);
    const proofNote = proofBearingCoachNote(note, envelope.coach[0].coachProof);
    assert.deepEqual(proofNote.decisions, [DECISION]);
    assert.equal(payloadSha256(envelope.coach[0]), expectedSha);

    const pending = execFilePromise(process.execPath, [
      PUBLISH, '--from', desc.exactEnvelopePath, '--game-dir', dir,
    ], { encoding: 'utf8', timeout: 20_000 });
    queueMicrotask(() => registerOwnedProcess(pending.child, 'node-cli'));
    const { stdout } = await pending;
    const published = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(published.ok, true, JSON.stringify(published));

    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'ui-snapshot.json'), 'utf8'));
    assert.equal(snap.coach[0].coachProof.payloadSha256, expectedSha);
    assert.deepEqual(snap.coach[0].decisions, [DECISION]);
  } finally {
    await srv.close();
  }
});
