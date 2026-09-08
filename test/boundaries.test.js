import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { scanModule } from './helpers/module-scan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDER = path.join(ROOT, 'test/helpers/import-recorder.mjs');
const FIXTURES = path.join(ROOT, 'test/fixtures/boundaries');
const SCANNED = ['engine', 'training', 'server', 'tools', 'export', 'shared'];

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

// The graph describes source, not the host: a module's identity is its
// POSIX-relative path whichever separator path.relative produced it with.
const posixRelative = (file) => path.relative(ROOT, file).split(path.sep).join('/');

function staticGraph() {
  if (staticCache) return staticCache;
  const edges = [];
  const unresolved = [];
  for (const dir of SCANNED) {
    for (const file of jsFilesUnder(dir)) {
      const relative = posixRelative(file);
      const scan = scanModule(fs.readFileSync(file, 'utf8'));
      for (const entry of scan.imports) {
        const target = entry.specifier.startsWith('.')
          ? posixRelative(path.resolve(path.dirname(file), entry.specifier))
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
  return target.split('/')[0];
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

test('training imports only named state locks plus the predeclared pure evaluator edge from engine', () => {
  const allowed = new Set([
    'training/profile-store.js -> engine/state.js',
    'training/mistake-bank.js -> engine/state.js',
    'training/opponent-notes.js -> engine/state.js',
    'training/policies/hand-strength.js -> engine/evaluator.js',
  ]);
  const offenders = edgesFrom('training')
    .filter((edge) => layerOf(edge.to) === 'engine')
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .filter((edge) => !allowed.has(edge));
  assert.deepEqual(offenders, []);
});

test('shared contracts remain pure of engine, training, server and tools imports', () => {
  const forbidden = new Set(['engine', 'training', 'server', 'tools']);
  const offenders = edgesFrom('shared')
    .filter((edge) => forbidden.has(layerOf(edge.to)))
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
const CONTAINMENT_MODULE = 'tools/training-store.js';
const SERVER_ALLOWED_REFERENCE = 'shared/reference.js';

test('server imports only the publish contract and named containment primitives', () => {
  const offenders = [];
  for (const edge of edgesFrom('server')) {
    if (layerOf(edge.to) === null) continue;
    if (edge.to === 'publish-contract.js') continue;
    if (layerOf(edge.to) === 'server') continue;
    if (edge.to === SERVER_ALLOWED_REFERENCE && !edge.dynamic && edge.bindings?.length) continue;
    const referenceBindings = { 'shared/reference-coverage.js': ['referenceAssessmentEligibility'], 'shared/preflop-key.js': ['parsePreflopKey'] };
    if (!edge.dynamic && edge.bindings?.length && referenceBindings[edge.to]
      && edge.bindings.every(name=>referenceBindings[edge.to].includes(name))) continue;
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

// S1: 서버는 `state.json`·`players.json`·`hands/`를 **읽기 전용 보안 술어**로만 본다.
// 그 파일들이 쓰기 원시자 옆에 나타나는 순간 "중계만 하는 서버"가 깨진다.
const SERVER_WRITE_TARGETS = new Set(['ui-snapshot.json', 'ui-action-receipt.json', 'lock.json']);
const WRITE_PRIMITIVE_RE = /\b(?:fs\.(?:write|append|rename|unlink|rm|truncate|copyFile|mkdir)\w*|writeJsonAtomic|writeContained|writeRelayJsonAtomic)\(/;
const SECURITY_INPUT_RE = /'(?:state|players)\.json'|'hands'|'\.coach-authority\.json'/;

test('the server writes only its UI, receipt and lock files, never its security predicates', () => {
  const offenders = [];
  for (const file of jsFilesUnder('server')) {
    const relative = posixRelative(file);
    const source = fs.readFileSync(file, 'utf8');
    if (/\bwriteContained\b/.test(source)) offenders.push(`${relative} -> writeContained`);
    const relayTargets = relative === 'server/server.js' ? new Set(['ui-snapshot.json', 'lock.json'])
      : relative === 'server/action-receipts.js' ? new Set(['ui-action-receipt.json']) : new Set();
    for (const call of source.matchAll(/\bwriteRelayJsonAtomic\(([^\n]*)/g)) {
      if (source.slice(Math.max(0, call.index - 16), call.index).endsWith('function ')) {
        if (relative !== 'server/action-receipts.js') offenders.push(`${relative} -> unowned writer declaration`);
        continue;
      }
      const target = /^owner, '([^']+)',/.exec(call[1])?.[1];
      if (!relayTargets.has(target)) offenders.push(`${relative} -> unapproved relay destination`);
    }
    if (relative === 'server/action-receipts.js') {
      assert.ok(source.includes("const RELAY_FILES = new Set(['ui-action-receipt.json', 'ui-snapshot.json', 'lock.json']);"));
      assert.ok(source.includes('!owners.has(owner) || !RELAY_FILES.has(name)'));
    }
    for (const call of source.matchAll(/writeJsonAtomic\(\s*path\.join\(([^)]*)\)/g)) {
      const literals = [...call[1].matchAll(/'([^']+)'/g)].map((row) => row[1]);
      const target = literals[literals.length - 1];
      if (!SERVER_WRITE_TARGETS.has(target)) offenders.push(`${relative} -> ${target ?? call[1]}`);
    }
    for (const line of source.split('\n')) {
      if (WRITE_PRIMITIVE_RE.test(line) && SECURITY_INPUT_RE.test(line)) {
        offenders.push(`${relative} -> ${line.trim()}`);
      }
    }
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

  // A regex literal containing a quote must not open a bogus string and eat the
  // import after it — this tree really contains such a pattern.
  const afterRegex = scanModule(read('regex-then-import.txt'));
  assert.deepEqual(
    afterRegex.imports.map((row) => row.specifier),
    ['../tools/training-store.js'],
    'a regex literal must not swallow the import that follows it',
  );
  assert.deepEqual(afterRegex.unresolved, [], 'division must not be read as a regex');

  // A specifier no layer rule can classify must fail closed rather than be
  // skipped silently.
  const url = scanModule(read('url-specifier.txt'));
  assert.ok(url.unresolved.some((row) => row.kind.startsWith('unclassifiable specifier')));

  // Reaching for the module machinery is how a loader gets minted.
  const minting = scanModule(read('loader-minting.txt'));
  // `Module['_load'](...)` is unreachable without importing the machinery, so
  // refusing the import is what closes the whole family.
  assert.ok(minting.unresolved.some((row) => row.kind === 'node:module'));

  // A template substitution is executable code, so a load inside it must stay
  // visible even though the template itself is not a literal specifier.
  const substitution = scanModule(read('template-substitution.txt'));
  assert.deepEqual(
    substitution.imports.map((row) => row.specifier),
    ['../tools/training-store.js'],
  );

  // Node cooks `\x2f` to `/`; a reader of the raw bytes does not. Refuse rather
  // than guess.
  const escaped = scanModule(read('escaped-specifier.txt'));
  assert.deepEqual(escaped.imports, []);
  assert.deepEqual(escaped.unresolved.map((row) => row.kind), ['import()']);

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
  const dir = createOwnedTempDir('holdem-graph');
  const sourceDir = path.join(dir, 'source');
  fs.mkdirSync(sourceDir);
  const sourceRoot = fs.realpathSync(sourceDir);
  for (const name of SCANNED) fs.cpSync(path.join(ROOT, name), path.join(sourceRoot, name), { recursive: true });
  for (const name of ['package.json', 'publish-contract.js']) fs.copyFileSync(path.join(ROOT, name), path.join(sourceRoot, name));
  const out = path.join(dir, 'edges.jsonl');
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, [
    "import { register } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    "register(process.env.RECORDER, pathToFileURL(process.env.ROOT), {",
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
        cwd: sourceRoot,
        timeout: 20_000,
        stdio: 'ignore',
        env: {
          ...process.env, RECORDER: pathToFileURL(RECORDER).href, ROOT: sourceRoot, RECORD_OUT: out, RECORD_FILE: path.join(sourceRoot, path.relative(ROOT, file)),
        },
      });
    } catch { /* a script that exits non-zero still recorded what it resolved */ }
  }
  const edges = [];
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (!row.parent?.startsWith('file:')) continue;
    const from = path.relative(sourceRoot, fs.realpathSync(fileURLToPath(row.parent)));
    // The probe's own import of the target is not an edge of the tree.
    if (from.startsWith('..')) continue;
    const to = row.url?.startsWith('file:') ? path.relative(sourceRoot, fs.realpathSync(fileURLToPath(row.url))) : row.url;
    edges.push({ from, to, specifier: row.specifier });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  recordedCache = { edges, files: files.map((file) => path.relative(ROOT, file)) };
  return recordedCache;
}

test('every edge Node actually resolves was already known to the scanner', () => {
  const recorded = recordedGraph();
  // Without this the cross-check would pass on an empty recording, which is
  // what a broken recorder looks like.
  assert.ok(recorded.edges.length > 100, `only ${recorded.edges.length} edges recorded`);
  const parents = new Set(recorded.edges.map((edge) => edge.from));
  assert.ok(
    recorded.files.filter((file) => parents.has(file)).length > recorded.files.length / 2,
    'most scanned modules should have produced at least one recorded edge',
  );
  const known = new Set(staticGraph().edges.map((edge) => `${edge.from} ${edge.to}`));
  const surprises = [];
  for (const edge of recorded.edges) {
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
    'tools/study-service.js',
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
  const builderRoot = createOwnedTempDir('holdem-builder-copy');
  for (const name of ['tools', 'training/data', 'shared']) fs.mkdirSync(path.join(builderRoot, name), { recursive: true });
  for (const name of ['package.json', 'tools/build-preflop-baseline.js', 'training/cards.js',
    'training/data/legacy-preflop-recipe.js', 'shared/preflop-key.js',
    'training/data/preflop-baseline-v1.json', 'training/data/preflop-baseline-v1.sha256']) {
    fs.copyFileSync(path.join(ROOT, name), path.join(builderRoot, name));
  }
  const dataset = path.join(builderRoot, 'training/data/preflop-baseline-v1.json');
  const digestFile = path.join(builderRoot, 'training/data/preflop-baseline-v1.sha256');
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

  execFileSync(process.execPath, [path.join(builderRoot, 'tools/build-preflop-baseline.js'), '--version', '1'], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.notEqual(fs.statSync(dataset).mtimeMs, staleDataset, 'the builder did not write the dataset');
  assert.notEqual(fs.statSync(digestFile).mtimeMs, staleDigest, 'the builder did not write the pin');
  const asLf = (buf) => Buffer.from(String(buf).replace(/\r\n/g, '\n'));
  assert.equal(asLf(fs.readFileSync(dataset)).equals(asLf(before)), true, 'the rebuild changed the dataset bytes');
  assert.equal(asLf(fs.readFileSync(digestFile)).equals(asLf(digestBefore)), true, 'the rebuild changed the pin');
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

test('study service reaches engine only through named ownership primitives', () => {
  const edges = staticGraph().edges.filter(edge => edge.from === 'tools/study-service.js' && layerOf(edge.to) === 'engine');
  const allowed = new Set(['acquireOwnedLock', 'releaseOwnedLock', 'ownedIdentityStatus', 'ownedProcessStartTime', 'parseOwnedLockIdentity']);
  assert.ok(edges.length > 0);
  for (const edge of edges) {
    assert.equal(edge.to, 'engine/state.js');
    assert.equal(edge.dynamic, false);
    assert.ok(edge.bindings.length > 0);
    assert.deepEqual(edge.bindings.filter(binding => !allowed.has(binding)), []);
  }
  assert.deepEqual(edgesFrom('server').filter(edge => edge.to === 'tools/study-service.js'), []);
});

test('store game loop attaches study through its verified lifetime helper', () => {
  const edges = staticGraph().edges.filter(edge => edge.from === 'tools/game-loop.js' && edge.to === 'tools/study-service.js');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].dynamic, false);
  assert.deepEqual(edges[0].bindings, ['ensureStudyService']);
});
