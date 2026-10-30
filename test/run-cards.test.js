// issue 335: the run card list updates in place — the same element and button per run id, a rebuild only when the order
// changes, `disabled` and the gate line on a state change — and a click re-checks the gate when it happens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMiniDocument } from './helpers/mini-dom.js';
import { createRunCards } from '../server/drill-public/run-cards.js';

const card = (key, overrides = {}) => ({ key, kind: 'assessment', id: key, assessmentId: undefined, title: '새 문제 평가', rate: '60%', samples: '10 / 10문항',
  status: '완료', baseline: null, availableAt: null, canRetest: true, meta: '2026. 10. 9. 시작 · 기준표 v3.0.0', relation: null, badge: null, note: null, ...overrides });
const retest = (key, overrides = {}) => card(key, { kind: 'retest', title: '지연 재평가', assessmentId: 'a1', canRetest: false, relation: '이전 평가의 재평가', ...overrides });

function fixture(options = {}) {
  const doc = createMiniDocument();
  const box = doc.createElement('div');
  const gateBox = doc.createElement('p');
  const gate = { current: null };
  const started = [];
  let rebuilds = 0;
  const replace = box.replaceChildren.bind(box);
  box.replaceChildren = (...nodes) => { rebuilds += 1; replace(...nodes); };
  const view = createRunCards(doc, box, { gateBox, getGate: () => gate.current, onRetest: (picked) => started.push(picked.key), ...options });
  return { doc, box, gateBox, gate, started, view, rebuilds: () => rebuilds };
}
const texts = (root) => [...root.walk()].map((node) => node.textContent).join('|');

test('a card keeps its element and button across summaries; only the text changes', () => {
  const f = fixture();
  f.view.sync([card('a'), card('b')]);
  const [elementA, buttonA, buttonB] = [f.view.elementOf('a'), f.view.buttonOf('a'), f.view.buttonOf('b')];
  assert.ok(buttonA && buttonB && buttonA !== buttonB);
  assert.equal(f.rebuilds(), 1);
  f.view.sync([card('a', { rate: '80%', badge: '등록 기준 ①', note: '새 안내', canRetest: false }), card('b', { status: '미완료' })]);
  assert.equal(f.rebuilds(), 1, 'same order: no rebuild');
  assert.equal(f.view.elementOf('a'), elementA);
  assert.equal(f.view.buttonOf('a'), buttonA);
  assert.equal(f.view.buttonOf('b'), buttonB);
  assert.match(texts(elementA), /80%/);
  assert.match(texts(elementA), /등록 기준 ①/);
  assert.match(texts(elementA), /새 안내/);
  assert.equal(buttonA.disabled, true, 'canRetest false disables the button');
  assert.equal(buttonB.disabled, false);
  // The note and badge go away again without a new element.
  f.view.sync([card('a'), card('b')]);
  assert.equal(f.view.elementOf('a'), elementA);
  assert.equal(elementA.querySelector('.assessment-note').hidden, true);
  assert.equal(elementA.querySelector('.assessment-badge').hidden, true);
});

test('the list is rebuilt only when the order of run ids changes, and survivors keep their elements', () => {
  const f = fixture();
  f.view.sync([card('a'), card('b'), card('c')]);
  const [a, b, c] = ['a', 'b', 'c'].map((key) => [f.view.elementOf(key), f.view.buttonOf(key)]);
  assert.equal(f.rebuilds(), 1);
  f.view.sync([card('c'), card('a'), card('b')]);
  assert.equal(f.rebuilds(), 2);
  assert.deepEqual(f.view.keys, ['c', 'a', 'b']);
  assert.deepEqual(f.box.children, [c[0], a[0], b[0]], 'the box holds the same elements in the new order');
  for (const [key, [element, button]] of [['a', a], ['b', b], ['c', c]]) {
    assert.equal(f.view.elementOf(key), element); assert.equal(f.view.buttonOf(key), button);
  }
  f.view.sync([card('c'), card('a'), card('b')]);
  assert.equal(f.rebuilds(), 2);
  f.view.sync([card('d'), card('c'), card('a'), card('b')]);
  assert.equal(f.rebuilds(), 3);
  assert.equal(f.view.elementOf('c'), c[0]);
  f.view.sync([card('d'), card('a')]);
  assert.equal(f.rebuilds(), 4);
  assert.equal(f.view.elementOf('b'), null, 'a run that left the summary is dropped');
});

test('a state change touches disabled and the gate line only', () => {
  const f = fixture();
  f.view.sync([card('a'), retest('r')]);
  const rebuilds = f.rebuilds();
  const [element, button] = [f.view.elementOf('a'), f.view.buttonOf('a')];
  const before = texts(element);
  assert.equal(button.disabled, false);
  assert.equal(f.gateBox.textContent, '');
  f.gate.current = { code: 'BUSY', text: '요청을 확인하고 있습니다.' };
  f.view.refreshGate();
  assert.equal(button.disabled, true);
  assert.equal(f.gateBox.textContent, '요청을 확인하고 있습니다.');
  f.gate.current = { code: 'UNFINISHED', text: '진행 중인 연습이 있습니다. 끝낸 뒤 재평가할 수 있습니다.' };
  f.view.refreshGate();
  assert.equal(f.gateBox.textContent, '진행 중인 연습이 있습니다. 끝낸 뒤 재평가할 수 있습니다.');
  f.gate.current = null;
  f.view.refreshGate();
  assert.equal(button.disabled, false);
  assert.equal(f.gateBox.textContent, '');
  assert.equal(f.rebuilds(), rebuilds, 'no rebuild');
  assert.equal(f.view.buttonOf('a'), button);
  assert.equal(texts(element), before, 'no text changed');
  assert.equal(f.view.buttonOf('r'), null, 'a retest card has no button');
});

test('a summary rendered while a gate is up leaves the new button disabled', () => {
  const f = fixture();
  f.gate.current = { code: 'UNFINISHED', text: 'x' };
  f.view.sync([card('a')]);
  assert.equal(f.view.buttonOf('a').disabled, true);
  assert.equal(f.gateBox.textContent, 'x');
});

test('the click handler asks for the gate and the card again at click time', () => {
  const f = fixture();
  f.view.sync([card('a')]);
  const button = f.view.buttonOf('a');
  button.click();
  assert.deepEqual(f.started, ['a']);
  // The gate came up after the last render (another tab, a first click in flight) and nothing repainted yet.
  f.gate.current = { code: 'BUSY', text: 'busy' };
  assert.equal(button.disabled, false, 'the stale button is still enabled');
  button.click();
  assert.deepEqual(f.started, ['a'], 'the click handler itself refuses');
  // Even a click forced past a disabled button reaches the handler and is refused there.
  f.view.refreshGate();
  assert.equal(button.disabled, true);
  button.disabled = false; button.click();
  assert.deepEqual(f.started, ['a']);
  // A card that stopped being retestable is refused with the latest data, not the rendered one.
  f.gate.current = null;
  f.view.sync([card('a', { canRetest: false })]);
  button.disabled = false; button.click();
  assert.deepEqual(f.started, ['a']);
  f.view.sync([card('a', { canRetest: true })]);
  button.click();
  assert.deepEqual(f.started, ['a', 'a']);
});

test('an empty summary shows one explanation and a repeated duplicate id is ignored', () => {
  const f = fixture();
  f.view.sync([]);
  assert.match(f.box.textContent, /완료한 새 문제 평가가 없습니다/);
  const rebuilds = f.rebuilds();
  f.view.sync([]);
  assert.equal(f.rebuilds(), rebuilds);
  f.view.sync([card('a'), card('a', { title: '두 번째' })]);
  assert.deepEqual(f.view.keys, ['a']);
  assert.doesNotMatch(f.box.textContent, /두 번째/);
  assert.doesNotMatch(f.box.textContent, /없습니다/);
  f.view.sync([]);
  assert.match(f.box.textContent, /없습니다/);
});
