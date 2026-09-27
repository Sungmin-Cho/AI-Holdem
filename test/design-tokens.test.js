import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Design system contract: every theme's semantic tokens meet WCAG contrast for
// the roles they are used in. Translucent tokens are composited over the
// surface they sit on before measuring, and no size exemption is taken.
const css = fs.readFileSync(new URL('../server/public/design-tokens.css', import.meta.url), 'utf8');

function block(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing block ${selector}`);
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const vars = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) vars[match[1]] = match[2].trim();
  return vars;
}
const base = block(':root');
const themes = {
  b: base,
  a: { ...base, ...block(':root[data-theme="a"]') },
  c: { ...base, ...block(':root[data-theme="c"]') },
};

function parseColor(value) {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return { rgb: [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)), a: 1 };
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(value);
  if (rgba) return { rgb: rgba.slice(1, 4).map(Number), a: Number(rgba[4]) };
  throw new Error(`not a plain colour: ${value}`);
}
const composite = (fg, bg) => ({ rgb: fg.rgb.map((c, i) => Math.round(fg.a * c + (1 - fg.a) * bg.rgb[i])), a: 1 });
const luminance = ({ rgb }) => {
  const [r, g, b] = rgb.map((c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

function color(theme, name) {
  const value = theme[name];
  assert.ok(value, `token ${name} missing`);
  return parseColor(value);
}
// Measure fg over bg, where bg may itself be translucent over `under`.
function contrast(theme, fg, bg, under) {
  let back = color(theme, bg);
  if (back.a < 1) back = composite(back, color(theme, under));
  let front = color(theme, fg);
  if (front.a < 1) front = composite(front, back);
  return ratio(front, back);
}

const SURFACES = ['--c-bg', '--c-surface-1', '--c-surface-2', '--c-surface-3'];
const CHECKS = [
  ...['--c-text', '--c-text-2', '--c-text-3', '--c-danger'].flatMap((fg) => SURFACES.map((bg) => [fg, bg, 4.5])),
  ...['--c-info-text', '--c-pos', '--c-neg'].flatMap((fg) => SURFACES.slice(0, 3).map((bg) => [fg, bg, 4.5])),
  ...['--c-action', '--c-action-hover', '--c-action-pressed'].map((bg) => ['--c-action-ink', bg, 4.5]),
  ['--c-on-info', '--c-info', 4.5],
  ...['--c-control-border', '--c-danger-border', '--c-focus'].flatMap((fg) => SURFACES.slice(1).map((bg) => [fg, bg, 3])),
  ['--c-focus-on-felt', '--c-felt-mid', 3],
  ['--c-plate-text', '--c-plate', 4.5, '--c-felt-mid'],
  ['--c-plate-text-2', '--c-plate', 4.5, '--c-felt-mid'],
  ['--c-pot-text', '--c-pot-bg', 4.5, '--c-felt-mid'],
  ...['--c-suit-s', '--c-suit-h', '--c-suit-d', '--c-suit-c'].map((fg) => [fg, '--c-card-face', 4.5]),
  ['--c-badge-d-ink', '--c-badge-d-bg', 4.5],
  ['--c-badge-sb-ink', '--c-badge-sb-bg', 4.5],
  ['--c-badge-bb-ink', '--c-badge-bb-bg', 4.5],
];

for (const [name, theme] of Object.entries(themes)) {
  test(`theme ${name}: semantic tokens meet their contrast floor`, () => {
    const failures = [];
    for (const [fg, bg, floor, under] of CHECKS) {
      const value = contrast(theme, fg, bg, under);
      if (value < floor) failures.push(`${fg} on ${bg}: ${value.toFixed(2)} < ${floor}`);
    }
    assert.deepEqual(failures, []);
  });
}

test('every theme defines the same semantic colour names', () => {
  const names = (vars) => Object.keys(vars).filter((key) => key.startsWith('--c-')).sort();
  const a = block(':root[data-theme="a"]'), c = block(':root[data-theme="c"]');
  // Themes override colours only; shadows may differ per theme.
  const colourNames = names(base);
  assert.deepEqual(names(a).filter((n) => colourNames.includes(n)).length, names(a).length);
  assert.deepEqual(names(c).filter((n) => colourNames.includes(n)).length, names(c).length);
  for (const theme of [a, c]) {
    const missing = colourNames.filter((n) => !Object.hasOwn(theme, n));
    assert.deepEqual(missing, [], 'theme blocks must restate every semantic colour');
  }
});

test('the two-colour deck override wins over any theme block', () => {
  const deck = css.indexOf(':root[data-deck="2"]');
  assert.ok(deck > css.indexOf(':root[data-theme="c"]'), 'deck override must follow the theme blocks');
});

test('design tokens stay ASCII and never load external resources', () => {
  assert.ok([...css].every((ch) => ch.charCodeAt(0) < 128));
  assert.doesNotMatch(css, /url\(|@import|https?:\/\//);
});
