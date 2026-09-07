import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function bucket() {
  return { calls: 0, ms: 0, timedOut: 0, nonzero: 0 };
}
function add(into, row) {
  into.calls += 1;
  into.ms += Number(row.ms) || 0;
  if (row.timedOut) into.timedOut += 1;
  if (row.status !== 0) into.nonzero += 1;
}

export function reportProofProfile(file, { json = false } = {}) {
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
  if (json) return { total, byPid, byPhase, byKind };
  const line = (label, stats) => `${label}  calls=${stats.calls}  ms=${stats.ms}  timedOut=${stats.timedOut}  nonzero=${stats.nonzero}`;
  const out = [line('total', total), 'by pid:'];
  for (const [key, stats] of Object.entries(byPid)) out.push(line(`  ${key}`, stats));
  out.push('by phase:');
  for (const [key, stats] of Object.entries(byPhase)) out.push(line(`  ${key}`, stats));
  out.push('by kind:');
  for (const [key, stats] of Object.entries(byKind)) out.push(line(`  ${key}`, stats));
  return out.join('\n') + '\n';
}

function main(argv = process.argv.slice(2)) {
  const args = argv.filter((arg) => arg !== '--json');
  const asJson = argv.includes('--json');
  const file = args[0];
  if (!file) {
    console.error('usage: proof-profile-report.mjs <proofs.jsonl> [--json]');
    process.exitCode = 2;
    return;
  }
  const result = reportProofProfile(file, { json: asJson });
  process.stdout.write(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && !process.env.NODE_TEST_CONTEXT) main();
