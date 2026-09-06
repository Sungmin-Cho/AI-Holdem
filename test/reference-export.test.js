import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectReferenceEvaluation, loadReferenceEvaluations } from '../export/hand-normalizer.js';

test('REQ-002: export qualifies canonical reference without rewriting source bytes', async () => {
  const { dir, item } = await sealedExportFixture();
  const evaluation = loadReferenceEvaluations(dir)[1][0];
  const before = JSON.stringify(evaluation);
  const projected = projectReferenceEvaluation(evaluation);
  assert.equal(JSON.stringify(evaluation), before);
  assert.equal(projected.sourcePayloadSha256, item.payloadSha256);
  assert.equal(projected.referenceQuality, 'heuristic-reference');
  assert.equal(projected.payloadSha256, undefined);
});

import { CANONICAL_REFERENCE_SOURCE, referenceClaimAllowed } from '../shared/reference.js';
import { formatTrainingCard } from '../server/public/training-format.js';
import './helpers/owned-fixtures.mjs';

test('spoofed and synthetic sources cannot export recommendations or grades', () => {
  for (const source of [
    { ...CANONICAL_REFERENCE_SOURCE, version: '1.0.1' },
    { id: 'fake-solver', version: '1.0.0', contentSha256: 'f'.repeat(64) },
  ]) {
    const projected = projectReferenceEvaluation({
      payloadSha256: 'b'.repeat(64), status: 'supported', grade: 'preferred', source,
      chosen: { action: 'call' }, recommended: [{ action: 'raise' }],
    });
    assert.equal(projected.recommended, undefined);
    assert.equal(projected.grade, undefined);
    assert.deepEqual(projected.chosen, { action: 'call' });
  }
});

test('export never infers a missing source payload hash', () => {
  const projected = projectReferenceEvaluation({
    status: 'supported', source: CANONICAL_REFERENCE_SOURCE,
  });
  assert.equal(projected.sourcePayloadSha256, undefined);
});

test('authority claim validation resists invisible separators and mixed caveat claims', () => {
  assert.equal(referenceClaimAllowed('GTO 정답이 아닙니다.'), true);
  assert.equal(referenceClaimAllowed('solver-verified 결과가 아닙니다.'), true);
  assert.equal(referenceClaimAllowed('GTO\u200B 정답입니다.'), false);
  assert.equal(referenceClaimAllowed('EV 손실이 큽니다. GTO 정답은 아닙니다.'), false);
  assert.equal(referenceClaimAllowed('not a verified GTO answer'), true);
});

test('legacy display drops invalid explanation and unqualified reference labels', () => {
  const card = formatTrainingCard({
    handNo: 1,
    status: 'supported',
    grade: 'preferred',
    source: { ...CANONICAL_REFERENCE_SOURCE, contentSha256: '0'.repeat(64) },
    chosen: { action: 'call' },
    recommended: [{ action: 'raise', frequency: 0.8 }],
    explanation: '검증된 GTO 정답입니다.',
  });
  assert.equal(card.recommendation, '');
  assert.equal(card.grade, null);
  assert.equal(card.explanation, '');
  assert.match(card.note, /출처 식별값/);
});

test('S2 contracted authority claims and compound negation cannot bypass the guard', () => {
  for (const claim of [
    '검증된 최적입니다.', '확정 누수입니다.', '이 상황의 정답은 콜입니다.',
    'EV 3bb 이득입니다.', '이 선택은 +3bb EV입니다.',
    'GTO 정답이며 틀린 선택이 아닙니다.',
    '검증된 최적이며 나쁜 선택은 아닙니다.',
    'not a verified GTO answer but a verified optimum',
    'EV 손실은 3bb이지만 검증된 수치는 아닙니다.',
  ]) assert.equal(referenceClaimAllowed(claim), false, claim);
  for (const caveat of [
    '검증된 최적이 아닙니다.', '확정 누수가 아닙니다.', '정답으로 단정할 수 없습니다.',
    'EV 수치는 제공하지 않습니다.', 'EV 손실을 검증한 것이 아닙니다.',
    'not a verified GTO answer', 'GTO 정답이 아니며 참고용입니다.',
  ]) assert.equal(referenceClaimAllowed(caveat), true, caveat);
});

test('S2 equivalent optimum and solver certification claims cannot cross qualified feedback sinks', async () => {
  const { verifyTrainingDetail } = await import('../server/public/training-format.js');
  const { validateExplanation } = await import('../training/explain.js');
  const { dir, item, evaluation } = await sealedExportFixture();
  const detail = JSON.parse(fs.readFileSync(path.join(dir, 'training', 'details', `${item.detailRef}.json`)));
  const summary = item.summary;
  const verifiedDetail = await verifyTrainingDetail(summary, detail);
  assert.ok(verifiedDetail);
  for (const claim of [
    '이 선택은 GTO 최적 플레이입니다.', '이 선택은 최적입니다.',
    'This is GTO-optimal play.', 'This is the optimal choice.',
    'This move is solver certified.', 'This is a solver-proven result.',
    '이것이 GTO 전략입니다.', 'This is a GTO strategy.',
    'GTO 해법입니다.', 'This is GTO play.', 'GTO 정책입니다.',
    'GTO 기반 전략입니다.', 'This is a GTO-based strategy.',
  ]) {
    assert.equal(referenceClaimAllowed(claim), false, claim);
    assert.equal(validateExplanation(evaluation, claim).ok, false, claim);
    assert.equal(formatTrainingCard({ ...summary, explanation: claim }, { verifiedDetail }).explanation, '', claim);
  }
  for (const caveat of [
    '최적 플레이가 아닙니다.', '최적이라고 단정할 수 없습니다.',
    'This is not the optimal choice.', 'This move is not solver certified.',
    'GTO-optimal play is not verified.',
    'GTO 전략이 아닙니다.', 'This is not a GTO strategy.',
    'GTO 해법이 아닙니다.', 'This is not GTO play.',
    'GTO 기반 전략이 아닙니다.', 'GTO 기반의 전략이 아닙니다.',
    'GTO-based strategy is not verified.', '검증된 GTO 기반 전략이 아닙니다.',
    'This is not a verified GTO-based strategy.',
  ]) assert.equal(referenceClaimAllowed(caveat), true, caveat);
  assert.equal(referenceClaimAllowed('이번 핸드의 실제 결과는 3bb 손실입니다.'), true);
});

test('S2 fake and absent source strategy text is excluded from formatter and export', () => {
  for (const source of [undefined, { id: 'fake-solver', version: '1.0.0', contentSha256: 'f'.repeat(64) }]) {
    const row = { handNo: 1, status: 'supported', source, explanation: '레이즈가 주력입니다.' };
    assert.equal(formatTrainingCard(row).explanation, '');
    assert.equal(projectReferenceEvaluation(row).explanation, undefined);
  }
});

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTrainingControl } from '../tools/training-control.js';
import { evaluationIdOf } from '../training/contracts.js';
import { gameEpochOf } from '../publish-contract.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { HANDS } from './fixtures/hand-history/hands.js';

async function sealedExportFixture() {
  const dir = createOwnedTempDir('s2-export-source');
  const outputDir = createOwnedTempDir('s2-export-output');
  const epoch = gameEpochOf('s2-export-token');
  const decisionId = 'd-1-preflop-0';
  const evaluation = {
    schemaVersion: 1, handNo: 1, decisionId,
    evaluationId: evaluationIdOf({ gameEpoch: epoch, decisionId,
      providerId: CANONICAL_REFERENCE_SOURCE.id, providerVersion: CANONICAL_REFERENCE_SOURCE.version }),
    status: 'supported', street: 'preflop', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.2, evBb: null },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.8, evBb: null }],
    bestEvBb: null, evLossBb: null, grade: 'mixed', forced: false, source: CANONICAL_REFERENCE_SOURCE,
  };
  fs.mkdirSync(path.join(dir, 'hands'));
  const hand = { ...structuredClone(HANDS[0].record), handNo: 1 };
  fs.writeFileSync(path.join(dir, 'hands', 'hand-0001.json'), JSON.stringify(hand));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ gameEpoch: epoch, sessionToken: 's2-export-token', config: { mode: 'cash-training' } }));
  const tc = createTrainingControl();
  await tc.acceptEvaluations(dir, { gameEpoch: epoch, owner: 'export-owner', handNo: 1, evaluations: [evaluation] });
  const item = tc.loadAuthority(dir).items[evaluation.evaluationId];
  return { dir, outputDir, item, evaluation };
}

function exportSourceSnapshot(dir) {
  const rows = [];
  const visit = (root) => {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      const st = fs.lstatSync(file);
      rows.push([path.relative(dir, file), st.mode, st.mtimeMs,
        entry.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]);
      if (entry.isDirectory()) visit(file);
    }
  };
  visit(dir);
  return rows;
}

function runExportFixture(dir, out) {
  const cli = fileURLToPath(new URL('../tools/export-hh.js', import.meta.url));
  const args = [cli, '--game-dir', dir, '--out', out, '--format', 'canonical-json'];
  try {
    return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8', timeout: 10_000 }));
  } catch (error) {
    if (!error.stdout) throw error;
    return JSON.parse(error.stdout);
  }
}

test('S2 real export CLI materializes sealed authority details with no source writes', async () => {
  const { dir, outputDir, item } = await sealedExportFixture();
  const before = exportSourceSnapshot(dir);
  const out = path.join(outputDir, 'session.json');
  assert.equal(runExportFixture(dir, out).ok, true);
  assert.deepEqual(exportSourceSnapshot(dir), before);
  const evaluations = JSON.parse(fs.readFileSync(out)).hands[0].evaluations;
  assert.equal(evaluations.length, 1, 'real export must load the accepted learning evaluation');
  assert.equal(evaluations[0].referenceQuality, 'heuristic-reference');
  assert.equal(evaluations[0].sourcePayloadSha256, item.payloadSha256);
  assert.equal(evaluations[0].recommended[0].frequency, 0.8);
});

test('S2 declared corrupt or missing export detail fails before output publication', async () => {
  for (const corruption of ['mutated', 'missing', 'symlink']) {
    const { dir, outputDir, item } = await sealedExportFixture();
    const detail = path.join(dir, 'training', 'details', `${item.detailRef}.json`);
    if (corruption === 'mutated') fs.appendFileSync(detail, ' ');
    else {
      fs.unlinkSync(detail);
      if (corruption === 'symlink') fs.symlinkSync(path.join(dir, 'state.json'), detail);
    }
    const before = exportSourceSnapshot(dir);
    const out = path.join(outputDir, 'session.json');
    const result = runExportFixture(dir, out);
    assert.equal(result.ok, false, corruption);
    assert.match(result.code, /^LEARNING_DETAIL_/);
    assert.equal(fs.existsSync(out), false);
    assert.deepEqual(exportSourceSnapshot(dir), before);
  }
});

test('S2 unbound rows and raw JSONL cannot claim a source receipt or verified transport', async () => {
  const raw = { status: 'supported', source: CANONICAL_REFERENCE_SOURCE,
    recommended: [{ action: 'raise', frequency: 1 }], grade: 'preferred', payloadSha256: 'not-a-digest' };
  const projected = projectReferenceEvaluation(raw);
  assert.equal(projected.sourcePayloadSha256, undefined);
  assert.equal(projected.referenceQuality, 'unverified');
  assert.equal(projected.recommended, undefined);
  assert.equal(projectReferenceEvaluation({ ...raw, payloadSha256: 'a'.repeat(64) }).sourcePayloadSha256, undefined);
  const { dir, outputDir } = await sealedExportFixture();
  fs.unlinkSync(path.join(dir, 'training', '.training-authority.json'));
  fs.writeFileSync(path.join(dir, 'training', 'evaluations.jsonl'), JSON.stringify(raw) + '\n');
  const before = exportSourceSnapshot(dir);
  const out = path.join(outputDir, 'session.json');
  assert.equal(runExportFixture(dir, out).ok, true);
  const evaluations = JSON.parse(fs.readFileSync(out)).hands[0].evaluations;
  assert.equal(evaluations.length, 1);
  assert.equal(evaluations[0].referenceQuality, 'unverified');
  assert.equal(evaluations[0].status, 'unavailable');
  assert.equal(evaluations[0].recommended, undefined);
  assert.deepEqual(exportSourceSnapshot(dir), before);
});

test('S2 export receipts cannot be copied or survive nested value mutation', async () => {
  const { dir } = await sealedExportFixture();
  const value = loadReferenceEvaluations(dir)[1][0];
  assert.equal(projectReferenceEvaluation(value).referenceQuality, 'heuristic-reference');
  assert.equal(projectReferenceEvaluation(structuredClone(value)).referenceQuality, 'unverified');
  value.recommended[0].frequency = 1;
  const changed = projectReferenceEvaluation(value);
  assert.equal(changed.referenceQuality, 'unverified');
  assert.equal(changed.sourcePayloadSha256, undefined);
  assert.equal(changed.grade, undefined);
});

test('S2 explicit source limitations remain usable while unrelated and double negation fail', () => {
  for (const caveat of [
    '확정 누수는 없습니다.', '정답으로 볼 수 없습니다.',
    'EV 손실은 제공되지 않습니다.', 'EV는 계산하지 않았습니다.',
    'There is no verified GTO answer.', 'EV is unavailable.',
  ]) assert.equal(referenceClaimAllowed(caveat), true, caveat);
  for (const claim of [
    '검증된 최적이 아니라고 할 수는 없습니다.',
    '정답이 아닌 것은 아닙니다.',
    'solver-verified 결과이며 잘못된 선택은 아닙니다.',
  ]) assert.equal(referenceClaimAllowed(claim), false, claim);
});

test('S2 explicit predicate caveats and spelled-out EV claims retain truthful authority', () => {
  for (const caveat of ['검증된 최적이라고 단정할 수 없습니다.', '정답이라는 근거는 없습니다.', 'EV는 계산할 수 없다.']) {
    assert.equal(referenceClaimAllowed(caveat), true, caveat);
  }
  for (const claim of ['기대값 3bb 이득입니다.', 'Expected value is +3 big blinds.']) {
    assert.equal(referenceClaimAllowed(claim), false, claim);
  }
});
