import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scanModule } from './helpers/module-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDER = path.join(ROOT, 'test/helpers/import-recorder.mjs');
const FIXTURES = path.join(ROOT, 'test/fixtures/boundaries');
const SCANNED = ['engine', 'training', 'server', 'tools', 'export'];

// R12 계층 방향. 결함 #20은 engine과 training이 tools를 불러 쓰는 역전이었고,
// 이 가드가 없으면 다시 스며든다.
//
// 두 관점을 함께 쓴다. **정적 스캔이 계약이다**: `scanModule`이 주석·문자열을
// 인식해 로딩 구문을 읽고, 리터럴로 해석되지 않는 로드(계산된 specifier,
// `createRequire` 같은 자체 로더)는 무시하지 않고 **위반으로 올린다** — 숨기려면
// 가드가 이미 거부하는 문법을 써야 한다. 함수 안의 lazy `import()`도 여기서
// 잡힌다. 런타임 recorder는 보조로, 정적 스캔이 놓친 실제 해석이 있는지 대조한다.

function jsFilesUnder(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

let staticCache = null;

function staticGraph() {
  if (staticCache) return staticCache;
  const edges = [];
  const unresolved = [];
  for (const dir of SCANNED) {
    for (const file of jsFilesUnder(dir)) {
      const relative = path.relative(ROOT, file);
      const scan = scanModule(fs.readFileSync(file, 'utf8'));
      for (const entry of scan.imports) {
        const target = entry.specifier.startsWith('.')
          ? path.relative(ROOT, path.resolve(path.dirname(file), entry.specifier))
          : entry.specifier;
        edges.push({ from: relative, to: target, ...entry });
      }
      for (const entry of scan.unresolved) {
        unresolved.push({ from: relative, ...entry });
      }
    }
  }
  staticCache = { edges, unresolved };
  return staticCache;
}

function layerOf(target) {
  if (typeof target !== 'string' || target.startsWith('..') || target.includes(':')) return null;
  return target.split(path.sep)[0];
}

function edgesFrom(layer) {
  return staticGraph().edges.filter((edge) => layerOf(edge.from) === layer);
}

test('no guarded module loads anything the scanner cannot resolve', () => {
  // Fail closed. A computed specifier or a hand-rolled loader hides the
  // dependency from every rule below, so its presence is itself the violation.
  const offenders = staticGraph().unresolved
    .map((entry) => `${entry.from}:${entry.line} ${entry.kind}`);
  assert.deepEqual(offenders, []);
});

test('engine imports neither training nor tools', () => {
  const offenders = edgesFrom('engine')
    .filter((edge) => ['training', 'tools'].includes(layerOf(edge.to)))
    .map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(offenders, []);
});

test('training imports no tools module', () => {
  const offenders = edgesFrom('training')
    .filter((edge) => layerOf(edge.to) === 'tools')
    .map((edge) => `${edge.from} -> ${edge.to}`);
  assert.deepEqual(offenders, []);
});

test('training does no filesystem I/O of its own', () => {
  const offenders = edgesFrom('training')
    .filter((edge) => /^(node:)?fs(\/promises)?$/.test(edge.to))
    .map((edge) => edge.from);
  assert.deepEqual([...new Set(offenders)], []);
});

// 서버는 신뢰 경계 밖의 HTTP 입력을 다루므로 사이드카 로직을 불러선 안 된다.
// 예외는 담기 원시자뿐 — 서버는 별도 프로세스라 주입이 불가능하고, P0-0 helper를
// 재구현하는 쪽이 더 나쁘다.
const SERVER_ALLOWED_CONTAINMENT = new Set(['openContained', 'writeContained']);
const CONTAINMENT_MODULE = path.join('tools', 'training-store.js');

test('server imports only the publish contract and named containment primitives', () => {
  const offenders = [];
  for (const edge of edgesFrom('server')) {
    if (layerOf(edge.to) === null) continue;
    if (edge.to === 'publish-contract.js') continue;
    if (layerOf(edge.to) === 'server') continue;
    if (edge.to !== CONTAINMENT_MODULE) {
      offenders.push(`${edge.from} -> ${edge.to}`);
      continue;
    }
    // A dynamic import hands over the whole namespace, so it can never be the
    // narrow exception; a static one is judged by its bindings, not its text,
    // so reformatting or quote style cannot flip the result.
    if (edge.dynamic) {
      offenders.push(`${edge.from} -> ${edge.to} (namespace via dynamic import)`);
      continue;
    }
    const extra = (edge.bindings ?? []).filter((name) => !SERVER_ALLOWED_CONTAINMENT.has(name));
    if (edge.bindings?.length && extra.length === 0) continue;
    offenders.push(`${edge.from} -> ${edge.to} (${extra.join(', ') || 'no named binding'})`);
  }
  assert.deepEqual(offenders, []);
});

test('the scanner refuses every bypass form the reviews raised', () => {
  const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

  // Committed fixtures, so these stay regressions rather than one-off probes.
  const computed = scanModule(read('computed-dynamic.txt'));
  assert.deepEqual(computed.imports, []);
  assert.deepEqual(computed.unresolved.map((row) => row.kind), ['import()']);

  const requireLoader = scanModule(read('create-require.txt'));
  assert.ok(requireLoader.unresolved.some((row) => row.kind === 'createRequire'));

  // The runtime recorder cannot see this one; the scanner must.
  const lazy = scanModule(read('lazy-import.txt'));
  assert.deepEqual(
    lazy.imports.map((row) => row.specifier),
    ['../tools/training-store.js'],
  );

  const tricky = scanModule(read('commented-and-templated.txt'));
  assert.deepEqual(
    tricky.imports.map((row) => row.specifier).sort(),
    ['../tools/training-store.js', '../tools/training-store.js'],
    'commented-out and string-literal imports must not count, real ones must',
  );
  assert.deepEqual(tricky.unresolved, []);

  const mixed = scanModule(read('mixed-default.txt'));
  const bindings = mixed.imports[0].bindings;
  assert.ok(bindings.includes('default'), 'a default binding must be visible');
  assert.ok(
    bindings.some((name) => !SERVER_ALLOWED_CONTAINMENT.has(name)),
    'a forbidden binding smuggled beside an allowed one must be visible',
  );
});

let recordedCache = null;

/**
 * What Node actually resolved while loading each module, one child per module so
 * a script with top-level side effects or a `process.exit` cannot truncate the
 * recording for the rest. Supplementary: it sees only eager edges, which is why
 * the static scan above is the contract.
 */
function recordedGraph() {
  if (recordedCache) return recordedCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-graph-'));
  const out = path.join(dir, 'edges.jsonl');
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, [
    "import { register } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "register(process.env.RECORDER, pathToFileURL(process.env.ROOT + '/'), {",
    '  data: { out: process.env.RECORD_OUT },',
    '});',
    'try {',
    '  await import(pathToFileURL(process.env.RECORD_FILE).href);',
    '} catch { /* the edges are recorded before the body runs */ }',
    '',
  ].join('\n'));
  fs.writeFileSync(out, '');
  const files = SCANNED.flatMap(jsFilesUnder);
  for (const file of files) {
    try {
      execFileSync(process.execPath, [probe], {
        cwd: ROOT,
        timeout: 20_000,
        stdio: 'ignore',
        env: {
          ...process.env, RECORDER, ROOT, RECORD_OUT: out, RECORD_FILE: file,
        },
      });
    } catch { /* a script that exits non-zero still recorded what it resolved */ }
  }
  const edges = [];
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (!row.parent?.startsWith('file:')) continue;
    const from = path.relative(ROOT, fileURLToPath(row.parent));
    // The probe's own import of the target is not an edge of the tree.
    if (from.startsWith('..')) continue;
    const to = row.url?.startsWith('file:') ? path.relative(ROOT, fileURLToPath(row.url)) : row.url;
    edges.push({ from, to, specifier: row.specifier });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  recordedCache = { edges, files: files.map((file) => path.relative(ROOT, file)) };
  return recordedCache;
}

test('every edge Node actually resolves was already known to the scanner', () => {
  const known = new Set(staticGraph().edges.map((edge) => `${edge.from} ${edge.to}`));
  const surprises = [];
  for (const edge of recordedGraph().edges) {
    // Only modules the scanner covers can be cross-checked against it; the
    // recorder also walks into shared root modules like `publish-contract.js`.
    if (!SCANNED.includes(layerOf(edge.from))) continue;
    if (known.has(`${edge.from} ${edge.to}`)) continue;
    surprises.push(`${edge.from} -> ${edge.to} (${edge.specifier})`);
  }
  // The scan is the contract; this is the cross-check that it is not blind.
  assert.deepEqual([...new Set(surprises)], []);
});

test('the process entry points that spawn or touch the filesystem live in tools', () => {
  for (const entry of [
    'tools/evaluate-cli.js',
    'tools/drill-server.js',
    'tools/fake-solver-adapter.js',
    'tools/solver-adapter.js',
    'tools/build-preflop-baseline.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, entry)), true, `${entry} is missing`);
  }
  // Moved without a shim: the old paths must be gone, or the reverse import the
  // move exists to remove would survive behind them.
  for (const gone of [
    'training/cli.js',
    'server/drill-server.js',
    'training/providers/fake-solver.js',
    'training/providers/solver-adapter.js',
    'training/data/build-preflop-baseline.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} should have been moved`);
  }
});

test('the moved dataset builder rewrites the canonical dataset and its pin, byte for byte', () => {
  const dataset = path.join(ROOT, 'training/data/preflop-baseline-v1.json');
  const digestFile = path.join(ROOT, 'training/data/preflop-baseline-v1.sha256');
  const before = fs.readFileSync(dataset);
  const digestBefore = fs.readFileSync(digestFile);
  // Comparing bytes alone cannot tell "rebuilt identically" from "wrote
  // somewhere else and left these alone", which is what a bad output path after
  // the move looks like. Stale both mtimes and require both to move.
  const stampedAt = new Date(Date.now() - 5_000);
  fs.utimesSync(dataset, stampedAt, stampedAt);
  fs.utimesSync(digestFile, stampedAt, stampedAt);
  const staleDataset = fs.statSync(dataset).mtimeMs;
  const staleDigest = fs.statSync(digestFile).mtimeMs;

  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-preflop-baseline.js')], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.notEqual(fs.statSync(dataset).mtimeMs, staleDataset, 'the builder did not write the dataset');
  assert.notEqual(fs.statSync(digestFile).mtimeMs, staleDigest, 'the builder did not write the pin');
  assert.equal(fs.readFileSync(dataset).equals(before), true, 'the rebuild changed the dataset bytes');
  assert.equal(fs.readFileSync(digestFile).equals(digestBefore), true, 'the rebuild changed the pin');
});

test('a dataset that never went through the pinned parser cannot become a strategy', async () => {
  const { lookup, parsePreflopJson } = await import('../training/providers/preflop-json.js');
  const dataset = path.join(ROOT, 'training/data/preflop-baseline-v1.json');
  const raw = fs.readFileSync(dataset, 'utf8');
  const pinned = parsePreflopJson(raw, {
    expectedSha256: fs.readFileSync(dataset.replace(/\.json$/, '.sha256'), 'utf8').trim(),
  });
  const spotKey = Object.keys(pinned.data.spots)[0];
  const handClass = Object.keys(pinned.data.spots[spotKey])[0];
  assert.equal(lookup(pinned, { spotKey, handClass }).status, 'supported');

  // R5: reading the bytes and calling JSON.parse is the bypass no import rule
  // can stop. The association is a WeakMap keyed by object identity, so it is
  // not reflectable, not copyable, and not answerable by a Proxy.
  assert.deepEqual(Object.getOwnPropertySymbols(pinned.data), []);
  assert.equal(Object.isFrozen(pinned.data), true);
  assert.equal(Object.isFrozen(pinned.data.spots), true);

  const forged = JSON.parse(raw);
  for (const symbol of Object.getOwnPropertySymbols(pinned.data)) {
    forged[symbol] = pinned.contentSha256;
  }
  assert.throws(
    () => lookup({ data: forged, contentSha256: pinned.contentSha256 }, { spotKey, handClass }),
    { code: 'DATASET_INVALID' },
  );
  const proxied = new Proxy(forged, {
    get: (target, key) => (key in target ? target[key] : pinned.contentSha256),
  });
  assert.throws(
    () => lookup({ data: proxied, contentSha256: pinned.contentSha256 }, { spotKey, handClass }),
    { code: 'DATASET_INVALID' },
  );
  assert.throws(
    () => lookup({ data: pinned.data, contentSha256: 'f'.repeat(64) }, { spotKey, handClass }),
    { code: 'DATASET_INVALID' },
  );
});

// R12는 "기본값 없음"을 요구한다. 기본값이 슬쩍 돌아오면 training이 다시
// tools를 import하게 되므로, 주입 누락이 조용히 통과하지 않는지 직접 건다.
test('the training stores refuse to run without a complete injected io', async () => {
  const { createProfileStore } = await import('../training/profile-store.js');
  const { createMistakeBank } = await import('../training/mistake-bank.js');
  const notes = await import('../training/opponent-notes.js');
  const store = path.join(ROOT, 'test');
  const partial = { ensureDir() {}, readJsonl() { return []; } };

  assert.throws(() => createProfileStore(store), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => createMistakeBank(store), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => createProfileStore(store, { io: partial }), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => createMistakeBank(store, { io: partial }), { code: 'IO_NOT_INJECTED' });

  // opponent-notes injects per function, so every entry point needs its own
  // check — a helper missing on the write path would otherwise surface only at
  // runtime, on the one branch that uses it.
  assert.throws(() => notes.readOpponentNotes(store), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => notes.persistReadReport(store, {}), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => notes.persistReadReport(store, {}, { io: partial }), { code: 'IO_NOT_INJECTED' });
  await assert.rejects(() => notes.writeOpponentNote(store, {}), { code: 'IO_NOT_INJECTED' });
  await assert.rejects(() => notes.writeOpponentNote(store, {}, { io: partial }), { code: 'IO_NOT_INJECTED' });
  await assert.rejects(() => notes.rewriteOpponentNotesForbidden(store), { code: 'IO_NOT_INJECTED' });
});

test('the tools injector supplies every helper the training stores require', async () => {
  const { trainingStoreIo } = await import('../tools/training-stores.js');
  const { createProfileStore } = await import('../training/profile-store.js');
  const { createMistakeBank } = await import('../training/mistake-bank.js');
  const store = path.join(ROOT, 'test');
  assert.doesNotThrow(() => createProfileStore(store, { io: trainingStoreIo }));
  assert.doesNotThrow(() => createMistakeBank(store, { io: trainingStoreIo }));
});
