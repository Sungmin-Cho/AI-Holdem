import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUITS, parseCard, cardLabel, renderCard, renderMiniCard, handClassParts } from '../server/public/card-render.js';

// Minimal DOM double: enough surface for the renderer, nothing more.
function fakeDoc() {
  const make = (tag) => {
    const node = {
      tag, className: '', textContent: '', attrs: {}, children: [],
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return this.attrs[key] ?? null; },
      append(...items) { this.children.push(...items); },
    };
    return node;
  };
  return { createElement: make, createElementNS: (_ns, tag) => make(tag), createTextNode: (text) => ({ tag: '#text', textContent: text }) };
}
const doc = fakeDoc();

test('parseCard accepts engine codes and rejects anything else', () => {
  assert.deepEqual(parseCard('Ks'), { valid: true, rank: 'K', suit: SUITS.s, red: false });
  assert.equal(parseCard('Td').rank, '10');
  assert.equal(parseCard('Td').red, true);
  for (const bad of [null, '', 'K', 'Kx', '1s', 'Kss', 12]) assert.equal(parseCard(bad).valid, false, String(bad));
});

test('accessible labels keep the previous "rank suit" wording', () => {
  assert.equal(cardLabel(parseCard('Ah')), 'A 하트');
  assert.equal(cardLabel(parseCard('Tc')), '10 클럽');
});

test('face cards carry role=img, a label, the suit class and inline glyphs', () => {
  const node = renderCard('Qd', { doc });
  assert.equal(node.className, 'card suit-d is-red');
  assert.equal(node.getAttribute('role'), 'img');
  assert.equal(node.getAttribute('aria-label'), 'Q 다이아몬드');
  assert.equal(node.children.length, 3);
  assert.equal(node.children[0].className, 'card-rank');
  assert.equal(node.children[1].attrs.class, 'card-suit');
  assert.equal(node.children[2].attrs.class, 'card-pip');
  assert.equal(node.children[1].children[0].attrs.d, SUITS.d.path);
});

test('ten uses the narrow rank class; size flags map to the table classes', () => {
  assert.equal(renderCard('Ts', { doc }).children[0].className, 'card-rank is-ten');
  assert.equal(renderCard('As', { doc, small: true }).className, 'card card--sm suit-s');
  assert.equal(renderCard('As', { doc, hero: true }).className, 'card card--hero suit-s');
});

test('face-down, missing and invalid codes never guess a face', () => {
  for (const code of ['Kh', null, 'bad']) {
    const node = renderCard(code, { doc, faceDown: code === 'Kh' });
    assert.match(node.className, /card--back/);
    assert.equal(node.getAttribute('role'), null);
    assert.equal(node.children.length, 0);
  }
  assert.equal(renderCard(null, { doc, slot: true }).className, 'card card--slot');
});

test('mini cards label the rank and suit', () => {
  const node = renderMiniCard('9c', { doc });
  assert.equal(node.className, 'mini-card suit-c');
  assert.equal(node.getAttribute('aria-label'), '9 클럽');
  assert.equal(node.children[0].textContent, '9');
});

test('hand classes describe suitedness without inventing suits', () => {
  assert.deepEqual(handClassParts('ATo'), { ranks: ['A', '10'], kind: 'offsuit', label: '다른 무늬' });
  assert.deepEqual(handClassParts('KJs'), { ranks: ['K', 'J'], kind: 'suited', label: '같은 무늬' });
  assert.deepEqual(handClassParts('QQ'), { ranks: ['Q', 'Q'], kind: 'pair', label: '페어' });
  assert.equal(handClassParts('AXo'), null);
});
