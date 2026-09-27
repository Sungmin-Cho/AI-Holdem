import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Page stylesheets take colours only from the semantic tokens in
// design-tokens.css, so the three themes (and a future one) apply everywhere.
const PAGE_CSS = [
  'server/public/ui-base.css',
  'server/public/table.css',
  'server/public/lobby.css',
  'server/public/join.css',
  'server/drill-public/drill.css',
];

function withoutComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('page stylesheets use semantic tokens: no legacy --ui-* names and no literal hex colours', () => {
  for (const file of PAGE_CSS) {
    const css = withoutComments(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(css.match(/--ui-[a-z-]+/g) ?? [], [], `${file} uses a legacy --ui-* token`);
    assert.deepEqual(css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], [], `${file} hard-codes a hex colour`);
  }
});

test('the token file defines no legacy aliases and every var() a page uses is defined', () => {
  const tokens = fs.readFileSync('server/public/design-tokens.css', 'utf8');
  assert.equal(/--ui-[a-z-]+\s*:/.test(tokens), false, 'legacy aliases were removed');
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  for (const file of PAGE_CSS) {
    const css = withoutComments(fs.readFileSync(file, 'utf8'));
    // Page-local custom properties (set in the same file or from script) are allowed.
    for (const [, name] of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) defined.add(name);
  }
  // Seat positions set from script (app.js, replayer.js, drill.js).
  const scriptSet = ['--x', '--y', '--seat-x', '--seat-y', '--seat-mx', '--seat-my', '--desktop-seat-x', '--desktop-seat-y'];
  for (const name of scriptSet) defined.add(name);
  const missing = [];
  for (const file of PAGE_CSS) {
    const css = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const [, name, fallback] of css.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)) {
      if (!defined.has(name) && !fallback) missing.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test('page stylesheets declare no text smaller than 12px', () => {
  const offenders = [];
  for (const file of PAGE_CSS) {
    const css = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const [decl] of css.matchAll(/font-size:\s*([0-9.]+)(px|rem|em)/g)) {
      const [, value, unit] = /font-size:\s*([0-9.]+)(px|rem|em)/.exec(decl);
      const px = unit === 'px' ? Number(value) : Number(value) * 16;
      if (px < 12) offenders.push(`${file}: ${decl}`);
    }
  }
  assert.deepEqual(offenders, [], 'A5: 12px minimum (rem/em counted at 16px)');
});

test('a computed font size keeps the 12px floor', () => {
  const offenders = [];
  for (const file of PAGE_CSS) {
    const css = withoutComments(fs.readFileSync(file, 'utf8'));
    for (const [decl] of css.matchAll(/font-size:\s*calc\([^;}]*/g)) offenders.push(`${file}: ${decl}`);
  }
  assert.deepEqual(offenders, [], 'wrap computed sizes as max(12px, calc(...))');
});
