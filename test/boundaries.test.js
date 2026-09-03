import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// R12 계층 방향. 이 가드가 없으면 역방향 import가 다시 스며든다 — 결함 #20은
// "engine과 training이 tools를 불러 쓰는" 그 역전이 재발한 결과였다.
const LAYERS = {
  engine: 'engine',
  training: 'training',
  server: 'server',
  tools: 'tools',
};

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

const IMPORT_RE = /(?:^|\n)\s*(?:import\b[^'"`;]*?from\s*|import\s*|export\b[^'"`;]*?from\s*)['"]([^'"]+)['"]/g;
// Not anchored on the closing paren: `import(x, {...})` is a valid form, and a
// template literal with no substitution is just a string.
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"`]([^'"`$]+)['"`]/g;
// The tree is ESM, but a guard that only understands ESM is a guard that a
// single `require` walks past.
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let match = re.exec(source);
    while (match) {
      specifiers.push(match[1]);
      match = re.exec(source);
    }
  }
  return specifiers;
}

function resolvedLayer(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = path.resolve(path.dirname(file), specifier);
  const relative = path.relative(ROOT, target);
  const top = relative.split(path.sep)[0];
  return LAYERS[top] ?? null;
}

function rel(file) {
  return path.relative(ROOT, file);
}

test('engine imports neither training nor tools', () => {
  const offenders = [];
  for (const file of jsFilesUnder('engine')) {
    for (const specifier of importsOf(file)) {
      const layer = resolvedLayer(file, specifier);
      if (layer === 'training' || layer === 'tools') {
        offenders.push(`${rel(file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('training imports no tools module', () => {
  const offenders = [];
  for (const file of jsFilesUnder('training')) {
    for (const specifier of importsOf(file)) {
      if (resolvedLayer(file, specifier) === 'tools') {
        offenders.push(`${rel(file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('training does no filesystem I/O of its own', () => {
  const offenders = [];
  for (const file of jsFilesUnder('training')) {
    for (const specifier of importsOf(file)) {
      if (/^(node:)?fs(\/promises)?$/.test(specifier)) {
        offenders.push(rel(file));
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// 서버는 신뢰 경계 밖의 HTTP 입력을 다루는 계층이므로 사이드카 로직을 전혀
// 불러선 안 된다. 예외는 담기(containment) 원시자 하나뿐이다 — P0-0 helper를
// 재구현하는 것이 더 나쁘고, 서버는 별도 프로세스라 주입할 수 없다.
const SERVER_ALLOWED_CONTAINMENT = new Set(['openContained', 'writeContained']);

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every import declaration for `specifier`, not just the first: a second
 * default or namespace import from the same module would otherwise ride in
 * behind an allowed named one.
 */
function declarationsFor(source, specifier) {
  const re = new RegExp(`(?:^|\\n)\\s*import\\s+([^;'"\`]*?)\\s*from\\s*['"]${escapeRe(specifier)}['"]`, 'g');
  const clauses = [];
  let match = re.exec(source);
  while (match) {
    clauses.push(match[1].trim());
    match = re.exec(source);
  }
  return clauses;
}

function namesInClause(clause) {
  // A default or namespace binding is never an allowed containment primitive.
  if (!clause.startsWith('{')) return [clause.replace(/\s*,.*$/, '').trim() || 'default'];
  const inner = clause.slice(1, clause.lastIndexOf('}'));
  return inner.split(',').map((name) => name.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
}

test('server imports only the publish contract and the containment primitives', () => {
  const offenders = [];
  for (const file of jsFilesUnder('server')) {
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (target === path.join(ROOT, 'publish-contract.js')) continue;
      if (target.startsWith(path.join(ROOT, 'server') + path.sep)) continue;
      if (target === path.join(ROOT, 'tools', 'training-store.js')) {
        const clauses = declarationsFor(source, specifier);
        const names = clauses.flatMap(namesInClause);
        const extra = names.filter((name) => !SERVER_ALLOWED_CONTAINMENT.has(name));
        if (clauses.length > 0 && names.length > 0 && extra.length === 0) continue;
        offenders.push(`${rel(file)} -> ${specifier} (${extra.join(', ') || 'no named import'})`);
        continue;
      }
      offenders.push(`${rel(file)} -> ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
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

test('the moved dataset builder rewrites the canonical dataset, byte for byte', () => {
  const dataset = path.join(ROOT, 'training/data/preflop-baseline-v1.json');
  const digestFile = path.join(ROOT, 'training/data/preflop-baseline-v1.sha256');
  const before = fs.readFileSync(dataset);
  const digest = fs.readFileSync(digestFile, 'utf8').trim();
  // Comparing bytes alone cannot tell "rebuilt identically" from "wrote
  // somewhere else and left this file alone", which is exactly what a bad
  // output path after the move would look like.
  const stampedAt = new Date(Date.now() - 5_000);
  fs.utimesSync(dataset, stampedAt, stampedAt);
  const staleMtime = fs.statSync(dataset).mtimeMs;

  execFileSync(process.execPath, [path.join(ROOT, 'tools/build-preflop-baseline.js')], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.notEqual(fs.statSync(dataset).mtimeMs, staleMtime, 'the builder did not write this file');
  assert.equal(fs.readFileSync(dataset).equals(before), true, 'the rebuild changed the dataset bytes');
  assert.equal(fs.readFileSync(digestFile, 'utf8').trim(), digest);
});

test('the pinned parser has exactly one production caller, and only it reads the pin', () => {
  const parser = path.join(ROOT, 'training/providers/preflop-json.js');
  const parserImporters = [];
  const digestReaders = [];
  for (const dir of ['engine', 'training', 'server', 'tools', 'export']) {
    for (const file of jsFilesUnder(dir)) {
      const source = fs.readFileSync(file, 'utf8');
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('.')) continue;
        if (path.resolve(path.dirname(file), specifier) !== parser) continue;
        // `lookup` and `validateDataset` are pure and free to use. Only the
        // pin-checking entry point is restricted.
        const names = declarationsFor(source, specifier).flatMap(namesInClause);
        if (names.includes('parsePreflopJson')) parserImporters.push(rel(file));
      }
      if (/['"`]\.sha256['"`]/.test(source)) digestReaders.push(rel(file));
    }
  }
  // R5: the digest pin cannot be bypassed while the only way to turn dataset
  // bytes into a strategy runs through one caller that always supplies a pin.
  assert.deepEqual(
    [...new Set(parserImporters)].sort(),
    ['tools/preflop-dataset.js'],
    'only one module may turn dataset bytes into a strategy, and it always pins',
  );
  assert.deepEqual([...new Set(digestReaders)].sort(), ['tools/build-preflop-baseline.js', 'tools/preflop-dataset.js']);
});

// R12는 "기본값 없음"을 요구한다. 기본값이 슬쩍 돌아오면 training이 다시
// tools를 import하게 되므로, 주입 누락이 조용히 통과하지 않는지 직접 건다.
test('the training stores refuse to run without an injected io', async () => {
  const { createProfileStore } = await import('../training/profile-store.js');
  const { createMistakeBank } = await import('../training/mistake-bank.js');
  const notes = await import('../training/opponent-notes.js');
  const store = path.join(ROOT, 'test');

  assert.throws(() => createProfileStore(store), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => createMistakeBank(store), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => notes.readOpponentNotes(store), { code: 'IO_NOT_INJECTED' });

  // A partial io must fail at construction, not on a rare branch at runtime.
  const partial = { ensureDir() {}, readJsonl() { return []; } };
  assert.throws(() => createProfileStore(store, { io: partial }), { code: 'IO_NOT_INJECTED' });
  assert.throws(() => createMistakeBank(store, { io: partial }), { code: 'IO_NOT_INJECTED' });
});

test('the tools injector supplies every helper the training stores require', async () => {
  const { trainingStoreIo } = await import('../tools/training-stores.js');
  const { createProfileStore } = await import('../training/profile-store.js');
  const { createMistakeBank } = await import('../training/mistake-bank.js');
  const store = path.join(ROOT, 'test');
  assert.doesNotThrow(() => createProfileStore(store, { io: trainingStoreIo }));
  assert.doesNotThrow(() => createMistakeBank(store, { io: trainingStoreIo }));
});
