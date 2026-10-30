// issue 335: a study service started before this change keeps its static allow-list in memory and serves the NEW page
// files from disk. The page must therefore import only paths that the old allow-list serves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
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

/** Module specifiers a browser would request for this source: static imports and re-exports (with or without
 * whitespace, over several lines) and dynamic import() of a string literal. Comments are removed first so a
 * commented-out import is not a dependency. A specifier spelled inside a string literal is out of scope. */
function importSpecifiers(text) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const lead = '(?:^|[^.\\w$])';
  const patterns = [
    new RegExp(`${lead}import\\s*(?:[\\w$*{}\\s,]+?\\s*from\\s*)?(['"])([^'"\\n]+)\\1`, 'g'),
    new RegExp(`${lead}export\\s*[\\w$*{}\\s,]+?\\s*from\\s*(['"])([^'"\\n]+)\\1`, 'g'),
    new RegExp(`${lead}import\\s*\\(\\s*(['"])([^'"\\n]+)\\1\\s*\\)`, 'g'),
  ];
  return [...new Set(patterns.flatMap((pattern) => [...code.matchAll(pattern)].map((match) => match[2])))];
}

/** Every module reachable from /drill.js, resolved as a browser does, reading each module through `read(url)`
 * (null when it is not served). Returns url -> served (true/false). */
async function importGraph(read, entry = '/drill.js') {
  const seen = new Map();
  const pending = [entry];
  while (pending.length) {
    const url = pending.pop();
    if (seen.has(url)) continue;
    const text = await read(url);
    seen.set(url, text !== null);
    if (text === null) continue;
    for (const specifier of importSpecifiers(text)) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      pending.push(new URL(specifier, `http://page.invalid${url}`).pathname);
    }
  }
  return seen;
}
const readOldFile = async (url) => (OLD_FILE.has(url) ? fs.readFileSync(`${ROOT}${OLD_FILE.get(url)}`, 'utf8') : null);

test('the import scanner finds every form a browser loads and skips comments', () => {
  const source = [
    "import{a}from'./a.js';",
    'import {',
    '  b,',
    "  c as d } from \"./b.js\";",
    "import './side.js';",
    "import * as ns from '../shared/ns.js';",
    "export * from './star.js';",
    "export { e } from './re.js';",
    "const lazy = () => import('./lazy.js');",
    "// import gone from './commented.js';",
    "/* import './blocked.js'; */",
    "const url = 'http://example.invalid/x.js'; obj.import('./method.js');",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source).sort(), ['../shared/ns.js', './a.js', './b.js', './lazy.js', './re.js', './side.js', './star.js'].sort());
});

test('the page imports only paths that a service from before issue 335 serves', async () => {
  const graph = await importGraph(readOldFile);
  assert.ok(graph.has('/study-format.js') && graph.has('/spot-chart.js') && graph.has('/shared/reference.js'), 'the walk really follows the imports');
  assert.deepEqual([...graph].filter(([, served]) => !served).map(([url]) => url), [], 'paths the old allow-list does not serve');
});

async function serveGraph(staticAssets) {
  const storeDir = createOwnedTempDir('static-compat');
  const handler = createDrillHandler({ storeDir, token: 'compat-token', ...(staticAssets ? { staticAssets } : {}) });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const statuses = {};
    // The walk reads each module from the response body, as a browser would.
    const graph = await importGraph(async (url) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`);
      statuses[url] = response.status;
      const body = await response.text();
      return response.status === 200 ? body : null;
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200, '/');
    return { graph, statuses };
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
}

test('the old allow-list and the current service both serve the whole import graph with 200', async () => {
  const old = await serveGraph(new Map(OLD_SERVICE_ASSETS.map(([url, file, mime]) => [url, [file, mime]])));
  assert.ok(old.graph.size >= 5, 'the walk followed the served modules');
  assert.deepEqual(Object.entries(old.statuses).filter(([, status]) => status !== 200), [], 'old allow-list');
  const current = await serveGraph(null);
  assert.deepEqual(Object.entries(current.statuses).filter(([, status]) => status !== 200), [], 'current service');
  assert.deepEqual([...current.graph.keys()].sort(), [...old.graph.keys()].sort());
});
