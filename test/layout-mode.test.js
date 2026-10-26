import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COMPACT_QUERY, PHONE_LANDSCAPE_QUERY, PHONE_PORTRAIT_QUERY, compactLayout, onCompactChange } from '../server/public/layout-mode.js';

// table-mobile.css repeats the queries as literal @media strings; a drift would
// let the script and the stylesheet disagree about which layout is on screen.
test('the phone queries in layout-mode.js are the ones table-mobile.css uses', () => {
  const css = fs.readFileSync(new URL('../server/public/table-mobile.css', import.meta.url), 'utf8');
  const medias = [...css.matchAll(/@media ([^{]+)\{/g)].map((match) => match[1].trim());
  assert.ok(medias.includes(COMPACT_QUERY), 'the shared shell block');
  assert.ok(medias.includes(PHONE_PORTRAIT_QUERY), 'the upright block');
  assert.ok(medias.includes(PHONE_LANDSCAPE_QUERY), 'the sideways block');
  for (const query of medias.filter((query) => !/prefers-reduced-motion/.test(query))) {
    assert.ok([COMPACT_QUERY, PHONE_PORTRAIT_QUERY, PHONE_LANDSCAPE_QUERY].includes(query), `unexpected query: ${query}`);
  }
});

test('compactLayout is false without matchMedia and follows it when present', () => {
  assert.equal(compactLayout({}), false);
  assert.equal(compactLayout({ matchMedia: () => { throw new Error('blocked'); } }), false);
  const seen = [];
  const listeners = new Set();
  const list = { matches: true, addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) };
  const win = { matchMedia: (query) => { seen.push(query); return list; } };
  assert.equal(compactLayout(win), true);
  assert.deepEqual(seen, [COMPACT_QUERY]);
  const changes = [];
  const stop = onCompactChange((compact) => changes.push(compact), win);
  list.matches = false;
  for (const fn of listeners) fn();
  assert.deepEqual(changes, [false]);
  stop();
  assert.equal(listeners.size, 0);
  assert.doesNotThrow(() => onCompactChange(() => {}, {})());
});
