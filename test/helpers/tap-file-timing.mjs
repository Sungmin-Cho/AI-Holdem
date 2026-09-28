// Map flat TAP output (node --test, files run one at a time) back to files by test name,
// then report per-file wall time from the log timestamps.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// node --test's TAP reporter escapes names (tapEscape in lib/internal/test_runner/reporter/tap.js):
// a tab becomes backslash-t and so on, then every backslash is doubled and `#` gains a backslash.
// Source names are decoded as JS strings and re-encoded the same way, so they compare against the
// TAP text exactly — a name like `#196 …` arrives as backslash-`#196 …` (#212).
export function tapEscape(name) {
  let out = name;
  for (const [ch, esc] of [['\b', '\\b'], ['\f', '\\f'], ['\t', '\\t'], ['\n', '\\n'], ['\r', '\\r'], ['\v', '\\v']]) {
    out = out.replaceAll(ch, esc);
  }
  return out.replaceAll('\\', '\\\\').replaceAll('#', '\\#');
}

// Inverse for display only: failure names are printed the way the source spells them.
export function tapUnescape(name) {
  return name.replace(/\\([\\#])/g, '$1');
}

const JS_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
function decodeJsString(raw) {
  return raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|[\s\S])/g, (_, e) => {
    if (e[0] === 'u' && e[1] === '{') return String.fromCodePoint(parseInt(e.slice(2, -1), 16));
    if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === '\n' || e === '\r\n') return ''; // line continuation
    return JS_ESCAPES[e] ?? e;
  });
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const EXACT = 1e6;

// One matcher per source test name. `score` ranks how much of the TAP name the source pins down:
// an exact literal beats any template, and a template scores by its literal characters, so
// `${phase}-${gameOver}` (one literal `-`) no longer outbids a literal name in another file.
function matcher(raw, template) {
  if (!template) {
    const text = tapEscape(decodeJsString(raw));
    return { test: (name) => name === text, score: EXACT + text.length };
  }
  const parts = raw.split(/(?<!\\)\$\{[^}]*\}/).map((part) => tapEscape(decodeJsString(part)));
  const re = new RegExp('^' + parts.map(escapeRe).join('[\\s\\S]*') + '$');
  return { test: (name) => re.test(name), score: parts.join('').length };
}

function main(argv = process.argv.slice(2)) {
const [logPath, testDir] = argv;
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
const nameRe = /\b(?:test|it)\s*\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
const patterns = new Map();
for (const f of files) {
  const src = fs.readFileSync(path.join(testDir, f), 'utf8');
  const list = [];
  for (const m of src.matchAll(nameRe)) {
    list.push(m[3] !== undefined ? matcher(m[3], true) : matcher(m[1] ?? m[2], false));
  }
  patterns.set(f, list);
}
// Best score a file reaches for this TAP name; -1 when none of its names match.
const score = (f, name) => patterns.get(f).reduce((best, p) => (p.test(name) && p.score > best ? p.score : best), -1);
const lines = fs.readFileSync(logPath, 'utf8').split('\n');
const tsRe = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z) (.*)$/;
const events = [];
for (const line of lines) {
  const m = line.match(tsRe); if (!m) continue;
  const [, ts, body] = m;
  if (body.startsWith('# Subtest: ')) events.push({ ts: Date.parse(ts), kind: 'start', name: body.slice(11) });
  else if (/^not ok \d+ - /.test(body)) events.push({ ts: Date.parse(ts), kind: 'fail', name: body.replace(/^not ok \d+ - /, '') });
  else if (/^ok \d+ - .*# SKIP/.test(body)) events.push({ ts: Date.parse(ts), kind: 'skip' });
  else if (/^ok \d+ - /.test(body)) events.push({ ts: Date.parse(ts), kind: 'pass' });
  else if (body.includes('The operation was canceled') || body.includes('##[error]Process completed')) events.push({ ts: Date.parse(ts), kind: 'end' });
}
let idx = -1; const spans = []; let cur = null; let unmatched = 0;
for (const e of events) {
  if (e.kind === 'start') {
    const scores = files.map((f) => score(f, e.name));
    const best = Math.max(...scores);
    if (best < 0) { unmatched += 1; if (cur) cur.tests += 1; continue; }
    let next = idx;
    if (idx < 0 || scores[idx] !== best) {
      next = scores.findIndex((s, i) => i > idx && s === best);
      if (next === -1) next = scores.indexOf(best); // a new step restarts the alphabet
    }
    if (next !== idx) {
      if (cur) cur.end = e.ts;
      idx = next; cur = { file: files[idx], start: e.ts, end: null, tests: 0, fails: [], skips: 0 }; spans.push(cur);
    }
    cur.tests += 1;
  } else if (cur && e.kind === 'fail' && !/\.m?js$/.test(e.name)) cur.fails.push(tapUnescape(e.name));
  else if (cur && e.kind === 'fail') cur.fails.push(`[file-level] ${path.basename(e.name.replace(/\\\\/g, '/'))}`);
  else if (cur && e.kind === 'skip') cur.skips += 1;
  else if (cur && e.kind === 'end') { cur.end = e.ts; cur.cancelled = true; }
}
if (cur && !cur.end) cur.end = events.at(-1).ts;
const rows = spans.map((s) => ({ ...s, min: (s.end - s.start) / 60000 }));
const total = rows.reduce((a, r) => a + r.min, 0);
console.log(`files seen: ${rows.length}/${files.length}  total: ${total.toFixed(1)} min  unmatched subtests: ${unmatched}`);
for (const r of [...rows].sort((a, b) => b.min - a.min)) {
  console.log(`${r.min.toFixed(2).padStart(7)} min  ${r.file.padEnd(44)} tests=${String(r.tests).padStart(3)} skip=${String(r.skips).padStart(2)} fail=${r.fails.length}${r.cancelled ? ' CANCELLED' : ''}`);
}
const missing = files.filter((f) => !rows.some((r) => r.file === f));
console.log(`\nnot reached: ${missing.length}`); if (missing.length) console.log(missing.join(', '));
console.log('\nfailures by file:');
for (const r of rows) for (const f of r.fails) console.log(`  ${r.file}: ${f}`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) main();
