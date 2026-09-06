#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertBenchmark } from './benchmark-policies.js';
import { isDeepStrictEqual } from 'node:util';
import { assertTapResult, verifyCleanupReceipt } from '../test/helpers/assert-tap.mjs';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const REQUIRED_BASELINE = 'a4822d74a4251f199b52e0f02914ef659ea905dd';
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const REQUIRED_GATES = Object.freeze([
  'full-suite',
  'syntax-archive',
  'policy-benchmark',
  'browser',
  'compatibility-migration-rollback',
  'default-learning-integration',
  'scoped-mutations',
  'protected-store',
  'source-stability',
  'owned-cleanup',
]);
const BROWSER_CHECK_PLAN = Object.freeze({
  'desktop-layout': ['1280x900'],
  'mobile-layout': ['390x844'],
  'pot-sizing': ['1280x900'],
  'short-all-in': ['390x844'],
  'accepted-response-loss-before-delivery': ['1280x900'],
  'accepted-response-loss-after-delivery': ['390x844'],
  'stable-request-after-refresh': ['1280x900'],
  'sse-reconnect-relay-restart': ['1280x900'],
  'illegal-action-correction': ['1280x900'],
  'training-detail-source': ['1280x900'],
  'training-reading-context': ['1280x900'],
  'review-reopen-unread': ['390x844', '1280x900'],
  'study-fragment-header-auth': ['390x844'],
  'study-explicit-modes': ['390x844', '1280x900'],
  'study-feedback-refresh': ['390x844', '1280x900'],
  'study-source-goal-retest': ['1280x900'],
  'no-uncaught-errors': ['1280x900', '390x844'],
  'real-user-store-unchanged': [],
});
const REQUIRED_BROWSER_CHECKS = Object.freeze(Object.keys(BROWSER_CHECK_PLAN));
const REQUIRED_FULL_SUITE_NAMES = Object.freeze([
  'REQ-003: positive-frequency choices stay allowed',
  'REQ-004: prospective snapshots carry authoritative legal actions',
  'REQ-005: new sessions use separately versioned Nit policy',
  'REQ-007: authenticated action status is available',
  'REQ-009: free practice contains ten diverse questions',
  'REQ-007: pot preset includes the call in pot size',
  'REQ-010: drill health advertises an authenticated study capability',
  'REQ-001: new store sessions default to policy learning',
]);

function coded(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function receiptBody(value) {
  const { receiptSha256: ignored, ...body } = value;
  return body;
}

function seal(value) {
  const body = receiptBody(value);
  return { ...body, receiptSha256: sha256(JSON.stringify(body)) };
}

function record(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertSealed(value) {
  if (!record(value) || !SHA256.test(value.receiptSha256 ?? '')
    || sha256(JSON.stringify(receiptBody(value))) !== value.receiptSha256) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
  return value;
}

function assertSafeDirectory(dir, { create = false } = {}) {
  const resolved = path.resolve(dir);
  if (create) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded('UNSAFE_OUTPUT_DIRECTORY');
  return resolved;
}

function canonicalCandidate(target) {
  const resolved = path.resolve(target);
  const suffix = [];
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw coded('UNSAFE_OUTPUT_DIRECTORY');
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

function defaultProtectedRoot(repoRoot = ROOT) {
  const commonText = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const common = path.isAbsolute(commonText) ? commonText : path.resolve(repoRoot, commonText);
  return canonicalCandidate(path.join(path.dirname(common), 'game'));
}

export function assertEvidenceDestination(outDir, { protectedRoot = defaultProtectedRoot() } = {}) {
  if (typeof outDir !== 'string' || !outDir || outDir.includes('\0')) throw coded('UNSAFE_OUTPUT_DIRECTORY');
  const output = canonicalCandidate(outDir);
  const protectedPath = canonicalCandidate(protectedRoot);
  if (output === protectedPath || output.startsWith(`${protectedPath}${path.sep}`)) {
    throw coded('PROTECTED_STORE_OUTPUT_FORBIDDEN');
  }
  return output;
}

function readRegular(file, maxBytes = MAX_JSON_BYTES) {
  const resolved = path.resolve(file);
  const before = fs.lstatSync(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw coded('UNSAFE_EVIDENCE_FILE');
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.nlink !== 1 || opened.size > maxBytes) throw coded('UNSAFE_EVIDENCE_FILE');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== bytes.length) {
      throw coded('UNSAFE_EVIDENCE_FILE');
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function readJson(file, missingCode = 'RELEASE_RECEIPT_MISSING') {
  try {
    return JSON.parse(readRegular(file).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw coded(missingCode);
    if (error.code) throw error;
    throw coded('RELEASE_RECEIPT_MALFORMED');
  }
}

function writeJson(file, value) {
  const resolved = path.resolve(file);
  assertSafeDirectory(path.dirname(resolved), { create: true });
  const tmp = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, resolved);
  } finally {
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export function parseReleaseArgs(argv) {
  const usage = () => { throw coded('RELEASE_USAGE', 'usage: verify-learning-release.js --baseline SHA40 --before-manifest FILE --out-dir DIR'); };
  if (!Array.isArray(argv) || argv.length !== 6) usage();
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!['--baseline', '--before-manifest', '--out-dir'].includes(flag)
      || typeof value !== 'string' || value.length === 0 || Object.hasOwn(values, flag)) usage();
    values[flag] = value;
  }
  if (values['--baseline'] !== REQUIRED_BASELINE || !values['--before-manifest'] || !values['--out-dir']) usage();
  return {
    baseline: values['--baseline'],
    beforeManifest: values['--before-manifest'],
    outDir: values['--out-dir'],
  };
}

function assertProcessReceiptIntegrity(result) {
  if (result == null) throw coded('PROCESS_RESULT_MISSING');
  if (typeof result !== 'object' || Array.isArray(result)) throw coded('PROCESS_RESULT_MALFORMED');
  if (result.skipped === true) throw coded('PROCESS_RESULT_SKIPPED');
  for (const key of ['command', 'cwd', 'startedAt', 'endedAt', 'durationMs', 'exitCode', 'signal',
    'timedOut', 'outputLimited', 'spawnError', 'stdout', 'stderr', 'stdoutSha256', 'stderrSha256', 'receiptSha256']) {
    if (!Object.hasOwn(result, key)) throw coded('PROCESS_RESULT_MALFORMED');
  }
  if (!Array.isArray(result.command) || result.command.length === 0
    || typeof result.cwd !== 'string' || !Number.isSafeInteger(result.durationMs) || result.durationMs < 0
    || (result.exitCode !== null && !Number.isInteger(result.exitCode))
    || (result.signal !== null && typeof result.signal !== 'string')
    || typeof result.timedOut !== 'boolean' || typeof result.outputLimited !== 'boolean'
    || (result.spawnError !== null && typeof result.spawnError !== 'object')
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || !SHA256.test(result.stdoutSha256) || !SHA256.test(result.stderrSha256)
    || !SHA256.test(result.receiptSha256)) throw coded('PROCESS_RESULT_MALFORMED');
  if (result.exitCode === null && result.signal === null && result.spawnError === null) {
    throw coded('PROCESS_RESULT_NONTERMINAL');
  }
  if (sha256(result.stdout) !== result.stdoutSha256 || sha256(result.stderr) !== result.stderrSha256
    || sha256(JSON.stringify(receiptBody(result))) !== result.receiptSha256) {
    throw coded('PROCESS_RESULT_TAMPERED');
  }
  return result;
}

export function assertTerminalProcessResult(result) {
  assertProcessReceiptIntegrity(result);
  if (result.exitCode !== 0 || result.signal !== null || result.timedOut
    || result.outputLimited || result.spawnError !== null) throw coded('PROCESS_RESULT_FAILED');
  return result;
}

export function assertExpectedFailureProcessResult(result) {
  assertProcessReceiptIntegrity(result);
  if (result.signal !== null || result.timedOut || result.outputLimited || result.spawnError !== null) {
    throw coded('PROCESS_RESULT_FAILED');
  }
  if (result.expectedFailure !== true || result.exitCode === 0) throw coded('PROCESS_RESULT_UNEXPECTED_PASS');
  return result;
}

function readOwnedCleanupEvidence(result) {
  const markers = result.stdout.split('\n').map((line) => line.match(
    /^\s*#?\s*OWNED_FIXTURE_CLEANUP receipt=(\S+) sha256=([0-9a-f]{64})\s*$/,
  )).filter(Boolean);
  if (markers.length === 0) throw coded('OWNED_CLEANUP_MISSING');
  try {
    return markers.map((marker) => verifyCleanupReceipt(marker[1], marker[2]));
  } catch {
    throw coded('OWNED_CLEANUP_INVALID');
  }
}

export function assertOwnedCleanupEvidence(result) {
  assertTerminalProcessResult(result);
  return readOwnedCleanupEvidence(result);
}

export function assertSourceSnapshot(snapshot) {
  if (!snapshot || !SHA1.test(snapshot.startHead ?? '') || !SHA1.test(snapshot.startTree ?? '')
    || !SHA1.test(snapshot.endHead ?? '') || !SHA1.test(snapshot.endTree ?? '')
    || snapshot.startHead !== snapshot.endHead || snapshot.startTree !== snapshot.endTree
    || snapshot.startChanges !== '' || snapshot.startUntracked !== ''
    || snapshot.endChanges !== '' || snapshot.endUntracked !== '') {
    throw coded('SOURCE_PIN_CHANGED');
  }
  return { pass: true, head: snapshot.startHead, tree: snapshot.startTree };
}

function inspectNestedTerminals(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value.command) && Object.hasOwn(value, 'exitCode') && Object.hasOwn(value, 'stdoutSha256')) {
    if (value.expectedFailure === true) assertExpectedFailureProcessResult(value);
    else assertTerminalProcessResult(value);
    return;
  }
  for (const nested of Object.values(value)) inspectNestedTerminals(nested);
}

function assertGateReceipt(receipt, gateName, sourcePin) {
  if (receipt == null) throw coded('RELEASE_RECEIPT_MISSING');
  if (typeof receipt !== 'object' || Array.isArray(receipt) || Object.keys(receipt).length === 0) {
    throw coded('RELEASE_RECEIPT_EMPTY');
  }
  if (receipt.skipped === true || receipt.status === 'skipped') throw coded('RELEASE_RECEIPT_SKIPPED');
  if (receipt.gate !== gateName || receipt.pass !== true || receipt.status !== 'passed') {
    throw coded('RELEASE_RECEIPT_FAILED');
  }
  if (receipt.sourcePin !== sourcePin) throw coded('SOURCE_PIN_CHANGED');
  if (!SHA256.test(receipt.receiptSha256 ?? '')
    || sha256(JSON.stringify(receiptBody(receipt))) !== receipt.receiptSha256) {
    throw coded('RELEASE_RECEIPT_TAMPERED');
  }
  inspectNestedTerminals(receipt.evidence);
  return receipt;
}

function assertCompatibilityProcessSummary(result) {
  assertSealed(result);
  if (typeof result.command !== 'string' || !Array.isArray(result.argv) || result.argv.length === 0
    || typeof result.cwd !== 'string' || !Number.isSafeInteger(result.durationMs) || result.durationMs < 0
    || (result.expectedFailure === true ? result.exitCode === 0 : result.exitCode !== 0)
    || result.signal !== null || result.timedOut !== false
    || result.outputLimited !== false || result.spawnError !== null
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || sha256(result.stdout) !== result.stdoutSha256 || sha256(result.stderr) !== result.stderrSha256) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
}

function assertExpectedRelaySummary(result) {
  assertSealed(result);
  if (result.command !== 'actual relay' || !Array.isArray(result.argv)
    || result.argv.includes(undefined) || !result.argv.includes('[redacted]')
    || !SHA256.test(result.commandSha256 ?? '') || result.exitCode !== null
    || result.signal !== 'SIGTERM' || result.expectedSignal !== 'SIGTERM'
    || result.timedOut !== false || result.outputLimited !== false || result.spawnError !== null
    || sha256(result.stdout) !== result.stdoutSha256 || sha256(result.stderr) !== result.stderrSha256) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
}

function assertCleanupReceiptObject(receipt) {
  assertSealed(receipt);
  if (receipt.marker !== 'OWNED_FIXTURE_CLEANUP' || !Array.isArray(receipt.evidence)
    || receipt.evidence.some((row) => row?.removed !== true && row?.closed !== true && row?.dead !== true)) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
}

function assertBrowserResult(result, { expectedPath = null, requiredChecks = REQUIRED_BROWSER_CHECKS } = {}) {
  const checks = Array.isArray(result?.checks) ? result.checks : [];
  const names = new Set(checks.filter((row) => row?.pass === true).map((row) => row.name));
  const fullPlan = requiredChecks === REQUIRED_BROWSER_CHECKS;
  const viewportInvalid = fullPlan && checks.some((row) => {
    const expected = BROWSER_CHECK_PLAN[row.name];
    return !expected || !Array.isArray(row.requiredViewports) || !Array.isArray(row.observedViewports)
      || JSON.stringify(row.requiredViewports) !== JSON.stringify(expected)
      || expected.some((viewport) => !row.observedViewports.includes(viewport));
  });
  if (!record(result) || result.schemaVersion !== 1 || result.pass !== true || result.blocked || result.error
    || !Array.isArray(result.pending) || result.pending.length !== 0 || checks.length === 0
    || checks.some((row) => !row || row.pass !== true || typeof row.name !== 'string')
    || names.size !== checks.length || (fullPlan && checks.length !== REQUIRED_BROWSER_CHECKS.length)
    || viewportInvalid
    || !Array.isArray(requiredChecks) || requiredChecks.length === 0
    || requiredChecks.some((name) => !names.has(name))
    || result.cleanup?.pass !== true || !Array.isArray(result.cleanup.errors) || result.cleanup.errors.length !== 0
    || typeof result.userStore?.path !== 'string' || !path.isAbsolute(result.userStore.path)
    || typeof result.userStore?.beforeExists !== 'boolean' || typeof result.userStore?.afterExists !== 'boolean'
    || result.userStore.beforeExists !== true || result.userStore.afterExists !== true
    || !SHA256.test(result.userStore?.before ?? '')
    || !SHA256.test(result.userStore?.after ?? '')
    || result.userStore.unchanged !== true || result.userStore.before !== result.userStore.after
    || (expectedPath !== null && result.userStore.path !== expectedPath)) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
  return result;
}

export function validateCompatibilityResult(result) {
  assertSealed(result);
  const commands = result.profile?.priorCommands;
  if (result.schemaVersion !== 1 || result.pass !== true || result.baseline !== REQUIRED_BASELINE
    || result.archive?.commit !== result.baseline || result.archive?.actualReader !== true
    || result.profile?.sourceSchemaVersion !== 4 || result.profile?.priorSchemaVersion !== 3
    || JSON.stringify(result.profile.processedIds) !== JSON.stringify(result.profile.currentProcessedIds)
    || JSON.stringify(result.profile.processedDigests) !== JSON.stringify(result.profile.currentProcessedDigests)
    || result.profile.eventBytesBeforeSha256 !== result.profile.eventBytesAfterSha256
    || result.profile.evaluationBytesBeforeSha256 !== result.profile.evaluationBytesAfterSha256
    || !Array.isArray(commands) || commands.length !== 3
    || JSON.stringify(commands.map((row) => row.command)) !== JSON.stringify(['rebuild', 'show', 'apply'])
    || result.priorReaders?.policy?.code !== 'POLICY_CONFIG_MISMATCH'
    || result.priorReaders.policy.wrote !== false
    || result.priorReaders?.bank?.code !== 'UNSUPPORTED_MISTAKES'
    || result.priorReaders.bank.wrote !== false
    || result.priorReaders?.lockProtection?.code !== 'LOCKED'
    || result.priorReaders.lockProtection.wrote !== false
    || result.priorReaders.lockProtection.process?.expectedFailure !== true
    || result.currentResume?.profileSchemaVersion !== 4 || result.currentResume?.policyId !== 'tag-v2'
    || !Number.isSafeInteger(result.currentResume?.bankEvidenceCount) || result.currentResume.bankEvidenceCount < 1
    || result.rollback?.actionRecovery?.unresolvedAccepted?.phase !== 'accepted'
    || result.rollback.actionRecovery.unresolvedAccepted.code !== 'OUTCOME_UNRESOLVED'
    || result.rollback.actionRecovery.unresolvedAccepted.sideEffects !== false
    || result.rollback?.actionRecovery?.unresolvedDelivered?.phase !== 'delivered'
    || result.rollback.actionRecovery.unresolvedDelivered.code !== 'OUTCOME_UNRESOLVED'
    || result.rollback.actionRecovery.unresolvedDelivered.sideEffects !== false
    || result.rollback.actionRecovery?.synchronized?.phase !== 'consumed'
    || result.rollback.actionRecovery.synchronized.reason !== 'ACTION_APPLIED'
    || result.rollback.actionRecovery?.engine?.applicationCount !== 1
    || result.rollback.actionRecovery.engine.invocationCount !== 1
    || result.rollback.actionRecovery.engine.chosenAction !== 'fold'
    || !(result.rollback.actionRecovery.engine.afterStateVersion > result.rollback.actionRecovery.engine.beforeStateVersion)
    || result.rollback.actionRecovery?.recoveryRelay?.dead !== true
    || !Number.isSafeInteger(result.rollback.actionRecovery.recoveryRelay.pid)
    || !/^utc-v1:/.test(result.rollback.actionRecovery.recoveryRelay.startTime ?? '')
    || !Array.isArray(result.rollback.actionRecovery.setupCommands)
    || result.rollback.actionRecovery.setupCommands.length !== 2
    || result.rollback?.serviceRotation?.firstStop?.stopped !== true
    || result.rollback?.serviceRotation?.rebootstrap?.instanceRotated !== true
    || result.rollback.serviceRotation.rebootstrap.drillTokenRotated !== true
    || result.rollback.serviceRotation.rebootstrap.controlTokenRotated !== true
    || result.rollback.serviceRotation.rebootstrap.oldDrillStatus !== 401
    || result.rollback.serviceRotation.rebootstrap.oldControlStatus !== 401
    || result.rollback.serviceRotation.rebootstrap.stopped !== true
    || result.rollback?.serviceRotation?.drillIdempotence?.count !== 1
    || result.rollback.serviceRotation.drillIdempotence.sameSession !== true
    || result.limitations?.providerSmoke !== 'not-run'
    || result.limitations?.humanLearningEvidence !== 'none'
    || result.limitations?.solverCorrectnessEvidence !== 'none'
    || /"(?:drillToken|controlToken)":"[0-9a-f]{64}"/.test(JSON.stringify(result))) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
  assertCompatibilityProcessSummary(result.archive.archiveProcess);
  assertCompatibilityProcessSummary(result.archive.extractProcess);
  for (const command of commands) assertCompatibilityProcessSummary(command);
  assertCompatibilityProcessSummary(result.priorReaders.policy.process);
  assertCompatibilityProcessSummary(result.priorReaders.bank.process);
  assertCompatibilityProcessSummary(result.priorReaders.lockProtection.process);
  result.rollback.actionRecovery.setupCommands.forEach(assertCompatibilityProcessSummary);
  assertExpectedRelaySummary(result.rollback.actionRecovery.relay);
  return result;
}

function exactMarkerJson(stdout, marker) {
  const rows = stdout.split('\n').filter((line) => line.includes(`${marker} `));
  return rows.map((line) => {
    const index = line.indexOf(`${marker} `);
    try { return JSON.parse(line.slice(index + marker.length + 1)); }
    catch { throw coded('RELEASE_GATE_EVIDENCE_INVALID'); }
  });
}

export function parseDefaultIntegrationOutput(result) {
  const defaultRows = exactMarkerJson(result.stdout, 'S8_DEFAULT20_EVIDENCE');
  const exclusions = exactMarkerJson(result.stdout, 'S8_EXCLUSION_EVIDENCE');
  if (defaultRows.length !== 1 || defaultRows[0].completedHands !== 20
    || !Number.isSafeInteger(defaultRows[0].supported) || defaultRows[0].supported < 1
    || defaultRows[0].studyReused !== true || defaultRows[0].gameMetricsPreserved !== true
    || !Array.isArray(defaultRows[0].firstDeck) || !Array.isArray(defaultRows[0].hands)
    || defaultRows[0].hands.length !== 20 || !Array.isArray(defaultRows[0].actions)
    || typeof defaultRows[0].policySeed !== 'string' || defaultRows[0].policySeed.length === 0
    || typeof defaultRows[0].nextStop?.requestId !== 'string'
    || typeof defaultRows[0].nextStop?.decisionId !== 'string'
    || defaultRows[0].nextStop.stoppingBeforeDelivery !== true
    || defaultRows[0].nextStop.receiptPhase !== 'delivered'
    || defaultRows[0].nextStop.engineApplied !== false
    || defaultRows[0].nextStop.queuedForResume !== true
    || defaultRows[0].nextStop.recoveredOnce !== true
    || exclusions.length !== 4
    || JSON.stringify(exclusions.map((row) => row.scenario).sort()) !== JSON.stringify(['four-bet', 'limp', 'multiway', 'off-size'])
    || exclusions.some((row) => row.status !== 'unsupported' || !Array.isArray(row.transcript)
      || typeof row.decisionId !== 'string' || typeof row.reason !== 'string')) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
  return { default20: defaultRows[0], exclusions };
}

function assertDefaultIntegrationResult(result) {
  const validation = assertTapResult(result, {
    testName: 'S8 full: default 20-hand production session records support then study remains usable and reusable',
    minTests: 10,
  });
  return {
    ...parseDefaultIntegrationOutput(result),
    tap: {
      tests: tapCount(result.stdout, 'tests'),
      fail: tapCount(result.stdout, 'fail'),
      skipped: tapCount(result.stdout, 'skipped'),
      cancelled: tapCount(result.stdout, 'cancelled'),
      todo: tapCount(result.stdout, 'todo'),
      cleanup: validation.cleanupReceipts.map((file) => readJson(file, 'OWNED_CLEANUP_MISSING')),
    },
  };
}

export function validatePolicyBenchmark(result) {
  const acceptance = {
    nutsFoldMax: 0.05, nutsAirDifferenceMin: 0.5, marginalPriceViolationCountMax: 0,
    comboParticipationStrictOrder: ['nit-v2', 'tag-v2', 'lag-v2', 'maniac-v2'],
    stationCallMinusTagMinExclusive: 0, tricksterBaselineMeanTvMin: 0.05, safetyViolationCountMax: 0,
  };
  const metrics = ['nutsFoldMax', 'nutsAirDifferenceMin', 'tricksterBaselineMeanTv', 'stationCallMinusTag'];
  if (result?.schemaVersion !== 1 || result.claims?.humanSkill !== false || result.claims?.gto !== false
    || result.claims?.solverAccuracy !== false || result.methodology?.authority !== 'local-card-aware-heuristic'
    || result.preflop?.comboCount !== 1326 || result.preflop?.classCount !== 169
    || !isDeepStrictEqual(Object.keys(result.personaResponses ?? {}).sort(),
      ['nit-v2', 'tag-v2', 'lag-v2', 'calling-station-v2', 'maniac-v2', 'trickster-v2'].sort())
    || result.evidenceKind !== 'deterministic-heuristic-policy-behavior'
    || !isDeepStrictEqual(result.methodology, { authority: 'local-card-aware-heuristic',
      opponentModel: 'uniform-unknown-single-opponent-sampling', humanOutcomeEvidence: 'none', solverOrGtoEvidence: 'none',
      preflopGrid: '169 classes weighted to 1326 combinations', preflopScenarios: 'derived-once-from-engine-state-transitions' })
    || !isDeepStrictEqual(result.acceptance, acceptance)
    || metrics.some((key) => !Number.isFinite(result.thresholds?.[key])
      || result.thresholds[key] < 0 || result.thresholds[key] > 1)) {
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
  assertBenchmark(result);
  return result;
}

function assertGateSpecificEvidence(gateName, evidence) {
  if (!record(evidence) || Object.keys(evidence).length === 0) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  switch (gateName) {
    case 'full-suite': {
      assertTerminalProcessResult(evidence.terminal);
      if (evidence.terminal.node !== 'v26.0.0') throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      if (!record(evidence.summary) || evidence.summary.tests < 1111 || evidence.summary.fail !== 0
        || evidence.summary.skipped !== 0 || evidence.summary.cancelled !== 0 || evidence.summary.todo !== 0
        || !Array.isArray(evidence.summary.cleanup) || evidence.summary.cleanup.length === 0) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      evidence.summary.cleanup.forEach(assertCleanupReceiptObject);
      if (tapCount(evidence.terminal.stdout, 'tests') !== evidence.summary.tests
        || tapCount(evidence.terminal.stdout, 'fail') !== evidence.summary.fail
        || tapCount(evidence.terminal.stdout, 'skipped') !== evidence.summary.skipped
        || tapCount(evidence.terminal.stdout, 'cancelled') !== evidence.summary.cancelled
        || tapCount(evidence.terminal.stdout, 'todo') !== evidence.summary.todo) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      for (const name of REQUIRED_FULL_SUITE_NAMES) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (!new RegExp(`^ok \\d+ - ${escaped}$`, 'm').test(evidence.terminal.stdout)) {
          throw coded('RELEASE_GATE_EVIDENCE_INVALID');
        }
      }
      break;
    }
    case 'syntax-archive': {
      const { changed, currentResults, cleanResults } = evidence;
      if (!Array.isArray(changed) || changed.length === 0 || !Array.isArray(currentResults)
        || !Array.isArray(cleanResults) || currentResults.length !== changed.length
        || cleanResults.length !== changed.length) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      for (const result of [...currentResults, ...cleanResults]) {
        if (!changed.includes(result?.path)) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
        assertTerminalProcessResult(result.receipt);
      }
      assertTerminalProcessResult(evidence.archiveResult);
      assertTerminalProcessResult(evidence.extractResult);
      break;
    }
    case 'policy-benchmark': {
      assertTerminalProcessResult(evidence.terminal);
      const result = evidence.result;
      validatePolicyBenchmark(result);
      break;
    }
    case 'compatibility-migration-rollback':
      assertTerminalProcessResult(evidence.terminal);
      if (!Array.isArray(evidence.cleanup) || evidence.cleanup.length === 0) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      evidence.cleanup.forEach(assertCleanupReceiptObject);
      validateCompatibilityResult(evidence.result);
      break;
    case 'default-learning-integration':
      assertTerminalProcessResult(evidence.terminal);
      if (!record(evidence.parsed) || evidence.parsed.default20?.completedHands !== 20
        || evidence.parsed.default20?.supported < 1 || evidence.parsed.exclusions?.length !== 4
        || evidence.parsed.tap?.tests < 10 || evidence.parsed.tap?.fail !== 0
        || evidence.parsed.tap?.skipped !== 0 || evidence.parsed.tap?.cancelled !== 0
        || evidence.parsed.tap?.todo !== 0 || !Array.isArray(evidence.parsed.tap?.cleanup)
        || evidence.parsed.tap.cleanup.length === 0) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      evidence.parsed.tap.cleanup.forEach(assertCleanupReceiptObject);
      if (!/^ok \d+ - S8 full: default 20-hand production session records support then study remains usable and reusable$/m
        .test(evidence.terminal.stdout)) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      if (JSON.stringify(parseDefaultIntegrationOutput(evidence.terminal))
        !== JSON.stringify({ default20: evidence.parsed.default20, exclusions: evidence.parsed.exclusions })) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      break;
    case 'browser':
      assertTerminalProcessResult(evidence.terminal);
      if (typeof evidence.protectedPath !== 'string' || !path.isAbsolute(evidence.protectedPath)) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      assertBrowserResult(evidence.result, { expectedPath: evidence.protectedPath });
      break;
    case 'scoped-mutations': {
      const expected = mutationSpecs();
      if (!Array.isArray(evidence.mutations) || evidence.mutations.length !== expected.length) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      for (const spec of expected) {
        const observed = evidence.mutations.find((row) => row?.name === spec.name);
        if (!observed || observed.source !== spec.file || observed.test !== spec.test) {
          throw coded('RELEASE_GATE_EVIDENCE_INVALID');
        }
        assertTerminalProcessResult(observed.syntax);
        assertExpectedFailureProcessResult(observed.result);
        if (!Array.isArray(observed.cleanup) || observed.cleanup.length === 0) {
          throw coded('RELEASE_GATE_EVIDENCE_INVALID');
        }
        observed.cleanup.forEach(assertCleanupReceiptObject);
        if (!spec.expected.test(observed.result.stdout)) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      break;
    }
    case 'protected-store':
      if (evidence.pass !== true || !Number.isSafeInteger(evidence.beforeCount) || evidence.beforeCount < 1
        || evidence.afterCount !== evidence.beforeCount || evidence.beforeSha256 !== evidence.afterSha256
        || !SHA256.test(evidence.beforeSha256 ?? '') || typeof evidence.path !== 'string'
        || !path.isAbsolute(evidence.path) || evidence.beforeExists !== true || evidence.afterExists !== true) {
        throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      }
      break;
    case 'source-stability':
      assertSealed(evidence);
      assertSourceSnapshot(evidence.snapshot);
      break;
    case 'owned-cleanup':
      assertSealed(evidence);
      if (evidence.marker !== 'RELEASE_OWNED_CLEANUP' || evidence.removed !== true
        || !SHA256.test(evidence.identitySha256 ?? '')) throw coded('RELEASE_GATE_EVIDENCE_INVALID');
      break;
    default:
      throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
}

export function validateReleaseEvidence(receipts, { sourcePin, completedGates } = {}) {
  if (!SHA1.test(sourcePin ?? '')) throw coded('SOURCE_PIN_CHANGED');
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) throw coded('RELEASE_RECEIPT_MISSING');
  if (completedGates !== undefined && JSON.stringify(completedGates) !== JSON.stringify(REQUIRED_GATES)) {
    throw coded('RELEASE_SEQUENCE_INVALID');
  }
  for (const gateName of REQUIRED_GATES) {
    if (!Object.hasOwn(receipts, gateName)) throw coded('RELEASE_RECEIPT_MISSING');
    assertGateReceipt(receipts[gateName], gateName, sourcePin);
  }
  try {
    for (const gateName of REQUIRED_GATES) assertGateSpecificEvidence(gateName, receipts[gateName].evidence);
  } catch (error) {
    if (error.code === 'SOURCE_PIN_CHANGED') throw error;
    throw coded('RELEASE_GATE_EVIDENCE_INVALID');
  }
  return { pass: true, sourcePin, completedGates: [...REQUIRED_GATES] };
}

function assertBrowserSources(repoRoot) {
  for (const relative of ['test/browser/learning-journey.mjs', 'test/helpers/learning-browser-fixture.mjs']) {
    try {
      const stat = fs.lstatSync(path.join(repoRoot, relative));
      if (!stat.isFile() || stat.isSymbolicLink()) throw coded('BROWSER_MODULE_MISSING');
    } catch (error) {
      if (error.code === 'BROWSER_MODULE_MISSING') throw error;
      throw coded('BROWSER_MODULE_MISSING');
    }
  }
}

export function assertBrowserEvidence({
  repoRoot = ROOT,
  browserDir,
  expectedUserStoreDir,
  requireArtifacts = false,
  requiredChecks = REQUIRED_BROWSER_CHECKS,
} = {}) {
  assertBrowserSources(path.resolve(repoRoot));
  if (!browserDir) throw coded('BROWSER_RESULT_MISSING');
  const result = readJson(path.join(browserDir, 'result.json'), 'BROWSER_RESULT_MISSING');
  const expectedPath = expectedUserStoreDir === undefined ? null
    : (fs.existsSync(expectedUserStoreDir) ? fs.realpathSync(expectedUserStoreDir) : path.resolve(expectedUserStoreDir));
  try { assertBrowserResult(result, { expectedPath, requiredChecks }); }
  catch { throw coded('BROWSER_PROOF_FAILED'); }
  if (requireArtifacts) {
    for (const relative of ['trace.json', 'table-desktop.png', 'study-mobile.png']) {
      try { readRegular(path.join(browserDir, relative), 64 * 1024 * 1024); }
      catch { throw coded('BROWSER_PROOF_FAILED'); }
    }
  }
  return result;
}

function commandEnvironment(tmpDir) {
  const allowed = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'CI', 'NO_COLOR'];
  return {
    ...Object.fromEntries(allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    TMPDIR: tmpDir,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  };
}

export async function runProcess(command, args, {
  cwd = ROOT,
  timeoutMs = 120_000,
  resultFile,
  tmpDir = os.tmpdir(),
  allowFailure = false,
} = {}) {
  if (!Array.isArray(args) || typeof command !== 'string' || !command || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw coded('PROCESS_ARGUMENT_INVALID');
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let outputLimited = false;
  let spawnError = null;
  const child = spawn(command, args, {
    cwd,
    env: commandEnvironment(tmpDir),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => {
    // The leader may exit before descendants close their inherited pipes.
    if (Number.isSafeInteger(child.pid) && child.pid > 1) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const append = (which, chunk) => {
    if (which === 'stdout') stdout += chunk;
    else stderr += chunk;
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
      outputLimited = true;
      stop();
    }
  };
  child.stdout.setEncoding('utf8').on('data', (chunk) => append('stdout', chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk) => append('stderr', chunk));
  child.on('error', (error) => { spawnError = { code: error.code ?? null, message: error.message }; });
  const [exitCode, signal] = await new Promise((resolve) => child.on('close', (...result) => resolve(result)));
  clearTimeout(timer);
  stop(); // A successful leader exit must not strand same-group descendants.
  const result = seal({
    schemaVersion: 1,
    node: process.version,
    command: [command, ...args],
    cwd: path.resolve(cwd),
    startedAt,
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    exitCode,
    signal,
    timedOut,
    outputLimited,
    spawnError,
    stdout,
    stderr,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
    ...(allowFailure ? { expectedFailure: true } : {}),
  });
  if (resultFile) writeJson(resultFile, result);
  if (!allowFailure) assertTerminalProcessResult(result);
  return result;
}

async function gitText(args, options = {}) {
  const result = await runProcess('git', args, { ...options, timeoutMs: options.timeoutMs ?? 30_000 });
  return result.stdout.trim();
}

function gateReceipt(gate, sourcePin, evidence) {
  return seal({ schemaVersion: 1, gate, status: 'passed', pass: true, sourcePin, evidence });
}

function tapCount(stdout, label) {
  const matches = [...stdout.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gm'))];
  if (matches.length === 0) throw coded('FULL_SUITE_TAP_INVALID');
  return Number(matches.at(-1)[1]);
}

function validateFullSuite(result) {
  const validation = assertTapResult(result, { minTests: 1111 });
  if (tapCount(result.stdout, 'tests') < 1111 || tapCount(result.stdout, 'fail') !== 0
    || tapCount(result.stdout, 'skipped') !== 0 || tapCount(result.stdout, 'cancelled') !== 0
    || tapCount(result.stdout, 'todo') !== 0) throw coded('FULL_SUITE_TAP_INVALID');
  return {
    tests: tapCount(result.stdout, 'tests'),
    fail: tapCount(result.stdout, 'fail'),
    skipped: tapCount(result.stdout, 'skipped'),
    cancelled: tapCount(result.stdout, 'cancelled'),
    todo: tapCount(result.stdout, 'todo'),
    cleanup: validation.cleanupReceipts.map((file) => readJson(file, 'OWNED_CLEANUP_MISSING')),
  };
}

function changedScriptPaths(output) {
  return [...new Set(output.split('\n').map((row) => row.trim()).filter(Boolean)
    .filter((file) => /\.(?:c|m)?js$/.test(file)))].sort();
}

async function syntaxGate({ baseline, sourcePin, outDir, cleanTree, tmpDir, archiveResult, extractResult }) {
  const changed = changedScriptPaths(await gitText(['diff', '--name-only', `${baseline}...${sourcePin}`, '--'], { tmpDir }));
  if (changed.length === 0) throw coded('SYNTAX_SCOPE_EMPTY');
  const currentResults = [];
  const cleanResults = [];
  for (const [kind, root, bucket] of [['current', ROOT, currentResults], ['clean', cleanTree, cleanResults]]) {
    for (const [index, relative] of changed.entries()) {
      const file = path.join(root, relative);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw coded('SYNTAX_SOURCE_MISSING');
      const receipt = await runProcess(process.execPath, ['--check', file], {
        cwd: root,
        tmpDir,
        timeoutMs: 30_000,
        resultFile: path.join(outDir, `syntax-${kind}`, `${String(index).padStart(3, '0')}.json`),
      });
      bucket.push({ path: relative, receipt });
    }
  }
  const receipt = gateReceipt('syntax-archive', sourcePin, {
    changed, currentResults, cleanResults, archiveResult, extractResult,
  });
  writeJson(path.join(outDir, 'syntax.json'), receipt);
  return receipt;
}

function parseJsonOutput(result, code) {
  try { return JSON.parse(result.stdout.trim()); }
  catch { throw coded(code); }
}

function mutationSpecs() {
  return [
    {
      name: 'allowed-grade-acceptance', file: 'shared/reference.js',
      search: "new Set(['preferred', 'mixed', 'low-frequency'])",
      replace: "new Set(['preferred', 'mixed'])",
      test: 'test/learning-metrics.test.js',
      expected: /not ok .*mixed and low-frequency actions do not create practice candidates/m,
    },
    {
      name: 'tv-calibration', file: 'training/profile-aggregator.js',
      search: '1 - 0.5 * difference', replace: '1 - difference',
      test: 'test/learning-metrics.test.js',
      expected: /not ok .*20\/0 choices use exact total-variation agreement/m,
    },
    {
      name: 'pot-sizing', file: 'server/public/table-controls.js',
      search: 'actorBet + legal.callAmount + fraction * (legal.potTotal + legal.callAmount)',
      replace: 'actorBet + fraction * legal.potTotal',
      test: 'test/table-ux.test.js', expected: /not ok .*REQ-007: pot preset includes the call in pot size/m,
    },
    {
      name: 'hidden-input-isolation', file: 'training/process-review.js',
      search: 'chosenAction: { action: snapshot.chosenAction.action, amount: snapshot.chosenAction.amount },',
      replace: 'chosenAction: { ...snapshot.chosenAction },',
      test: 'test/decision-time-review.test.js',
      expected: /not ok .*nested extra outcome fields cannot ride on allowed process objects/m,
    },
    {
      name: 'receipt-rejection', file: 'server/action-receipts.js',
      search: "const fail = () => coded('ACTION_RECEIPT_CORRUPT');",
      replace: "const fail = () => coded('ACTION_RECEIPT_IGNORED');",
      test: 'test/action-receipts.test.js',
      expected: /not ok .*corrupt, unknown-schema, wrong-epoch and noncanonical receipts are preserved and fail startup/m,
    },
    {
      name: 'source-qualification', file: 'shared/reference.js',
      search: '&& source.contentSha256 === CANONICAL_REFERENCE_SOURCE.contentSha256',
      replace: '&& typeof source.contentSha256 === \'string\'',
      test: 'test/learning-metrics.test.js',
      expected: /not ok .*unverified source identities cannot complete a canonical calibration group/m,
    },
    {
      name: 'latest-rejection-anchor', file: 'server/action-receipts.js',
      search: 'const historical = receipt.rejections.at(-1);',
      replace: 'const historical = receipt.rejections.at(0);',
      test: 'test/action-receipts.test.js',
      expected: /not ok .*S4 R4: the latest historical anchor restores and permits authoritative advancement/m,
    },
    {
      name: 'game-practice-separation', file: 'training/profile-aggregator.js',
      search: "return ['practice', 'drill', 'retest'].includes(event.origin) ? 'practice' : 'game';",
      replace: "return 'game';",
      test: 'test/learning-metrics.test.js',
      expected: /not ok .*practice observations cannot change game totals or calibration/m,
    },
  ];
}

function replaceExactlyOnce(file, search, replacement) {
  const source = readRegular(file).toString('utf8');
  const first = source.indexOf(search);
  if (first < 0 || source.indexOf(search, first + search.length) >= 0) throw coded('MUTATION_TARGET_INVALID');
  fs.writeFileSync(file, source.replace(search, replacement));
}

async function mutationGate({ sourcePin, outDir, cleanTree, tempRoot, tmpDir }) {
  const evidence = [];
  for (const [index, spec] of mutationSpecs().entries()) {
    const root = path.join(tempRoot, `mutation-${index}`);
    fs.cpSync(cleanTree, root, { recursive: true, errorOnExist: true });
    replaceExactlyOnce(path.join(root, spec.file), spec.search, spec.replace);
    const syntax = await runProcess(process.execPath, ['--check', path.join(root, spec.file)], {
      cwd: root,
      tmpDir,
      timeoutMs: 30_000,
      resultFile: path.join(outDir, 'mutations', `${spec.name}-syntax.json`),
    });
    const result = await runProcess(process.execPath, ['--test', '--test-reporter=tap', '--', spec.test], {
      cwd: root,
      tmpDir,
      timeoutMs: 120_000,
      allowFailure: true,
      resultFile: path.join(outDir, 'mutations', `${spec.name}.json`),
    });
    try { assertExpectedFailureProcessResult(result); }
    catch { throw coded('MUTATION_NOT_DETECTED'); }
    if (!/^TAP version 13$/m.test(result.stdout) || !spec.expected.test(result.stdout)
      || tapCount(result.stdout, 'fail') < 1 || tapCount(result.stdout, 'skipped') !== 0
      || tapCount(result.stdout, 'cancelled') !== 0 || tapCount(result.stdout, 'todo') !== 0) {
      throw coded('MUTATION_NOT_DETECTED');
    }
    const cleanup = readOwnedCleanupEvidence(result);
    evidence.push({ name: spec.name, source: spec.file, test: spec.test, syntax, result, cleanup });
  }
  const receipt = gateReceipt('scoped-mutations', sourcePin, { mutations: evidence });
  writeJson(path.join(outDir, 'mutation.json'), receipt);
  return receipt;
}

function listManifestFiles(root, prefix = 'game') {
  const rows = [];
  const visit = (dir, relative) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      const next = `${relative}/${entry.name}`;
      const stat = fs.lstatSync(file);
      if (entry.isSymbolicLink()) throw coded('USER_STORE_UNSAFE');
      if (entry.isDirectory()) visit(file, next);
      else if (entry.isFile()) rows.push({ path: next, sha256: sha256(readRegular(file, Number.MAX_SAFE_INTEGER)), size: stat.size });
      else throw coded('USER_STORE_UNSAFE');
    }
  };
  visit(root, prefix);
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function readBeforeManifest(beforeManifest) {
  const before = readJson(beforeManifest, 'USER_STORE_MANIFEST_MISSING');
  const seen = new Set();
  if (!Array.isArray(before) || before.length === 0
    || before.some((row) => {
      const normalized = typeof row?.path === 'string' ? path.posix.normalize(row.path) : '';
      const invalid = !row || normalized !== row.path || !normalized.startsWith('game/')
        || normalized.includes('/../') || !SHA256.test(row.sha256 ?? '')
        || !Number.isSafeInteger(row.size) || row.size < 0 || seen.has(normalized);
      seen.add(normalized);
      return invalid;
    })) throw coded('USER_STORE_MANIFEST_INVALID');
  return [...before].sort((left, right) => left.path.localeCompare(right.path));
}

export function releaseMainRoot(repoRoot = ROOT) {
  return path.dirname(defaultProtectedRoot(repoRoot));
}

function protectedStoreFromManifest(beforeManifest, mainRoot) {
  readBeforeManifest(beforeManifest);
  const target = path.join(mainRoot, 'game');
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded('USER_STORE_UNSAFE');
  return fs.realpathSync(target);
}

function userStoreGate({ before, actualBefore, sourcePin, outDir, userStoreTarget }) {
  const after = listManifestFiles(userStoreTarget);
  writeJson(path.join(outDir, 'user-store-after.json'), after);
  const pass = JSON.stringify(actualBefore) === JSON.stringify(before)
    && JSON.stringify(after) === JSON.stringify(before);
  const comparison = {
    schemaVersion: 1,
    pass,
    path: userStoreTarget,
    beforeExists: true,
    afterExists: fs.existsSync(userStoreTarget),
    beforeCount: before.length,
    afterCount: after.length,
    beforeSha256: sha256(JSON.stringify(actualBefore)),
    afterSha256: sha256(JSON.stringify(after)),
  };
  writeJson(path.join(outDir, 'user-store-preserved.json'), comparison);
  if (!pass) throw coded('USER_STORE_CHANGED');
  return gateReceipt('protected-store', sourcePin, comparison);
}

function exactKeys(value, keys) {
  return record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function sameSourcePin(left, right) {
  return exactKeys(left, ['commit', 'tree']) && exactKeys(right, ['commit', 'tree'])
    && SHA1.test(left.commit) && SHA1.test(left.tree)
    && left.commit === right.commit && left.tree === right.tree;
}

function bundleArtifact(bundleRoot, relative, expectedSha256, code) {
  try {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)
      || path.posix.normalize(relative) !== relative || relative.startsWith('../')
      || !SHA256.test(expectedSha256 ?? '')) throw coded(code);
    const requestedRoot = path.resolve(bundleRoot);
    const rootStat = fs.lstatSync(requestedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw coded(code);
    const root = fs.realpathSync(requestedRoot);
    const resolved = path.resolve(root, relative);
    if (!resolved.startsWith(`${root}${path.sep}`)) throw coded(code);
    const ancestors = [{ path: root, stat: rootStat }];
    let current = root;
    for (const segment of relative.split('/').slice(0, -1)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw coded(code);
      ancestors.push({ path: current, stat });
    }
    const bytes = readRegular(resolved, 8 * 1024 * 1024);
    for (const ancestor of ancestors) {
      const after = fs.lstatSync(ancestor.path);
      if (!after.isDirectory() || after.isSymbolicLink()
        || after.dev !== ancestor.stat.dev || after.ino !== ancestor.stat.ino) throw coded(code);
    }
    if (fs.realpathSync(root) !== root) throw coded(code);
    if (sha256(bytes) !== expectedSha256) throw coded(code);
    return { resolved, bytes };
  } catch {
    throw coded(code);
  }
}

export async function validateWorkflowInput(input, {
  bundleRoot,
  repoRoot = ROOT,
  sourcePin,
  tmpDir = os.tmpdir(),
} = {}) {
  const code = 'WORKFLOW_INPUT_INVALID';
  try {
    if (!exactKeys(input, ['schemaVersion', 'producer', 'sourcePin', 'methodology', 'sliceReceipts'])
      || input.schemaVersion !== 1 || input.producer !== 'manual-supervised-v1'
      || !sameSourcePin(input.sourcePin, sourcePin)
      || !exactKeys(input.methodology, [
        'mode', 'amendmentPath', 'amendmentSha256', 'nativeController', 'nativeProof',
      ])
      || input.methodology.mode !== 'manual-supervised-v1'
      || input.methodology.nativeController !== 'retired-unavailable'
      || input.methodology.nativeProof !== false
      || !Array.isArray(input.sliceReceipts) || input.sliceReceipts.length !== 8) throw coded(code);
    const amendment = bundleArtifact(
      bundleRoot, input.methodology.amendmentPath, input.methodology.amendmentSha256, code,
    );
    if (amendment.bytes.length === 0) throw coded(code);
    const seen = new Set();
    const sliceReceipts = [];
    for (let number = 1; number <= 8; number += 1) {
      const sliceId = `SLICE-${String(number).padStart(3, '0')}`;
      const entry = input.sliceReceipts.find((row) => row?.sliceId === sliceId);
      if (!entry || seen.has(entry.sliceId) || !exactKeys(entry, ['sliceId', 'path', 'sha256'])) throw coded(code);
      seen.add(entry.sliceId);
      const artifact = bundleArtifact(bundleRoot, entry.path, entry.sha256, code);
      let receipt;
      try { receipt = JSON.parse(artifact.bytes.toString('utf8')); } catch { throw coded(code); }
      if (!record(receipt) || receipt.schemaVersion !== 1 || receipt.producer !== 'manual-supervised-v1'
        || receipt.sliceId !== sliceId || receipt.status !== 'complete' || receipt.nativeProof !== false
        || (receipt.nativeController !== undefined && receipt.nativeController !== 'retired-unavailable')
        || (receipt.gitAfter !== undefined && receipt.commit !== undefined && receipt.gitAfter !== receipt.commit)) {
        throw coded(code);
      }
      const commit = receipt.gitAfter ?? receipt.commit;
      if (!SHA1.test(commit ?? '')) throw coded(code);
      const ancestry = await runProcess('git', ['merge-base', '--is-ancestor', commit, sourcePin.commit], {
        cwd: repoRoot, tmpDir, timeoutMs: 30_000,
      });
      sliceReceipts.push({ sliceId, path: entry.path, sha256: entry.sha256, commit, ancestry });
    }
    return {
      schemaVersion: 1,
      producer: input.producer,
      sourcePin: { ...input.sourcePin },
      methodology: { ...input.methodology },
      sliceReceipts,
    };
  } catch (error) {
    if (error.code === code) throw error;
    throw coded(code);
  }
}

export function validateFinalReviewInput(input, { bundleRoot, sourcePin } = {}) {
  const code = 'FINAL_REVIEWS_INPUT_INVALID';
  try {
    if (!exactKeys(input, ['schemaVersion', 'producer', 'sourcePin', 'reviews'])
      || input.schemaVersion !== 1 || input.producer !== 'manual-supervised-v1'
      || !sameSourcePin(input.sourcePin, sourcePin)
      || !Array.isArray(input.reviews) || input.reviews.length < 2) throw coded(code);
    const seen = new Set();
    const authorIds = new Set(['author', 'source-author', 'implementer', 's8-verifiers', 's8_verifiers']);
    const reviews = input.reviews.map((entry) => {
      if (!exactKeys(entry, ['reviewerId', 'reportPath', 'reportSha256'])
        || typeof entry.reviewerId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{1,127}$/.test(entry.reviewerId)
        || authorIds.has(entry.reviewerId.toLowerCase()) || seen.has(entry.reviewerId)) throw coded(code);
      seen.add(entry.reviewerId);
      const artifact = bundleArtifact(bundleRoot, entry.reportPath, entry.reportSha256, code);
      let report;
      try { report = JSON.parse(artifact.bytes.toString('utf8')); } catch { throw coded(code); }
      if (!exactKeys(report, [
        'schemaVersion', 'producer', 'reviewerId', 'sourcePin', 'scope', 'verdict',
        'authoredSource', 'unresolvedBlockingFindings', 'verification', 'findings',
      ])
        || report.schemaVersion !== 1 || report.producer !== 'manual-supervised-v1'
        || report.reviewerId !== entry.reviewerId || !sameSourcePin(report.sourcePin, sourcePin)
        || report.scope !== 'full-release' || report.verdict !== 'PASS' || report.authoredSource !== false
        || report.unresolvedBlockingFindings !== 0
        || !exactKeys(report.verification, ['mode', 'evidence'])
        || !['static', 'executed-and-static'].includes(report.verification.mode)
        || !Array.isArray(report.verification.evidence) || report.verification.evidence.length === 0
        || !Array.isArray(report.findings)
        || report.findings.some((finding) => finding?.blocking === true && finding?.resolved !== true)) throw coded(code);
      return { reviewerId: entry.reviewerId, reportPath: entry.reportPath, reportSha256: entry.reportSha256, report };
    });
    return { schemaVersion: 1, producer: input.producer, sourcePin: { ...input.sourcePin }, reviews };
  } catch (error) {
    if (error.code === code) throw error;
    throw coded(code);
  }
}

function cleanupReceipt(tempRoot, tempIdentity, sourcePin, outDir) {
  let removed = false;
  try {
    const stat = fs.lstatSync(tempRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== tempIdentity.dev || stat.ino !== tempIdentity.ino) {
      throw coded('RELEASE_TEMP_REPLACED');
    }
    fs.rmSync(tempRoot, { recursive: true, force: false });
    removed = !fs.existsSync(tempRoot);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    removed = true;
  }
  const evidence = seal({
    schemaVersion: 1,
    marker: 'RELEASE_OWNED_CLEANUP',
    identitySha256: sha256(`${tempRoot}:${tempIdentity.dev}:${tempIdentity.ino}`),
    removed,
  });
  writeJson(path.join(outDir, 'cleanup.json'), evidence);
  if (!removed) throw coded('RELEASE_CLEANUP_FAILED');
  return gateReceipt('owned-cleanup', sourcePin, evidence);
}

export function validateProducerSummary(kind, terminal, result) {
  const summaries = String(terminal.stdout).split('\n').flatMap((line) => {
    try { const value = JSON.parse(line); return record(value) && Object.hasOwn(value, 'pass') ? [value] : []; }
    catch { return []; }
  });
  const expected = kind === 'browser' ? { pass: true, pending: [] }
    : kind === 'compatibility' ? { pass: true, baseline: result.baseline, receiptSha256: result.receiptSha256 } : null;
  if (!expected || summaries.length !== 1 || !isDeepStrictEqual(summaries[0], expected)) {
    throw coded('PRODUCER_SUMMARY_MISMATCH');
  }
  return result;
}

export function reserveReleaseOutput(output) {
  // Inputs may be prepared by the parent; execution artifacts must be new.
  for (const name of ['browser', 'compatibility', 'result.json', 'full-suite.json', 'execution-owner.json']) {
    try { fs.lstatSync(path.join(output, name)); throw coded('RELEASE_OUTPUT_NOT_FRESH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  try { fs.writeFileSync(path.join(output, 'execution-owner.json'), JSON.stringify({
    schemaVersion: 1, pid: process.pid, startedAt: new Date().toISOString(), nonce: randomBytes(16).toString('hex'),
  }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') throw coded('RELEASE_OUTPUT_NOT_FRESH'); throw error; }
  return output;
}

export async function runReleaseVerification({ baseline, beforeManifest, outDir }) {
  const output = assertSafeDirectory(assertEvidenceDestination(outDir), { create: true });
  reserveReleaseOutput(output);
  const completedGates = [];
  const receipts = {};
  let tempRoot;
  let tempIdentity;
  let sourcePin = null;
  try {
    if (baseline !== REQUIRED_BASELINE) throw coded('RELEASE_USAGE');
    if (process.version !== 'v26.0.0') throw coded('NODE_RUNTIME_UNSUPPORTED');
    readRegular(beforeManifest);
    // Browser modules are an integration prerequisite. Refuse before the broad suite.
    assertBrowserSources(ROOT);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'holdem-learning-release-'));
    fs.chmodSync(tempRoot, 0o700);
    tempIdentity = fs.lstatSync(tempRoot);
    const commandTmp = path.join(tempRoot, 'command-tmp');
    fs.mkdirSync(commandTmp, { mode: 0o700 });
    await gitText(['cat-file', '-e', `${baseline}^{commit}`], { tmpDir: commandTmp });
    sourcePin = await gitText(['rev-parse', 'HEAD'], { tmpDir: commandTmp });
    if (!SHA1.test(sourcePin)) throw coded('SOURCE_PIN_INVALID');
    const sourceStart = {
      startHead: sourcePin,
      startTree: await gitText(['rev-parse', 'HEAD^{tree}'], { tmpDir: commandTmp }),
      startChanges: await gitText(['diff', '--name-only', 'HEAD', '--'], { tmpDir: commandTmp }),
      startUntracked: await gitText(['ls-files', '--others', '--exclude-standard'], { tmpDir: commandTmp }),
    };
    assertSourceSnapshot({
      ...sourceStart,
      endHead: sourceStart.startHead,
      endTree: sourceStart.startTree,
      endChanges: sourceStart.startChanges,
      endUntracked: sourceStart.startUntracked,
    });
    const mainRoot = releaseMainRoot();
    const userStoreTarget = protectedStoreFromManifest(beforeManifest, mainRoot);
    const protectedBeforeManifest = readBeforeManifest(beforeManifest);
    const protectedBefore = listManifestFiles(userStoreTarget);
    writeJson(path.join(output, 'user-store-before-actual.json'), protectedBefore);
    if (JSON.stringify(protectedBefore) !== JSON.stringify(protectedBeforeManifest)) {
      throw coded('USER_STORE_CHANGED');
    }

    const fullSuite = await runProcess('npm', ['run', 'test:ci', '--', '--test-reporter=tap'], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 15 * 60_000,
      resultFile: path.join(output, 'full-suite.json'),
    });
    fs.writeFileSync(path.join(output, 'full-suite.tap'), fullSuite.stdout, { mode: 0o600 });
    const fullSuiteSummary = validateFullSuite(fullSuite);
    receipts['full-suite'] = gateReceipt('full-suite', sourcePin, {
      terminal: fullSuite, summary: fullSuiteSummary,
    });
    writeJson(path.join(output, 'full-suite-gate.json'), receipts['full-suite']);
    completedGates.push('full-suite');

    const archive = path.join(tempRoot, 'current.tar');
    const cleanTree = path.join(tempRoot, 'clean-tree');
    fs.mkdirSync(cleanTree, { mode: 0o700 });
    const archiveResult = await runProcess('git', ['archive', '--format=tar', `--output=${archive}`, sourcePin], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 120_000,
      resultFile: path.join(output, 'clean-tree-archive-process.json'),
    });
    const extractResult = await runProcess('tar', ['-xf', archive, '-C', cleanTree], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 120_000,
      resultFile: path.join(output, 'clean-tree-extract-process.json'),
    });
    writeJson(path.join(output, 'clean-tree.json'), seal({
      schemaVersion: 1, sourcePin, archiveResult, extractResult,
    }));
    receipts['syntax-archive'] = await syntaxGate({
      baseline, sourcePin, outDir: output, cleanTree, tmpDir: commandTmp, archiveResult, extractResult,
    });
    completedGates.push('syntax-archive');

    const benchmarkProcess = await runProcess(process.execPath, ['tools/benchmark-policies.js', '--assert', '--json'], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 120_000,
      resultFile: path.join(output, 'policy-benchmark-process.json'),
    });
    const benchmark = parseJsonOutput(benchmarkProcess, 'POLICY_BENCHMARK_INVALID');
    validatePolicyBenchmark(benchmark);
    writeJson(path.join(output, 'policy-benchmark.json'), benchmark);
    receipts['policy-benchmark'] = gateReceipt('policy-benchmark', sourcePin, { terminal: benchmarkProcess, result: benchmark });
    completedGates.push('policy-benchmark');

    const browserDir = assertEvidenceDestination(path.join(output, 'browser'));
    const browserProcess = await runProcess(process.execPath, [
      'test/browser/learning-journey.mjs', '--out-dir', browserDir, '--user-store-dir', userStoreTarget,
    ], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 15 * 60_000,
      resultFile: path.join(output, 'browser-process.json'),
    });
    const browser = assertBrowserEvidence({
      repoRoot: ROOT, browserDir, expectedUserStoreDir: userStoreTarget, requireArtifacts: true,
    });
    validateProducerSummary('browser', browserProcess, browser);
    receipts.browser = gateReceipt('browser', sourcePin, {
      terminal: browserProcess, protectedPath: userStoreTarget, result: browser,
    });
    completedGates.push('browser');

    const compatibilityDir = assertEvidenceDestination(path.join(output, 'compatibility'));
    const compatibilityProcess = await runProcess(process.execPath, [
      'test/helpers/verify-learning-compatibility.mjs', '--baseline', baseline, '--out-dir', compatibilityDir,
    ], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 180_000,
      resultFile: path.join(output, 'compatibility-process.json'),
    });
    const compatibilityCleanup = assertOwnedCleanupEvidence(compatibilityProcess);
    const compatibility = readJson(path.join(compatibilityDir, 'result.json'), 'COMPATIBILITY_RESULT_MISSING');
    validateCompatibilityResult(compatibility);
    validateProducerSummary('compatibility', compatibilityProcess, compatibility);
    if (compatibility.baseline !== baseline) throw coded('COMPATIBILITY_RESULT_FAILED');
    receipts['compatibility-migration-rollback'] = gateReceipt('compatibility-migration-rollback', sourcePin, {
      terminal: compatibilityProcess, cleanup: compatibilityCleanup, result: compatibility,
    });
    completedGates.push('compatibility-migration-rollback');

    const integrationProcess = await runProcess(process.execPath, [
      '--test', '--test-reporter=tap', '--', 'test/learning-integration.test.js',
    ], {
      cwd: ROOT, tmpDir: commandTmp, timeoutMs: 180_000,
      resultFile: path.join(output, 'default-learning-integration.json'),
    });
    const integrationParsed = assertDefaultIntegrationResult(integrationProcess);
    writeJson(path.join(output, 'default-learning-evidence.json'), integrationParsed);
    receipts['default-learning-integration'] = gateReceipt('default-learning-integration', sourcePin, {
      terminal: integrationProcess, parsed: integrationParsed,
    });
    completedGates.push('default-learning-integration');

    receipts['scoped-mutations'] = await mutationGate({
      sourcePin, outDir: output, cleanTree, tempRoot, tmpDir: commandTmp,
    });
    completedGates.push('scoped-mutations');

    receipts['protected-store'] = userStoreGate({
      before: protectedBeforeManifest,
      actualBefore: protectedBefore,
      sourcePin,
      outDir: output,
      userStoreTarget,
    });
    completedGates.push('protected-store');

    const finalSourcePin = { commit: sourcePin, tree: sourceStart.startTree };
    const workflowInputPath = path.join(output, 'workflow.input.json');
    const workflowInput = readJson(workflowInputPath, 'WORKFLOW_INPUT_MISSING');
    const workflow = await validateWorkflowInput(workflowInput, {
      bundleRoot: output, repoRoot: ROOT, sourcePin: finalSourcePin, tmpDir: commandTmp,
    });
    writeJson(path.join(output, 'workflow.json'), seal(workflow));
    const finalReviewInputPath = path.join(output, 'final-reviews.input.json');
    const finalReviewInput = readJson(finalReviewInputPath, 'FINAL_REVIEWS_INPUT_MISSING');
    const finalReviews = validateFinalReviewInput(finalReviewInput, {
      bundleRoot: output, sourcePin: finalSourcePin,
    });
    writeJson(path.join(output, 'final-reviews.json'), seal(finalReviews));

    const sourceSnapshot = {
      ...sourceStart,
      endHead: await gitText(['rev-parse', 'HEAD'], { tmpDir: commandTmp }),
      endTree: await gitText(['rev-parse', 'HEAD^{tree}'], { tmpDir: commandTmp }),
      endChanges: await gitText(['diff', '--name-only', 'HEAD', '--'], { tmpDir: commandTmp }),
      endUntracked: await gitText(['ls-files', '--others', '--exclude-standard'], { tmpDir: commandTmp }),
    };
    const sourceEvidence = assertSourceSnapshot(sourceSnapshot);
    const sourceStability = seal({ schemaVersion: 1, ...sourceEvidence, snapshot: sourceSnapshot });
    writeJson(path.join(output, 'source-pin.json'), sourceStability);
    receipts['source-stability'] = gateReceipt('source-stability', sourcePin, sourceStability);
    completedGates.push('source-stability');

    receipts['owned-cleanup'] = cleanupReceipt(tempRoot, tempIdentity, sourcePin, output);
    tempRoot = null;
    completedGates.push('owned-cleanup');
    validateReleaseEvidence(receipts, { sourcePin, completedGates });
    const result = seal({
      schemaVersion: 1,
      pass: true,
      baseline,
      sourcePin,
      sourceTree: sourceStart.startTree,
      completedGates,
      receipts,
      externalInputs: {
        workflowSha256: sha256(readRegular(workflowInputPath)),
        finalReviewsSha256: sha256(readRegular(finalReviewInputPath)),
      },
      limitations: {
        nativeController: 'retired-unavailable',
        nativeProof: false,
        eslint: 'not-installed-not-run',
        stryker: 'not-installed-not-run',
        providerSmoke: 'not-run',
      },
      fullSuiteSummary,
    });
    writeJson(path.join(output, 'result.json'), result);
    return result;
  } catch (error) {
    if (tempRoot && tempIdentity) {
      try {
        receipts['owned-cleanup'] = cleanupReceipt(tempRoot, tempIdentity, sourcePin ?? baseline, output);
        completedGates.push('owned-cleanup');
      } catch (cleanupError) {
        error.cleanupCode = cleanupError.code ?? 'RELEASE_CLEANUP_FAILED';
      }
    }
    const result = seal({
      schemaVersion: 1,
      pass: false,
      baseline: SHA1.test(baseline ?? '') ? baseline : null,
      sourcePin,
      code: error.code ?? 'RELEASE_VERIFICATION_FAILED',
      ...(error.cleanupCode ? { cleanupCode: error.cleanupCode } : {}),
      completedGates,
    });
    writeJson(path.join(output, 'result.json'), result);
    return result;
  }
}

async function main() {
  let parsed;
  try {
    parsed = parseReleaseArgs(process.argv.slice(2));
  } catch (error) {
    const argv = process.argv.slice(2);
    const index = argv.indexOf('--out-dir');
    if (index >= 0 && argv[index + 1]) {
      try {
        const outDir = assertSafeDirectory(assertEvidenceDestination(argv[index + 1]), { create: true });
        reserveReleaseOutput(outDir);
        writeJson(path.join(outDir, 'result.json'), seal({
          schemaVersion: 1, pass: false, baseline: null, sourcePin: null,
          code: error.code ?? 'RELEASE_USAGE', completedGates: [],
        }));
      } catch (destinationError) {
        process.stderr.write(`${destinationError.code ?? 'UNSAFE_OUTPUT_DIRECTORY'}\n`);
        process.exitCode = 1;
        return;
      }
    }
    process.stderr.write(`${error.code ?? 'RELEASE_USAGE'}\n`);
    process.exitCode = 1;
    return;
  }
  const result = await runReleaseVerification(parsed);
  process.stdout.write(`${JSON.stringify({ pass: result.pass, code: result.code, sourcePin: result.sourcePin })}\n`);
  if (!result.pass) process.exitCode = 1;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === SELF;
if (direct && !process.env.NODE_TEST_CONTEXT) await main();
