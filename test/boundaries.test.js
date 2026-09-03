import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
      if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(ROOT, dir));
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import\b[^'"`;]*?from\s*|import\s*|export\b[^'"`;]*?from\s*)['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file) {
  const source = fs.readFileSync(file, 'utf8');
  const specifiers = [];
  for (const re of [IMPORT_RE, DYNAMIC_IMPORT_RE]) {
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
      if (specifier === 'node:fs' || specifier === 'node:fs/promises' || specifier === 'fs') {
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

function namedImportsFrom(source, specifier) {
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*['"]${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  const match = re.exec(source);
  if (!match) return [];
  return match[1].split(',').map((name) => name.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
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
        const names = namedImportsFrom(source, specifier);
        const extra = names.filter((name) => !SERVER_ALLOWED_CONTAINMENT.has(name));
        if (names.length > 0 && extra.length === 0) continue;
        offenders.push(`${rel(file)} -> ${specifier} (${extra.join(', ') || 'namespace import'})`);
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
    'training/data/build-preflop-baseline.js',
  ]) {
    assert.equal(fs.existsSync(path.join(ROOT, gone)), false, `${gone} should have been moved`);
  }
});
