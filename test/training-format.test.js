import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTrainingCard, verifyTrainingDetail } from '../server/public/training-format.js';

import { toPublicSummary } from '../training/public-view.js';
import { createHash } from 'node:crypto';
import './helpers/owned-fixtures.mjs';

const CONTENT_SHA256 = '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf';

async function canonicalFixture(overrides) {
  const handNo = overrides.handNo ?? 1;
  const decisionId = `d-${handNo}-preflop-0`;
  const source = overrides.source ?? { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 };
  const detail = { schemaVersion: 1, forced: false, ...overrides, handNo, decisionId, source,
    evaluationId: `${'a'.repeat(64)}:${decisionId}:${source.id}@${source.version}` };
  const item = toPublicSummary(detail, { handNo,
    detailSha256: createHash('sha256').update(JSON.stringify(detail)).digest('hex') });
  const verifiedDetail = await verifyTrainingDetail(item, detail);
  assert.ok(verifiedDetail, 'canonical fixture must supply verified detail evidence');
  return { item: { ...item, explanation: overrides.explanation }, verifiedDetail };
}

async function canonicalFormat(overrides) {
  const { item, verifiedDetail } = await canonicalFixture(overrides);
  return formatTrainingCard(item, { verifiedDetail });
}

test('formatter: collapsed card, unsupported reason, forced is not a mistake', async () => {
  const supported = await canonicalFormat({
    handNo: 17,
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.04 },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96 }],
    grade: 'mixed',
    evLossBb: null,
    status: 'supported',
    forced: false,
    explanation: 'BTN에서 AJo는 오픈이 주력입니다.',
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
  });
  assert.match(supported.title, /핸드 17/);
  assert.match(supported.title, /AJo/);
  assert.match(supported.choice, /폴드/);
  assert.match(supported.recommendation, /레이즈/);
  assert.equal(supported.grade, 'mixed');
  assert.equal(supported.forced, false);

  const forced = formatTrainingCard({
    handNo: 2,
    handClass: '72o',
    chosen: { action: 'fold' },
    grade: 'off-policy',
    status: 'supported',
    forced: true,
  });
  assert.equal(forced.forced, true);
  assert.match(forced.note, /몰수/);

  const unsupported = formatTrainingCard({
    handNo: 3,
    status: 'unsupported',
    code: 'UNSUPPORTED_SPOT',
    reason: '6-max only',
    chosen: { action: 'raise' },
  });
  assert.equal(unsupported.grade, null);
  assert.match(unsupported.note, /지원되지/);

  const exploit = formatTrainingCard({
    handNo: 44,
    status: 'supported',
    grade: 'preferred',
    chosen: { action: 'raise' },
    exploit: {
      opponents: [{
        opponentId: 'villain-1',
        policyId: 'policy-1',
        adjustment: { bluff: 'decrease', thinValue: 'increase', defense: 'hold' },
        comparison: { summaryCode: 'GTO_CLOSE' },
      }],
      primary: 'villain-1',
    },
  });
  assert.match(exploit.exploit, /bluff decrease/);
  assert.match(exploit.exploit, /thin value increase/);
});

test('formatter merge by evaluationId+field displays unavailable and does not use payloadSha256 no-op for annotations', async () => {
  const { applyTrainingAnnotation, formatTrainingCard: format } = await import('../server/public/training-format.js');
  const item = {
    handNo: 17,
    evaluationId: 'eval-merge',
    payloadSha256: 'aa'.repeat(32),
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold' },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96 }],
    grade: 'mixed',
    status: 'supported',
  };
  const merged = applyTrainingAnnotation(item, {
    evaluationId: 'eval-merge',
    field: 'explanation',
    status: 'unavailable',
    value: null,
    payloadSha256: 'ff'.repeat(32),
  });
  const card = format(merged);
  assert.match(String(card.explanation), /unavailable/i);
});

test('SSE-style merge keeps the machine card and fills explanation later', async () => {
  const { applyTrainingAnnotation, formatTrainingCard: format } = await import('../server/public/training-format.js');
  const machine = {
    handNo: 17,
    evaluationId: 'eval-sse',
    payloadSha256: 'aa'.repeat(32),
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.04 },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.96 }],
    grade: 'mixed',
    status: 'supported',
  };
  const fixture = await canonicalFixture(machine);
  const ui = { training: [fixture.item], trainingAnnotations: [] };
  const options = { verifiedDetail: fixture.verifiedDetail };
  const firstCard = format(ui.training[0], options);
  assert.equal(firstCard.explanation, '');
  const ann = {
    evaluationId: fixture.item.evaluationId,
    field: 'explanation',
    status: 'ready',
    value: 'BTN에서 AJo는 0.96 빈도로 2.5bb 오픈이 주력입니다.',
    payloadSha256: 'ff'.repeat(32),
  };
  ui.trainingAnnotations.push(ann);
  ui.training[0] = applyTrainingAnnotation(ui.training[0], ann);
  assert.equal(ui.training[0].payloadSha256, fixture.item.payloadSha256);
  assert.equal(ui.training[0].handClass, 'AJo');
  const filled = format(ui.training[0], options);
  assert.match(filled.explanation, /0\.96/);
});

test('canonical cards use qualified reference wording without solver authority', async () => {
  const card = await canonicalFormat({
    handNo: 17,
    spotKey: '6max-100bb-btn-rfi-unopened',
    handClass: 'AJo',
    chosen: { action: 'fold', frequency: 0.2 },
    recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.8 }],
    grade: 'mixed',
    status: 'supported',
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
  });
  const raw = JSON.stringify(card);
  assert.match(card.recommendation, /기준표|참고/);
  assert.doesNotMatch(raw, /solver.?verified|검증된 GTO|포커 실수|EV 손실/i);
});

test('fake and spoofed sources expose no recommendation or process grade', () => {
  const rows = [
    { id: 'fake-solver', version: '1.0.0', contentSha256: 'aa'.repeat(32) },
    { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: 'ff'.repeat(32) },
  ];
  for (const source of rows) {
    const card = formatTrainingCard({
      handNo: 1,
      status: 'supported',
      grade: 'preferred',
      chosen: { action: 'raise' },
      recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 1 }],
      source,
    });
    assert.equal(card.recommendation, '');
    assert.equal(card.grade, null);
    assert.match(card.note, /미검증|테스트|출처/);
  }
});

test('unsupported solver-authority explanations are not displayed as feedback', async () => {
  const card = await canonicalFormat({
    handNo: 1,
    status: 'supported',
    grade: 'preferred',
    chosen: { action: 'raise' },
    recommended: [{ action: 'raise', frequency: 1 }],
    explanation: '이 선택은 검증된 GTO 정답이며 1.2bb EV 손실을 막습니다.',
    source: {
      id: 'local-preflop-baseline',
      version: '1.0.0',
      contentSha256: '7df129ed8503a3df45058a13a52e05b1f8db8d8dd029dd65c31d98c94a9e9eaf',
    },
  });
  assert.equal(card.explanation, '');
  assert.match(card.note, /근거|표현|제한/);
});

test('missing source digest and mixed negative-positive claims remain unavailable', () => {
  const legacy = formatTrainingCard({
    status: 'supported', grade: 'preferred', chosen: { action: 'raise' },
    recommended: [{ action: 'raise', frequency: 1 }],
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
  });
  assert.equal(legacy.grade, null);
  assert.equal(legacy.recommendation, '');
  const mixed = formatTrainingCard({
    status: 'supported', grade: 'preferred', chosen: { action: 'raise' },
    recommended: [{ action: 'raise', frequency: 1 }],
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
    explanation: '이 기준은 GTO 정답이 아닙니다. 하지만 다음 선택은 검증된 GTO 정답입니다.',
  });
  assert.equal(mixed.explanation, '');
});

test('authority claims require negation bound to the claim itself', async () => {
  const { referenceClaimAllowed } = await import('../shared/reference.js');
  const forbidden = [
    '검증된 GTO 정답이며 실수가 없습니다.',
    '잘못된 선택은 아니며 검증된 GTO 정답입니다.',
    '이것은 참고 기준이며 검증된 GTO 정답입니다.',
  ];
  for (const explanation of forbidden) {
    assert.equal(referenceClaimAllowed(explanation), false);
    const card = formatTrainingCard({
      status: 'supported', grade: 'preferred', chosen: { action: 'raise' },
      recommended: [{ action: 'raise', frequency: 1 }],
      source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
      explanation,
    });
    assert.equal(card.explanation, '');
  }
  for (const caveat of [
    '이 참고 기준은 검증된 GTO 정답이 아닙니다.',
    'EV 손실을 검증한 것이 아닙니다.',
    'solver-verified 결과가 아닙니다.',
  ]) assert.equal(referenceClaimAllowed(caveat), true);
});

test('S2 separately verified detail restores canonical cards without mutating compact summaries', async () => {
  const { verifyTrainingDetail } = await import('../server/public/training-format.js');
  assert.equal(typeof verifyTrainingDetail, 'function', 'formatter needs an identity-bound detail path');
  const { toPublicSummary } = await import('../training/public-view.js');
  const { createHash } = await import('node:crypto');
  const evaluation = {
    schemaVersion: 1,
    evaluationId: `${'a'.repeat(64)}:d-1-preflop-0:local-preflop-baseline@1.0.0`,
    decisionId: 'd-1-preflop-0', handNo: 1, status: 'supported', grade: 'mixed',
    street: 'preflop', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo', forced: false,
    chosen: { action: 'fold', frequency: 0.2 }, recommended: [{ action: 'raise', sizeBb: 2.5, frequency: 0.8 }],
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
  };
  const digest = createHash('sha256').update(JSON.stringify(evaluation)).digest('hex');
  const item = toPublicSummary(evaluation, { handNo: 1, detailSha256: digest });
  const bytes = JSON.stringify(item);
  const verifiedDetail = await verifyTrainingDetail(item, evaluation);
  assert.ok(verifiedDetail);
  const card = formatTrainingCard({ ...item, explanation: '레이즈가 주력입니다.' }, { verifiedDetail });
  assert.match(card.recommendation, /80%/);
  assert.equal(card.explanation, '레이즈가 주력입니다.');
  assert.equal(JSON.stringify(item), bytes);
  assert.equal(await verifyTrainingDetail(item, { ...evaluation, grade: 'preferred' }), null);
  assert.equal(formatTrainingCard(item, { verifiedDetail: { source: evaluation.source } }).recommendation, '');
  assert.equal(formatTrainingCard({ ...item, payloadSha256: 'b'.repeat(64) }, { verifiedDetail }).recommendation, '');
  assert.equal(formatTrainingCard({ ...item, source: evaluation.source }).recommendation, '');
});

test('S2 detail verification rejects a summary identity changed while hashing', async () => {
  const { item } = await canonicalFixture({ handNo: 1, status: 'supported', grade: 'mixed',
    chosen: { action: 'fold', frequency: 0.2 }, recommended: [{ action: 'raise', frequency: 0.8 }] });
  const detail = { schemaVersion: 1, forced: false, handNo: 1, status: 'supported', grade: 'mixed',
    chosen: { action: 'fold', frequency: 0.2 }, recommended: [{ action: 'raise', frequency: 0.8 }],
    decisionId: item.decisionId,
    source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 },
    evaluationId: item.evaluationId };
  assert.equal(createHash('sha256').update(JSON.stringify(detail)).digest('hex'), item.detailSha256);
  const pending = verifyTrainingDetail(item, detail);
  item.handNo = 2;
  assert.equal(await pending, null, 'a receipt must stay bound to the initially verified summary');
});

test('formatter exposes source classification without upgrading synthetic or unverified detail', async () => {
  const synthetic = await canonicalFormat({ status: 'supported', handClass: 'AJo', spotKey: '6max-100bb-btn-rfi-unopened', source: { id: 'fake-solver', version: '9.9.9', contentSha256: 'f'.repeat(64) } });
  assert.equal(synthetic.sourceQuality, 'synthetic', 'a verified digest does not turn a synthetic provider into heuristic evidence');
  assert.match(synthetic.sourceLabel, /테스트용 합성/); assert.doesNotMatch(synthetic.sourceLabel, /휴리스틱/);
  assert.equal(synthetic.practiceTarget, null);
  const unverified = formatTrainingCard({ status: 'supported', handClass: 'AJo', spotKey: '6max-100bb-btn-rfi-unopened', source: { id: 'local-preflop-baseline', version: '1.0.0', contentSha256: CONTENT_SHA256 } });
  assert.equal(unverified.sourceQuality, 'unverified'); assert.equal(unverified.practiceTarget, null);
  assert.doesNotMatch(unverified.sourceLabel, /휴리스틱/);
});

test('specific practice target comes only from supported identity-bound detail and leaves compact bytes unchanged', async () => {
  const fixture = await canonicalFixture({ status: 'supported', handClass: 'AJo', spotKey: '6max-100bb-btn-rfi-unopened', street: 'preflop' });
  const before = JSON.stringify(fixture.item);
  const compact = formatTrainingCard(fixture.item);
  assert.equal(compact.practiceTarget, null);
  const card = formatTrainingCard(fixture.item, { verifiedDetail: fixture.verifiedDetail });
  assert.equal(card.sourceQuality, 'heuristic-reference'); assert.match(card.sourceLabel, /휴리스틱 참고 자료/);
  assert.deepEqual(card.practiceTarget, { spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo' });
  assert.equal(JSON.stringify(fixture.item), before);
  for (const overrides of [{ status: 'unsupported' }, { street: 'river' }, { forced: true }, { spotKey: 'postflop-river-heads-up' }, { handClass: 'JAs' }]) {
    const other = await canonicalFormat({ status: 'supported', handClass: 'AJo', spotKey: '6max-100bb-btn-rfi-unopened', street: 'preflop', ...overrides });
    assert.equal(other.practiceTarget, null, JSON.stringify(overrides));
  }
});

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { studyLink } from '../server/public/table-controls.js';

// A small DOM boundary double executes the actual renderer; it does not replace
// its source formatter or navigation decision with test implementations.
function renderTrainingCards(items, receipts = new Map()) {
  class Node {
    constructor(tag, className = '', text = '') {
      this.tag = tag; this.className = className; this.text = text; this.children = [];
      this.dataset = {}; this.scrollTop = 0; this.open = false;
      this.classList = { toggle() {} };
    }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    addEventListener() {}
    contains() { return false; }
    remove() { this.parent.children = this.parent.children.filter((child) => child !== this); }
    querySelectorAll(selector) {
      const matches = (node) => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
        : selector === '[data-evaluation-id]' ? Boolean(node.dataset.evaluationId) : node.tag === selector;
      return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const list = new Node('div'); const panel = new Node('div');
  const src = readFileSync(new URL('../server/public/app.js', import.meta.url), 'utf8');
  const functionSource = src.slice(src.indexOf('function paintTraining()'), src.indexOf('function paintReview('));
  runInNewContext(`${functionSource}; paintTraining();`, {
    ui: { training: items }, document: { activeElement: null },
    $: (id) => id === 'training-list' ? list : panel,
    el: (tag, cls, text) => new Node(tag, cls, text),
    detailKey: (item) => `${item.evaluationId}:${item.detailSha256}`,
    detailCache: receipts, detailErrors: new Set(),
    formatTrainingCard, studyLink,
    authenticatedStudyUrl: `http://127.0.0.1:1234/#token=${'a'.repeat(64)}`,
    loadTrainingDetail: () => { throw new Error('closed cards should not load detail'); },
  });
  return list;
}

test('training DOM renders synthetic source caveat and only a generic study link', () => {
  const item = { evaluationId: 'synthetic-display', source: { id: 'fake-solver', version: '9.9.9' }, status: 'supported', spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo' };
  const dom = renderTrainingCards([item]);
  const source = dom.querySelector('.training-source').text;
  assert.match(source, /fake-solver@9.9.9.*테스트용 합성/);
  assert.doesNotMatch(source, /휴리스틱/);
  const link = dom.querySelector('a');
  assert.equal(new URL(link.href).search, ''); assert.match(link.text, /지원 상황/);
});

test('training DOM routes a verified supported practice target without altering compact summaries', async () => {
  const fixture = await canonicalFixture({ status: 'supported', handClass: 'AJo', spotKey: '6max-100bb-btn-rfi-unopened', street: 'preflop' });
  const before = JSON.stringify(fixture.item);
  const cache = new Map([[`${fixture.item.evaluationId}:${fixture.item.detailSha256}`, fixture.verifiedDetail]]);
  const dom = renderTrainingCards([fixture.item], cache);
  assert.match(dom.querySelector('.training-source').text, /휴리스틱 참고 자료/);
  const href = new URL(dom.querySelector('a').href);
  assert.equal(href.searchParams.get('spotKey'), '6max-100bb-btn-rfi-unopened'); assert.equal(href.searchParams.get('handClass'), 'AJo');
  assert.equal(JSON.stringify(fixture.item), before);
});
