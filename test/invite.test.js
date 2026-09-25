import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderQr, copyText } from '../server/public/invite.js';
import { qrcode } from '../server/public/vendor-qrcode.js';

function fakeDoc() {
  const make = (tag) => ({
    tag, attrs: {}, children: [],
    setAttribute(key, value) { this.attrs[key] = String(value); },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = [...items]; },
  });
  return { createElementNS: (_ns, tag) => make(tag), container: make('div') };
}

test('renderQr draws the encoder modules as one SVG path with a quiet zone', () => {
  const doc = fakeDoc();
  const link = 'http://192.168.0.12:8899/join?code=NU49-DVZY';
  assert.equal(renderQr(doc.container, link, { doc }), true);
  const [svg] = doc.container.children;
  assert.equal(svg.tag, 'svg');
  assert.equal(svg.attrs.role, 'img');
  const reference = qrcode(0, 'M');
  reference.addData(link);
  reference.make();
  const count = reference.getModuleCount();
  assert.equal(svg.attrs.viewBox, `0 0 ${count + 4} ${count + 4}`);
  const [, path] = svg.children;
  let dark = 0;
  for (let r = 0; r < count; r += 1) for (let c = 0; c < count; c += 1) if (reference.isDark(r, c)) dark += 1;
  assert.equal((path.attrs.d.match(/M/g) ?? []).length, dark);
  assert.match(path.attrs.d, /^M\d+ \d+h1v1h-1z/);
});

test('renderQr empties the container for missing input', () => {
  const doc = fakeDoc();
  doc.container.children = ['stale'];
  assert.equal(renderQr(doc.container, '', { doc }), false);
  assert.deepEqual(doc.container.children, []);
});

test('copyText uses the clipboard and falls back to a selected field', async () => {
  const written = [];
  assert.equal(await copyText('link', { nav: { clipboard: { writeText: async (text) => { written.push(text); } } } }), 'copied');
  assert.deepEqual(written, ['link']);
  const field = { value: '', hidden: true, selected: false, focus() {}, select() { this.selected = true; } };
  const denied = { clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } } };
  assert.equal(await copyText('link', { nav: denied, fallback: field }), 'selected');
  assert.deepEqual([field.value, field.hidden, field.selected], ['link', false, true]);
  assert.equal(await copyText('link', { nav: {} }), 'failed');
});
