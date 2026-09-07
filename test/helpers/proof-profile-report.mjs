import fs from 'node:fs';

const args = process.argv.slice(2).filter((arg) => arg !== '--json');
const asJson = process.argv.includes('--json');
const file = args[0];
if (!file) {
  console.error('usage: proof-profile-report.mjs <proofs.jsonl> [--json]');
  process.exit(2);
}

function bucket() {
  return { calls: 0, ms: 0, timedOut: 0, nonzero: 0 };
}
function add(into, row) {
  into.calls += 1;
  into.ms += Number(row.ms) || 0;
  if (row.timedOut) into.timedOut += 1;
  if (row.status !== 0) into.nonzero += 1;
}

const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const rows = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const total = bucket();
const byPid = {};
const byPhase = {};
const byKind = {};
for (const row of rows) {
  add(total, row);
  const pid = String(row.pid);
  const phase = row.phase == null ? '(none)' : String(row.phase);
  const kind = String(row.kind);
  add(byPid[pid] ??= bucket(), row);
  add(byPhase[phase] ??= bucket(), row);
  add(byKind[kind] ??= bucket(), row);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ total, byPid, byPhase, byKind })}\n`);
  process.exit(0);
}

function line(label, stats) {
  return `${label}  calls=${stats.calls}  ms=${stats.ms}  timedOut=${stats.timedOut}  nonzero=${stats.nonzero}`;
}
console.log(line('total', total));
console.log('by pid:');
for (const [key, stats] of Object.entries(byPid)) console.log(line(`  ${key}`, stats));
console.log('by phase:');
for (const [key, stats] of Object.entries(byPhase)) console.log(line(`  ${key}`, stats));
console.log('by kind:');
for (const [key, stats] of Object.entries(byKind)) console.log(line(`  ${key}`, stats));
