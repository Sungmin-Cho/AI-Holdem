#!/usr/bin/env node
// #272: capture SR v1 drill pending transactions from the producer that wrote
// them (main@62ea79c, the last commit before SR v2) and that producer's own
// recovery of every state it left between two writes.
//
//   git worktree add --detach <dir> 62ea79cbf9d1d9b5cdcc1e1ded504d4631c113e4
//   node scripts/capture-srs-v1-recovery.mjs --baseline <dir> --write   capture, run the negative controls, write the fixture
//   node scripts/capture-srs-v1-recovery.mjs --baseline <dir> --check   capture again and compare with the committed fixture
//   node scripts/capture-srs-v1-recovery.mjs --controls                 negative controls against the committed fixture
//
// The old code is not modified. Its public API (startDrill, answerQuestion)
// runs in a fresh process with the clock and randomUUID fixed before it loads;
// every fs mutation is followed by a read of `.training`, and each distinct
// durable state during an answer is one checkpoint. Writes are atomic renames
// or fsynced appends, so a crash leaves exactly one of these states.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CAPTURE_INPUTS, FIXTURE_DIR, PRODUCER_COMMIT, RECOVER_AT, REPO_ROOT,
  identities, listEntries, loadFixture, materialize, readState, runRecovery,
  semanticFailures, sha256, touched, verifyRecovery,
} from '../test/helpers/srs-v1-recovery.mjs';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

// Clock steps of the scenario (UTC). Recovery runs later, at RECOVER_AT.
const SEED_AT = '2026-10-01T09:00:00.000Z';
const REVIEW_AT = ['2026-10-02T09:00:00.000Z', '2026-10-05T09:00:00.000Z', '2026-10-06T09:00:00.000Z'];
const STEP_MS = 20_000;
const UUID_SEED = 'srs-v1-capture';

// Practice mistakes come from single-question free runs answered off-policy.
const SEEDS = [
  ['2.0.0', '6max-100bb-sb-rfi-v2', 'A7o'],
  ['2.0.0', '8max-100bb-hj-vs-lj-open25-v2', 'JTs'],
  ['2.0.0', '9max-100bb-sb-vs-co-open25-v2', 'A2o'],
  ['1.0.0', '6max-100bb-bb-vs-single-raise', 'A8s'],
  ['1.0.0', '6max-100bb-btn-rfi-unopened', 'K6o'],
];

// --- producer (fresh process) ------------------------------------------------

async function produce(baseline, out) {
  const RealDate = globalThis.Date;
  let nowMs = RealDate.parse(SEED_AT);
  globalThis.Date = class extends RealDate {
    constructor(...rest) { if (rest.length) super(...rest); else super(nowMs); }
    static now() { return nowMs; }
  };
  const at = (base, steps = 0) => { nowMs = RealDate.parse(base) + steps * STEP_MS; };
  let uuids = 0;
  crypto.randomUUID = () => {
    const h = crypto.createHash('sha256').update(`${UUID_SEED}:${uuids += 1}`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-v1-producer-'));
  let recording = null;
  let reading = false;
  const record = (op) => {
    if (!recording || reading) return;
    reading = true;
    try {
      const files = readState(store);
      const signature = JSON.stringify(Object.entries(files).map(([rel, bytes]) => [rel, sha256(bytes)]));
      if (recording.at(-1)?.signature !== signature) recording.push({ op, signature, files });
    } finally {
      reading = false;
    }
  };
  for (const name of ['renameSync', 'linkSync', 'closeSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'writeFileSync', 'appendFileSync']) {
    const original = fs[name];
    fs[name] = function hooked(...rest) {
      const result = original.apply(this, rest);
      record(name);
      return result;
    };
  }
  syncBuiltinESMExports();

  const load = (rel) => import(pathToFileURL(path.join(baseline, rel)).href);
  const drill = await load('tools/drill-cli.js');
  const { evaluateDrillAnswer } = await load('training/drill-evaluator.js');
  const { lookup } = await load('training/providers/preflop-json.js');
  const { loadReferenceDataset } = await load('tools/preflop-dataset.js');
  const { KNOWN_REFERENCE_SOURCES } = await load('shared/reference.js');
  const sourceOf = (version) => KNOWN_REFERENCE_SOURCES.find((row) => row.version === version);
  const answerFor = (question, grade) => {
    const strategy = lookup(loadReferenceDataset(question.sourceIdentity), question.prompt);
    for (const key of question.prompt.legalActions) {
      const [action, size] = key.split(':');
      const answer = { action, ...(size ? { sizeBb: Number(size) } : {}) };
      if (evaluateDrillAnswer(question, answer, strategy).grade === grade) return answer;
    }
    throw new Error(`no ${grade} answer for ${question.questionId}`);
  };
  const answer = (session, index, grade) => drill.answerQuestion(store, {
    ...answerFor(session.queue[index], grade),
    sessionId: session.sessionId, questionId: session.queue[index].questionId, attemptNo: index,
  });
  const hands = (session) => session.queue.map((question) => question.prompt.handClass).join(',');
  const transactions = [];
  const capture = async (id, session, index, grade) => {
    recording = [];
    record('before');
    await answer(session, index, grade);
    const states = recording.slice(1);
    recording = null;
    transactions.push({
      id, source: session.sourceIdentity, grade, attemptNo: index,
      states: states.map(({ op, files }) => ({ op, files: Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [rel, bytes.toString('base64')])) })),
    });
  };

  for (const [index, [version, spotKey, handClass]] of SEEDS.entries()) {
    at(SEED_AT, index * 3);
    const session = await drill.startDrill(store, { mode: 'free', source: sourceOf(version), spotKey, handClass, idempotencyKey: `seed-${index}` });
    if (hands(session) !== handClass) throw new Error(`seed ${index} queue is ${hands(session)}`);
    at(SEED_AT, index * 3 + 1);
    await answer(session, 0, 'off-policy');
  }
  // R1 gives every v2 mistake a reviewed SR v1 schedule (one lapse on JTs).
  at(REVIEW_AT[0]);
  const r1 = await drill.startDrill(store, { mode: 'mistake-review', source: sourceOf('2.0.0'), idempotencyKey: 'review-1' });
  if (hands(r1) !== 'A7o,JTs,A2o') throw new Error(`R1 queue is ${hands(r1)}`);
  for (const [index, grade] of ['preferred', 'off-policy', 'preferred'].entries()) {
    at(REVIEW_AT[0], index + 1);
    await answer(r1, index, grade);
  }
  // R2: one committed answer, then A (off-policy: bank write + lapse) and B (preferred: no bank write).
  at(REVIEW_AT[1]);
  const r2 = await drill.startDrill(store, { mode: 'mistake-review', source: sourceOf('2.0.0'), idempotencyKey: 'review-2' });
  if (hands(r2) !== 'A7o,JTs,A2o') throw new Error(`R2 queue is ${hands(r2)}`);
  at(REVIEW_AT[1], 1);
  await answer(r2, 0, 'preferred');
  at(REVIEW_AT[1], 2);
  await capture('a-v2-off-policy', r2, 1, 'off-policy');
  at(REVIEW_AT[1], 3);
  await capture('b-v2-preferred', r2, 2, 'preferred');
  // R3: C is the first answer of a v1-source run, graded mixed.
  at(REVIEW_AT[2]);
  const r3 = await drill.startDrill(store, { mode: 'mistake-review', source: sourceOf('1.0.0'), idempotencyKey: 'review-3' });
  if (hands(r3) !== 'A8s,K6o') throw new Error(`R3 queue is ${hands(r3)}`);
  at(REVIEW_AT[2], 1);
  await capture('c-v1-mixed', r3, 0, 'mixed');

  fs.writeFileSync(out, JSON.stringify({ store, realStore: fs.realpathSync(store), transactions }));
  fs.rmSync(store, { recursive: true, force: true });
}

// --- capture (parent) --------------------------------------------------------

function git(cwd, ...rest) {
  return execFileSync('git', ['-C', cwd, ...rest], { encoding: 'utf8', windowsHide: true }).trim();
}

function checkedBaseline() {
  const given = option('--baseline');
  if (!given) fail('--baseline <detached checkout of the producer commit> is required');
  const baseline = fs.realpathSync(given);
  if (git(baseline, 'rev-parse', 'HEAD') !== PRODUCER_COMMIT) fail(`baseline is not ${PRODUCER_COMMIT}`);
  if (git(baseline, 'status', '--porcelain', '--untracked-files=all')) fail('baseline checkout is not pristine');
  if (baseline === REPO_ROOT || baseline.startsWith(`${REPO_ROOT}${path.sep}game`)) fail('baseline must be a separate checkout');
  return baseline;
}

function runProducer(baseline) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-v1-produce-'));
  try {
    const out = path.join(scratch, 'produced.json');
    const run = spawnSync(process.execPath, [SELF, '--produce', baseline, out], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) fail(`producer failed (${run.status}): ${run.stderr}`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// What each boundary is, read from what changed: the producer's write order.
function nameOf(previous, state) {
  const changed = [...new Set([...Object.keys(previous ?? {}), ...Object.keys(state)])]
    .filter((rel) => !previous || !previous[rel] || !state[rel] || !previous[rel].equals(state[rel]));
  const session = JSON.parse(state['drill-session.json']);
  if (!previous) {
    if (!session.pending || Object.values(session.pending.applied).some(Boolean)) throw new Error('first state is not a fresh pending');
    return 'pending-saved';
  }
  if (changed.length !== 1) throw new Error(`a boundary changed ${changed.join(',')}`);
  const [rel] = changed;
  if (rel === 'drill-session.json') {
    if (!session.pending) return 'committed';
    const before = JSON.parse(previous['drill-session.json']).pending.applied;
    const flipped = Object.keys(session.pending.applied).filter((key) => session.pending.applied[key] !== before[key]);
    if (flipped.length !== 1) throw new Error(`a session write flipped ${flipped.join(',')}`);
    return `${flipped[0]}-flag-saved`;
  }
  if (rel === 'profile-events.jsonl') return 'profile-event-appended';
  if (rel === 'profile.json') return 'profile-projection-written';
  if (rel === 'mistakes.json') return session.pending.applied.bank ? 'srs-written' : 'bank-written';
  throw new Error(`unexpected boundary file ${rel}`);
}

// The issue's four checkpoints, plus the SRS-applied-but-not-cleared boundary it asks for.
const ISSUE_CHECKPOINT = {
  'pending-saved': 'unapplied',
  'profile-flag-saved': 'profile-only',
  'bank-flag-saved': 'through-bank',
  'srs-flag-saved': 'srs-applied-pending-not-cleared',
  committed: 'complete',
};

async function capture(baseline) {
  const runs = [runProducer(baseline), runProducer(baseline)];
  if (JSON.stringify(runs[0].transactions) !== JSON.stringify(runs[1].transactions)) fail('two producer runs differ');
  if (runs[0].store === runs[1].store) fail('the two producer runs shared a store path');
  const blobs = new Map();
  const put = (bytes) => {
    const hash = sha256(bytes);
    blobs.set(hash, bytes);
    return hash;
  };
  const markers = [...runs.flatMap((run) => [run.store, run.realStore]), os.homedir()]
    .flatMap((dir) => [dir, dir.replaceAll('\\', '/'), JSON.stringify(dir).slice(1, -1)]);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-v1-expected-'));
  try {
    const rows = [];
    const transactions = runs[0].transactions.map((tx) => {
      let previous = null;
      const checkpoints = tx.states.map((state, index) => {
        const files = Object.fromEntries(Object.entries(state.files).map(([rel, base64]) => [rel, Buffer.from(base64, 'base64')]));
        for (const bytes of Object.values(files)) {
          if (markers.some((marker) => bytes.includes(marker))) fail('a captured file contains its store path');
        }
        const name = nameOf(previous, files);
        previous = files;
        const id = `${String(index).padStart(2, '0')}-${name}`;
        const storeDir = fs.mkdtempSync(path.join(scratch, 'cp-'));
        materialize(storeDir, files);
        const row = { tx, id, name, boundary: state.op, files, storeDir, ids: identities(storeDir) };
        rows.push(row);
        return row;
      });
      const pending = JSON.parse(checkpoints[0].files['drill-session.json']).pending;
      return {
        id: tx.id, source: tx.source, grade: tx.grade, attemptNo: tx.attemptNo,
        questionId: pending.questionId, evaluationId: pending.profileEvent.evaluationId,
        srsPatch: pending.srsPatch, checkpoints,
      };
    });
    for (const tx of transactions) {
      if (!tx.srsPatch || Object.hasOwn(tx.srsPatch.patch, 'srsVersion') || pendingOf(tx).result.grade !== tx.grade) fail(`${tx.id} is not an SR v1 capture of a ${tx.grade} answer`);
    }
    const first = await runRecovery(baseline, rows.map((row) => row.storeDir));
    for (const [index, row] of rows.entries()) {
      if (!first[index].ok) fail(`producer recovery of ${row.tx.id}/${row.id} failed: ${first[index].code} ${first[index].message}`);
      const state = readState(row.storeDir);
      row.expected = {
        state, entries: listEntries(row.storeDir), rewritten: touched(row.ids, identities(row.storeDir)),
        dto: JSON.stringify(first[index].dto), ids: identities(row.storeDir),
      };
      const tx = transactions.find((candidate) => candidate.id === row.tx.id);
      const failures = semanticFailures(tx, row.files, state);
      if (failures.length) fail(`producer recovery breaks the invariants: ${failures.join('; ')}`);
    }
    const second = await runRecovery(baseline, rows.map((row) => row.storeDir));
    for (const [index, row] of rows.entries()) {
      if (!second[index].ok || JSON.stringify(second[index].dto) !== row.expected.dto
        || touched(row.expected.ids, identities(row.storeDir)).length) fail(`producer recovery of ${row.tx.id}/${row.id} is not idempotent`);
    }
    const names = [...new Set(rows.flatMap((row) => [...Object.keys(row.files), ...Object.keys(row.expected.state)]))].sort();
    const hashes = (files) => Object.fromEntries(names.map((rel) => [rel, files[rel] ? put(files[rel]) : null]));
    return {
      blobs,
      transactions: transactions.map(({ checkpoints, ...tx }) => ({
        ...tx,
        checkpoints: checkpoints.map((row) => ({
          id: row.id,
          boundary: `${row.boundary} after ${row.name}`,
          ...(ISSUE_CHECKPOINT[row.name] ? { issueCheckpoint: ISSUE_CHECKPOINT[row.name] } : {}),
          applied: JSON.parse(row.files['drill-session.json']).pending?.applied ?? null,
          files: hashes(row.files),
          expected: {
            files: hashes(row.expected.state),
            entries: row.expected.entries,
            rewritten: row.expected.rewritten,
            dto: put(Buffer.from(row.expected.dto)),
          },
        })),
      })),
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function pendingOf(tx) {
  return JSON.parse(tx.checkpoints[0].files['drill-session.json']).pending;
}

// --- negative controls ---------------------------------------------------------

// Each mutation is a plausible regression of the recovery path; the comparison
// must reject every one. Replacements must each match exactly once.
const MUTATIONS = [
  {
    id: 'v1-patch-rederived-as-v2',
    description: 'recovery re-derives a v1 pending patch with the SR v2 formula',
    edits: [['tools/drill-cli.js', 'captured.patch.srsVersion === SRS_VERSION ? SRS_VERSION : 1', 'SRS_VERSION']],
  },
  {
    id: 'srs-target-marked-v2',
    description: 'applying the captured v1 target also stamps srsVersion 2 on the review',
    edits: [['tools/drill-cli.js', 'await bank.updateReviewState(captured.mistakeId, captured.patch);',
      'await bank.updateReviewState(captured.mistakeId, { ...captured.patch, srsVersion: 2 });']],
  },
  {
    id: 'srs-attempt-counted-twice',
    description: 'the SRS write adds another attempt on top of the captured target',
    edits: [['tools/drill-cli.js', 'await bank.updateReviewState(captured.mistakeId, captured.patch);',
      'await bank.updateReviewState(captured.mistakeId, { ...captured.patch, attempts: captured.patch.attempts + 1 });']],
  },
  {
    id: 'profile-event-duplicated',
    description: 'recovery ignores the journal proof and the store appends without its duplicate check',
    edits: [
      ['tools/drill-cli.js', 'if (!proof.profileDone) await createProfileStore(storeDir).apply(pending.profileEvent);',
        'await createProfileStore(storeDir).apply(pending.profileEvent);'],
      ['training/profile-store.js', 'if (!readJsonl(eventsPath).some((row) => row.evaluationId === event.evaluationId',
        'if (true || !readJsonl(eventsPath).some((row) => row.evaluationId === event.evaluationId'],
    ],
  },
  {
    id: 'profile-consumer-reapplied',
    description: 'recovery re-applies a profile event the journal already holds',
    edits: [['tools/drill-cli.js', 'if (!proof.profileDone) await createProfileStore(storeDir).apply(pending.profileEvent);',
      'await createProfileStore(storeDir).apply(pending.profileEvent);']],
  },
  {
    id: 'session-rewritten-without-pending',
    description: 'loading a session with nothing pending persists it again',
    edits: [['tools/drill-cli.js', 'if (session.pending) await replayPending(storeDir, session, proof.events);',
      'if (session.pending) await replayPending(storeDir, session, proof.events); else persistSession(storeDir, session);']],
  },
];
// The module graph reaches beyond tools/ (engine, shared, training, server, export and
// the root publish contract); copy all of it so only the edits differ.
const CODE_PATHS = ['engine', 'export', 'server', 'shared', 'tools', 'training', 'package.json', 'publish-contract.js'];

function codeCopy(scratch, edits) {
  const root = fs.mkdtempSync(path.join(scratch, 'code-'));
  for (const rel of CODE_PATHS) fs.cpSync(path.join(REPO_ROOT, rel), path.join(root, rel), { recursive: true });
  for (const [rel, from, to] of edits) {
    const file = path.join(root, rel);
    const text = fs.readFileSync(file, 'utf8');
    if (text.split(from).length !== 2) throw new Error(`${rel}: mutation target must match once: ${from}`);
    fs.writeFileSync(file, text.replace(from, () => to));
  }
  return root;
}

async function negativeControls(fixture) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'srs-v1-controls-'));
  try {
    let stores = 0;
    const makeStore = () => {
      const dir = path.join(scratch, `store-${stores += 1}`);
      fs.mkdirSync(dir);
      return dir;
    };
    const unmodified = await verifyRecovery({ codeRoot: codeCopy(scratch, []), fixture, makeStore });
    if (unmodified.mismatches.length) fail(`the unmodified copy fails: ${unmodified.mismatches.slice(0, 5).join('; ')}`);
    const results = [];
    for (const mutation of MUTATIONS) {
      const report = await verifyRecovery({ codeRoot: codeCopy(scratch, mutation.edits), fixture, makeStore });
      results.push({
        id: mutation.id, description: mutation.description,
        files: [...new Set(mutation.edits.map(([rel]) => rel))],
        detected: report.mismatches.length > 0,
        mismatches: report.mismatches.length,
        first: report.mismatches.slice(0, 3),
      });
    }
    const dirty = git(REPO_ROOT, 'status', '--porcelain', '--', ...CODE_PATHS) !== '';
    return {
      codeTree: `${git(REPO_ROOT, 'rev-parse', 'HEAD')}${dirty ? ' + uncommitted changes' : ''}`,
      unmodified: { checkpoints: unmodified.checkpoints, mismatches: 0 },
      mutations: results,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// --- entry ---------------------------------------------------------------------

function fixtureFromCapture(captured) {
  return {
    manifest: { transactions: captured.transactions },
    blob: (hash) => captured.blobs.get(hash),
    filesOf: (map) => Object.fromEntries(Object.entries(map).filter(([, hash]) => hash !== null).map(([rel, hash]) => [rel, captured.blobs.get(hash)])),
  };
}

function inputHashes() {
  return Object.fromEntries(CAPTURE_INPUTS.map((rel) => [rel, sha256(fs.readFileSync(path.join(REPO_ROOT, rel)))]));
}

async function main() {
  if (flag('--produce')) {
    const [baseline, out] = args.slice(args.indexOf('--produce') + 1);
    await produce(baseline, out);
    return;
  }
  if (flag('--write')) {
    const baseline = checkedBaseline();
    const captured = await capture(baseline);
    const controls = await negativeControls(fixtureFromCapture(captured));
    const undetected = controls.mutations.filter((row) => !row.detected).map((row) => row.id);
    if (undetected.length) fail(`negative controls not detected: ${undetected.join(', ')}`);
    const manifest = {
      schemaVersion: 1,
      issue: 272,
      producer: {
        commit: PRODUCER_COMMIT,
        api: 'tools/drill-cli.js startDrill + answerQuestion (public exports, unmodified)',
        recovery: 'tools/drill-cli.js nextQuestion, run by test/helpers/srs-v1-recovery-runner.mjs',
      },
      capture: {
        command: 'node scripts/capture-srs-v1-recovery.mjs --baseline <detached checkout of producer.commit> --write',
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        inputs: inputHashes(),
        reproduced: 'two producer processes in separate temp stores produced identical states; no captured byte contains a store path',
      },
      determinism: {
        clock: `global Date frozen and stepped before the producer loads: seeds from ${SEED_AT}, reviews at ${REVIEW_AT.join(', ')}, ${STEP_MS / 1000}s between answers`,
        uuid: `crypto.randomUUID = sha256("${UUID_SEED}:<n>") formatted as a v4 UUID`,
        recoverAt: RECOVER_AT,
        normalization: 'none: files are compared as written',
      },
      scope: {
        directory: '.training',
        checkpointFiles: 'every regular file; a file absent from a state is null',
        excluded: '*.lock.d (held by a running writer) and *.tmp (atomic-write temps) in checkpoints; after recovery every entry is listed',
        boundary: 'one checkpoint per distinct durable state between two producer writes (fs rename/link/close/unlink/rm/rmdir/writeFile/appendFile)',
      },
      expected: 'the producer\'s own nextQuestion in a fresh process at recoverAt: files, remaining entries, rewritten files (inode/mtime/size changed) and payload; a second fresh run changes nothing',
      scenario: {
        seeds: SEEDS.map(([version, spotKey, handClass]) => `${version} ${spotKey}:${handClass} off-policy`),
        reviews: [
          'R1 2.0.0 mistake-review: preferred, off-policy, preferred',
          'R2 2.0.0 mistake-review: preferred (committed), A off-policy, B preferred',
          'R3 1.0.0 mistake-review: C mixed (first answer of the run)',
        ],
      },
      transactions: captured.transactions,
      negativeControls: controls,
    };
    fs.rmSync(path.join(FIXTURE_DIR, 'blobs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(FIXTURE_DIR, 'blobs'), { recursive: true });
    for (const [hash, bytes] of captured.blobs) fs.writeFileSync(path.join(FIXTURE_DIR, 'blobs', hash), bytes);
    fs.writeFileSync(path.join(FIXTURE_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`wrote ${captured.transactions.reduce((n, tx) => n + tx.checkpoints.length, 0)} checkpoints, ${captured.blobs.size} blobs; controls ${controls.mutations.map((row) => `${row.id}=${row.mismatches}`).join(' ')}\n`);
    return;
  }
  if (flag('--check')) {
    const baseline = checkedBaseline();
    const captured = await capture(baseline);
    const committed = loadFixture();
    if (JSON.stringify(captured.transactions) !== JSON.stringify(committed.manifest.transactions)) fail('regenerated checkpoints differ from the committed manifest');
    for (const [hash, bytes] of captured.blobs) {
      if (!committed.blob(hash).equals(bytes)) fail(`blob ${hash} differs`);
    }
    process.stdout.write(`regenerated ${captured.blobs.size} blobs: identical to the committed fixture\n`);
    return;
  }
  if (flag('--controls')) {
    const controls = await negativeControls(loadFixture());
    process.stdout.write(`${JSON.stringify(controls, null, 2)}\n`);
    if (controls.mutations.some((row) => !row.detected)) process.exit(1);
    return;
  }
  fail('usage: capture-srs-v1-recovery.mjs --baseline <dir> --write|--check, or --controls');
}

await main();
