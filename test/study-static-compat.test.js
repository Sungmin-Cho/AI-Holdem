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
const OLD_PATHS = new Set(OLD_SERVICE_ASSETS.map(([url]) => url));

// url path -> file as the current service maps it (read from the source: the map is private to the module).
function currentFileOf(url) {
  const source = fs.readFileSync(`${ROOT}tools/drill-server.js`, 'utf8');
  const match = source.match(new RegExp(`\\['${url.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}', \\['([^']+)'`));
  return match?.[1] ?? null;
}

/** Every static import/re-export reachable from /drill.js, resolved as a browser does. */
function importGraph(entry = '/drill.js') {
  const seen = new Map();
  const pending = [entry];
  while (pending.length) {
    const url = pending.pop();
    if (seen.has(url)) continue;
    const file = currentFileOf(url);
    seen.set(url, file);
    if (!file) continue;
    const text = fs.readFileSync(`${ROOT}${file}`, 'utf8');
    const specifiers = [...text.matchAll(/(?:^|[\s;])(?:import|export)\s[^'";]*?\sfrom\s*['"]([^'"]+)['"]/gm), ...text.matchAll(/(?:^|[\s;])import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.') && !specifier.startsWith('/')) continue;
      pending.push(new URL(specifier, `http://page.invalid${url}`).pathname);
    }
  }
  return seen;
}

test('the page imports only paths that a service from before issue 335 serves', () => {
  const graph = importGraph();
  assert.ok(graph.has('/study-format.js') && graph.has('/spot-chart.js') && graph.has('/shared/reference.js'), 'the walk really follows the imports');
  const missing = [...graph.keys()].filter((url) => !OLD_PATHS.has(url));
  assert.deepEqual(missing, [], 'paths the old allow-list does not serve');
  assert.deepEqual([...graph].filter(([, file]) => file === null).map(([url]) => url), [], 'every imported path is served by the current service too');
});

test('the old allow-list serves the whole import graph with 200 from the current files', async () => {
  const storeDir = createOwnedTempDir('static-compat');
  const staticAssets = new Map(OLD_SERVICE_ASSETS.map(([url, file, mime]) => [url, [file, mime]]));
  const handler = createDrillHandler({ storeDir, token: 'compat-token', staticAssets });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    for (const url of ['/', ...importGraph().keys()]) {
      const response = await fetch(`http://127.0.0.1:${port}${url}`);
      assert.equal(response.status, 200, url);
      await response.arrayBuffer();
    }
  } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }); }
});
