import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import * as journey from './browser/learning-journey.mjs';
import { createBrowserWorkspace, runOwnedCommand, startResponseProxy, hashTree, NODE26 } from './helpers/learning-browser-fixture.mjs';
import './helpers/owned-fixtures.mjs';

test('browser CLI is inert under NODE_TEST_CONTEXT without spawning a browser or fixture', async () => {
  const workspace = createBrowserWorkspace();
  try {
    const output = path.join(workspace.root, 'forbidden-output');
    const result = await runOwnedCommand(NODE26, ['test/browser/learning-journey.mjs', '--out-dir', output], { env: { NODE_TEST_CONTEXT: 'child-v8' } });
    assert.equal(result.exitCode, 0); assert.equal(result.signal, null); assert.equal(result.timedOut, false);
    assert.equal(result.stdout.trim(), 'BROWSER_CLI_DISABLED_UNDER_NODE_TEST_CONTEXT');
    assert.equal(fs.existsSync(output), false); assert.equal(result.stderr, '');
    assert.equal(journey.browserCliEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false);
    assert.equal(journey.browserCliEnabled({}), true);
  } finally { workspace.close(); }
});
test('owned browser workspace refuses replacement inode cleanup', () => {
  const workspace = createBrowserWorkspace(); const original = `${workspace.root}-original`;
  fs.renameSync(workspace.root, original); fs.mkdirSync(workspace.root);
  try { assert.throws(() => workspace.close(), /replacement workspace/); }
  finally { fs.rmdirSync(workspace.root); fs.renameSync(original, workspace.root); workspace.close(); }
});
test('response proxy forwards mutation once before dropping only its response', async () => {
  let mutations = 0; let body = '';
  const upstream = http.createServer((req, res) => { req.on('data', (chunk) => { body += chunk; }); req.on('end', () => { mutations += 1; res.end('committed'); }); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startResponseProxy(upstream.address().port);
  try {
    proxy.arm({ path: '/api/action', kind: 'drop' });
    await assert.rejects(fetch(`http://127.0.0.1:${proxy.port}/api/action`, { method: 'POST', body: 'transport-test' }));
    assert.equal(mutations, 1); assert.equal(body, 'transport-test');
  } finally { await proxy.close(); await new Promise((resolve) => upstream.close(resolve)); }
});
test('response proxy delay preserves actual upstream body and headers', async () => {
  const upstream = http.createServer((_req, res) => { res.writeHead(202, { 'x-actual': 'upstream' }); res.end('forwarded'); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await startResponseProxy(upstream.address().port);
  try {
    proxy.arm({ path: '/api/answer', kind: 'delay', delayMs: 20 });
    const response = await fetch(`http://127.0.0.1:${proxy.port}/api/answer`);
    assert.equal(response.status, 202); assert.equal(response.headers.get('x-actual'), 'upstream'); assert.equal(await response.text(), 'forwarded');
  } finally { await proxy.close(); await new Promise((resolve) => upstream.close(resolve)); }
});
test('store digest detects changed bytes without traversing outside symlinks', () => {
  const workspace = createBrowserWorkspace();
  try {
    fs.writeFileSync(path.join(workspace.root, 'record'), 'before');
    fs.symlinkSync('/not-read-by-digest', path.join(workspace.root, 'external'));
    const before = hashTree(workspace.root); fs.writeFileSync(path.join(workspace.root, 'record'), 'after');
    assert.notEqual(hashTree(workspace.root), before);
  } finally { workspace.close(); }
});

test('browser protected-store gate is portable, canonical and cannot pass on missing or non-directory targets', () => {
  assert.equal(typeof journey.inspectProtectedUserStore, 'function');
  assert.equal(typeof journey.protectedUserStoreResult, 'function');
  assert.equal(typeof journey.parseJourneyArgs, 'function');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  assert.equal(journey.DEFAULT_USER_STORE, path.join(root, 'game'));
  const workspace = createBrowserWorkspace();
  try {
    const before = journey.inspectProtectedUserStore(workspace.root);
    const unchanged = journey.protectedUserStoreResult(before, journey.inspectProtectedUserStore(workspace.root));
    assert.deepEqual(Object.keys(unchanged).sort(), ['after','afterExists','before','beforeExists','path','unchanged']);
    assert.equal(unchanged.path, fs.realpathSync(workspace.root));
    assert.equal(unchanged.beforeExists, true); assert.equal(unchanged.afterExists, true); assert.equal(unchanged.unchanged, true);

    const missing = path.join(workspace.root, 'missing-game');
    const absent = journey.protectedUserStoreResult(
      journey.inspectProtectedUserStore(missing), journey.inspectProtectedUserStore(missing),
    );
    assert.equal(absent.path, path.join(fs.realpathSync(workspace.root), 'missing-game'));
    assert.equal(absent.beforeExists, false); assert.equal(absent.afterExists, false); assert.equal(absent.unchanged, false);

    const file = path.join(workspace.root, 'not-a-store'); fs.writeFileSync(file, 'fixture');
    const nonDirectory = journey.protectedUserStoreResult(
      journey.inspectProtectedUserStore(file), journey.inspectProtectedUserStore(file),
    );
    assert.equal(nonDirectory.beforeExists, true); assert.equal(nonDirectory.afterExists, true); assert.equal(nonDirectory.unchanged, false);

    const parsed = journey.parseJourneyArgs(['--out-dir', 'evidence', '--user-store-dir', workspace.root]);
    assert.equal(parsed.outDir, 'evidence'); assert.equal(parsed.userStoreDir, workspace.root);
    assert.throws(() => journey.parseJourneyArgs(['--unknown']), /unknown browser journey option/);
  } finally { workspace.close(); }
});

test('review and unread browser proof requires real desktop and mobile interactions', () => {
  assert.deepEqual(journey.journeyScenarioPlan['review-reopen-unread'].viewports, ['390x844', '1280x900']);
});

test('missing and non-directory protected stores fail the real journey gate before browser startup', async () => {
  const workspace = createBrowserWorkspace();
  try {
    const targets = [path.join(workspace.root, 'missing'), path.join(workspace.root, 'file')];
    fs.writeFileSync(targets[1], 'not a directory');
    for (const [index, userStoreDir] of targets.entries()) {
      const result = await journey.runLearningJourney({
        outDir: path.join(workspace.root, `evidence-${index}`), userStoreDir,
      });
      assert.equal(result.pass, false);
      assert.equal(result.userStore.beforeExists, index === 1);
      assert.equal(result.userStore.afterExists, index === 1);
      assert.equal(result.userStore.unchanged, false);
      assert.equal(result.checks.some((row) => row.name === 'real-user-store-unchanged'), false);
      assert.equal(result.error, 'protected user store must be an existing directory');
    }
  } finally { workspace.close(); }
});
