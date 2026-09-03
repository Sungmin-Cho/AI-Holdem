import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECORDER = path.join(ROOT, 'test/helpers/import-recorder.mjs');
const SCANNED = ['engine', 'training', 'server', 'tools', 'export'];

// R12 계층 방향. 이 가드가 없으면 역방향 import가 다시 스며든다 — 결함 #20은
// engine과 training이 tools를 불러 쓰는 그 역전이었다.
//
// 소스를 정규식으로 훑지 않는다. 정규식은 주석이 낀 dynamic import, 템플릿
// 리터럴 specifier, 문자열 이름 바인딩, `require`를 전부 놓친다. 대신 resolve
// 훅으로 **Node가 실제로 해석한 그래프**를 기록한다. 이 가드를 우회하려면 Node의
// 해석기 자체를 우회해야 한다.

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

let graphCache = null;

/**
 * Every edge Node resolves while loading each module — one child process per
 * module, so a script with top-level side effects (or one that calls
 * `process.exit`) cannot cut the recording short for the rest.
 */
function moduleGraph() {
  if (graphCache) return graphCache;
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
  const loaded = [];
  for (const file of files) {
    const before = fs.statSync(out).size;
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
    if (fs.statSync(out).size > before) loaded.push(path.relative(ROOT, file));
  }
  const edges = [];
  const seen = new Set();
  for (const line of fs.readFileSync(out, 'utf8').split('\n')) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (!row.parent?.startsWith('file:')) continue;
    const from = path.relative(ROOT, fileURLToPath(row.parent));
    const to = row.url?.startsWith('file:') ? path.relative(ROOT, fileURLToPath(row.url)) : row.url;
    const key = `${from} ${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, specifier: row.specifier });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  graphCache = { edges, files: files.map((file) => path.relative(ROOT, file)), loaded };
  return graphCache;
}

function layerOf(target) {
  if (typeof target !== 'string' || target.startsWith('..') || target.includes(':')) return null;
  return target.split(path.sep)[0];
}

function edgesFrom(layer) {
  return moduleGraph().edges.filter((edge) => layerOf(edge.from) === layer);
}

test('the recorder actually observed the tree it is guarding', () => {
  const { edges, files, loaded } = moduleGraph();
  // An empty or partial recording would make every rule below pass vacuously.
  assert.ok(edges.length > 100, `only ${edges.length} edges were recorded`);
  const missed = files.filter((file) => !loaded.includes(file));
  assert.deepEqual(missed, [], 'these modules resolved nothing, so they are unguarded');
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
    .filter((edge) => /^(node:)?fs(\/promises)?$/.test(edge.specifier))
    .map((edge) => edge.from);
  assert.deepEqual([...new Set(offenders)], []);
});

// 서버는 신뢰 경계 밖의 HTTP 입력을 다루므로 사이드카 로직을 전혀 불러선 안
// 된다. 예외는 담기 원시자 하나뿐이다 — 서버는 별도 프로세스라 주입이
// 불가능하고, P0-0 helper를 재구현하는 쪽이 더 나쁘다.
const SERVER_CONTAINMENT_IMPORT = "import { openContained } from '../tools/training-store.js';";

test('server imports only the publish contract and the containment primitives', () => {
  const offenders = [];
  for (const edge of edgesFrom('server')) {
    if (layerOf(edge.to) === null) continue;
    if (edge.to === 'publish-contract.js') continue;
    if (layerOf(edge.to) === 'server') continue;
    if (edge.to === path.join('tools', 'training-store.js')) continue;
    offenders.push(`${edge.from} -> ${edge.to}`);
  }
  assert.deepEqual(offenders, []);

  // An edge cannot say which bindings crossed it, so the one allowed module is
  // pinned to its exact declaration. A mixed default import, a namespace import
  // or an extra named binding would not match this line.
  for (const file of jsFilesUnder('server')) {
    const declarations = fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.includes('tools/training-store.js'))
      .map((line) => line.trim());
    if (declarations.length === 0) continue;
    assert.deepEqual(
      declarations,
      [SERVER_CONTAINMENT_IMPORT],
      `${path.relative(ROOT, file)} may take only the containment primitive`,
    );
  }
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
  // somewhere else and left these alone", which is exactly what a bad output
  // path after the move looks like. Stale both mtimes and require both to move.
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
  // can stop, so the parser brands what it pinned and `lookup` refuses anything
  // else — including data carrying a digest the caller supplied itself.
  const forged = JSON.parse(raw);
  assert.throws(
    () => lookup({ data: forged, contentSha256: pinned.contentSha256 }, { spotKey, handClass }),
    { code: 'DATASET_INVALID' },
  );
  assert.throws(
    () => lookup({ data: forged, contentSha256: 'f'.repeat(64) }, { spotKey, handClass }),
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
