// #272: shared by scripts/capture-srs-v1-recovery.mjs (capture and negative
// controls) and test/srs-v1-recovery-bytes.test.js. Checkpoints are the store
// states the pinned SR v1 producer actually left between its writes; expected
// bytes are that same producer's own recovery of each one.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

export const PRODUCER_COMMIT = '62ea79cbf9d1d9b5cdcc1e1ded504d4631c113e4';
// One recovery time for every checkpoint, after the last capture (2026-10-06T09:00:20Z).
export const RECOVER_AT = '2026-10-06T09:30:00.000Z';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'srs-v1-recovery');
export const RUNNER = path.join(REPO_ROOT, 'test', 'helpers', 'srs-v1-recovery-runner.mjs');
// Changing any of these changes what a capture produces, so the manifest pins them.
export const CAPTURE_INPUTS = [
  'scripts/capture-srs-v1-recovery.mjs',
  'test/helpers/srs-v1-recovery.mjs',
  'test/helpers/srs-v1-recovery-runner.mjs',
];
const TRAINING = '.training';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A lock directory lives only while its writer holds it and an atomic write's
// temp file only until its rename; neither is store state. Reclaiming a dead
// writer's lock is its own contract (#148, #265), not this one.
export const transient = (name) => name.endsWith('.lock.d') || name.endsWith('.tmp');

function walk(dir, rel, visit) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (visit(entry, relPath) === false) continue;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relPath, visit);
  }
}

/** Regular files under `.training` by POSIX relative path; transient entries are skipped. */
export function readState(storeDir) {
  const root = path.join(storeDir, TRAINING);
  const files = {};
  walk(root, '', (entry, rel) => {
    if (transient(entry.name)) return false;
    if (entry.isDirectory()) return true;
    if (!entry.isFile()) throw new Error(`unexpected store entry: ${rel}`);
    files[rel] = fs.readFileSync(path.join(root, ...rel.split('/')));
    return true;
  });
  return files;
}

/** Every entry under `.training`, transient or not; directories end with '/'. */
export function listEntries(storeDir) {
  const out = [];
  walk(path.join(storeDir, TRAINING), '', (entry, rel) => {
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    return true;
  });
  return out;
}

/** A rewrite changes one of these: rename-replace gives a new inode, an append a new size. */
export function identities(storeDir) {
  const out = {};
  const root = path.join(storeDir, TRAINING);
  walk(root, '', (entry, rel) => {
    if (!entry.isFile()) return true;
    const st = fs.statSync(path.join(root, ...rel.split('/')), { bigint: true });
    out[rel] = `${st.dev}:${st.ino}:${st.mtimeNs}:${st.size}`;
    return true;
  });
  return out;
}

export function touched(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((rel) => before[rel] !== after[rel]).sort();
}

export function materialize(storeDir, files) {
  const root = path.join(storeDir, TRAINING);
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, bytes] of Object.entries(files)) {
    const file = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
}

/** One fresh process recovers every store with `codeRoot`'s own nextQuestion. */
export function runRecovery(codeRoot, stores, { now = RECOVER_AT, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [RUNNER, codeRoot, now, ...stores], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    onSpawn?.(child);
    // Chunks are joined as bytes: a pipe chunk can end inside a multi-byte
    // character of the Korean feedback text, and decoding each chunk alone
    // would replace it (where it ends depends on the Node version).
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const out = Buffer.concat(stdout).toString('utf8');
      if (code !== 0) return reject(new Error(`recovery runner exited ${code ?? signal}: ${Buffer.concat(stderr).toString('utf8')}`));
      try { resolve(JSON.parse(out)); } catch (error) { reject(new Error(`recovery runner output: ${error.message}: ${out}`)); }
    });
  });
}

export function loadFixture(dir = FIXTURE_DIR) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const blob = (hash) => fs.readFileSync(path.join(dir, 'blobs', hash));
  const filesOf = (map) => Object.fromEntries(Object.entries(map)
    .filter(([, hash]) => hash !== null).map(([rel, hash]) => [rel, blob(hash)]));
  return { dir, manifest, blob, filesOf };
}

const jsonl = (bytes) => bytes.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/**
 * What the recovered state must say whatever its bytes: the transaction is
 * committed once, its SR v1 target is the captured one and nothing became v2.
 */
export function semanticFailures(tx, before, after) {
  const failures = [];
  const fail = (message) => failures.push(`${tx.id}: ${message}`);
  const session = JSON.parse(after['drill-session.json']);
  if (session.pending !== null) fail('pending was not cleared');
  if (session.index !== tx.attemptNo + 1) fail(`index ${session.index}, expected ${tx.attemptNo + 1}`);
  if (session.queue[tx.attemptNo]?.questionId !== tx.questionId
    || session.answers[tx.attemptNo]?.questionId !== tx.questionId
    || session.answers[tx.attemptNo]?.grade !== tx.grade) fail('the answer was not committed to its question');
  const eventsBefore = before['profile-events.jsonl'] ?? Buffer.alloc(0);
  const eventsAfter = after['profile-events.jsonl'] ?? Buffer.alloc(0);
  if (!eventsAfter.subarray(0, eventsBefore.length).equals(eventsBefore)) fail('earlier learning events were rewritten');
  const rows = jsonl(eventsAfter).filter((row) => row.evaluationId === tx.evaluationId);
  if (rows.length !== 1) fail(`${rows.length} learning events for the transaction`);
  const bank = JSON.parse(after['mistakes.json']);
  const target = { ...tx.srsPatch.before, ...tx.srsPatch.patch };
  if (!isDeepStrictEqual(bank.reviewState[tx.srsPatch.mistakeId], target)) fail('the SR v1 target is not the captured one');
  for (const [id, review] of Object.entries(bank.reviewState)) {
    if (Object.hasOwn(review, 'srsVersion') || Object.hasOwn(review, 'graduatedAt')) fail(`review ${id} gained SR v2 fields`);
  }
  // Counted per evidence id, so the same answer banked twice on one item shows too.
  const banked = bank.items.flatMap((item) => item.evidenceIds).filter((id) => id === tx.evaluationId).length;
  if (banked !== (tx.grade === 'off-policy' ? 1 : 0)) fail(`${banked} bank evidence rows for the ${tx.grade} answer`);
  return failures;
}

const hashesOf = (files) => Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [rel, sha256(bytes)]));

/**
 * Recover every checkpoint with `codeRoot` (two fresh processes) and list every
 * way the result differs from the pinned producer's own recovery.
 */
export async function verifyRecovery({ codeRoot, fixture = loadFixture(), makeStore, onSpawn }) {
  const { manifest, filesOf } = fixture;
  const mismatches = [];
  const rows = [];
  for (const tx of manifest.transactions) {
    for (const checkpoint of tx.checkpoints) {
      const store = makeStore(`${tx.id}-${checkpoint.id}`);
      const files = filesOf(checkpoint.files);
      materialize(store, files);
      rows.push({ tx, checkpoint, store, files, ids: identities(store) });
    }
  }
  const first = await runRecovery(codeRoot, rows.map((row) => row.store), { onSpawn });
  for (const [index, row] of rows.entries()) {
    const { tx, checkpoint, store } = row;
    const label = `${tx.id}/${checkpoint.id}`;
    const want = checkpoint.expected;
    const got = first[index];
    if (!got?.ok) {
      mismatches.push(`${label}: recovery failed ${got?.code}: ${got?.message}`);
      continue;
    }
    if (sha256(JSON.stringify(got.dto)) !== want.dto) mismatches.push(`${label}: next-question payload differs`);
    const state = readState(store);
    if (!isDeepStrictEqual(hashesOf(state), Object.fromEntries(Object.entries(want.files).filter(([, hash]) => hash !== null)))) {
      for (const rel of new Set([...Object.keys(state), ...Object.keys(want.files)])) {
        const hash = state[rel] ? sha256(state[rel]) : null;
        if (hash !== (want.files[rel] ?? null)) mismatches.push(`${label}: ${rel} ${hash ?? 'absent'} != ${want.files[rel] ?? 'absent'}`);
      }
    }
    if (!isDeepStrictEqual(listEntries(store), want.entries)) mismatches.push(`${label}: leftover entries ${JSON.stringify(listEntries(store))}`);
    const rewritten = touched(row.ids, identities(store));
    if (!isDeepStrictEqual(rewritten, want.rewritten)) mismatches.push(`${label}: rewrote ${JSON.stringify(rewritten)}, producer rewrote ${JSON.stringify(want.rewritten)}`);
    for (const failure of semanticFailures(tx, row.files, state)) mismatches.push(`${label}: ${failure}`);
    row.after = { state, ids: identities(store), dto: JSON.stringify(got.dto) };
  }
  const repeat = rows.filter((row) => row.after);
  const second = await runRecovery(codeRoot, repeat.map((row) => row.store), { onSpawn });
  for (const [index, row] of repeat.entries()) {
    const label = `${row.tx.id}/${row.checkpoint.id} repeat`;
    const got = second[index];
    if (!got?.ok) {
      mismatches.push(`${label}: recovery failed ${got?.code}: ${got?.message}`);
      continue;
    }
    if (JSON.stringify(got.dto) !== row.after.dto) mismatches.push(`${label}: next-question payload changed`);
    const rewritten = touched(row.after.ids, identities(row.store));
    if (rewritten.length) mismatches.push(`${label}: rewrote ${JSON.stringify(rewritten)}`);
    if (!isDeepStrictEqual(hashesOf(readState(row.store)), hashesOf(row.after.state))) mismatches.push(`${label}: bytes changed`);
    if (!isDeepStrictEqual(listEntries(row.store), row.checkpoint.expected.entries)) mismatches.push(`${label}: leftover entries ${JSON.stringify(listEntries(row.store))}`);
  }
  return { mismatches, checkpoints: rows.length };
}
