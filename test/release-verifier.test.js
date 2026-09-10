import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBrowserEvidence,
  assertEvidenceDestination,
  assertExpectedFailureProcessResult,
  assertOwnedCleanupEvidence,
  assertSourceSnapshot,
  assertTerminalProcessResult,
  parseReleaseArgs,
  parseDefaultIntegrationOutput,
  validateFinalReviewInput,
  validateCompatibilityResult,
  validateReleaseEvidence,
  validateWorkflowInput,
} from '../tools/verify-learning-release.js';
import {
  classifyRollbackSafety,
  parseCompatibilityArgs,
  runCompatibilityVerification,
  assertCompatibilityDestination,
} from './helpers/verify-learning-compatibility.mjs';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { studyBudget } from './helpers/platform.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a4822d74a4251f199b52e0f02914ef659ea905dd';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function terminal(overrides = {}) {
  const result = {
    schemaVersion: 1,
    command: [process.execPath, '-e', 'process.stdout.write("ok")'],
    cwd: ROOT,
    startedAt: '2026-09-06T00:00:00.000Z',
    endedAt: '2026-09-06T00:00:00.010Z',
    durationMs: 10,
    exitCode: 0,
    signal: null,
    timedOut: false,
    outputLimited: false,
    spawnError: null,
    stdout: 'ok',
    stderr: '',
    stdoutSha256: sha256('ok'),
    stderrSha256: sha256(''),
    ...overrides,
  };
  const { receiptSha256: ignored, ...body } = result;
  result.receiptSha256 = sha256(JSON.stringify(body));
  return result;
}

function gate(name, sourcePin = SHA, overrides = {}) {
  const receipt = {
    schemaVersion: 1,
    gate: name,
    status: 'passed',
    pass: true,
    sourcePin,
    evidence: { terminal: terminal() },
    ...overrides,
  };
  const { receiptSha256: ignored, ...body } = receipt;
  receipt.receiptSha256 = sha256(JSON.stringify(body));
  return receipt;
}

function releaseReceipts(sourcePin = SHA) {
  return Object.fromEntries([
    'full-suite', 'syntax-archive', 'policy-benchmark', 'browser',
    'compatibility-migration-rollback', 'default-learning-integration', 'scoped-mutations',
    'protected-store', 'source-stability', 'owned-cleanup',
  ].map((name) => [name, gate(name, sourcePin)]));
}

const RELEASE_SEQUENCE = [
  'full-suite', 'syntax-archive', 'policy-benchmark', 'browser',
  'compatibility-migration-rollback', 'default-learning-integration', 'scoped-mutations',
  'protected-store', 'source-stability', 'owned-cleanup',
];

function wait(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

test('release CLI accepts each exact required structured argument once', () => {
  const parsed = parseReleaseArgs([
    '--baseline', SHA,
    '--before-manifest', '/tmp/before.json',
    '--out-dir', '/tmp/release',
  ]);
  assert.deepEqual(parsed, {
    baseline: SHA,
    beforeManifest: '/tmp/before.json',
    outDir: '/tmp/release',
  });
  for (const argv of [
    [],
    ['--baseline', SHA, '--before-manifest', '/tmp/before.json'],
    ['--baseline', 'not-a-commit', '--before-manifest', '/tmp/before.json', '--out-dir', '/tmp/release'],
    ['--baseline', SHA, '--baseline', SHA, '--before-manifest', '/tmp/before.json', '--out-dir', '/tmp/release'],
    ['--baseline', SHA, '--before-manifest', '/tmp/before.json', '--out-dir', '/tmp/release', '--skip-browser', 'true'],
  ]) assert.throws(() => parseReleaseArgs(argv), { code: 'RELEASE_USAGE' });
});

test('release and compatibility outputs reject the protected store and descendants before creation', () => {
  const root = createOwnedTempDir('holdem-output-containment');
  const protectedRoot = path.join(root, 'game');
  fs.mkdirSync(protectedRoot, { mode: 0o700 });
  const sentinel = path.join(protectedRoot, 'sentinel');
  fs.writeFileSync(sentinel, 'preserve');
  for (const target of [protectedRoot, path.join(protectedRoot, 'nested', 'evidence')]) {
    assert.throws(() => assertEvidenceDestination(target, { protectedRoot }), { code: 'PROTECTED_STORE_OUTPUT_FORBIDDEN' });
    assert.throws(() => assertCompatibilityDestination(target, { protectedRoot }), { code: 'PROTECTED_STORE_OUTPUT_FORBIDDEN' });
    assert.equal(fs.existsSync(path.join(protectedRoot, 'nested')), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  }
  assert.equal(assertEvidenceDestination(path.join(root, 'evidence'), { protectedRoot }), path.join(fs.realpathSync(root), 'evidence'));
});

test('terminal result validation rejects absent, nonterminal, skipped, failed and tampered evidence', () => {
  assert.throws(() => assertTerminalProcessResult(null), { code: 'PROCESS_RESULT_MISSING' });
  const missing = terminal();
  delete missing.exitCode;
  assert.throws(() => assertTerminalProcessResult(missing), { code: 'PROCESS_RESULT_MALFORMED' });
  assert.throws(() => assertTerminalProcessResult(terminal({ exitCode: null })), { code: 'PROCESS_RESULT_NONTERMINAL' });
  assert.throws(() => assertTerminalProcessResult(terminal({ skipped: true })), { code: 'PROCESS_RESULT_SKIPPED' });
  assert.throws(() => assertTerminalProcessResult(terminal({ exitCode: 1 })), { code: 'PROCESS_RESULT_FAILED' });
  assert.throws(() => assertTerminalProcessResult(terminal({ timedOut: true, signal: 'SIGKILL' })), { code: 'PROCESS_RESULT_FAILED' });
  assert.throws(() => assertTerminalProcessResult({ ...terminal(), stdout: 'changed' }), { code: 'PROCESS_RESULT_TAMPERED' });
  assert.equal(assertTerminalProcessResult(terminal()).exitCode, 0);
});

test('expected-failure process evidence still requires a clean terminal nonzero assertion failure', () => {
  const failed = terminal({ exitCode: 1, expectedFailure: true });
  assert.equal(assertExpectedFailureProcessResult(failed).exitCode, 1);
  assert.throws(() => assertExpectedFailureProcessResult(terminal({ expectedFailure: true })), { code: 'PROCESS_RESULT_UNEXPECTED_PASS' });
  assert.throws(() => assertExpectedFailureProcessResult(terminal({
    exitCode: null, signal: 'SIGKILL', timedOut: true, expectedFailure: true,
  })), { code: 'PROCESS_RESULT_FAILED' });
  assert.throws(() => assertExpectedFailureProcessResult({ ...failed, stderr: 'changed' }), { code: 'PROCESS_RESULT_TAMPERED' });
});

test('owned cleanup evidence requires a marker bound to a valid hashed receipt', () => {
  const dir = createOwnedTempDir('holdem-release-cleanup-receipt');
  const file = path.join(dir, 'cleanup.json');
  const body = {
    schemaVersion: 1,
    marker: 'OWNED_FIXTURE_CLEANUP',
    pid: 123,
    evidence: [{ kind: 'directory', removed: true }],
  };
  const receiptSha256 = sha256(JSON.stringify(body));
  fs.writeFileSync(file, JSON.stringify({ ...body, receiptSha256 }));
  const stdout = `OWNED_FIXTURE_CLEANUP receipt=${file} sha256=${receiptSha256}\n`;
  const processResult = terminal({ stdout, stdoutSha256: sha256(stdout) });
  assert.equal(assertOwnedCleanupEvidence(processResult).length, 1);
  assert.throws(() => assertOwnedCleanupEvidence(terminal()), { code: 'OWNED_CLEANUP_MISSING' });
  fs.writeFileSync(file, JSON.stringify({ ...body, receiptSha256: '00'.repeat(32) }));
  assert.throws(() => assertOwnedCleanupEvidence(processResult), { code: 'OWNED_CLEANUP_INVALID' });
});

test('source snapshot requires the same clean HEAD and tree before and after verification', () => {
  const snapshot = {
    startHead: SHA,
    startTree: '1'.repeat(40),
    startChanges: '',
    startUntracked: '',
    endHead: SHA,
    endTree: '1'.repeat(40),
    endChanges: '',
    endUntracked: '',
  };
  assert.equal(assertSourceSnapshot(snapshot).pass, true);
  for (const patch of [
    { startChanges: 'M tools/example.js' },
    { startUntracked: 'tools/untracked.js' },
    { endChanges: 'M shared/reference.js' },
    { endUntracked: 'test/new.test.js' },
    { endHead: '2'.repeat(40) },
    { endTree: '2'.repeat(40) },
  ]) assert.throws(() => assertSourceSnapshot({ ...snapshot, ...patch }), { code: 'SOURCE_PIN_CHANGED' });
});

test('release evidence rejects missing, empty, skipped, failed and tampered gate receipts', () => {
  const complete = releaseReceipts();
  assert.throws(() => validateReleaseEvidence(complete, {
    sourcePin: SHA, completedGates: RELEASE_SEQUENCE,
  }), { code: 'RELEASE_GATE_EVIDENCE_INVALID' }, 'a self-hashed generic wrapper is not gate evidence');
  assert.throws(() => validateReleaseEvidence(complete, {
    sourcePin: SHA,
    completedGates: ['clean-tree', ...RELEASE_SEQUENCE.filter((name) => name !== 'clean-tree')],
  }), { code: 'RELEASE_SEQUENCE_INVALID' });

  const missing = { ...complete };
  delete missing.browser;
  assert.throws(() => validateReleaseEvidence(missing, { sourcePin: SHA }), { code: 'RELEASE_RECEIPT_MISSING' });

  for (const bad of [
    {},
    gate('browser', SHA, { skipped: true }),
    gate('browser', SHA, { pass: false, status: 'failed' }),
    { ...gate('browser'), receiptSha256: '00'.repeat(32) },
  ]) {
    const receipts = { ...complete, browser: bad };
    assert.throws(() => validateReleaseEvidence(receipts, { sourcePin: SHA }), (error) =>
      ['RELEASE_RECEIPT_EMPTY', 'RELEASE_RECEIPT_SKIPPED', 'RELEASE_RECEIPT_FAILED', 'RELEASE_RECEIPT_TAMPERED'].includes(error.code));
  }
  assert.throws(() => validateReleaseEvidence(complete, { sourcePin: 'b'.repeat(40) }), { code: 'SOURCE_PIN_CHANGED' });
});

test('browser proof is unavailable when source, result, named checks, cleanup or user-store proof is missing', () => {
  const root = createOwnedTempDir('holdem-release-browser-root');
  const browserDir = createOwnedTempDir('holdem-release-browser-out');
  assert.throws(() => assertBrowserEvidence({ repoRoot: root, browserDir }), { code: 'BROWSER_MODULE_MISSING' });

  fs.mkdirSync(path.join(root, 'test', 'browser'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test', 'helpers'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test', 'browser', 'learning-journey.mjs'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'test', 'helpers', 'learning-browser-fixture.mjs'), 'export {}\n');
  assert.throws(() => assertBrowserEvidence({ repoRoot: root, browserDir }), { code: 'BROWSER_RESULT_MISSING' });

  const resultPath = path.join(browserDir, 'result.json');
  const protectedStore = path.join(root, 'game');
  fs.mkdirSync(protectedStore, { mode: 0o700 });
  const valid = {
    schemaVersion: 1,
    pass: true,
    checks: [{ name: 'desktop-layout', pass: true }, { name: 'mobile-layout', pass: true }],
    pending: [],
    cleanup: { pass: true, errors: [] },
    userStore: {
      path: fs.realpathSync(protectedStore),
      beforeExists: true,
      afterExists: true,
      before: 'a'.repeat(64),
      after: 'a'.repeat(64),
      unchanged: true,
    },
  };
  fs.writeFileSync(resultPath, JSON.stringify({ ...valid, checks: [] }));
  assert.throws(() => assertBrowserEvidence({ repoRoot: root, browserDir }), { code: 'BROWSER_PROOF_FAILED' });
  fs.writeFileSync(resultPath, JSON.stringify({ ...valid, cleanup: { pass: false, errors: ['leak'] } }));
  assert.throws(() => assertBrowserEvidence({ repoRoot: root, browserDir }), { code: 'BROWSER_PROOF_FAILED' });
  fs.writeFileSync(resultPath, JSON.stringify({ ...valid, userStore: { before: 'a', after: 'b', unchanged: false } }));
  assert.throws(() => assertBrowserEvidence({ repoRoot: root, browserDir }), { code: 'BROWSER_PROOF_FAILED' });
  fs.writeFileSync(resultPath, JSON.stringify(valid));
  assert.throws(() => assertBrowserEvidence({
    repoRoot: root, browserDir, expectedUserStoreDir: protectedStore,
  }), { code: 'BROWSER_PROOF_FAILED' }, 'two layout checks cannot stand in for the full journey');
  const unitChecks = ['desktop-layout', 'mobile-layout'];
  assert.equal(assertBrowserEvidence({
    repoRoot: root, browserDir, expectedUserStoreDir: protectedStore, requiredChecks: unitChecks,
  }).pass, true);
  fs.writeFileSync(resultPath, JSON.stringify({ ...valid, userStore: { ...valid.userStore, path: root } }));
  assert.throws(() => assertBrowserEvidence({
    repoRoot: root, browserDir, expectedUserStoreDir: protectedStore, requiredChecks: unitChecks,
  }), { code: 'BROWSER_PROOF_FAILED' });
  fs.writeFileSync(resultPath, JSON.stringify({ ...valid, userStore: { ...valid.userStore, before: 'not-a-hash', after: 'not-a-hash' } }));
  assert.throws(() => assertBrowserEvidence({ repoRoot: root, browserDir, expectedUserStoreDir: protectedStore, requiredChecks: unitChecks }), { code: 'BROWSER_PROOF_FAILED' });
  const missingExistence = { ...valid, userStore: { ...valid.userStore } };
  delete missingExistence.userStore.beforeExists;
  fs.writeFileSync(resultPath, JSON.stringify(missingExistence));
  assert.throws(() => assertBrowserEvidence({
    repoRoot: root, browserDir, expectedUserStoreDir: protectedStore, requiredChecks: unitChecks,
  }), { code: 'BROWSER_PROOF_FAILED' });
});

test('direct verifier invocation reports malformed baseline without starting release gates', async () => {
  const dir = createOwnedTempDir('holdem-release-cli');
  const manifest = path.join(dir, 'before.json');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(manifest, '[]\n');
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = registerOwnedProcess(spawn(process.execPath, [
    path.join(ROOT, 'tools', 'verify-learning-release.js'),
    '--baseline', 'invalid', '--before-manifest', manifest, '--out-dir', outDir,
  ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }), 'release verifier invalid invocation');
  const result = await wait(child);
  assert.equal(result.exitCode, 1, result.stderr);
  const receipt = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'));
  assert.equal(receipt.pass, false);
  assert.equal(receipt.code, 'RELEASE_USAGE');
  assert.deepEqual(receipt.completedGates, []);
  assert.equal(fs.existsSync(path.join(outDir, 'full-suite.json')), false);
});

test('compatibility CLI requires the pinned baseline and one output directory', () => {
  assert.deepEqual(parseCompatibilityArgs(['--baseline', SHA, '--out-dir', '/tmp/compat']), {
    baseline: SHA,
    outDir: '/tmp/compat',
  });
  for (const argv of [
    [],
    ['--baseline', SHA],
    ['--baseline', 'short', '--out-dir', '/tmp/compat'],
    ['--baseline', SHA, '--out-dir', '/tmp/compat', '--simulate-old-reader', 'true'],
  ]) assert.throws(() => parseCompatibilityArgs(argv), { code: 'COMPATIBILITY_USAGE' });
});

test('accepted and delivered actions remain unresolved until authoritative reconciliation', () => {
  for (const phase of ['accepted', 'delivered']) {
    assert.deepEqual(classifyRollbackSafety({ phase }, null), {
      safe: false,
      code: 'OUTCOME_UNRESOLVED',
    });
    assert.deepEqual(classifyRollbackSafety({ phase }, { legal: { decisionId: 'same' } }), {
      safe: false,
      code: 'OUTCOME_UNRESOLVED',
    });
  }
  assert.deepEqual(classifyRollbackSafety({ phase: 'consumed' }, { legal: { decisionId: null } }), {
    safe: true,
    code: null,
  });
});

test('default integration evidence requires controlled20 completion, four exclusions and stop-resume once', () => {
  const default20 = {
    policySeed: 'seed',
    firstDeck: ['As'],
    hands: Array.from({ length: 20 }, (_, index) => ({ handNo: index + 1 })),
    actions: [],
    completedHands: 20,
    supported: 7,
    unsupported: 13,
    studyReused: true,
    gameMetricsPreserved: true,
    nextStop: {
      requestId: 'request-1',
      decisionId: 'd-1-preflop-0',
      stoppingBeforeDelivery: true,
      receiptPhase: 'delivered',
      engineApplied: false,
      queuedForResume: true,
      recoveredOnce: true,
    },
  };
  const exclusions = ['limp', 'off-size', 'multiway', 'four-bet'].map((scenario) => ({
    scenario, transcript: [], decisionId: 'd-1-preflop-0', status: 'unsupported', reason: scenario,
  }));
  const stdout = [
    `S8_DEFAULT20_EVIDENCE ${JSON.stringify(default20)}`,
    ...exclusions.map((row) => `S8_EXCLUSION_EVIDENCE ${JSON.stringify(row)}`),
  ].join('\n');
  assert.equal(parseDefaultIntegrationOutput({ stdout }).default20.nextStop.recoveredOnce, true);
  delete default20.nextStop.recoveredOnce;
  assert.throws(() => parseDefaultIntegrationOutput({
    stdout: stdout.replace(/S8_DEFAULT20_EVIDENCE .*/, `S8_DEFAULT20_EVIDENCE ${JSON.stringify(default20)}`),
  }), { code: 'RELEASE_GATE_EVIDENCE_INVALID' });
});

test('actual archived readers reject new identities without writes and compatible code resumes', { timeout: studyBudget({ coldStarts: 2, warmCalls: 4, extraMs: 60_000 }) }, async () => {
  const dir = createOwnedTempDir('holdem-compatibility-proof');
  const outDir = path.join(dir, 'evidence');
  const result = await runCompatibilityVerification({ baseline: SHA, outDir });
  assert.equal(validateCompatibilityResult(result), result);
  assert.equal(result.pass, true);
  assert.equal(result.baseline, SHA);
  assert.equal(result.archive.commit, SHA);
  assert.equal(result.archive.actualReader, true);
  assert.deepEqual(result.profile.processedIds, result.profile.currentProcessedIds);
  assert.deepEqual(result.profile.processedDigests, result.profile.currentProcessedDigests);
  assert.equal(result.profile.processedDigests[result.profile.processedIds[0]], 'cd'.repeat(32));
  assert.equal(result.profile.eventBytesBeforeSha256, result.profile.eventBytesAfterSha256);
  assert.equal(result.profile.evaluationBytesBeforeSha256, result.profile.evaluationBytesAfterSha256);
  assert.deepEqual(result.profile.priorCommands.map((row) => [row.command, row.exitCode]), [
    ['rebuild', 0], ['show', 0], ['apply', 0],
  ]);
  for (const row of result.profile.priorCommands) {
    assert.ok(Array.isArray(row.argv) && row.argv[0] === process.execPath);
    assert.equal(typeof row.stdout, 'string');
    assert.equal(row.stderr, '');
    assert.equal(row.signal, null);
    assert.equal(row.timedOut, false);
    assert.match(row.receiptSha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(result.priorReaders.policy.code, 'POLICY_CONFIG_MISMATCH');
  assert.equal(result.priorReaders.policy.wrote, false);
  assert.equal(result.priorReaders.bank.code, 'UNSUPPORTED_MISTAKES');
  assert.equal(result.priorReaders.bank.wrote, false);
  assert.equal(result.priorReaders.lockProtection.code, 'LOCKED');
  assert.equal(result.priorReaders.lockProtection.wrote, false);
  assert.equal(result.priorReaders.lockProtection.process.exitCode, 1);
  assert.equal(result.priorReaders.lockProtection.process.expectedFailure, true);
  assert.equal(result.currentResume.profileSchemaVersion, 6);
  assert.equal(result.currentResume.policyId, 'tag-v2');
  assert.equal(result.currentResume.bankEvidenceCount, 1);
  assert.equal(result.currentResume.bankPayloadSha256, 'cd'.repeat(32));
  assert.deepEqual(result.rollback.actionRecovery.unresolvedAccepted, {
    phase: 'accepted', code: 'OUTCOME_UNRESOLVED', sideEffects: false,
  });
  assert.deepEqual(result.rollback.actionRecovery.unresolvedDelivered, {
    phase: 'delivered', code: 'OUTCOME_UNRESOLVED', sideEffects: false,
  });
  assert.equal(result.rollback.actionRecovery.synchronized.phase, 'consumed');
  assert.equal(result.rollback.actionRecovery.engine.applicationCount, 1);
  assert.equal(result.rollback.actionRecovery.engine.invocationCount, 1);
  assert.equal(result.rollback.actionRecovery.engine.chosenAction, 'fold');
  assert.ok(result.rollback.actionRecovery.engine.afterStateVersion > result.rollback.actionRecovery.engine.beforeStateVersion);
  assert.equal(result.rollback.actionRecovery.recoveryRelay.dead, true);
  assert.match(result.rollback.actionRecovery.recoveryRelay.startTime, /^(?:utc-v1:|win32-v1:)/);
  assert.equal(result.rollback.serviceRotation.firstStop.stopped, true);
  assert.equal(result.rollback.serviceRotation.rebootstrap.instanceRotated, true);
  assert.equal(result.rollback.serviceRotation.rebootstrap.drillTokenRotated, true);
  assert.equal(result.rollback.serviceRotation.rebootstrap.controlTokenRotated, true);
  assert.equal(result.rollback.serviceRotation.drillIdempotence.count, 1);
  assert.equal(result.rollback.serviceRotation.drillIdempotence.sameSession, true);
  assert.doesNotMatch(JSON.stringify(result), /#token=[0-9a-f]{64}|"(?:drill|control)Token":"[0-9a-f]{64}"/);
  assert.doesNotMatch(JSON.stringify(result), /"sessionToken":"[^"]+"/);
  assert.match(result.rollback.actionRecovery.setupCommands[0].stdout, /"sessionToken":"\[redacted\]"/);
  assert.doesNotMatch(result.rollback.actionRecovery.setupCommands[0].stdout, /"sessionToken":"[0-9a-f]+"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8')), result);
});

function writeHashed(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`;
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { path: relative, sha256: sha256(bytes) };
}

test('workflow provenance validates exact S1-S8 receipts and real commit ancestry', async () => {
  const root = createOwnedTempDir('holdem-workflow-input');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const amendment = writeHashed(root, 'provenance/verification-amendment.md', 'binding amendment\n');
  const sliceReceipts = [];
  for (let number = 1; number <= 8; number += 1) {
    const sliceId = `SLICE-${String(number).padStart(3, '0')}`;
    sliceReceipts.push({ sliceId, ...writeHashed(root, `receipts/${sliceId}.json`, {
      schemaVersion: 1,
      producer: 'manual-supervised-v1',
      sliceId,
      status: 'complete',
      gitAfter: SHA,
      nativeProof: false,
      nativeController: 'retired-unavailable',
    }) });
  }
  const input = {
    schemaVersion: 1,
    producer: 'manual-supervised-v1',
    sourcePin: { commit, tree },
    methodology: {
      mode: 'manual-supervised-v1',
      amendmentPath: amendment.path,
      amendmentSha256: amendment.sha256,
      nativeController: 'retired-unavailable',
      nativeProof: false,
    },
    sliceReceipts,
  };
  const valid = await validateWorkflowInput(input, { bundleRoot: root, repoRoot: ROOT, sourcePin: { commit, tree } });
  assert.equal(valid.sliceReceipts.length, 8);
  fs.appendFileSync(path.join(root, amendment.path), 'tampered');
  await assert.rejects(() => validateWorkflowInput(input, {
    bundleRoot: root, repoRoot: ROOT, sourcePin: { commit, tree },
  }), { code: 'WORKFLOW_INPUT_INVALID' });
  await assert.rejects(() => validateWorkflowInput({
    ...input,
    methodology: { ...input.methodology, amendmentPath: '../escape.md' },
  }, { bundleRoot: root, repoRoot: ROOT, sourcePin: { commit, tree } }), { code: 'WORKFLOW_INPUT_INVALID' });
});

test('final review input binds two distinct non-author PASS reports to the final commit and tree', () => {
  const root = createOwnedTempDir('holdem-final-review-input');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const reviews = ['semantic-reviewer', 'executability-reviewer'].map((reviewerId) => {
    const report = writeHashed(root, `reviews/${reviewerId}.json`, {
      schemaVersion: 1,
      producer: 'manual-supervised-v1',
      reviewerId,
      sourcePin: { commit, tree },
      scope: 'full-release',
      verdict: 'PASS',
      authoredSource: false,
      unresolvedBlockingFindings: 0,
      verification: { mode: 'static', evidence: [`${reviewerId} report`] },
      findings: [],
    });
    return { reviewerId, reportPath: report.path, reportSha256: report.sha256 };
  });
  const input = { schemaVersion: 1, producer: 'manual-supervised-v1', sourcePin: { commit, tree }, reviews };
  assert.equal(validateFinalReviewInput(input, {
    bundleRoot: root, sourcePin: { commit, tree },
  }).reviews.length, 2);
  const outside = createOwnedTempDir('holdem-review-path-escape');
  fs.mkdirSync(path.join(outside, 'reports'));
  const originalReportBytes = fs.readFileSync(path.join(root, reviews[0].reportPath));
  fs.writeFileSync(path.join(outside, 'reports', 'semantic.json'), originalReportBytes);
  fs.symlinkSync(path.join(outside, 'reports'), path.join(root, 'linked-reports'));
  assert.throws(() => validateFinalReviewInput({
    ...input,
    reviews: [{
      reviewerId: reviews[0].reviewerId,
      reportPath: 'linked-reports/semantic.json',
      reportSha256: sha256(originalReportBytes),
    }, reviews[1]],
  }, { bundleRoot: root, sourcePin: { commit, tree } }), { code: 'FINAL_REVIEWS_INPUT_INVALID' });
  assert.throws(() => validateFinalReviewInput({ ...input, reviews: [reviews[0], reviews[0]] }, {
    bundleRoot: root, sourcePin: { commit, tree },
  }), { code: 'FINAL_REVIEWS_INPUT_INVALID' });
  const authorReport = writeHashed(root, 'reviews/author.json', {
    schemaVersion: 1,
    producer: 'manual-supervised-v1',
    reviewerId: 'author',
    sourcePin: { commit, tree },
    scope: 'full-release',
    verdict: 'PASS',
    authoredSource: false,
    unresolvedBlockingFindings: 0,
    verification: { mode: 'static', evidence: ['self review'] },
    findings: [],
  });
  assert.throws(() => validateFinalReviewInput({
    ...input,
    reviews: [{ reviewerId: 'author', reportPath: authorReport.path, reportSha256: authorReport.sha256 }, reviews[1]],
  }, { bundleRoot: root, sourcePin: { commit, tree } }), { code: 'FINAL_REVIEWS_INPUT_INVALID' });
  const blockingReport = writeHashed(root, 'reviews/blocking.json', {
    schemaVersion: 1,
    producer: 'manual-supervised-v1',
    reviewerId: 'blocking-reviewer',
    sourcePin: { commit, tree },
    scope: 'full-release',
    verdict: 'PASS',
    authoredSource: false,
    unresolvedBlockingFindings: 0,
    verification: { mode: 'static', evidence: ['review'] },
    findings: [{ blocking: true, resolved: false }],
  });
  assert.throws(() => validateFinalReviewInput({
    ...input,
    reviews: [{ reviewerId: 'blocking-reviewer', reportPath: blockingReport.path, reportSha256: blockingReport.sha256 }, reviews[1]],
  }, { bundleRoot: root, sourcePin: { commit, tree } }), { code: 'FINAL_REVIEWS_INPUT_INVALID' });
  const report = JSON.parse(fs.readFileSync(path.join(root, reviews[0].reportPath), 'utf8'));
  report.unresolvedBlockingFindings = 1;
  fs.writeFileSync(path.join(root, reviews[0].reportPath), JSON.stringify(report));
  assert.throws(() => validateFinalReviewInput(input, {
    bundleRoot: root, sourcePin: { commit, tree },
  }), { code: 'FINAL_REVIEWS_INPUT_INVALID' });
});

test('release browser contract accepts the complete journey and requires mobile review coverage', async () => {
  const { journeyScenarioPlan } = await import('./browser/learning-journey.mjs');
  const browserDir = createOwnedTempDir('holdem-release-journey-proof');
  const protectedStore = createOwnedTempDir('holdem-release-journey-protected');
  const result = { schemaVersion: 1, pass: true, pending: [], cleanup: { pass: true, errors: [] },
    checks: Object.entries(journeyScenarioPlan).map(([name, spec]) => ({ name, pass: true,
      requiredViewports: [...spec.viewports], observedViewports: [...spec.viewports] })),
    userStore: { path: fs.realpathSync(protectedStore), beforeExists: true, afterExists: true,
      before: 'a'.repeat(64), after: 'a'.repeat(64), unchanged: true } };
  const resultPath = path.join(browserDir, 'result.json');
  fs.writeFileSync(resultPath, JSON.stringify(result));
  assert.equal(assertBrowserEvidence({ repoRoot: ROOT, browserDir, expectedUserStoreDir: protectedStore }).pass, true);
  result.checks.find((row) => row.name === 'review-reopen-unread').observedViewports = ['1280x900'];
  fs.writeFileSync(resultPath, JSON.stringify(result));
  assert.throws(() => assertBrowserEvidence({ repoRoot: ROOT, browserDir, expectedUserStoreDir: protectedStore }), { code: 'BROWSER_PROOF_FAILED' });
});

for (const helper of ['release', 'compatibility']) {
  test(`${helper} supervisor bounds inherited pipes after the leader exits`, async () => {
    const root = createOwnedTempDir('holdem-supervisor-descendant');
    const { runProcess } = await import('../tools/verify-learning-release.js');
    const { runOwned } = await import('./helpers/verify-learning-compatibility.mjs');
    const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},2500)'],{stdio:['ignore',1,2]});console.log(child.pid);child.unref();`;
    const result = await (helper === 'release' ? runProcess : runOwned)(process.execPath, ['-e', code],
      { cwd: root, tmpDir: root, timeoutMs: process.platform === 'win32' ? 15000 : 400, allowFailure: true });
    assert.equal(result.exitCode, 0, 'leader must have exited before deadline');
    assert.equal(result.timedOut, process.platform !== 'win32', 'Windows Job closes descendants at leader exit');
    assert.ok(result.durationMs < (process.platform === 'win32' ? 15000 : 1800), `descendant kept pipes open for ${result.durationMs}ms`);
    const pid = Number(result.stdout.trim()); assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const state = processState(pid);
    assert.ok(!state || /^Z/.test(state), 'descendant must be dead or awaiting OS reaping');
  });
}

test('policy benchmark evidence requires finite measurements and fixed producer acceptance', async () => {
  const { validatePolicyBenchmark } = await import('../tools/verify-learning-release.js');
  const { benchmarkPolicies } = await import('../tools/benchmark-policies.js');
  const valid = benchmarkPolicies(); assert.equal(validatePolicyBenchmark(valid), valid);
  for (const key of ['nutsFoldMax', 'nutsAirDifferenceMin', 'tricksterBaselineMeanTv']) {
    for (const value of [undefined, null, '0.8', NaN, Infinity]) {
      const bad = structuredClone(valid); bad.thresholds[key] = value;
      assert.throws(() => validatePolicyBenchmark(bad), undefined, `${key}=${String(value)}`);
    }
  }
  for (const mutate of [
    (r) => { delete r.acceptance; },
    (r) => { r.acceptance.nutsFoldMax = 1; },
    (r) => { r.thresholds.comboParticipationOrder = []; },
    (r) => { r.thresholds.stationCallMinusTag = 0; },
    (r) => { delete r.scenarios; },
    (r) => { delete r.evidenceKind; },
    ...['humanOutcomeEvidence', 'solverOrGtoEvidence', 'opponentModel', 'preflopGrid'].map((key) => (r) => { delete r.methodology[key]; }),
  ]) { const bad = structuredClone(valid); mutate(bad); assert.throws(() => validatePolicyBenchmark(bad)); }
});

test('release and compatibility baseline cannot be replaced with another SHA40', () => {
  const other = 'f'.repeat(40);
  assert.throws(() => parseReleaseArgs(['--baseline', other, '--before-manifest', '/tmp/before.json', '--out-dir', '/tmp/out']), { code: 'RELEASE_USAGE' });
  assert.throws(() => parseCompatibilityArgs(['--baseline', other, '--out-dir', '/tmp/out']), { code: 'COMPATIBILITY_USAGE' });
});

test('release protected main root is absolute for a relative git common directory', async () => {
  const { releaseMainRoot } = await import('../tools/verify-learning-release.js');
  const repo = createOwnedTempDir('holdem-release-main-root');
  execFileSync('git', ['init', '--quiet', repo]);
  assert.equal(releaseMainRoot(repo), fs.realpathSync(repo));
});

test('release evidence output cannot reuse stale results or an existing execution', async () => {
  const { reserveReleaseOutput } = await import('../tools/verify-learning-release.js');
  for (const artifact of ['browser', 'compatibility', 'result.json', 'full-suite.json']) {
    const dir = createOwnedTempDir('holdem-release-stale-output');
    fs.writeFileSync(path.join(dir, artifact), 'prior evidence');
    assert.throws(() => reserveReleaseOutput(dir), { code: 'RELEASE_OUTPUT_NOT_FRESH' });
    assert.equal(fs.readFileSync(path.join(dir, artifact), 'utf8'), 'prior evidence');
  }
  const fresh = createOwnedTempDir('holdem-release-new-output');
  fs.writeFileSync(path.join(fresh, 'workflow.input.json'), '{}');
  reserveReleaseOutput(fresh);
  assert.throws(() => reserveReleaseOutput(fresh), { code: 'RELEASE_OUTPUT_NOT_FRESH' });
});

test('release entrypoint rejects reused output before reading inputs and preserves prior result', async () => {
  const { runReleaseVerification } = await import('../tools/verify-learning-release.js');
  const outDir = createOwnedTempDir('holdem-release-stale-entry');
  fs.writeFileSync(path.join(outDir, 'result.json'), 'prior result');
  await assert.rejects(runReleaseVerification({ baseline: SHA, beforeManifest: path.join(outDir, 'missing'), outDir }), { code: 'RELEASE_OUTPUT_NOT_FRESH' });
  assert.equal(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'), 'prior result');
});

for (const helper of ['release', 'compatibility']) {
  test(`${helper} supervisor closes descendants even when their output is detached`, async (t) => {
    const root = createOwnedTempDir('holdem-supervisor-normal-exit');
    const { runProcess } = await import('../tools/verify-learning-release.js');
    const { runOwned } = await import('./helpers/verify-learning-compatibility.mjs');
    const code = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:'ignore'});console.log(child.pid);child.unref();`;
    // A broken supervisor still leaves only a finite owned fixture.
    t.after(() => new Promise((resolve) => setTimeout(resolve, 1600)));
    const result = await (helper === 'release' ? runProcess : runOwned)(process.execPath, ['-e', code],
      { cwd: root, tmpDir: root, timeoutMs: process.platform === 'win32' ? 15000 : 400, allowFailure: true });
    assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
    const pid = Number(result.stdout.trim()); assert.ok(Number.isSafeInteger(pid) && pid > 1);
    const state = processState(pid);
    assert.ok(!state || /^Z/.test(state), `normal exit left descendant alive: ${state}`);
  });
}

test('executed producer summaries bind the fresh browser and compatibility artifacts', async () => {
  const { validateProducerSummary } = await import('../tools/verify-learning-release.js');
  const result = { pass: true, pending: [], baseline: SHA, receiptSha256: 'a'.repeat(64) };
  assert.equal(validateProducerSummary('browser', { stdout: '{"pass":true,"pending":[]}\n' }, result), result);
  assert.equal(validateProducerSummary('compatibility', { stdout: JSON.stringify({ pass: true, baseline: SHA, receiptSha256: result.receiptSha256 }) }, result), result);
  for (const [kind, stdout] of [['browser', ''], ['browser', '{"pass":true}'], ['browser', '{"pass":false,"pending":[]}'], ['compatibility', JSON.stringify({ pass: true, baseline: SHA, receiptSha256: 'b'.repeat(64) })]]) {
    assert.throws(() => validateProducerSummary(kind, { stdout }, result), { code: 'PRODUCER_SUMMARY_MISMATCH' });
  }
});

test('malformed release CLI retry preserves the prior evidence bundle', async () => {
  const dir = createOwnedTempDir('holdem-release-malformed-retry');
  const file = path.join(dir, 'result.json'); fs.writeFileSync(file, 'previous result');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const child = registerOwnedProcess(spawn(process.execPath, [path.join(ROOT, 'tools/verify-learning-release.js'),
    '--baseline', 'invalid', '--before-manifest', path.join(dir, 'missing'), '--out-dir', dir],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }), 'release malformed retry');
  const result = await wait(child); assert.equal(result.exitCode, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'previous result');
  assert.match(result.stderr, /RELEASE_OUTPUT_NOT_FRESH/);
});

function processState(pid) {
  if (process.platform === 'win32') {
    try { process.kill(pid, 0); return 'alive'; }
    catch (error) { assert.equal(error.code, 'ESRCH'); return ''; }
  }
  try { return execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch (error) { assert.equal(error.status, 1, 'ps must only report a missing process'); return ''; }
}

for (const helper of ['release', 'compatibility']) {
  test(`${helper} owned command preserves literal argv and a nonzero leader exit`, async () => {
    const root = createOwnedTempDir('holdem-owned-argv');
    const { runProcess } = await import('../tools/verify-learning-release.js');
    const { runOwned } = await import('./helpers/verify-learning-compatibility.mjs');
    const literal = ['', 'two words', 'trailing\\', 'quote"inside', 'slashes\\\\"quote',
      '$HOME; $(echo forbidden)', '`echo forbidden`', '한글', 'line\nbreak'];
    const result = await (helper === 'release' ? runProcess : runOwned)(process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)));process.exitCode=7', '--', ...literal],
      { cwd: root, tmpDir: root, timeoutMs: 15000, allowFailure: true });
    assert.equal(result.exitCode, 7); assert.equal(result.signal, null);
    assert.equal(result.timedOut, false); assert.equal(result.outputLimited, false);
    assert.equal(result.spawnError, null); assert.deepEqual(JSON.parse(result.stdout), literal);
  });
}
