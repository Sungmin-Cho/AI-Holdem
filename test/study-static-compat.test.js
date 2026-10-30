// issue 335: a study service started before this change keeps its static allow-list in memory and serves the NEW page
// files from disk. The page must therefore import only paths that the old allow-list serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDrillHandler } from '../tools/drill-server.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const JS = 'text/javascript; charset=utf-8';
// Paths (and their files) that a study service built from main 0d09a12 (before issue 335) serves: STATIC and REPLAY_STATIC.
const OLD_SERVICE_ASSETS = [
  ['/', 'server/drill-public/drill.html', 'text/html; charset=utf-8'],
  ['/drill.html', 'server/drill-public/drill.html', 'text/html; charset=utf-8'],
  ['/drill.js', 'server/drill-public/drill.js', JS],
  ['/drill.css', 'server/drill-public/drill.css', 'text/css; charset=utf-8'],
  ['/design-tokens.css', 'server/public/design-tokens.css', 'text/css; charset=utf-8'],
  ['/ui-base.css', 'server/public/ui-base.css', 'text/css; charset=utf-8'],
  ['/theme-boot.js', 'server/public/theme-boot.js', JS],
  ['/public/card-render.js', 'server/public/card-render.js', JS],
  ['/public/help-panel.js', 'server/public/help-panel.js', JS],
  ['/public/display-settings.js', 'server/public/display-settings.js', JS],
  ['/public/chip-format.js', 'server/public/chip-format.js', JS],
  ['/font-pretendard-400.woff2', 'server/public/font-pretendard-400.woff2', 'font/woff2'],
  ['/font-pretendard-600.woff2', 'server/public/font-pretendard-600.woff2', 'font/woff2'],
  ['/font-pretendard-700.woff2', 'server/public/font-pretendard-700.woff2', 'font/woff2'],
  ['/font-space-grotesk.woff2', 'server/public/font-space-grotesk.woff2', 'font/woff2'],
  ['/study-format.js', 'server/drill-public/study-format.js', JS],
  ['/shared/preflop-key.js', 'shared/preflop-key.js', JS],
  ['/shared/reference.js', 'shared/reference.js', JS],
  ['/pot-odds-drill.js', 'server/drill-public/pot-odds-drill.js', JS],
  ['/spot-chart.js', 'server/drill-public/spot-chart.js', JS],
  ['/replay.html', 'server/drill-public/replay.html', 'text/html; charset=utf-8'],
  ['/replay.js', 'server/drill-public/replay.js', JS],
  ['/replay.css', 'server/drill-public/replay.css', 'text/css; charset=utf-8'],
  ['/replay-library-state.js', 'server/drill-public/replay-library-state.js', JS],
  ...['replay-player', 'replay-controller', 'replay-perspective', 'replay-model', 'replay-format', 'replay-facts', 'replayer', 'seat-format']
    .map((name) => [`/public/${name}.js`, `server/public/${name}.js`, JS]),
  ['/public/replay.css', 'server/public/replay.css', 'text/css; charset=utf-8'],
  ...['decision-facts', 'poker-eval'].map((name) => [`/shared/${name}.js`, `shared/${name}.js`, JS]),
];
const OLD_FILE = new Map(OLD_SERVICE_ASSETS.map(([url, file]) => [url, file]));

// A resolve hook for a child Node process: it records every module request the ES module loader itself makes while
// linking the graph (static imports and re-exports, with the specifier as the parser decoded it) and the file it
// resolved to. Nothing here scans source text, so no comment, string, template, escape or line ending can hide one.
// `registerHooks` runs in the thread (Node 22.15+); older Node uses `register` (off-thread, writes the same file).
const RECORDING_HOOK = `import fs from 'node:fs';
let out;
export async function initialize(data) { out = data.out; }
export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  fs.appendFileSync(out, JSON.stringify({ parent: context.parentURL ?? null, specifier, url: result.url }) + '\\n');
  return result;
}`;
// File URLs as the loader writes them: real paths (macOS /private/var, Windows long names), compared by path.
const realFileUrl = (file) => pathToFileURL(fs.realpathSync(file)).href;

/** The module requests the loader makes when it imports `entryFile`: [{ parent, specifier, url }] with real file URLs.
 * A request the loader cannot resolve (an extensionless or remote path, a missing file) fails the import, and so
 * the caller. */
function loaderRequests(entryFile, workDir) {
  const out = path.join(workDir, 'requests.jsonl');
  fs.writeFileSync(out, '');
  const script = `import * as mod from 'node:module';
import fs from 'node:fs';
const out = ${JSON.stringify(out)};
if (typeof mod.registerHooks === 'function') {
  mod.registerHooks({ resolve(specifier, context, next) {
    const result = next(specifier, context);
    fs.appendFileSync(out, JSON.stringify({ parent: context.parentURL ?? null, specifier, url: result.url }) + '\\n');
    return result;
  } });
} else mod.register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(RECORDING_HOOK)}`)}, import.meta.url, { data: { out } });
await import(${JSON.stringify(realFileUrl(entryFile))});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.status, 0, `the loader could not import ${entryFile}: ${child.stderr}`);
  return fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** Every module a page loads, as browser URLs, from the loader's own requests: each request is resolved against the
 * browser URL of the module that made it. Returns url -> the file URL the loader used for it. A request that leaves
 * the page's origin (another host, `node:` or any other scheme a browser page cannot load) is kept as `EXTERNAL …`,
 * so it fails the served-path check. Requests of the recording harness itself have no page parent and are skipped. */
function pageGraph(workDir, entry = path.join(ROOT, OLD_FILE.get('/drill.js')), entryUrl = '/drill.js') {
  const requests = loaderRequests(entry, workDir);
  const browserUrlOf = new Map([[realFileUrl(entry), entryUrl]]);
  const graph = new Map([[entryUrl, realFileUrl(entry)]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { parent, specifier, url } of requests) {
      const from = browserUrlOf.get(parent);
      if (!from) continue;
      const target = new URL(specifier, `http://page.invalid${from}`);
      const local = target.origin === 'http://page.invalid';
      const key = local ? target.pathname : `EXTERNAL ${target.href}`;
      if (!graph.has(key)) { graph.set(key, url); grew = true; }
      if (local && !browserUrlOf.has(url)) { browserUrlOf.set(url, target.pathname); grew = true; }
    }
  }
  return graph;
}
// The same file on disk: a query or fragment the loader keeps on its URL does not change which file is served.
const sameFile = (fileUrl, file) => fs.realpathSync(fileURLToPath(fileUrl)) === fs.realpathSync(file);

test('the graph comes from the loader, so syntax that fools a text scan cannot hide an import', () => {
  const dir = createOwnedTempDir('static-compat-loader');
  const files = { 'a.js': '', 'b.js': '', 'c.js': '', 'd.js': '', 'e.js': '', 'f.js': '', 'g.js': '', 'h.js': '' };
  for (const name of Object.keys(files)) fs.writeFileSync(path.join(dir, name), 'export const x = 1;\n');
  const lines = [
    "/*'./decoy.js?*/import'./a.js';",
    "const marker = '//'; import './b.js';",
    'const t = `${`/*`}`; import "./c.js";',
    "if (globalThis) {} /[/*]/g.test('x'); import './d.js';",
    'const s = "a\\',
    '/*"; import "./e.js";',
    "import '\\u002e/f.js';",
    "export * from './g.js?label=a b';",
    "import{x as h}from'./h.js';",
  ];
  for (const newline of ['\n', '\r\n']) {
    fs.writeFileSync(path.join(dir, 'entry.js'), lines.join(newline));
    fs.rmSync(path.join(dir, 'requests.jsonl'), { force: true });
    const requested = loaderRequests(path.join(dir, 'entry.js'), dir)
      .filter((row) => row.parent === realFileUrl(path.join(dir, 'entry.js')))
      .map((row) => path.basename(fileURLToPath(row.url)));
    assert.deepEqual([...new Set(requested)].sort(), Object.keys(files).sort(), JSON.stringify(newline));
  }
  // An extensionless path does not load at all, so it cannot pass the check.
  fs.writeFileSync(path.join(dir, 'bare.js'), "import './a';\n");
  assert.throws(() => loaderRequests(path.join(dir, 'bare.js'), dir), /could not import/);
});

test('the page imports only paths that a service from before issue 335 serves, from the same files', () => {
  const graph = pageGraph(createOwnedTempDir('static-compat-graph'));
  assert.ok(graph.has('/study-format.js') && graph.has('/spot-chart.js') && graph.has('/shared/reference.js'), 'the walk really follows the imports');
  assert.deepEqual([...graph.keys()].filter((url) => !OLD_FILE.has(url)), [], 'paths the old allow-list does not serve');
  for (const [url, fileUrl] of graph) assert.ok(sameFile(fileUrl, path.join(ROOT, OLD_FILE.get(url))), url);
});

test('a query or fragment keeps the served file; node: and remote imports cannot pass', () => {
  const dir = createOwnedTempDir('static-compat-forms');
  for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(dir, name), 'export const x = 1;\n');
  fs.writeFileSync(path.join(dir, 'page.js'), "import './a.js?label=a b';\nimport './b.js#v2';\n");
  const graph = pageGraph(dir, path.join(dir, 'page.js'), '/page.js');
  assert.deepEqual([...graph.keys()].sort(), ['/a.js', '/b.js', '/page.js']);
  assert.ok(sameFile(graph.get('/a.js'), path.join(dir, 'a.js')) && sameFile(graph.get('/b.js'), path.join(dir, 'b.js')));
  // node: loads in Node but not in a page: it stays in the graph as an external request.
  fs.writeFileSync(path.join(dir, 'builtin.js'), "import './a.js';\nimport 'node:fs';\n");
  assert.deepEqual([...pageGraph(dir, path.join(dir, 'builtin.js'), '/builtin.js').keys()].filter((key) => key.startsWith('EXTERNAL')), ['EXTERNAL node:fs']);
  // A protocol-relative (remote) path does not load at all.
  fs.writeFileSync(path.join(dir, 'remote.js'), "import '//remote.invalid/x.js';\n");
  assert.throws(() => pageGraph(dir, path.join(dir, 'remote.js'), '/remote.js'), /could not import/);
});

async function statusesOf(urls, staticAssets) {
  const storeDir = createOwnedTempDir('static-compat');
  const handler = createDrillHandler({ storeDir, token: 'compat-token', ...(staticAssets ? { staticAssets } : {}) });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const statuses = {};
    for (const url of ['/', ...urls]) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`);
      statuses[url] = response.status;
      await response.arrayBuffer();
    }
    return statuses;
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

test('the old allow-list and the current service both serve the whole page graph with 200', async () => {
  const urls = [...pageGraph(createOwnedTempDir('static-compat-graph')).keys()];
  assert.ok(urls.length >= 5, 'the graph has the page modules');
  const old = await statusesOf(urls, new Map(OLD_SERVICE_ASSETS.map(([url, file, mime]) => [url, [file, mime]])));
  assert.deepEqual(Object.entries(old).filter(([, status]) => status !== 200), [], 'old allow-list');
  const current = await statusesOf(urls, null);
  assert.deepEqual(Object.entries(current).filter(([, status]) => status !== 200), [], 'current service');
});
