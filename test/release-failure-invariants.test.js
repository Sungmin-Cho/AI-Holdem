import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as verifier from '../tools/verify-learning-release.js';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';

function fixture() {
  const root = createOwnedTempDir('release-failure-invariants');
  const repoRoot = path.join(root, 'repo');
  const userStoreTarget = path.join(root, 'game');
  const outDir = path.join(root, 'evidence');
  const tmpDir = path.join(root, 'tmp');
  for (const dir of [repoRoot, userStoreTarget, outDir, tmpDir]) fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init');
  fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'original');
  git('add', 'tracked.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  fs.writeFileSync(path.join(userStoreTarget, 'state.json'), 'original');
  const before = [{ path: 'game/state.json', sha256: createHash('sha256').update('original').digest('hex'), size: 8 }];
  const sourcePin = git('rev-parse', 'HEAD');
  return { root, repoRoot, userStoreTarget, outDir, tmpDir, sourcePin,
    storeContext: { userStoreTarget, before, actualBefore: before },
    sourceStart: { startHead: sourcePin, startTree: git('rev-parse', 'HEAD^{tree}'), startChanges: '', startUntracked: '' } };
}

test('failed owned child records both real store and tracked-source mutations', async () => {
  const context = fixture();
  const resultFile = path.join(context.outDir, 'failed-child.json');
  let primary;
  try {
    await verifier.runProcess(process.execPath, ['-e',
      'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"changed");fs.writeFileSync(process.argv[2],"changed");process.exit(23)',
      path.join(context.userStoreTarget, 'state.json'), path.join(context.repoRoot, 'tracked.txt')],
    { cwd: context.repoRoot, tmpDir: context.tmpDir, resultFile });
  } catch (error) { primary = error; }
  assert.equal(primary.code, 'PROCESS_RESULT_FAILED');
  assert.equal(JSON.parse(fs.readFileSync(resultFile)).exitCode, 23);
  const raw = fs.readFileSync(resultFile);
  const prior = path.join(context.outDir, 'user-store-after.json');
  fs.writeFileSync(prior, 'prior gate evidence');
  const result = await verifier.collectFailureInvariants(context);
  assert.equal(result['protected-store'].code, 'USER_STORE_CHANGED');
  assert.equal(result['source-stability'].code, 'SOURCE_PIN_CHANGED');
  assert.equal(primary.code, 'PROCESS_RESULT_FAILED');
  process.stdout.write(`FAILED_OWNED_CHILD ${raw.toString('utf8').trim()}\n`);
  process.stdout.write(`FAILURE_INVARIANTS ${JSON.stringify(result)}\n`);
  assert.deepEqual(fs.readFileSync(resultFile), raw);
  assert.equal(fs.readFileSync(prior, 'utf8'), 'prior gate evidence');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(context.outDir, 'failure-invariants.json'))), result);
});

test('missing store proof still checks changed source; absent source context is explicit', async () => {
  const context = fixture();
  fs.rmSync(context.userStoreTarget, { recursive: true });
  fs.writeFileSync(path.join(context.repoRoot, 'tracked.txt'), 'changed');
  const result = await verifier.collectFailureInvariants(context);
  assert.equal(result['protected-store'].code, 'USER_STORE_PROOF_UNAVAILABLE');
  assert.equal(result['source-stability'].code, 'SOURCE_PIN_CHANGED');
  const empty = await verifier.collectFailureInvariants({ outDir: path.join(context.root, 'empty') });
  assert.equal(empty['protected-store'].code, 'USER_STORE_PROOF_UNAVAILABLE');
  assert.equal(empty['source-stability'].code, 'SOURCE_PROOF_UNAVAILABLE');
});

test('real verifier early failure preserves primary error and reports missing baseline proof', async () => {
  const root = createOwnedTempDir('release-failure-entry');
  const result = await verifier.runReleaseVerification({ baseline: 'invalid', beforeManifest: path.join(root, 'missing.json'), outDir: root });
  assert.equal(result.pass, false);
  assert.equal(result.code, 'RELEASE_USAGE');
  assert.equal(result.failureInvariants['protected-store'].code, 'USER_STORE_PROOF_UNAVAILABLE');
  assert.equal(result.failureInvariants['source-stability'].code, 'SOURCE_PROOF_UNAVAILABLE');
});


test('source command failure is unavailable while store proof is retained', async () => {
  const context = fixture();
  fs.rmSync(path.join(context.repoRoot, '.git'), { recursive: true });
  const result = await verifier.collectFailureInvariants(context);
  assert.equal(result['protected-store'].status, 'passed');
  assert.equal(result['source-stability'].code, 'SOURCE_PROOF_UNAVAILABLE');
  assert.equal(result['source-stability'].causeCode, 'PROCESS_RESULT_FAILED');
});

test('actual CLI failure writes invariant diagnostics and exits nonzero without gate bypass', () => {
  const root = createOwnedTempDir('release-failure-cli');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  let failure;
  try {
    execFileSync(process.execPath, ['tools/verify-learning-release.js',
      '--baseline', 'a4822d74a4251f199b52e0f02914ef659ea905dd',
      '--before-manifest', path.join(root, 'absent.json'), '--out-dir', root],
    { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) { failure = error; }
  assert.equal(failure.status, 1);
  const result = JSON.parse(fs.readFileSync(path.join(root, 'result.json')));
  assert.equal(result.pass, false);
  assert.equal(result.code, process.version === 'v26.0.0' ? 'ENOENT' : 'NODE_RUNTIME_UNSUPPORTED');
  assert.equal(result.failureInvariants['protected-store'].status, 'unavailable');
  assert.equal(result.failureInvariants['source-stability'].status, 'unavailable');
  assert.deepEqual(result.completedGates, []);
});


test('unchanged owned baselines produce both proofs without implying release success', async () => {
  const context = fixture();
  const result = await verifier.collectFailureInvariants(context);
  assert.equal(result['protected-store'].status, 'passed');
  assert.equal(result['source-stability'].status, 'passed');
  assert.equal(Object.hasOwn(result, 'pass'), false);
});


test('fresh output guard refuses preexisting failure evidence', () => {
  const root = createOwnedTempDir('release-failure-fresh');
  const evidence = path.join(root, 'failure-invariants.json');
  fs.writeFileSync(evidence, 'existing evidence');
  assert.throws(() => verifier.reserveReleaseOutput(root), { code: 'RELEASE_OUTPUT_NOT_FRESH' });
  assert.equal(fs.readFileSync(evidence, 'utf8'), 'existing evidence');
});
