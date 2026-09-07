// Map flat TAP output (node --test, files run one at a time) back to files by test name,
// then report per-file wall time from the log timestamps.
import fs from 'node:fs';
import path from 'node:path';
const [logPath, testDir] = process.argv.slice(2);
const files = fs.readdirSync(testDir).filter((f) => f.endsWith('.test.js')).sort();
const nameRe = /\b(?:test|it)\s*\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`)/g;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = new Map();
for (const f of files) {
  const src = fs.readFileSync(path.join(testDir, f), 'utf8');
  const list = [];
  for (const m of src.matchAll(nameRe)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (m[3] !== undefined) {
      const re = '^' + raw.split(/\$\{[^}]*\}/).map(escape).join('.*') + '$';
      list.push(new RegExp(re));
    } else list.push(new RegExp('^' + escape(raw.replace(/\\'/g, "'")) + '$'));
  }
  patterns.set(f, list);
}
const matches = (f, name) => patterns.get(f).some((re) => re.test(name));
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
    let next = idx;
    if (idx < 0 || !matches(files[idx], e.name)) {
      next = files.findIndex((f, i) => i > idx && matches(f, e.name));
      if (next === -1) next = files.findIndex((f) => matches(f, e.name)); // a new step restarts the alphabet
      if (next === -1) { unmatched += 1; if (cur) cur.tests += 1; continue; }
    }
    if (next !== idx) {
      if (cur) cur.end = e.ts;
      idx = next; cur = { file: files[idx], start: e.ts, end: null, tests: 0, fails: [], skips: 0 }; spans.push(cur);
    }
    cur.tests += 1;
  } else if (cur && e.kind === 'fail' && !/\.m?js$/.test(e.name)) cur.fails.push(e.name);
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
