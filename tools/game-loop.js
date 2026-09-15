#!/usr/bin/env node
import { classifyDecision, validatedDecision, legalFromMessage, projectRejectionForSink, validateDiagnostics, validateRawDiagnostics, retryWillCorrect, correctionMessage, CORRECTABLE_DETAILS } from './player-decision.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { childSpawnOptions } from '../shared/child-spawn-options.js';
import { resolveSessionReference } from './reference-source.js';
import { openContained, writeContained } from './training-store.js';
import { abortModeFor, validateAbortingCheckpoint, validRecoveryOperation } from './recovery-exit.js';
import { createHintControl, checkHintResume } from './hint-control.js';
import fs from 'node:fs';
import {sealPreparation, readPreparation} from './session-preparation.js';
import { cliModeDefaults } from '../shared/game-setup.js';
import {checkDealBiasResume} from '../shared/deal-selection.js';
import { playerBudget, playerFailureCategory } from '../shared/player-budget.js';
import { createSessionControl, retryControlWrite } from './session-control.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireOwnedLock,
  processStartTime,
  ownedProcessStartTime,
  readOwnedLock,
  releaseOwnedLock,
  verifyOwnedLock,
  writeJsonAtomic,
} from '../engine/state.js';
import { createListenerOwnedBy } from './listener-ownership.js';
import { createRelayRootOwner, writeRelayJsonAtomic } from '../server/action-receipts.js';
import {
  buildPlayerPrompt,
  extractJsonLine,
  isArgvSafeSessionId,
  RUNTIME_TABLE,
  resolveRuntimes,
} from './player-runtime.js';
import {
  coachNoteStrings,
  collectPrivateLiteralsDetailed,
  gameEpochOf,
  validateActionAck,
  validateCoachDecisions,
} from '../publish-contract.js';
import { normalizeFreeText, REASON_MAX_BYTES, REASON_MAX_CHARS } from '../shared/free-text.js';
import { canStartReplacement } from './coach-control.js';
import { createTrainingControl, enterExplanationCutoff } from './training-control.js';
import { decide as decidePolicy, readDerivedPolicyConfigs, stampPlayerPolicies } from './policy-player.js';
import {
  assertSelfOpponentsConsistent,
  assignSelfOpponents,
  buildSelfOpponentSection,
  buildSelfOpponentsRaw,
  requireStoreTendency,
  selfOpponentNotices,
  writeSelfOpponentsMarker,
} from './self-opponents.js';
import { sanitizePlayersForReview } from '../training/policies/catalog.js';
import { modelsFromPlayers } from '../training/exploit/policy-model.js';
import { buildProcessInput } from '../training/process-review.js';
import { referenceClaimAllowed } from '../shared/reference.js';
import { preserveReviewFailure, sanitizeReviewDiagnostic } from './review-diagnostics.js';
import { killGroup as killSolverGroup, readPersistedSolver } from './solver-runtime.js';
import {
  buildExplanationPrompt,
  defaultEvaluate,
  defaultSolve,
  flushAnnotationPublish as flushAnnotationEnvelope,
  flushMachinePublish,
  isTrainingEnabled,
  reconcileSession,
  retryUnresolvedTrainingAttempt as retryTrainingAttempt,
  runHandPipeline,
  runSolveTask,
  sealExploitAnnotations,
  toRunnerHandle,
  trainingAggregate,
} from './training-pipeline.js';
import {
  completeSessionStoreMigration,
  installPracticeFocus,
  readInstalledPracticeFocus,
  sweepStore,
  writePracticeFocus,
} from './profile-cli.js';
import { createProfileStore } from './training-stores.js';
import { ensureStudyService } from './study-service.js';
import { assertNotSessionCatalogTarget, isAlive } from '../engine/game-archive.js';
import {
  commitSession,
  ensureSessionStore,
  prepareSession,
  resolveCurrentSession,
} from '../engine/session-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE_CLI = path.join(ROOT, 'engine/cli.js');
const PUBLISH_CLI = path.join(ROOT, 'tools/publish.js');
const COACH_CLI = path.join(ROOT, 'tools/coach-control.js');
const SERVER_CLI = path.join(ROOT, 'server/server.js');
const LOOP_LOCK = 'loop.lock.d';
const COACH_GENERATION_MS = 120_000;
const REVIEW_GENERATION_MS = 300_000;
const REVIEW_HEADING_PATTERNS = Object.freeze([
  /^#{1,6}[ \t]+내 성향 통계(?:[ \t]|$)/m,
  /^#{1,6}[ \t]+결정적 핸드(?:[ \t]|$)/m,
  /^#{1,6}[ \t]+각 AI의 실제 아키타입 공개[ \t]*\+[ \t]*읽기 평가(?:[ \t]|$)/m,
  /^#{1,6}[ \t]+다음 게임에서 연습할 것(?:[ \t]|$)/m,
]);
const FINAL_PHASES = new Set(['finalizing', 'review_generated', 'review_published']);
// §5 종료 시퀀스: finalDeadlineMono = now + 20s, resultWaitCutoffMono = finalDeadline - 10s.
// Win32 ACL proofs spent ~72s in a 20-hand session under that POSIX ceiling.
const FINALIZE_BUDGET_MS = process.platform === 'win32' ? 200_000 : 20_000;
const FINALIZE_CUTOFF_LEAD_MS = 10_000;
// A finalization halt is a retryable operator condition: the next --resume re-enters the
// same checkpoint. repair_failed/NO_PLAYER_RUNTIME keep their own play-time boundaries.
const RESUMABLE_FINAL_HALTS = new Set([
  'COACH_RECONCILE_PENDING',
  'FINALIZATION_ABORTED',
  'REVIEW_FAILED',
  'REVIEW_GATE_CLOSED',
]);
const DEFAULT_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;
const DEFAULT_WAIT_NETWORK_MARGIN_MS = 11_000;
// 127.0.0.1 왕복 한 번의 상한. health는 실패해도 startup 루프가 다시 돌지만
// `assertAuthenticatedServer`의 두 프로브는 재시도가 없어서, 느린 기기에서 스냅샷
// 한 번이 이 값을 넘기면 정상 서버인데도 부트스트랩이 통째로 실패한다. 이 머신에서는
// 왕복이 1ms대지만(2026-09-11 실측) 그건 상한을 좁게 둘 근거가 아니다 — 기다림의
// 천장이지 소비하는 지연이 아니다.
const LOCAL_HTTP_PROBE_MS = 5_000;
const FATAL_RUNTIME_CODES = new Set([
  'CHILD_CLOSE_UNCONFIRMED',
  'CHILD_SIGNAL_FAILED',
  'CHILD_STOP_UNCONFIRMED',
  'CLOSE_UNSETTLED',
  'IDENTITY_UNAVAILABLE',
  'IDENTITY_UNVERIFIABLE',
  'IDENTITY_MISMATCH',
  'RUNTIME_CLOSED',
  'RUNTIME_DISPOSING',
  'SIGNAL_FAILED',
]);
const RESTORED_SESSION_REJECTION_CODES = new Set([
  'CLI_FAILED',
  'INVALID_SESSION',
  'INVALID_SESSION_ID',
  'NO_SESSION',
  'SESSION_EXPIRED',
  'SESSION_NOT_FOUND',
]);

function isFatalRuntimeFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return FATAL_RUNTIME_CODES.has(code)
    || code.includes('IDENTITY_')
    || code.includes('SIGNAL_')
    || code.endsWith('_CLOSE_UNCONFIRMED')
    || code.endsWith('_STOP_UNCONFIRMED');
}

function isFatalRepairFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return code === 'CLOSE_UNSETTLED'
    || code.includes('IDENTITY_')
    || code.includes('SIGNAL_')
    || code.endsWith('_CLOSE_UNCONFIRMED')
    || code.endsWith('_STOP_UNCONFIRMED');
}

function codedError(code, message, extra = {}) {
  const error = new Error(message ?? code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

// #192 I2: undefined (not 0) on a platform that has no O_NOFOLLOW (e.g. Windows) so callers
// can tell "no such flag exists" apart from "flag value is 0" and use
// `readSidecarFileWithoutNoFollow` there instead of opening with no protection at all.
const SIDECAR_NOFOLLOW = fs.constants.O_NOFOLLOW;

// #192 oK1: sidecar read for a platform without O_NOFOLLOW. `lstat` first rejects anything
// that is not a regular file, then the file is opened without the flag and `fstat` on that
// fd must report the same dev and ino. A path swapped to a symlink or another file between
// the two calls therefore reads as `invalid`, never as evidence, which closes the TOCTOU
// window without refusing every sidecar (refusing them all disabled the O7 spawn guard and
// the sidecar judgments on Windows). A file that disappears after `lstat` is `invalid`, not
// `absent`, because absence was not observed atomically. `fsImpl` is a test seam.
export function readSidecarFileWithoutNoFollow(filePath, { maxBytes, fsImpl = fs } = {}) {
  let before;
  try {
    before = fsImpl.lstatSync(filePath, { bigint: true });
  } catch (error) {
    return { status: error?.code === 'ENOENT' ? 'absent' : 'invalid' };
  }
  if (before.isSymbolicLink() || !before.isFile()) return { status: 'invalid' };
  let fd;
  try {
    fd = fsImpl.openSync(filePath, 'r');
  } catch {
    return { status: 'invalid' };
  }
  try {
    const after = fsImpl.fstatSync(fd, { bigint: true });
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.nlink !== 1n
      || after.size > BigInt(maxBytes)
    ) {
      return { status: 'invalid' };
    }
    return { status: 'ok', text: fsImpl.readFileSync(fd, 'utf8') };
  } catch {
    return { status: 'invalid' };
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* best effort */ }
  }
}

// #192 D5 (design memo §4 D5, G11): top-level error `code` values the three coach/publish/
// engine CLI children can legitimately print on their own stdout — every `fail(...)`/
// `bail(...)` (CoachError/ToolError) call and every literal top-level `code:` field in
// tools/coach-control.js and tools/publish.js, plus engine/cli.js's FAIL_MESSAGES keys, its
// own `fail(...)` call sites, and its uncaught-error fallback ('ERROR'). Deliberately
// excludes the lowercase `reasons[].code` tags nested inside coach-control's
// ROLLBACK_REFUSED response body — those are a separate, non-top-level vocabulary. A
// BAD_CHILD_OUTPUT diagnostic never reports a `code` outside this set; anything else
// (including a well-formed but unrecognized string) becomes 'UNLISTED' so a crafted or
// buggy child can never smuggle private text through this field.
const KNOWN_CHILD_ERROR_CODES = new Set([
  // tools/coach-control.js
  'STALE_GAME_EPOCH', 'STALE_GENERATION', 'INVALID_COACH_OUTPUT', 'USAGE', 'NO_RETIRED',
  'STALE_OWNER', 'COMPLETED_MISMATCH', 'BAD_FORBIDDEN_FILE', 'SPAWN_PROTOCOL_REQUIRED',
  'NO_LOCK', 'UNSUPPORTED_COACH_AUTHORITY', 'UNSAFE_PATH', 'MISSING_PATH', 'SYMLINK_PATH',
  'NOT_FILE', 'MULTI_LINK_PATH', 'GENERATION_REQUIRED', 'NO_AUTHORITY', 'NO_ENVELOPE',
  'ADAPTER_DISABLED', 'ATTEMPT_TIMEOUT', 'FINALIZATION_ABORTED', 'HAND_ALREADY_PUBLISHED',
  'HAND_DEFERRED', 'HAND_SNAPSHOT_OCCUPIED', 'NO_RESULT', 'PUBLISH_FAILED',
  'QUEUE_ALREADY_SEALED', 'ROLLBACK_REFUSED', 'SUPERSEDED', 'INTERNAL',
  // tools/publish.js
  'BAD_ENVELOPE', 'BAD_AUTHORITY', 'BAD_TRAINING_AUTHORITY', 'STALE_TRAINING_AUTHORITY',
  'UNSUPPORTED_TRAINING_AUTHORITY', 'STALE_ANNOTATION_AUTHORITY', 'PUBLISH_REJECTED',
  'DEADLINE_EXPIRED', 'NO_ATTEMPT', 'ATTEMPT_PENDING', 'BAD_ATTEMPT',
  'PLAYTIME_PUBLISH_STOPPED', 'PUBLISH_ID_OVERFLOW', 'BAD_HAND_REPLAY', 'BAD_ACTION_ACK',
  'PAYLOAD_TOO_LARGE', 'PUBLISH_ID_REUSED', 'LOCK_TIMEOUT',
  // #192 I6: assertCoachQueue and staleAttemptReason's own bail(stale, …) both surface
  // these — staleAttemptReason additionally returns BAD_ATTEMPT_VERSION/STALE_GAME_ATTEMPT,
  // and readJson(ui-snapshot.json, 'BAD_SNAPSHOT', …) surfaces BAD_SNAPSHOT.
  'STALE_COACH_AUTHORITY', 'BAD_ATTEMPT_VERSION', 'STALE_GAME_ATTEMPT', 'BAD_SNAPSHOT',
  // engine/cli.js
  'ILLEGAL_ACTION', 'GAME_OVER', 'LOCKED', 'VERSION_MISMATCH', 'NO_GAME', 'ACTIVE_GAME',
  'ARCHIVE_FAILED', 'SERVER_ALIVE', 'HAND_NOT_FOUND', 'SNAPSHOT_INVALID', 'BAD_CONFIG',
  'LOOP_ALIVE', 'OPERATION_CONFLICT', 'ERROR',
  // #192 I6: throwCoded('HINT_SNAPSHOT_INVALID') in cmdDecisionPeek's hint-snapshot read
  // reaches the catch-all dispatcher and is surfaced as a top-level `code`.
  'HINT_SNAPSHOT_INVALID',
]);

function classifyChildOutputCode(rawCode) {
  return typeof rawCode === 'string' && KNOWN_CHILD_ERROR_CODES.has(rawCode) ? rawCode : 'UNLISTED';
}

// Pure by design so it can be unit-tested without spawning any child process: given the raw
// bytes a child printed (and how it exited), build the redacted diagnostic `details` object
// for a BAD_CHILD_OUTPUT error. `code` is included only when stdout parsed as JSON at all
// (regardless of shape) — a non-string, an object, an over-long string, or any string
// outside `KNOWN_CHILD_ERROR_CODES` all collapse to 'UNLISTED'. Raw stdout/stderr text is
// never included, only their byte lengths.
export function buildBadChildOutputDetails({ script, exitCode, signal, stdout, stderr }) {
  const stdoutText = String(stdout ?? '');
  const stderrText = String(stderr ?? '');
  let parsed;
  let parsedOk = true;
  try { parsed = JSON.parse(stdoutText.trim()); } catch { parsedOk = false; }
  const rawCode = parsedOk && parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed.code
    : undefined;
  return {
    script: path.basename(script),
    exitCode,
    signal,
    stdoutBytes: Buffer.byteLength(stdoutText, 'utf8'),
    stderrBytes: Buffer.byteLength(stderrText, 'utf8'),
    ...(parsedOk ? { code: classifyChildOutputCode(rawCode) } : {}),
  };
}

// #192 §3/§4 D2: evidence that closes a persisted coach row without any live identity check.
// Order follows the design memo: c → closed-confirmed → f. Every hit releases the row, so
// the order only decides which reason string is reported.
// - c: `closures` is `loop-state.coachRuntimeClosures`, `requestStop`'s success-path receipt
//   (§3 E1). It lists every owner some loop instance durably confirmed fully stopped, so a
//   row whose `ownerSessionId` appears there closes regardless of any other evidence.
// - closed-confirmed (#192 O2): the caller (`terminatePersistedCoachAttempt` Step 0) already
//   rejected any sidecar whose tuple does not match this exact row and epoch, so the phase is
//   trusted at face value. `sidecar` is optional for callers that have none.
// - f: `acceptEvidence` (`closed-child` or `no-spawn`, written by `accept` in
//   tools/coach-control.js) is copied onto the attempt by `persistedCoachAttempts()`.
// Pure function of its inputs with no disk reads, so consulting it twice for the same attempt
// (the H2 fast path and the post-poll fallback) is always safe. Returns `{ reason }` when
// evidence closes the row, otherwise `null`.
export function consultCoachCloseEvidence(attempt, closures, sidecar = null) {
  if (Array.isArray(closures) && closures.some((entry) => (
    entry && typeof entry === 'object' && entry.ownerSessionId === attempt?.ownerSessionId
  ))) {
    return { reason: 'OWNER_RUNTIME_CLOSED' };
  }
  if (sidecar?.phase === 'closed-confirmed') {
    return { reason: 'CLOSED_CONFIRMED' };
  }
  if (attempt?.acceptEvidence === 'closed-child' || attempt?.acceptEvidence === 'no-spawn') {
    return { reason: 'ACCEPT_EVIDENCE' };
  }
  return null;
}

// #192 D5/O5: distinguishes, for an operator halted on unresolved coach rows, whether any
// row still carries a spawn-intent sidecar (a spawn may genuinely have happened — verify no
// leftover coach CLI child) from a genuinely evidence-free legacy row, from a row whose path
// could not be attributed to the current root at all (archived/moved game, legacy
// `--game-dir`), from a synthetic authority-level failure that never classified any coach
// row's evidence in the first place (STALE_GAME_EPOCH, COACH_EPOCH_UNVERIFIABLE,
// NO_COACH_OWNER, RESUME_RECLAIM_DEADLINE_EXCEEDED, ADAPTER_DISABLE_CHILD_FAILED,
// AUTHORITY_MISSING — none of these ever carry an `evidence` field). Each needs a different
// manual check before resuming, and the wrong one wastes an operator's time chasing a
// nonexistent legacy row. Returns null when no category applies, leaving the base message
// unchanged.
export function unresolvedEvidenceGuidance(unresolved) {
  const withEvidence = unresolved.filter((row) => row?.evidence);
  if (withEvidence.some((row) => row.evidence.sidecar === 'intent')) {
    return 'spawn이 실제로 시작됐을 수 있습니다. 이 게임의 coach CLI 자식이 남아있지 않은지 확인한 뒤 halt.recovery.commands를 실행하세요.';
  }
  // A row whose path could not be attributed to the current root is checked first: even a
  // row that also happens to have no handle/spawnEvidence/sidecar is not "legacy with no
  // evidence" here — it is "this root cannot even verify the row's own path", a different
  // and more fundamental problem than an old pre-stamp row.
  if (withEvidence.length > 0 && withEvidence.every((row) => row.evidence.attributable === false)) {
    return '게임 디렉터리가 이동했거나 경로를 확인할 수 없는 행입니다. halt.recovery.commands 실행 전에 게임 디렉터리 위치를 먼저 확인하세요.';
  }
  // #192 O1/L1 부록 v3.2: judgment g가 legacy 행을 프로세스 스캔으로 판정했지만 여전히
  // unresolved로 남은 두 경우 — 후보 프로세스가 있거나(fail-closed), 조회 자체가
  // 불가능했던 경우 — 는 일반 "증거 없는 legacy" 문구보다 구체적인 안내가 필요하다.
  // g는 sidecar가 absent인 행에만 적용되므로 이 두 reason은 항상 evidence를 동반한다.
  if (withEvidence.length > 0 && withEvidence.every((row) => row.reason === 'LEGACY_RUNTIME_PROCESS_PRESENT')) {
    const pids = [...new Set(withEvidence.flatMap((row) => row.evidence?.legacyScanPids ?? []))];
    return pids.length > 0
      ? `legacy 행과 연결됐을 수 있는 coach CLI 프로세스(pid: ${pids.join(', ')})가 남아 있습니다. 해당 프로세스를 모두 종료한 뒤 resume하세요.`
      : 'legacy 행과 연결됐을 수 있는 coach CLI 프로세스가 남아 있습니다. 해당 프로세스를 모두 종료한 뒤 resume하세요.';
  }
  if (withEvidence.length > 0 && withEvidence.every((row) => row.reason === 'LEGACY_SCAN_UNAVAILABLE')) {
    return 'legacy 행의 coach 런타임 프로세스 여부를 확인할 수 없습니다. halt.recovery.commands를 검토해 실행하세요.';
  }
  // Genuinely evidence-free legacy: no handle was ever recorded, no new-protocol stamp, and
  // the sidecar has never been seen at all (not merely unreadable/invalid/moved).
  if (withEvidence.length > 0 && withEvidence.every((row) => (
    row.evidence.hasHandle === false
    && row.evidence.spawnEvidence === false
    && row.evidence.sidecar === 'absent'
  ))) {
    return '증거가 없는 legacy 행입니다. 수동으로 이 게임의 coach CLI 자식 부재를 확인한 뒤 halt.recovery.commands를 검토하세요.';
  }
  // No `evidence` field at all means every unresolved row here is a synthetic
  // authority/epoch/owner/deadline/adapter-disable failure, not a coach-row evidence
  // classification — neither wording applies, and claiming "legacy" would mislead.
  return null;
}

// #192 O1/L1 부록 v3.2: legacy 행 자동 복구용 프로세스 스캐너. player-runtime.js의
// ensureCwd()는 코치 CLI 자식을 `realpath(os.tmpdir())/ai-holdem-<kind>-XXXXXX` 전용
// cwd에서 띄운다 — 그 경로 관례를 `lsof -d cwd` 출력과 대조해 이 uid 아래 아직 남아
// 있을 수 있는 코치 런타임 프로세스를 찾는다. 실제 판정(judgment g)은
// createGameLoop 안 `terminatePersistedCoachAttempt`가 소유한다 — 아래 함수들은
// 순수 파싱/매칭이라 픽스처 문자열만으로 단위 테스트할 수 있다.
function aiHoldemCwdSegment(cwd) {
  return String(cwd ?? '').split(/[\\/]+/).some((segment) => segment.startsWith('ai-holdem-'));
}

// `lsof -n -P -a -u <uid> -d cwd -Fpn`은 프로세스마다 `p<pid>` 레코드 하나, 그 식별
// 대상 파일디스크립터를 밝히는 `f<fd>` 레코드 하나(`-F`가 지정한 필드와 무관하게
// lsof가 항상 내보내는 필수 식별 필드 — 실측: 이 머신에서 `-Fpn` 출력도 예외 없이
// `p`마다 `fcwd`가 끼어 있다), 그리고 그 파일의 이름(여기서는 cwd 경로)을 담은
// `n<path>` 레코드 하나로 된 `(p, f, n)` 삼중항이 반복되는 구조다. 이 순서가 깨지거나
// (짝이 맞지 않는 p/f/n, 알 수 없는 레코드 태그, 중간에 잘린 삼중항) 하면 전체 출력을
// 신뢰할 수 없다는 뜻이므로 `null`을 반환한다 — 호출자는 이를 "조회 불가"로 취급해야
// 하며, 절대 "매칭되는 후보 0개"로 착각해서는 안 된다. 빈 문자열만은 예외로, 프로세스가
// 하나도 나열되지 않은 정상적인 빈 표를 뜻하므로 빈 배열을 반환한다.
export function parseLsofCwdRecords(stdout) {
  const text = String(stdout ?? '');
  if (text.trim() === '') return [];
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  const records = [];
  let i = 0;
  while (i < lines.length) {
    const pLine = lines[i];
    if (pLine[0] !== 'p') return null;
    const pid = Number(pLine.slice(1));
    if (!Number.isInteger(pid) || pid <= 0) return null;
    // #192 J2: a cwd query only ever emits `fcwd` — a numeric fd, a blank tag, or anything
    // else means this triple is not the cwd fd we asked for and the whole listing can no
    // longer be trusted as "exactly the p/fcwd/n triple" the design requires.
    const fLine = lines[i + 1];
    if (fLine !== 'fcwd') return null;
    const nLine = lines[i + 2];
    if (!nLine || nLine[0] !== 'n') return null;
    let cwd = nLine.slice(1);
    // A process whose cwd was itself deleted from disk still has a real, trustworthy path —
    // lsof only appends `(deleted)`. Strip it before matching so a legacy `ai-holdem-*` cwd
    // that has since been removed is still a candidate below.
    const deletedSuffix = ' (deleted)';
    if (cwd.endsWith(deletedSuffix)) cwd = cwd.slice(0, -deletedSuffix.length);
    // #192 J2: an empty name, a relative name, or an lsof annotation such as
    // `(readlink: Permission denied)` / `(stat: ...)` (seen on Linux when this uid's own
    // process cannot have its cwd read) means lsof could not actually verify this process's
    // cwd — never let that read as "no candidate here". Fail the whole listing instead.
    if (cwd === '' || !cwd.startsWith('/') || cwd.includes('(readlink:') || cwd.includes('(stat:')) return null;
    records.push({ pid, cwd });
    i += 3;
  }
  return records;
}

// player-runtime.js가 코치 CLI를 띄우는 cwd 관례(`ai-holdem-<kind>-XXXXXX`)와 대조해
// 후보 프로세스만 골라낸다. `excludePid`는 이 loop 프로세스 자신이다 — 스캔이 자기
// 자신을 legacy 코치 런타임으로 오인해서는 안 된다.
// #192 sJ2: 이 cwd-구성요소 규칙은 지원 코치 CLI(claude·codex·grok)가 자신의 프로세스
// 트리 전체(래퍼·네이티브 바이너리·자식 프로세스 모두)에서 런타임 cwd를 계속 유지한다는
// 전제에 의존한다. 오케스트레이터가 2026-09-14 이 머신에서
// `createPlayerRuntime(kind).oneshotStart({ tier: 'upper' })` 실제 경로로 세 CLI를 띄워
// 250ms 간격으로 `ps`+`lsof -d cwd`로 프로세스 트리를 표본 조사했다: codex(codex-cli
// 0.154.0, model gpt-5.6-sol, node 래퍼 → 네이티브 codex 바이너리 → node_repl 자식),
// claude(2.1.270, model opus, 단일 프로세스), grok(1.0.25, model grok-4.6, 사용자 훅 스크립트·lsof·
// awk·sort 자식 포함 11개 프로세스) 전부 — cwd를 관측할 수 있었던 모든 프로세스가
// `ai-holdem-<kind>-*` cwd를 유지했다. chdir, 다른 cwd로의 재실행, 데몬화된 helper는
// 어느 CLI에서도 관측되지 않았다(grok의 세 단명 자식은 cwd 없는 종료된 `(bash)`/`(git)`
// 항목으로만 나타났다). CLI가 업데이트되면 이 전제는 달라질 수 있다 — 그래서 (J2가 이미
// 보장하듯) 목록에 있는 어떤 프로세스든 cwd를 관측할 수 없으면 전체 스캔을 clean이
// 아니라 unavailable로 처리한다(`parseLsofCwdRecords`의 `CWD_UNVERIFIABLE`).
export function legacyCoachRuntimeCandidates(records, { excludePid = null } = {}) {
  return records
    .filter((record) => record.pid !== excludePid && aiHoldemCwdSegment(record.cwd))
    .map((record) => ({ pid: record.pid, cwd: record.cwd }));
}

// 기본 스캐너 구현: POSIX에서 이 프로세스 uid 아래, cwd fd 하나만(`-d cwd`) 골라
// `-Fpn`으로 pid/경로 쌍만 받는다. 서버 소유 확인과 달리 exit 1 + 빈 출력을 "매칭 없음"으로
// 읽지 않는다: 이 uid 조회에는 스캔하는 프로세스 자신이 반드시 나와야 하므로, 자기 pid가
// 없는 결과는 전부 조회 불가다(#192 구현 리뷰 전 오케스트레이터 검토).
export function scanCoachRuntimeProcesses({
  lsofPath, timeoutMs = 5_000, excludePid = process.pid, selfPid = process.pid, execFileFn = execFile,
  // #192 CI: platform and uid are parameters so the POSIX branch below can be exercised from
  // a win32 runner, where `process.platform` would short-circuit every scanner test and
  // `process.getuid` does not exist at all. Production passes neither.
  platform = process.platform,
  uid = undefined,
} = {}) {
  if (platform === 'win32') {
    return Promise.resolve({ status: 'unavailable', reason: 'WIN32_UNSUPPORTED' });
  }
  if (!lsofPath) return Promise.resolve({ status: 'unavailable', reason: 'LSOF_MISSING' });
  let scanUid = uid;
  if (scanUid === undefined) {
    try {
      scanUid = process.getuid?.();
    } catch {
      scanUid = undefined;
    }
  }
  if (!Number.isInteger(scanUid)) return Promise.resolve({ status: 'unavailable', reason: 'UID_UNAVAILABLE' });
  return new Promise((resolve) => {
    execFileFn(lsofPath, [
      '-n', '-P', '-a', '-u', String(scanUid), '-d', 'cwd', '-Fpn',
    ], {
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      // A scan of this uid always includes the scanning process itself, so "no output" is
      // never proof of "no coach runtime process": lsof exits 1 with nothing when it could
      // not observe anything at all. #192 J2: trust only a clean exit (status 0) — a
      // parseable listing on a non-zero exit (including exit 1 with a candidate-looking
      // record) is never trusted either, since a partial/erroring listing can silently omit
      // processes it failed to enumerate.
      if (String(stdout ?? '').trim() === '') {
        resolve({ status: 'unavailable', reason: error?.killed ? 'LSOF_TIMEOUT' : 'LSOF_NO_OUTPUT' });
        return;
      }
      if (error) {
        resolve({ status: 'unavailable', reason: error.killed ? 'LSOF_TIMEOUT' : 'LSOF_FAILED' });
        return;
      }
      const records = parseLsofCwdRecords(stdout);
      if (records === null) {
        resolve({ status: 'unavailable', reason: 'CWD_UNVERIFIABLE' });
        return;
      }
      if (!records.some((record) => record.pid === selfPid)) {
        resolve({ status: 'unavailable', reason: 'SELF_NOT_OBSERVED' });
        return;
      }
      const candidates = legacyCoachRuntimeCandidates(records, { excludePid });
      resolve(candidates.length > 0 ? { status: 'candidates', candidates } : { status: 'clean' });
    });
  });
}

function readJsonOptional(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw codedError(`BAD_${label}`, `${label}을 읽을 수 없습니다.`, { cause: error });
  }
}

function readStrictServerLock(gameDir) {
  const lockPath = path.join(gameDir, 'lock.json');
  let fd;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw codedError('BAD_SERVER_LOCK', '이전 session server lock을 안전하게 열 수 없습니다.', { cause: error });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw codedError('BAD_SERVER_LOCK', '이전 session server lock inode가 올바르지 않습니다.');
    const lock = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (
      !lock || typeof lock !== 'object' || Array.isArray(lock)
      || !Number.isInteger(lock.serverPid) || lock.serverPid <= 0
      || !Number.isInteger(lock.port) || lock.port <= 0
      || typeof lock.sessionToken !== 'string' || lock.sessionToken === ''
    ) throw codedError('BAD_SERVER_LOCK', '이전 session server lock schema가 올바르지 않습니다.');
    return lock;
  } catch (error) {
    if (error.code === 'BAD_SERVER_LOCK') throw error;
    throw codedError('BAD_SERVER_LOCK', '이전 session server lock을 읽을 수 없습니다.', { cause: error });
  } finally {
    fs.closeSync(fd);
  }
}

function integerValue(value, flag, minimum = 1) {
  const label = minimum === 0 ? '0 이상의 정수' : '양의 정수';
  if (!/^\d+$/.test(String(value))) throw codedError('USAGE', `${flag}는 ${label}여야 합니다.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw codedError('USAGE', `${flag}는 ${label}여야 합니다.`);
  return parsed;
}

export const REVIEW_REPLAY_BUDGET_BYTES = 200_000;

export function trimReviewReplays(records, budget = REVIEW_REPLAY_BUDGET_BYTES) {
  const clone = structuredClone(records ?? []);
  const sizeOf = (rows) => Buffer.byteLength(JSON.stringify(rows));
  if (sizeOf(clone) <= budget) return { records: clone, stage: null };
  for (const row of clone) {
    for (const action of row.actions ?? []) delete action.reason;
  }
  if (sizeOf(clone) <= budget) return { records: clone, stage: 'reason' };
  for (const row of clone) delete row.actions;
  return { records: clone, stage: 'actions' };
}

export function engineInitFlags(args = {}) {
  const extra = [];
  if (args.stack !== undefined) extra.push('--stack', String(args.stack));
  if (args.levelEvery !== undefined) extra.push('--level-every', String(args.levelEvery));
  if (args.blinds !== undefined) extra.push('--blinds', String(args.blinds));
  if (args.mode !== undefined) extra.push('--mode', String(args.mode));
  if (args.stackBb !== undefined) extra.push('--stack-bb', String(args.stackBb));
  if (args.hands !== undefined) extra.push('--hands', String(args.hands));
  if (args.opponentRuntime === 'policy') extra.push('--opponent-runtime', 'policy');
  if (args.showdownPolicy !== undefined) extra.push('--showdown-policy', String(args.showdownPolicy));
  if (args.hints !== undefined) extra.push('--hints',String(args.hints));
  if (args.dealBias !== undefined) extra.push('--deal-bias',String(args.dealBias));
  if (args.replayReveal !== undefined) extra.push('--replay-reveal', String(args.replayReveal));
  return extra;
}

export const applyModeDefaults = cliModeDefaults;

export function gtoEvalNotice(config = {}) {
  if (config.mode !== 'cash-training') return null;
  const seats = Number(config.aiCount) + 1;
  const stackBb = config.startStackBb;
  const badSeats = !Number.isFinite(seats) || ![6, 8, 9].includes(seats);
  const badStack = !Number.isFinite(stackBb) || stackBb !== 100;
  if (!badSeats && !badStack) return null;
  const parts = [];
  if (badSeats) parts.push(Number.isFinite(seats) ? `${seats}인` : '좌석 수 확인 불가');
  if (badStack) parts.push(Number.isFinite(stackBb) ? `시작 스택 ${Number(stackBb.toFixed(2))}BB` : '시작 스택 확인 불가');
  const availability = !badSeats && Number.isFinite(stackBb) && stackBb >= 80 && stackBb <= 120
    ? '투영 참고이며 점수에서 제외됩니다' : '지원 범위 밖이므로 기준표 비교를 제공하지 않습니다';
  return `휴리스틱 프리플롭 기준표는 6·8·9인 100BB의 미오픈·단일 오픈 상황을 지원합니다. 현재 ${parts.join(', ')}는 ${availability}.`;
}

export function parseGameLoopArgs(argv) {
  const parsed = {
    gameDir: path.resolve('game'),
    ai: undefined,
    stack: undefined,
    levelEvery: undefined,
    blinds: undefined,
    force: false,
    resume: false,
    mirrorSelf: false,
    exploitSelf: false,
    playerRuntime: undefined,
    practiceFocusFile: undefined,
    mode: undefined,
    stackBb: undefined,
    hands: undefined,
    opponentRuntime: undefined,
    solverAdapterId: undefined,
  };
  const bools = new Map([
    ['--force', 'force'],
    ['--resume', 'resume'],
    ['--fresh-session', 'freshSession'],
    ['--mirror-self', 'mirrorSelf'],
    ['--exploit-self', 'exploitSelf'],
  ]);
  const values = new Map([
    ['--game-dir', 'gameDir'],
    ['--store-dir', 'storeDir'],
    ['--ai', 'ai'],
    ['--stack', 'stack'],
    ['--level-every', 'levelEvery'],
    ['--blinds', 'blinds'],
    ['--player-runtime', 'playerRuntime'],
    ['--practice-focus-file', 'practiceFocusFile'],
    ['--mode', 'mode'],
    ['--stack-bb', 'stackBb'],
    ['--hands', 'hands'],
    ['--opponent-runtime', 'opponentRuntime'],
    ['--solver', 'solverAdapterId'],
    ['--port', 'port'],
    ['--showdown-policy', 'showdownPolicy'],
    ['--replay-reveal', 'replayReveal'],
    ['--hints','hints'],
    ['--deal-bias','dealBias'],
    ['--player-soft-ms', 'playerSoftMs'],
    ['--player-hard-ms', 'playerHardMs'],
    ['--retry-decision', 'retryDecisionId'],
    ['--abort-unrecoverable', 'abortUnrecoverableId'],
  ]);
  let sawGameDir = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const boolName = bools.get(arg);
    if (boolName) {
      parsed[boolName] = true;
      continue;
    }
    const valueName = values.get(arg);
    if (!valueName) throw codedError('USAGE', `알 수 없는 옵션: ${arg}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw codedError('USAGE', `${arg}의 값이 필요합니다.`);
    index += 1;
    if (valueName === 'gameDir') sawGameDir = true;
    if (valueName === 'ai' || valueName === 'stack' || valueName === 'levelEvery'
      || valueName === 'stackBb' || valueName === 'hands' || valueName === 'port'
      || valueName === 'playerSoftMs' || valueName === 'playerHardMs') {
      parsed[valueName] = integerValue(value, arg, valueName === 'port' ? 0 : 1);
    } else if (valueName === 'gameDir' || valueName === 'storeDir' || valueName === 'practiceFocusFile') {
      parsed[valueName] = path.resolve(value);
    } else {
      parsed[valueName] = value;
    }
  }
  if (parsed.storeDir !== undefined && sawGameDir) {
    throw codedError('USAGE', '--store-dir와 --game-dir는 함께 사용할 수 없습니다.');
  }
  if (parsed.port !== undefined && (parsed.port < 0 || parsed.port > 65535)) {
    throw codedError('USAGE', '--port는 0..65535 정수여야 합니다.');
  }
  if (parsed.opponentRuntime != null && parsed.opponentRuntime !== 'llm' && parsed.opponentRuntime !== 'policy') {
    throw codedError('USAGE', '--opponent-runtime는 llm 또는 policy입니다.');
  }
  if (parsed.solverAdapterId != null && !/^[a-z0-9-]{1,64}$/.test(parsed.solverAdapterId)) {
    throw codedError('USAGE', '--solver는 [a-z0-9-] 64자 이내 adapterId입니다.');
  }
  if (parsed.showdownPolicy != null && parsed.showdownPolicy !== 'open' && parsed.showdownPolicy !== 'standard') {
    throw codedError('USAGE', '--showdown-policy는 open 또는 standard입니다.');
  }
  if (parsed.replayReveal != null && parsed.replayReveal !== 'all' && parsed.replayReveal !== 'showdown') {
    throw codedError('USAGE', '--replay-reveal는 all 또는 showdown입니다.');
  }
  if (parsed.hints !== undefined && !['on','off'].includes(parsed.hints)) throw codedError('USAGE','--hints는 on 또는 off입니다.');
  if (parsed.dealBias !== undefined && !['off','light','strong'].includes(parsed.dealBias)) throw codedError('USAGE','--deal-bias는 off/light/strong입니다.');
  if (parsed.storeDir === undefined && parsed.hints === 'on') throw codedError('USAGE','--hints on은 --store-dir가 필요합니다.');
  if (parsed.retryDecisionId !== undefined && !parsed.resume) throw codedError('USAGE', '--retry-decision은 --resume과 함께 사용하세요.');
  if (parsed.freshSession && !parsed.retryDecisionId) throw codedError('USAGE', '--fresh-session은 --retry-decision과 함께 사용하세요.');
  if (parsed.abortUnrecoverableId !== undefined && (!parsed.resume || parsed.retryDecisionId !== undefined || !validRecoveryOperation(parsed.abortUnrecoverableId))) {
    throw codedError('USAGE','--abort-unrecoverable은 안전한 operationId와 --resume이 필요하며 --retry-decision과 함께 쓸 수 없습니다.');
  }
  const budgetOverrides = { ...(parsed.playerSoftMs !== undefined ? { softMs: parsed.playerSoftMs } : {}),
    ...(parsed.playerHardMs !== undefined ? { hardMs: parsed.playerHardMs } : {}) };
  if (parsed.resume && Object.keys(budgetOverrides).length && !parsed.retryDecisionId) {
    throw codedError('USAGE', '저장된 예산 변경은 --retry-decision과 함께 사용하세요.');
  }
  if (parsed.resume) {
    if (Object.values(budgetOverrides).some(value => !Number.isSafeInteger(value) || value < 1 || value > 3_600_000)) {
      throw codedError('BAD_PLAYER_BUDGET', '예산 범위가 유효하지 않습니다.');
    }
  } else playerBudget(budgetOverrides);
  return parsed;
}

export function validateSelfOpponentArgs(args) {
  if (!args?.mirrorSelf && !args?.exploitSelf) return args;
  if (args.resume) {
    throw codedError('USAGE', '--mirror-self/--exploit-self는 새 게임에서만 사용할 수 있습니다.');
  }
  if (args.opponentRuntime !== 'policy') {
    throw codedError(
      'USAGE',
      '--mirror-self/--exploit-self는 policy 상대 런타임이 필요합니다 — tournament·legacy 설정에서는 --opponent-runtime policy를 명시하세요.',
    );
  }
  if (args.storeDir === undefined) {
    throw codedError('USAGE', '--mirror-self/--exploit-self는 --store-dir가 필요합니다.');
  }
  const needed = (args.mirrorSelf ? 1 : 0) + (args.exploitSelf ? 1 : 0);
  if (!Number.isInteger(args.ai) || args.ai < needed) {
    throw codedError('USAGE', '--ai는 요청한 자기 상대 좌석 수 이상이어야 합니다.');
  }
  return args;
}

export function exitCodeFor(error) {
  if (!error) return 0;
  if (
    error.code === 'USAGE'
    || error.code === 'repair_failed'
    || error.code === 'REPAIR_FAILED'
    || error.code === 'TENDENCY_INSUFFICIENT'
    || error.code === 'TENDENCY_SOURCE_UNREADABLE'
  ) return 2;
  if (error.code === 'REVIEW_FAILED') return 3;
  if (error.code === 'NO_PLAYER_RUNTIME') return 4;
  return 5;
}

function isoNow(now) {
  const value = now();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return String(value);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* absent or preserved original failure */ }
    throw error;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

export { validatedDecision, legalFromMessage };

const USER_ACTIONS = new Set(['fold', 'check', 'call', 'raise']);

export function validatedUserAction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !USER_ACTIONS.has(raw.action)) return null;
  let action;
  if (raw.action === 'raise') {
    if (!Number.isSafeInteger(raw.amount) || raw.amount < 1) return null;
    action = { action: 'raise', amount: raw.amount };
  } else if (raw.amount !== undefined) {
    // 숫자라도 raise 외 action의 amount는 engine argv에 싣을 의미가 없다.
    // 예상 못 한 필드를 버리지 말고 요청 전체를 거부해 경계를 명확히 한다.
    return null;
  } else {
    action = { action: raw.action };
  }
  if (typeof raw.note === 'string') action.note = raw.note;
  return action;
}

export function createGameLoop({ gameDir, lockDir = gameDir, initialLockHandle = null, resolver = resolveRuntimes, opts = {} }) {
  if (!gameDir) throw codedError('USAGE', 'gameDir가 필요합니다.');
  if (typeof resolver !== 'function') throw codedError('USAGE', 'resolver가 필요합니다.');
  const requestedOpponentRuntime = opts.opponentRuntime === 'policy' ? 'policy' : 'llm';

  const root = path.resolve(gameDir);
  const lockRoot = path.resolve(lockDir);
  const now = opts.now ?? (() => new Date());
  const requestedPort = opts.port ?? 8877;
  const pollMs = opts.pollMs ?? 20;
  // 아래 셋은 전부 "정상인데 느린" 기기에 대한 인내심이지 지연 예산이 아니다. 이
  // 머신 실측은 server health 0.14–0.21s, lsof 0.03s로 여유가 24–33배였고 load
  // average 32에서도 그대로였지만(2026-09-11), 느린 기기의 node 부팅·프로세스
  // 테이블 조회는 그 배수를 쉽게 먹는다. 만료는 기동 실패로 직결되므로 넉넉히 둔다.
  const serverStartMs = opts.serverStartMs ?? 20_000;
  const childTimeoutMs = opts.childTimeoutMs ?? 60_000;
  const osVerifyMs = opts.osVerifyMs ?? 5_000;
  const localHttpProbeMs = opts.localHttpProbeMs ?? LOCAL_HTTP_PROBE_MS;
  const waitMs = opts.waitMs ?? 60_000;
  const waitNetworkMarginMs = opts.waitNetworkMarginMs ?? DEFAULT_WAIT_NETWORK_MARGIN_MS;
  const monotonicNow = opts.monotonicNow ?? (() => performance.now());
  // publish.js compares --deadline-monotonic-ns against its own process.hrtime.bigint(),
  // which is the system monotonic clock: the two processes share the origin.
  const monotonicNs = opts.monotonicNs ?? (() => process.hrtime.bigint());
  const finalizeBudgetMs = opts.finalizeBudgetMs ?? FINALIZE_BUDGET_MS;
  const finalizeCutoffLeadMs = Math.min(
    opts.finalizeCutoffLeadMs ?? FINALIZE_CUTOFF_LEAD_MS,
    finalizeBudgetMs,
  );
  const orphanTerminateGraceMs = opts.orphanTerminateGraceMs ?? 5_000;
  const orphanTerminateKillWaitMs = opts.orphanTerminateKillWaitMs ?? 2_000;
  const resumeReclaimResidualMs = opts.resumeReclaimResidualMs ?? 5_000;
  const minRepairFloorMs = opts.minRepairFloorMs ?? 2_000;
  const lsofPath = opts.lsofPath ?? DEFAULT_LSOF;
  const startTimeOf = opts.processStartTime ?? processStartTime;
  const ownedStartTimeOf = opts.ownedProcessStartTime ?? ownedProcessStartTime;
  const listenerOwnedByFn = opts.listenerOwnedBy ?? createListenerOwnedBy({
    lsofPath,
    timeoutMs: osVerifyMs,
    onChild: (event, child) => {
      if (event === 'open') activeChildren.add(child);
      else activeChildren.delete(child);
    },
  });
  const signalProcess = opts.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  // #192 O1/L1: test seam for judgment g's process scanner. Defaults to the real POSIX
  // lsof-based scan, reusing this instance's own `lsofPath`/`osVerifyMs` conventions.
  const scanCoachRuntimeProcessesFn = opts.scanCoachRuntimeProcesses
    ?? (() => scanCoachRuntimeProcesses({ lsofPath, timeoutMs: osVerifyMs }));
  // #192 sJ5: test seam so a platform that does have `O_NOFOLLOW` can still exercise the
  // no-flag fallback path deterministically, instead of depending on which OS the test suite
  // happens to run on.
  const sidecarNoFollowFlag = 'sidecarNoFollowFlag' in opts ? opts.sidecarNoFollowFlag : SIDECAR_NOFOLLOW;
  // #192 E2: test seam for the per-attempt spawn sidecar writes. Always synchronous, like
  // writeJsonAtomic itself — the spawn sequence relies on no `await` landing between steps.
  const writeSpawnEvidence = opts.writeSpawnEvidence ?? writeJsonAtomic;
  // #192 O4-rest 4: test seam for the sidecar classifier's "is the game root itself still
  // there" check (`absentOrInvalid` below) — genuinely reproducing an unmounted/relocated
  // root's `stat` failure (as opposed to the sidecar file's own missing-ness) needs real
  // filesystem/mount manipulation a test cannot do portably.
  const statGameRoot = opts.statGameRoot ?? fs.statSync;
  // #192 O4-rest 6: test seam for the coach CLI child path (§5 "새 loop·구 CLI") — defaults
  // to the real tools/coach-control.js. A test can point this at a shim script that strips
  // E3's protocol flags (`--spawn-evidence`/`--accept-evidence`) before delegating to the
  // real CLI, reproducing "this loop is new but the coach CLI on disk predates E3" without
  // needing a second checked-out worktree.
  const coachCliPath = opts.coachCliPath ?? COACH_CLI;
  const forceStopMs = opts.forceStopMs ?? 5_000;
  const forceKillMs = opts.forceKillMs ?? 200;
  const trainingOn = isTrainingEnabled(opts);
  const storeDir = opts.storeDir ?? null;
  const selfOpponentRequest = opts.selfOpponents ?? null;
  // The store launcher owns the store loop lock. Legacy API callers may use a
  // separate profile store while keeping their game-dir ownership unchanged.
  const ownsStore = storeDir !== null && path.resolve(storeDir) === lockRoot;
  // 플래그는 새 solve pending 생성만 게이트한다. 이미 pending에 적힌 adapterId는
  // 플래그 없이도 resume에서 재개된다.
  const solverAdapterId = typeof opts.solverAdapterId === 'string' && opts.solverAdapterId
    ? opts.solverAdapterId
    : null;
  const loopStatePath = path.join(root, 'loop-state.json');
  const engineStatePath = path.join(root, 'state.json');
  const playersPath = path.join(root, 'players.json');
  const sessionsPath = path.join(root, '.player-sessions.json');
  const reviewPath = path.join(root, 'review.md');
  const reviewEnvelopePath = path.join(root, '.review.json');
  const publishAttemptPath = path.join(root, '.publish-attempt.json');
  const lockPath = path.join(root, 'lock.json');
  const canaries = new Set();
  const activeChildren = new Set();
  const adapters = new Set();
  const adapterDisposals = new Map();
  const coachTasks = new Set();
  const coachAttempts = new Map();
  const trainingTasks = new Set();
  const trainingAttempts = new Map();
  const trainingInFlightHands = new Set();
  const trainingHooks = opts.training && typeof opts.training === 'object' ? opts.training : {};
  let trainingProducerOpen = false;
  const archiveCheckedHands = new Set();
  const restoredPlayerSessions = new Set();
  // #192 S4 E1: owners this exact loop instance minted with randomUUID() and durably
  // wrote to loop-state — bootstrap and resume are the only two writers. Never populated
  // from anything read off disk (a stale/foreign ownerSessionId never counts), so a lock
  // this instance never acquired, or a resume that fails before reaching the owner write,
  // leaves this empty.
  const issuedOwners = new Set();

  let lockHandle = initialLockHandle;
  // #192 L2: sticky across a retried `requestStop()` — the first attempt to detect a lost
  // lock nulls `lockHandle` via its own (unconditional, unchanged) `releaseLock()` call
  // before rejecting, so a caller that retries `requestStop()` after that rejection (e.g.
  // session-manager's `observeRun` cleanup catch) would otherwise look exactly like an
  // instance that never held the lock at all (item 2, design memo §11) and be let through.
  // This flag remembers "this instance already lost its lock" independent of `lockHandle`.
  let lockLostPermanently = false;
  let serverChild = null;
  let serverPid = null;
  let serverIdentity = null;
  let serverAdopted = false;
  let serverStartupIdentityMissing = false;
  let logFd = null;
  let playerAdapter = null;
  let upperAdapter = null;
  let coachAdapterDisabled = false;
  let playerSessions = null;
  let ownedPlayerAttempt = null;
  let resumeEntryPending = false;
  let doneResumeNoTrainingWrite = false;
  let stopRequested = false;
  let lifecycleStarted = false;
  let preserveLoopState = false;
  const managed = opts.controlProtocolVersion === 1;
  let control = null;
  let recoveringControl = false;
  let pauseRequested = !!opts.startPaused;
  let waitController = null;
  let parkWake = null;
  let pauseCompletion = null;
  let resolvePause = null;
  let terminalOperation = null;
  const auxiliaryTasks = new Set();
  const trackAuxiliary = (promise) => {
    auxiliaryTasks.add(promise);
    promise.finally(() => auxiliaryTasks.delete(promise)).catch(() => {});
    return promise;
  };
  let stopPromise = null;
  let pendingFinalStatePatch = null;
  let atomicTransition = null;
  let resolverPromise = null;
  let studyPromise = null;
  let finalizationCutoff = false;
  let publishDeadlineNs = null;
  let finalizeResultWaitCutoffNs = null;
  let finalizationDeadlineNs = null;
  let finalizationDeadlineStartedAt = null;
  let finalizationPriorTerminationConfirmed = true;

  // §9.2 (2): during the finalizing result-wait window a failed attempt may only be
  // replaced while at least 5s of that window remain. Outside finalization the play-time
  // replacement contract is unchanged.
  const coachReplacementAllowed = () => (
    finalizeResultWaitCutoffNs === null
    || canStartReplacement(monotonicNs(), finalizeResultWaitCutoffNs)
  );

  const assertBeforeResultWaitCutoff = () => {
    if (
      finalizeResultWaitCutoffNs !== null
      && remainingMsUntil(finalizeResultWaitCutoffNs) <= 0
    ) throw finalizationResultWaitCutoffError();
  };

  // Coach work stops taking new authority/publication steps once shutdown or the
  // game-over cutoff owns the sequence. After the cutoff, `finalize-cutoff` seals every
  // still-missing hand in one transaction and the residual drain publishes it.
  const coachWorkSuspended = () => stopRequested || finalizationCutoff || pauseRequested;

  // During finalization every accepted note remains in the owner-neutral Q until the
  // cutoff transaction has stopped play-time publishers. The residual drain is the only
  // publication path and carries the same final deadline.
  const coachPublicationDeferred = () => (
    coachWorkSuspended() || finalizationDeadlineNs !== null
  );

  const remainingMsUntil = (deadlineNs) => {
    const left = deadlineNs - monotonicNs();
    return left <= 0n ? 0 : Math.ceil(Number(left) / 1e6);
  };

  const finalizationDeadlineError = () => codedError(
    'FINALIZATION_DEADLINE_EXCEEDED',
    'finalization 공통 deadline이 만료됐습니다.',
  );

  const finalizationResultWaitCutoffError = () => codedError(
    'FINALIZATION_RESULT_WAIT_CUTOFF',
    'finalization result-wait cutoff가 만료됐습니다.',
  );

  const ensureFinalizationDeadline = () => {
    if (finalizationDeadlineNs === null) {
      finalizationDeadlineNs = monotonicNs() + BigInt(finalizeBudgetMs) * 1_000_000n;
      finalizationDeadlineStartedAt = isoNow(now);
    }
    return finalizationDeadlineNs;
  };

  const ensureFinalizationResultWaitCutoff = () => {
    const deadlineNs = ensureFinalizationDeadline();
    if (finalizeResultWaitCutoffNs === null) {
      finalizeResultWaitCutoffNs = deadlineNs - BigInt(finalizeCutoffLeadMs) * 1_000_000n;
    }
    return { deadlineNs, resultWaitCutoffNs: finalizeResultWaitCutoffNs };
  };

  const assertFinalizationDeadline = () => {
    if (finalizationDeadlineNs !== null && remainingMsUntil(finalizationDeadlineNs) <= 0) {
      throw finalizationDeadlineError();
    }
  };

  const assertAndBoundFinalizationMs = (ms) => {
    if (finalizationDeadlineNs === null) return ms;
    const remaining = remainingMsUntil(finalizationDeadlineNs);
    if (remaining <= 0) throw finalizationDeadlineError();
    return Math.min(ms, remaining);
  };

  const settleOrTimeout = async (promise, ms) => {
    let timer = null;
    try {
      return await Promise.race([
        promise.then(() => true, () => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const settleValueBeforeDeadline = async (promise, deadlineNs) => {
    // Observe both outcomes before consulting the deadline. Callers have already invoked
    // terminate(), so an expired deadline must not leave a rejected Promise unattached.
    const observed = Promise.resolve(promise).then(
      (value) => ({ settled: true, value }),
      (error) => ({ settled: true, error }),
    );
    const remaining = remainingMsUntil(deadlineNs);
    if (remaining <= 0) return { settled: false };
    let timer = null;
    try {
      return await Promise.race([
        observed,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ settled: false }), remaining);
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const assertNotStopping = () => {
    if (stopRequested) throw codedError('STOPPING', '정지 중에는 서버 복구·게시 재시도를 시작하지 않습니다.');
  };

  const d9Checkpoint = (name) => {
    opts.d9Checkpoint?.(name);
    assertNotStopping();
    assertFinalizationDeadline();
  };

  const log = (event, fields = {}) => {
    const record = { at: isoNow(now), event, ...fields };
    if (logFd !== null) fs.writeSync(logFd, `${JSON.stringify(record)}\n`);
    opts.log?.(record);
  };

  const openLog = () => {
    if (logFd !== null) return;
    fs.mkdirSync(root, { recursive: true });
    logFd = fs.openSync(path.join(root, 'loop.log'), 'a');
  };

  const readLoopState = () => readJsonOptional(loopStatePath, 'LOOP_STATE');
  const opponentRuntimeOf = () => readLoopState()?.opponentRuntime ?? requestedOpponentRuntime;
  const parseServerLock = (raw) => {
    let lock;
    try {
      lock = JSON.parse(raw);
    } catch (error) {
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK JSON이 올바르지 않습니다.', { cause: error });
    }
    if (
      !lock
      || typeof lock !== 'object'
      || Array.isArray(lock)
      || !Number.isSafeInteger(lock.serverPid)
      || lock.serverPid < 1
      || !Number.isSafeInteger(lock.port)
      || lock.port < 1
      || lock.port > 65_535
      || typeof lock.sessionToken !== 'string'
      || lock.sessionToken.length === 0
    ) {
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK pid/port/sessionToken 계약이 올바르지 않습니다.');
    }
    return lock;
  };
  const openServerLockPin = () => {
    let fd;
    try {
      fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK을 열 수 없습니다.', { cause: error });
    }
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n) {
        throw codedError('BAD_SERVER_LOCK', 'SERVER_LOCK이 일반 단일-link 파일이 아닙니다.');
      }
      const raw = fs.readFileSync(fd, 'utf8');
      return { fd, stat, raw, lock: parseServerLock(raw) };
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  };
  const closeServerLockPin = (pin) => {
    if (!pin || pin.fd === null) return;
    fs.closeSync(pin.fd);
    pin.fd = null;
  };
  const assertPinnedServerLock = (pin) => {
    if (!pin) throw codedError('SERVER_LOCK_REPLACED', '고정한 server lock identity가 없습니다.');
    let stat;
    let raw;
    try {
      stat = fs.lstatSync(lockPath, { bigint: true });
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (error) {
      throw codedError('SERVER_LOCK_REPLACED', '검증 중 server lock이 사라졌습니다.', { cause: error });
    }
    if (
      !stat.isFile()
      || stat.isSymbolicLink()
      || stat.dev !== pin.stat.dev
      || stat.ino !== pin.stat.ino
      || raw !== pin.raw
    ) {
      throw codedError('SERVER_LOCK_REPLACED', '검증 중 server lock path identity 또는 bytes가 교체됐습니다.');
    }
    return parseServerLock(raw);
  };
  const retirePinnedServerLock = (pin) => {
    assertNotStopping();
    if (!pin || pin.fd === null) {
      throw codedError('SERVER_LOCK_REPLACED', 'retirement할 server lock descriptor가 없습니다.');
    }
    // pathname을 검증한 뒤 unlink하면 그 두 syscall 사이에 들어온 replacement를 지울 수
    // 있다. 먼저 예측 불가능한 같은-directory quarantine으로 원자 이동하고, 실제로
    // 이동된 inode/bytes가 descriptor와 같을 때만 그 quarantine을 지운다.
    const quarantinePath = path.join(root, `.lock.json.retired-${randomUUID()}`);
    try {
      fs.renameSync(lockPath, quarantinePath);
    } catch (error) {
      throw codedError('SERVER_LOCK_REPLACED', 'server lock retirement 원자 이동에 실패했습니다.', { cause: error });
    }

    let movedMatches = false;
    try {
      const moved = fs.lstatSync(quarantinePath, { bigint: true });
      const raw = fs.readFileSync(quarantinePath, 'utf8');
      movedMatches = moved.isFile()
        && !moved.isSymbolicLink()
        && moved.dev === pin.stat.dev
        && moved.ino === pin.stat.ino
        && raw === pin.raw;
    } catch {
      movedMatches = false;
    }

    if (!movedMatches) {
      // replacement가 이동됐다. rename은 destination을 조용히 덮어쓰므로 복구에 쓰지
      // 않는다. 같은-directory hard link는 EEXIST로 두 파일을 모두 보존하며, 성공 시
      // source/destination이 같은 inode임을 증명한 뒤에만 quarantine 이름을 제거한다.
      try {
        fs.linkSync(quarantinePath, lockPath);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw codedError('SERVER_LOCK_REPLACED', '새 server lock이 있어 quarantine replacement를 함께 보존합니다.', {
            cause: error,
            quarantinePath,
          });
        }
        throw codedError('SERVER_LOCK_REPLACED', 'quarantine replacement를 non-clobber 복구하지 못했습니다.', {
          cause: error,
          quarantinePath,
        });
      }

      let quarantineStat;
      let restoredStat;
      try {
        quarantineStat = fs.lstatSync(quarantinePath, { bigint: true });
        restoredStat = fs.lstatSync(lockPath, { bigint: true });
      } catch (error) {
        throw codedError('SERVER_LOCK_REPLACED', '복구된 replacement identity를 확인할 수 없어 두 경로를 보존합니다.', {
          cause: error,
          quarantinePath,
        });
      }
      if (
        quarantineStat.dev !== restoredStat.dev
        || quarantineStat.ino !== restoredStat.ino
      ) {
        throw codedError('SERVER_LOCK_REPLACED', '복구 경로가 quarantine replacement와 다른 inode라 둘 다 보존합니다.', {
          quarantinePath,
        });
      }
      try {
        fs.unlinkSync(quarantinePath);
      } catch (error) {
        throw codedError('SERVER_LOCK_REPLACED', '복구 성공 뒤 quarantine 이름을 제거하지 못해 두 경로를 보존합니다.', {
          cause: error,
          quarantinePath,
        });
      }
      throw codedError('SERVER_LOCK_REPLACED', 'retirement 직전 server lock inode 또는 bytes가 교체됐습니다.');
    }

    fs.unlinkSync(quarantinePath);
    const pinned = fs.fstatSync(pin.fd, { bigint: true });
    if (pinned.nlink !== 0n) {
      throw codedError('SERVER_LOCK_REPLACED', '고정한 server lock inode retirement를 확인하지 못했습니다.');
    }
  };
  const readServerLock = () => {
    const pin = openServerLockPin();
    if (!pin) return null;
    try {
      return pin.lock;
    } finally {
      closeServerLockPin(pin);
    }
  };
  const writeLoopState = (patch) => {
    const current = readLoopState() ?? {};
    const next = { ...current, ...patch };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete next[key];
    }
    writeJsonAtomic(loopStatePath, next);
    return next;
  };

  const releaseLock = () => {
    if (!lockHandle) return;
    releaseOwnedLock(lockHandle);
    lockHandle = null;
  };

  const acquireLoopLock = async ({ mode, force = false }) => {
    if (lockHandle) throw codedError('LOCKED', '이 loop 인스턴스가 이미 락을 보유하고 있습니다.');
    // acquireOwnedLock은 일반 pid-less mutex와의 호환 때문에 오래된 unknown 기록을
    // mtime으로 회수할 수 있다. loop 락은 init의 파괴 경계를 보호하므로 더 엄격하다:
    // 존재하지만 identity가 불명인 기록은 나이와 무관하게 먼저 fail-closed한다.
    const observed = readOwnedLock(lockRoot, LOOP_LOCK, { processStartTime: startTimeOf });
    if (observed?.status === 'unknown') {
      throw codedError('LOOP_LOCK_UNKNOWN', 'loop 락 identity를 확인할 수 없어 중단합니다.');
    }
    try {
      lockHandle = acquireOwnedLock(lockRoot, LOOP_LOCK, { processStartTime: startTimeOf });
      return;
    } catch (error) {
      if (error.code === 'IDENTITY_UNAVAILABLE') throw error;
      if (error.code !== 'LOCKED') throw error;
      const owner = readOwnedLock(lockRoot, LOOP_LOCK, { processStartTime: startTimeOf });
      if (owner?.status === 'unknown') {
        throw codedError('LOOP_LOCK_UNKNOWN', 'loop 락 identity를 확인할 수 없어 중단합니다.');
      }
      if (owner?.status === 'dead') {
        throw codedError('LOOP_LOCK_UNRECLAIMABLE', '죽은 loop 락을 안전하게 회수할 수 없습니다.');
      }
      if (mode === 'bootstrap') {
        if (force) {
          await stopExistingLoopForForce(owner);
          lockHandle = acquireOwnedLock(lockRoot, LOOP_LOCK, { processStartTime: startTimeOf });
          return;
        }
        throw codedError('ACTIVE_GAME', '이미 진행 중인 게임이 있습니다.');
      }
      throw codedError('LOCKED', '다른 loop가 resume을 소유하고 있습니다.');
    }
  };

  const timeoutForChild = (args) => {
    const waits = args.includes('--wait') || args.includes('--wait-only');
    if (!waits) return childTimeoutMs;
    const index = args.lastIndexOf('--wait-ms');
    const declared = index === -1 ? waitMs : Number(args[index + 1]);
    const boundedWait = Number.isFinite(declared) && declared >= 0 ? declared : waitMs;
    // publish.js의 network abort margin(10s)보다 바깥 supervisor가 더 길어야
    // wait child가 자신의 truthful timeout envelope를 쓸 기회를 갖는다.
    return Math.max(childTimeoutMs, boundedWait + waitNetworkMarginMs);
  };

  const runJsonChild = async (script, args, {
    deadlineNs: deadlineOverrideNs,
    deadlineError = finalizationDeadlineError,
  } = {}) => {
    const deadlineNs = deadlineOverrideNs ?? finalizationDeadlineNs;
    const ordinaryTimeout = timeoutForChild(args);
    const deadlineRemaining = deadlineNs === null ? null : remainingMsUntil(deadlineNs);
    if (deadlineRemaining !== null && deadlineRemaining <= 0) {
      return Promise.reject(deadlineError());
    }
    const deadlineLimited = deadlineRemaining !== null && deadlineRemaining <= ordinaryTimeout;
    const timeout = deadlineLimited ? Math.max(1, deadlineRemaining) : ordinaryTimeout;
    const childArgs = [...args, '--game-dir', root];
    if (script === ENGINE_CLI) {
      const gate = opts.onEngineInvoke?.([...childArgs]);
      if (gate && typeof gate.then === 'function') {
        await gate;
        // A suspended preflight must not outlive shutdown. Already-owned atomic
        // transitions, however, must finish their engine mutation and publication.
        if (stopRequested && !atomicTransition) assertNotStopping();
      }
    }
    if (script === coachCliPath) opts.onCoachInvoke?.([...childArgs]);
    return new Promise((resolve, reject) => {
      const argv = [script, ...childArgs];
      const child = execFile(process.execPath, argv, childSpawnOptions({
        encoding: 'utf8',
        timeout,
        maxBuffer: 4 * 1024 * 1024,
      }), (error, stdout, stderr) => {
        activeChildren.delete(child);
        let envelope = null;
        try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
        if (error || envelope?.ok === false) {
          if (
            deadlineNs !== null
            && (envelope?.code === 'DEADLINE_EXPIRED'
              || (deadlineLimited && (error?.code === 'ETIMEDOUT' || error?.killed === true)))
          ) {
            reject(deadlineError());
            return;
          }
          reject(codedError(
            envelope?.code ?? error?.code ?? 'CHILD_FAILED',
            envelope?.message ?? String(stderr).trim() ?? '자식 프로세스가 실패했습니다.',
            { cause: error, envelope },
          ));
          return;
        }
        if (!envelope || envelope.ok !== true) {
          reject(codedError(
            'BAD_CHILD_OUTPUT',
            `${path.basename(script)} 출력이 JSON 성공 envelope가 아닙니다.`,
            { details: buildBadChildOutputDetails({ script, exitCode: child.exitCode, signal: child.signalCode, stdout, stderr }) },
          ));
          return;
        }
        if (deadlineNs !== null && remainingMsUntil(deadlineNs) <= 0) {
          reject(deadlineError());
          return;
        }
        resolve(envelope);
      });
      activeChildren.add(child);
    });
  };

  const assertHintEngine = async supervisor => {
    let caps;
    try { caps=await runJsonChild(ENGINE_CLI,['capabilities'],supervisor); }
    catch(error) {
      if (isFatalRuntimeFailure(error) || error.code === 'STOPPING' || error.code === 'FINALIZATION_RESULT_WAIT_CUTOFF') throw error;
      throw codedError('HINT_CAPABILITY_UNAVAILABLE','engine hint capability unavailable',{cause:error});
    }
    if (caps.preActionHints!==1 || caps.hintContractVersion!==1) throw codedError('HINT_CAPABILITY_UNAVAILABLE','engine hint capability missing');
  };
  const runCli = async (args, supervisor) => {
    const contract=readJsonOptional(engineStatePath,'ENGINE_STATE')?.config?.hintContractVersion;
    if ((contract===1 && ['step','apply','new-hand','end','hint-expose','resume-check'].includes(args[0]))
      || (args[0]==='init' && args.includes('--hints'))) await assertHintEngine(supervisor);
    return runJsonChild(ENGINE_CLI,args[0]==='resume-check' && lockRoot!==root ? [...args,'--lock-dir',lockRoot] : args,supervisor);
  };
  const runCoach = (args, supervisor) => runJsonChild(coachCliPath, args, supervisor);
  const resultWaitSupervisor = () => (
    finalizeResultWaitCutoffNs === null
      ? undefined
      : {
          deadlineNs: finalizeResultWaitCutoffNs,
          deadlineError: finalizationResultWaitCutoffError,
        }
  );
  const runCliBeforeResultCutoff = (args) => runCli(args, resultWaitSupervisor());
  const runCoachBeforeResultCutoff = (args) => runCoach(args, resultWaitSupervisor());
  // #192 I4: test seam for wherever the loop spawns the publish CLI — defaults to the real
  // tools/publish.js path.
  const publishCliPath = opts.publishCliPath ?? PUBLISH_CLI;
  const runPublish = (args) => {
    // Replayed bodies and queued/fallback envelopes cross the same output boundary.
    const from = args.indexOf('--from');
    let envelope;
    try {
      envelope = args.includes('--retry')
        ? readJsonOptional(path.join(root, '.publish-attempt.json'), 'PUBLISH_ATTEMPT')?.body
        : (from >= 0 ? readJsonOptional(args[from + 1], 'PUBLISH_ENVELOPE') : null);
    } catch (error) {
      // The publisher owns malformed-attempt rejection and its BAD_ATTEMPT code
      // drives the existing bounded recovery matrix. A syntax-invalid JSON file
      // has no publishable feedback; let that parser reject it, without bypassing
      // claim validation for a readable replay or swallowing I/O failures.
      if (!args.includes('--retry') || error.code !== 'BAD_PUBLISH_ATTEMPT'
        || !(error.cause instanceof SyntaxError)) throw error;
    }
    const feedback = [...(Array.isArray(envelope?.coach) ? envelope.coach.map((note) => note.text) : []), envelope?.review];
    if (feedback.some((text) => !referenceClaimAllowed(text))) {
      throw codedError('REFERENCE_AUTHORITY_CLAIM', '게시할 피드백에 근거 범위를 벗어난 표현이 있습니다.');
    }
    // After the cutoff every publication must carry the single finalization deadline:
    // publish.js refuses new play-time bodies once `noNewPlayTimePublishers` is set, and
    // the deadline is what bounds the residual drain to the remaining budget.
    const deadlined = publishDeadlineNs !== null && !args.includes('--deadline-monotonic-ns')
      ? [...args, '--deadline-monotonic-ns', String(publishDeadlineNs)]
      : args;
    opts.onPublishInvoke?.([...deadlined]);
    return runJsonChild(publishCliPath, deadlined);
  };

  const serverHealthy = async (port, { stopAware = false } = {}) => {
    if (!Number.isInteger(port) || port < 1) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), assertAndBoundFinalizationMs(localHttpProbeMs));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
      if (stopAware) assertNotStopping();
      const body = await response.json();
      if (stopAware) assertNotStopping();
      return response.ok && body.ok === true;
    } catch (error) {
      if (error.code === 'STOPPING') throw error;
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const listenerOwnedBy = async (pid, port) => {
    try {
      return await listenerOwnedByFn(pid, port, { timeoutMs: assertAndBoundFinalizationMs(osVerifyMs) });
    } catch (error) {
      if (error?.code === 'SERVER_LISTENER_UNAVAILABLE') {
        throw codedError('SERVER_LISTENER_UNAVAILABLE', error.message, { cause: error });
      }
      throw codedError('SERVER_LISTENER_UNAVAILABLE', 'pid↔port OS 검증을 완료할 수 없습니다.', { cause: error });
    }
  };

  const assertAuthenticatedServer = async (port, sessionToken, { stopAware = false } = {}) => {
    const requestSnapshot = async (token) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), assertAndBoundFinalizationMs(localHttpProbeMs));
      try {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/snapshot?token=${encodeURIComponent(token)}`,
          { signal: controller.signal },
        );
        let body = null;
        try { body = await response.json(); } catch { /* validated by caller */ }
        return { response, body };
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const challenge = `SIDECAR_AUTH_CHALLENGE_${randomBytes(24).toString('hex')}`;
      const denied = await requestSnapshot(challenge);
      if (stopAware) assertNotStopping();
      if (denied.response.status !== 401 || denied.body?.code !== 'UNAUTHORIZED') {
        throw codedError('SERVER_AUTH_FAILED', '서버가 fresh wrong-token challenge를 거부하지 않았습니다.');
      }
      const { response, body: snapshot } = await requestSnapshot(sessionToken);
      if (stopAware) assertNotStopping();
      if (!response.ok) throw codedError('SERVER_AUTH_FAILED', '서버 token 인증 probe가 거부됐습니다.');
      if (
        !snapshot
        || typeof snapshot !== 'object'
        || !Number.isInteger(snapshot.revision)
        || !Object.hasOwn(snapshot, 'view')
        || !Array.isArray(snapshot.log)
        || !Array.isArray(snapshot.coach)
      ) {
        throw codedError('SERVER_AUTH_FAILED', '서버 token 인증 응답이 relay snapshot 계약과 다릅니다.');
      }
      return snapshot;
    } catch (error) {
      if (error.code === 'STOPPING') throw error;
      if (error.code === 'SERVER_AUTH_FAILED') throw error;
      throw codedError('SERVER_AUTH_UNAVAILABLE', '서버 token 인증 probe를 완료할 수 없습니다.', { cause: error });
    }
  };

  const assertServerBinding = async ({ serverPid: pid, port, sessionToken }, { stopAware = false } = {}) => {
    let ownsListener;
    try {
      ownsListener = await listenerOwnedBy(pid, port);
      if (stopAware) assertNotStopping();
    } catch (error) {
      throw error;
    }
    if (!ownsListener) {
      throw codedError('SERVER_LISTENER_MISMATCH', 'lock.serverPid가 lock.port listener를 소유하지 않습니다.');
    }
    const snapshot = await assertAuthenticatedServer(port, sessionToken, { stopAware });
    if (stopAware) assertNotStopping();
    return snapshot;
  };

  const ensureStudyForOwner = async () => {
    if (!ownsStore) return null;
    assertNotStopping();
    if (!lockHandle) throw codedError('PARENT_IDENTITY_MISMATCH', 'store loop ownership가 없습니다.');
    const pending = ensureStudyService(storeDir, {
      parentIdentity: { pid: lockHandle.pid, startTime: lockHandle.startTime },
    });
    studyPromise = pending;
    try {
      const service = await pending;
      assertNotStopping();
      return service;
    } finally {
      if (studyPromise === pending) studyPromise = null;
    }
  };

  const matchesStoreRelay = async ({ port, sessionToken }, snapshot, study, { stopAware }) => {
    if (!study) return true;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { 'x-session-token': sessionToken },
      signal: AbortSignal.timeout(assertAndBoundFinalizationMs(localHttpProbeMs)),
    });
    if (stopAware) assertNotStopping();
    let health = null;
    try { health = await response.json(); } catch { /* incompatible owned relay */ }
    if (stopAware) assertNotStopping();
    return response.ok && health?.ok === true && health.protocolVersion === 2
      && health.capabilities?.actionReceipts === true && health.capabilities?.studyLink === true
      && (opts.hints !== 'on' || health.capabilities?.preActionHints === 1)
      && snapshot.studyUrl === study.studyUrl;
  };

  const identityStillAlive = (pid, startTime, { owned = false } = {}) => {
    if (!processAlive(pid)) return false;
    const current = owned ? ownedStartTimeOf(pid) : startTimeOf(pid);
    if (current === null) {
      throw codedError('IDENTITY_UNAVAILABLE', `pid ${pid} startTime을 재검증할 수 없습니다.`);
    }
    return current === startTime;
  };

  const sendSignal = (pid, signal, code) => {
    try {
      signalProcess(pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw codedError(code, `pid ${pid}에 ${signal} 전송을 완료하지 못했습니다.`, { cause: error });
    }
  };

  const waitForIdentityDeath = async (pid, startTime, timeoutMs, {
    unavailableCode,
    mismatchCode,
    label,
    owned = false,
  }) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return true;
      const current = owned ? ownedStartTimeOf(pid) : startTimeOf(pid);
      if (current === null) {
        // 종료 직후 kill(0)은 아직 성공하지만 ps identity가 먼저 사라지는
        // 짧은 전이 창이 있다. unknown을 사망으로 승격하지 않고 deadline까지 재확인한다.
        await sleep(pollMs);
        continue;
      }
      if (current !== startTime) {
        // pid 재사용은 원래 대상의 사망 증거가 아니다. 새 프로세스를
        // 살려 둔 채 아카이브나 추가 시그널로 진행하지 않는다.
        throw codedError(mismatchCode, `${label} pid가 다른 프로세스로 재사용됐습니다.`);
      }
      await sleep(pollMs);
    }
    if (!processAlive(pid)) return true;
    const current = owned ? ownedStartTimeOf(pid) : startTimeOf(pid);
    if (current === null) {
      throw codedError(unavailableCode, `${label} pid identity를 재검증할 수 없습니다.`);
    }
    if (current !== startTime) {
      throw codedError(mismatchCode, `${label} pid가 다른 프로세스로 재사용됐습니다.`);
    }
    return false;
  };

  const assertSameLoopOwner = (expected) => {
    const current = readOwnedLock(lockRoot, LOOP_LOCK, { processStartTime: startTimeOf });
    if (
      current?.status !== 'alive'
      || current.pid !== expected.pid
      || current.startTime !== expected.startTime
    ) {
      throw codedError('LOOP_IDENTITY_CHANGED', '정지 대상 loop identity가 바뀌어 시그널을 보내지 않습니다.');
    }
    return current;
  };

  const stopExistingLoopForForce = async (owner) => {
    const expected = { pid: owner.pid, startTime: owner.startTime };
    const signalLoopOwner = (signal) => {
      assertSameLoopOwner(expected);
      // lock 동일성 검사 직후 startTime을 한 번 더 맞춘 뒤 동기적으로 시그널한다.
      if (!identityStillAlive(expected.pid, expected.startTime, { owned: true })) {
        throw codedError('LOOP_IDENTITY_MISMATCH', '정지 대상 loop pid identity가 바뀌었습니다.');
      }
      return sendSignal(expected.pid, signal, 'LOOP_SIGNAL_FAILED');
    };
    signalLoopOwner('SIGTERM');
    if (await waitForIdentityDeath(expected.pid, expected.startTime, forceStopMs, {
      unavailableCode: 'LOOP_IDENTITY_UNAVAILABLE',
      mismatchCode: 'LOOP_IDENTITY_MISMATCH',
      label: 'loop',
      owned: true,
    })) return;
    // KILL 직전에도 lock pid+startTime이 같은 소유자를 가리킬 때만 신호한다.
    signalLoopOwner('SIGKILL');
    if (!await waitForIdentityDeath(expected.pid, expected.startTime, forceKillMs, {
      unavailableCode: 'LOOP_IDENTITY_UNAVAILABLE',
      mismatchCode: 'LOOP_IDENTITY_MISMATCH',
      label: 'loop',
      owned: true,
    })) {
      throw codedError('LOOP_ALIVE', '기존 게임 루프 종료를 확인하지 못해 아카이브하지 않습니다.');
    }
  };

  const assertSameForceServer = async (expected) => {
    const current = readServerLock();
    if (
      current?.serverPid !== expected.serverPid
      || current.port !== expected.port
      || current.sessionToken !== expected.sessionToken
    ) {
      throw codedError('SERVER_IDENTITY_CHANGED', '정지 대상 server lock이 바뀌어 시그널을 보내지 않습니다.');
    }
    if (!identityStillAlive(expected.serverPid, expected.startTime)) {
      throw codedError('SERVER_IDENTITY_MISMATCH', '정지 대상 server pid가 재사용되어 시그널을 보내지 않습니다.');
    }
    await assertServerBinding(current);
  };

  const signalSameForceServer = (expected, signal) => {
    const current = readServerLock();
    if (
      current?.serverPid !== expected.serverPid
      || current.port !== expected.port
      || current.sessionToken !== expected.sessionToken
    ) {
      throw codedError('SERVER_IDENTITY_CHANGED', '시그널 직전 server lock이 바뀌었습니다.');
    }
    // listener/token 검증은 await를 포함하므로, 그 뒤 신호 직전에
    // pid+startTime을 다시 맞춰 async 간격에서의 pid 재사용을 차단한다.
    if (!identityStillAlive(expected.serverPid, expected.startTime)) {
      throw codedError('SERVER_IDENTITY_MISMATCH', '정지 대상 server pid가 재사용됐습니다.');
    }
    return sendSignal(expected.serverPid, signal, 'SERVER_SIGNAL_FAILED');
  };

  const removeStoppedForceServerLock = (expected, pin) => {
    const current = assertPinnedServerLock(pin);
    if (
      current.serverPid !== expected.serverPid
      || current.port !== expected.port
      || current.sessionToken !== expected.sessionToken
    ) {
      throw codedError('SERVER_IDENTITY_CHANGED', '종료 확인 후 server lock이 바뀌었습니다.');
    }
    if (processAlive(current.serverPid)) {
      if (expected.startTime !== undefined) {
        const currentStart = startTimeOf(current.serverPid);
        if (currentStart === null) {
          throw codedError('SERVER_IDENTITY_UNAVAILABLE', '종료 후 server pid identity를 확인할 수 없습니다.');
        }
        if (currentStart !== expected.startTime) {
          throw codedError('SERVER_IDENTITY_MISMATCH', '종료 후 server pid가 재사용되어 lock을 제거하지 않습니다.');
        }
      }
      throw codedError('SERVER_ALIVE', '기존 게임 서버가 살아 있어 lock을 제거하지 않습니다.');
    }
    retirePinnedServerLock(pin);
  };

  const stopRereadServerForForce = async () => {
    // Loop 사망 확인 뒤 lock.json을 새로 읽는다. loop가 종료 직전 교체한 서버가
    // 있더라도, force 시작 전에 보았던 낡은 pid가 아니라 이 identity만 대상이다.
    const pin = openServerLockPin();
    if (!pin) return;
    try {
      const lock = pin.lock;
      if (!processAlive(lock.serverPid)) {
        // 시그널 대상이 없는 stale lock도 처음 고정한 descriptor 자체만 retire한다.
        removeStoppedForceServerLock(lock, pin);
        return;
      }
      const startTime = startTimeOf(lock.serverPid);
      if (startTime === null) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', 'force server startTime을 확인할 수 없습니다.');
      }
      const expected = { ...lock, startTime };
      await assertSameForceServer(expected);
      signalSameForceServer(expected, 'SIGTERM');
      if (await waitForIdentityDeath(expected.serverPid, expected.startTime, forceStopMs, {
        unavailableCode: 'SERVER_IDENTITY_UNAVAILABLE',
        mismatchCode: 'SERVER_IDENTITY_MISMATCH',
        label: 'server',
      })) {
        removeStoppedForceServerLock(expected, pin);
        return;
      }
      await assertSameForceServer(expected);
      signalSameForceServer(expected, 'SIGKILL');
      if (!await waitForIdentityDeath(expected.serverPid, expected.startTime, forceKillMs, {
        unavailableCode: 'SERVER_IDENTITY_UNAVAILABLE',
        mismatchCode: 'SERVER_IDENTITY_MISMATCH',
        label: 'server',
      })) {
        throw codedError('SERVER_ALIVE', '기존 게임 서버 종료를 확인하지 못해 아카이브하지 않습니다.');
      }
      removeStoppedForceServerLock(expected, pin);
    } finally {
      closeServerLockPin(pin);
    }
  };

  const ensureServer = async (sessionToken, {
    port: desiredPort = requestedPort,
    pin: providedPin = null,
    stopAware = true,
    recovery = false,
  } = {}) => {
    if (stopAware) assertNotStopping();
    if (managed && !control) {
      control = createSessionControl(root, gameEpochOf(sessionToken), { startPaused: pauseRequested, gameId:path.basename(root), mustExist:recoveringControl && readLoopState()?.controlProtocolVersion===1 });
      writeLoopState({controlProtocolVersion:1});
    }
    if (!Number.isSafeInteger(desiredPort) || desiredPort < 0 || desiredPort > 65_535) {
      throw codedError('BAD_SERVER_PORT', `서버 재기동 port가 올바르지 않습니다: ${desiredPort}`);
    }
    const study = ownsStore ? await ensureStudyForOwner() : null;
    if (recovery) d9Checkpoint('after-study-ensure');
    const ownsPin = providedPin === null;
    let pin = providedPin ?? openServerLockPin();
    try {
      const existing = pin?.lock ?? null;
      if (existing) {
        if (existing.sessionToken !== sessionToken || (existing.controlProtocolVersion ?? null) !== (managed ? 1 : null)) {
          throw codedError('SERVER_LOCK_MISMATCH', '기존 server lock의 sessionToken이 현재 게임과 다릅니다.');
        }
        if (processAlive(existing.serverPid)) {
          const startTime = startTimeOf(existing.serverPid);
          if (startTime === null) {
            throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 startTime을 확인할 수 없습니다.');
          }
          await assertServerBinding(existing, { stopAware });
          if (stopAware) assertNotStopping();
          const confirmed = assertPinnedServerLock(pin);
          if (
            confirmed.serverPid !== existing.serverPid
            || confirmed.port !== existing.port
            || confirmed.sessionToken !== sessionToken
            || startTimeOf(existing.serverPid) !== startTime
          ) {
            throw codedError('SERVER_IDENTITY_CHANGED', '재사용 서버 identity가 adoption 중 바뀌었습니다.');
          }
          const snapshot = await assertServerBinding(confirmed, { stopAware });
          if (stopAware) assertNotStopping();
          if (startTimeOf(existing.serverPid) !== startTime) {
            throw codedError('SERVER_IDENTITY_CHANGED', '재사용 서버 identity가 binding 재검증 뒤 바뀌었습니다.');
          }
          const compatible = study ? await matchesStoreRelay(confirmed, snapshot, study, { stopAware }) : true;
          if (study) {
            assertPinnedServerLock(pin);
            if (startTimeOf(existing.serverPid) !== startTime) {
              throw codedError('SERVER_IDENTITY_CHANGED', 'store relay identity가 capability 검증 중 바뀌었습니다.');
            }
          }
          serverChild = serverChild?.pid === existing.serverPid ? serverChild : null;
          serverPid = existing.serverPid;
          serverIdentity = { pid: existing.serverPid, startTime };
          serverAdopted = serverChild === null;
          serverStartupIdentityMissing = false;
          if (compatible) return existing.port;
          // Ownership/authentication is already proved. Retire only this pinned
          // relay when it lacks receipts or the current service capability URL.
          await stopServer({ boundToFinalizationDeadline: recovery });
          if (recovery) d9Checkpoint('after-incompatible-relay-stop');
          else if (stopAware) assertNotStopping();
          log('server-capability-replaced', { pid: existing.serverPid });
        }

        const confirmed = assertPinnedServerLock(pin);
        if (processAlive(confirmed.serverPid)) {
          throw codedError('SERVER_IDENTITY_CHANGED', '죽은 server pid가 확인 중 다시 살아났습니다.');
        }
        if (recovery) d9Checkpoint('before-retire-existing');
        else if (stopAware) assertNotStopping();
        retirePinnedServerLock(pin);
      }

      if (recovery) d9Checkpoint('before-spawn');
      else if (stopAware) assertNotStopping();
      const argv = [
        SERVER_CLI,
        '--game-dir', root,
        '--port', String(desiredPort),
        '--token', sessionToken,
        ...(study ? ['--study-url', study.studyUrl] : []), ...(managed ? ['--control-protocol', '1'] : []),
      ];
      const child = spawn(process.execPath, argv, childSpawnOptions({
        cwd: ROOT,
        stdio: 'ignore',
      }));
      serverChild = child;
      serverPid = child.pid ?? null;
      serverAdopted = false;
      serverStartupIdentityMissing = false;
      serverIdentity = null;
      let spawnError = null;
      child.once('error', (error) => { spawnError = error; });
      const spawnedStartTime = serverPid === null ? null : startTimeOf(serverPid);
      if (spawnedStartTime === null) {
        // spawn handle은 이미 우리 소유다. identity를 세울 수 없는 자식은 첫 await 전에
        // 즉시 KILL+exit 확인한다. 확인 실패면 handle을 유지해 bootstrap catch의
        // requestStop이 같은 직접 자식을 다시 종료하고 확인하게 한다.
        serverStartupIdentityMissing = true;
        await terminateUnidentifiedDirectServerChild(500);
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '새 server child startTime을 spawn 직후 확인할 수 없습니다.');
      }
      serverIdentity = { pid: serverPid, startTime: spawnedStartTime };
      log('server-spawn', { pid: serverPid, requestedPort: desiredPort });

      const deadline = Date.now() + serverStartMs;
      while (Date.now() < deadline) {
        if (recovery) d9Checkpoint('startup-iteration');
        else if (stopAware) assertNotStopping();
        if (spawnError) throw codedError('SERVER_START_FAILED', spawnError.message, { cause: spawnError });
        if (child.exitCode !== null || child.signalCode !== null) {
          throw codedError('SERVER_START_FAILED', `서버 자식이 조기 종료했습니다: ${child.exitCode ?? child.signalCode}`);
        }
        const lock = readServerLock();
        if (
          lock?.serverPid === child.pid
          && lock.sessionToken === sessionToken
          && await serverHealthy(lock.port, { stopAware })
        ) {
          if (stopAware) assertNotStopping();
          serverPid = lock.serverPid;
          const startTime = startTimeOf(lock.serverPid);
          if (startTime === null) {
            throw codedError('SERVER_IDENTITY_UNAVAILABLE', '새 server child startTime을 확인할 수 없습니다.');
          }
          if (
            serverIdentity?.pid !== lock.serverPid
            || serverIdentity.startTime !== startTime
          ) {
            throw codedError('SERVER_IDENTITY_CHANGED', '새 server child identity가 startup 중 바뀌었습니다.');
          }
          // Keep a fresh inode/bytes pin across listener, token and study URL
          // checks, then revalidate both the child and the pinned lock.
          if (pin) closeServerLockPin(pin);
          const startupRootOwner = createRelayRootOwner(root);
          pin = openServerLockPin();
          if (!pin) throw codedError('SERVER_LOCK_REPLACED', '새 server lock을 고정할 수 없습니다.');
          const pinned = assertPinnedServerLock(pin);
          if (pinned.serverPid !== child.pid || pinned.port !== lock.port || pinned.sessionToken !== sessionToken) {
            throw codedError('SERVER_LOCK_REPLACED', '새 server lock identity가 바뀌었습니다.');
          }
          const snapshot = await assertServerBinding(pinned, { stopAware });
          if (study && !await matchesStoreRelay(pinned, snapshot, study, { stopAware })) {
            throw codedError('SERVER_CAPABILITY_MISMATCH', '새 store relay의 학습 capability 연결이 올바르지 않습니다.');
          }
          if (stopAware) assertNotStopping();
          const confirmed = assertPinnedServerLock(pin);
          if (child.exitCode !== null || child.signalCode !== null || startTimeOf(child.pid) !== spawnedStartTime) {
            throw codedError('SERVER_IDENTITY_CHANGED', '새 server child identity가 binding 뒤 바뀌었습니다.');
          }
          closeServerLockPin(pin);
          pin = null;
          writeRelayJsonAtomic(startupRootOwner, 'lock.json', { ...confirmed, serverStartTime: spawnedStartTime });
          const merged = readServerLock();
          if (merged?.serverStartTime !== spawnedStartTime || merged.serverPid !== child.pid
            || merged.port !== confirmed.port || merged.sessionToken !== sessionToken) {
            throw codedError('SERVER_IDENTITY_CHANGED', 'serverStartTime 병합이 서버 lock을 바꾸었습니다.');
          }
          return merged.port;
        }
        await sleep(recovery ? assertAndBoundFinalizationMs(pollMs) : pollMs);
        if (recovery) d9Checkpoint('after-startup-sleep');
        else if (stopAware) assertNotStopping();
      }
      throw codedError('SERVER_START_TIMEOUT', '서버 health 확인 시간이 초과됐습니다.');
    } finally {
      if (ownsPin) closeServerLockPin(pin);
    }
  };

  const startAdapterDisposal = (adapter) => {
    if (!adapter || adapterDisposals.has(adapter)) return adapterDisposals.get(adapter) ?? Promise.resolve();
    let disposal;
    try {
      // createPlayerRuntime.dispose()는 호출 동기 구간에서 runtime을 영구 closed로 만든다.
      // stop 중 새로 등록된 adapter가 다음 probe child를 만들기 전에 이 호출을 시작한다.
      disposal = typeof adapter.dispose === 'function'
        ? Promise.resolve(adapter.dispose())
        : Promise.resolve();
    } catch (error) {
      disposal = Promise.reject(error);
    }
    disposal.catch(() => {});
    adapterDisposals.set(adapter, disposal);
    return disposal;
  };

  const registerAdapter = (adapter) => {
    if (!adapter) return;
    adapters.add(adapter);
    if (stopRequested) startAdapterDisposal(adapter);
  };

  const createCanaryAndResolve = async (need) => {
    if (resolverPromise) throw codedError('RESOLVER_OVERLAP', 'runtime resolver 호출이 중첩됐습니다.');
    const canaryAbsPath = path.join(root, `.runtime-canary-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(canaryAbsPath, `SIDECAR_CANARY_${randomBytes(24).toString('hex')}`);
    canaries.add(canaryAbsPath);
    const invocation = Promise.resolve().then(() => resolver({
      need,
      canaryAbsPath,
      registerAdapter,
    }));
    resolverPromise = invocation;
    try {
      const resolved = await invocation;
      assertNotStopping();
      return resolved;
    } finally {
      if (resolverPromise === invocation) resolverPromise = null;
      try { fs.unlinkSync(canaryAbsPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      canaries.delete(canaryAbsPath);
    }
  };

  const selectAdapters = (resolved) => {
    playerAdapter = resolved.player ?? null;
    upperAdapter = resolved.upper ?? null;
    registerAdapter(playerAdapter);
    registerAdapter(upperAdapter);
  };

  const haltNoPlayer = async (notices) => {
    writeLoopState({
      notices,
      halt: {
        code: 'NO_PLAYER_RUNTIME',
        message: '적격 플레이어 런타임이 없습니다.',
      },
    });
    throw codedError('NO_PLAYER_RUNTIME', '적격 플레이어 런타임이 없습니다.');
  };

  const createPlayerSession = async (persona, createdAt, {
    deadlineAt = null,
    purpose = 'repair-warmup',
    onWarmupClosed = null,
  } = {}) => {
    const prompt = buildPlayerPrompt({ persona });
    const timeoutMs = deadlineAt === null ? null : Math.ceil(deadlineAt - monotonicNow());
    if (timeoutMs !== null && timeoutMs <= 0) {
      throw codedError('TIMEOUT', `플레이어 ${persona.playerId} 세션 복구 예산이 만료됐습니다.`);
    }
    let result, code='RESPONSE_RECEIVED';
    const started=monotonicNow();
    try { result = await playerAdapter.warmup({
      playerId: persona.playerId, prompt, ...(timeoutMs === null ? {} : { timeoutMs }),
    }); } catch(error) {code=error.code??'CLI_FAILED';throw error;}
    finally {
      if(deadlineAt!==null) log('player-call',{purpose,
        decisionId:readLoopState()?.pendingDecision?.decisionId??null,
        generation:readLoopState()?.pendingDecision?.generation??null,
        runtime:playerAdapter.kind,model:RUNTIME_TABLE[playerAdapter.kind]?.player??null,
        timeoutMs,elapsedMs:Math.max(0,monotonicNow()-started),code,
        category:code==='RESPONSE_RECEIVED'?'response':playerFailureCategory(code),censored:code==='TIMEOUT'});
    }
    if (!result || typeof result.sessionId !== 'string' || result.sessionId === '') {
      throw codedError('NO_SESSION', `플레이어 ${persona.playerId} 세션이 없습니다.`);
    }
    if (!isArgvSafeSessionId(result.sessionId)) {
      throw codedError('INVALID_SESSION_ID', `플레이어 ${persona.playerId} 세션 id 형식이 안전하지 않습니다.`);
    }
    const session = {
      runtime: playerAdapter.kind,
      sessionId: result.sessionId,
      createdAt,
    };
    if (typeof onWarmupClosed === 'function') await onWarmupClosed(session.sessionId);
    return session;
  };

  const preparePlayerSessions = async ({ reuseExisting = false } = {}) => {
    if (!playerAdapter) throw codedError('NO_PLAYER_RUNTIME', '적격 플레이어 런타임이 없습니다.');
    const players = readJsonOptional(playersPath, 'PLAYERS');
    if (!Array.isArray(players)) throw codedError('BAD_PLAYERS', 'players.json이 배열이 아닙니다.');
    const aiPlayers = players.filter((player) => player.playerId !== 'user');
    const createdAt = readLoopState()?.startedAt ?? isoNow(now);
    let existing = {};
    if (reuseExisting) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
      } catch {
        // 파일 전체가 없거나 손상돼도 게임 identity와는 독립이다. 해당 entry들을 아래에서
        // 페르소나 카드로 다시 만들고 repaired map을 원자 기록한다.
        existing = {};
      }
    }
    restoredPlayerSessions.clear();
    const settled = await Promise.allSettled(aiPlayers.map(async (persona) => {
      const prior = existing[persona.playerId];
      if (
        reuseExisting
        && prior
        && typeof prior === 'object'
        && !Array.isArray(prior)
        && prior.runtime === playerAdapter.kind
        && isArgvSafeSessionId(prior.sessionId)
        && typeof prior.createdAt === 'string'
        && prior.createdAt !== ''
      ) {
        restoredPlayerSessions.add(persona.playerId);
        return [persona.playerId, {
          runtime: prior.runtime,
          sessionId: prior.sessionId,
          createdAt: prior.createdAt,
        }];
      }
      restoredPlayerSessions.delete(persona.playerId);
      return [persona.playerId, await createPlayerSession(persona, createdAt)];
    }));
    const failed = settled.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    const rows = settled.map((result) => result.value);
    const sessions = Object.fromEntries(rows);
    writeJsonAtomic(sessionsPath, sessions);
    playerSessions = sessions;
    return sessions;
  };
  const warmPlayers = () => preparePlayerSessions({ reuseExisting: false });
  const restorePlayers = () => preparePlayerSessions({ reuseExisting: true });

  const recreatePlayerSession = async (playerId, {
    deadlineAt,
    reason,
    onWarmupClosed = null,
  }) => {
    const players = readJsonOptional(playersPath, 'PLAYERS');
    const persona = Array.isArray(players)
      ? players.find((player) => player?.playerId === playerId && playerId !== 'user')
      : null;
    if (!persona) throw codedError('BAD_PLAYERS', `복구할 플레이어 ${playerId} 페르소나가 없습니다.`);
    const repaired = await createPlayerSession(persona, isoNow(now), {
      deadlineAt,
      purpose: reason === 'user_fresh_session' ? 'fresh-warmup' : 'repair-warmup',
      onWarmupClosed,
    });
    if (stopRequested) throw codedError('STOPPING', '세션 기록 전에 loop 정지가 요청되었습니다.');
    const nextSessions = { ...(playerSessions ?? {}), [playerId]: repaired };
    writeJsonAtomic(sessionsPath, nextSessions);
    playerSessions = nextSessions;
    restoredPlayerSessions.delete(playerId);
    log('player-session-recreated', {
      playerId,
      runtime: repaired.runtime,
      reason,
      decisionId: readLoopState()?.pendingDecision?.decisionId ?? null,
      generation: readLoopState()?.pendingDecision?.generation ?? null,
    });
    return repaired;
  };

  const repairRestoredPlayerSession = async (playerId, { deadlineAt }) => {
    if (!restoredPlayerSessions.has(playerId)) return null;
    // Consume-before-await prevents a failed repair from recursively recreating the same
    // persisted child. A later process resume may still retry the old on-disk entry.
    restoredPlayerSessions.delete(playerId);
    return recreatePlayerSession(playerId, { deadlineAt, reason: 'restored_session_repair' });
  };

  const clearDirectServerOwnership = () => {
    serverChild = null;
    serverIdentity = null;
    serverPid = null;
    serverAdopted = false;
    serverStartupIdentityMissing = false;
  };

  const terminateUnidentifiedDirectServerChild = async (timeoutMs = 500) => {
    const child = serverChild;
    if (!child) return true;
    if (child.exitCode !== null || child.signalCode !== null) {
      clearDirectServerOwnership();
      return true;
    }
    try { child.kill('SIGKILL'); } catch { /* exit confirmation below remains authoritative */ }
    if (await waitForChildExit(child, timeoutMs)) {
      clearDirectServerOwnership();
      return true;
    }
    return false;
  };

  const stopDirectServerChild = async ({ boundToFinalizationDeadline = false } = {}) => {
    const child = serverChild;
    if (!child) return;
    if (serverStartupIdentityMissing) {
      if (!await terminateUnidentifiedDirectServerChild(500)) {
        throw codedError('SERVER_STOP_UNCONFIRMED', 'identity 미확인 startup server child 종료를 확인하지 못했습니다.');
      }
      return;
    }
    const signalDirectChild = (signal) => {
      if (child.exitCode !== null || child.signalCode !== null || !processAlive(child.pid)) return false;
      const identity = serverIdentity;
      if (!identity || identity.pid !== child.pid) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '직접 server child의 시작 identity가 없습니다.');
      }
      const current = startTimeOf(child.pid);
      if (current === null) {
        throw codedError('SERVER_IDENTITY_UNAVAILABLE', '직접 server child startTime을 시그널 직전 확인할 수 없습니다.');
      }
      if (current !== identity.startTime) {
        throw codedError('SERVER_IDENTITY_MISMATCH', '직접 server child pid가 다른 프로세스로 재사용됐습니다.');
      }
      const delivered = child.kill(signal);
      if (delivered === false && child.exitCode === null && child.signalCode === null && processAlive(child.pid)) {
        throw codedError('SERVER_SIGNAL_FAILED', `직접 server child에 ${signal}을 전달하지 못했습니다.`);
      }
      return delivered;
    };
    if (child.exitCode === null && child.signalCode === null) {
      let exited = false;
      const exit = new Promise((resolve) => child.once('exit', () => {
        exited = true;
        resolve();
      }));
      signalDirectChild('SIGTERM');
      await Promise.race([
        exit,
        sleep(boundToFinalizationDeadline ? assertAndBoundFinalizationMs(1_000) : 1_000),
      ]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        if (boundToFinalizationDeadline) assertFinalizationDeadline();
        signalDirectChild('SIGKILL');
        await Promise.race([
          exit,
          sleep(boundToFinalizationDeadline ? assertAndBoundFinalizationMs(1_000) : 1_000),
        ]);
      }
      if (!exited && child.exitCode === null && child.signalCode === null) {
        throw codedError('SERVER_STOP_UNCONFIRMED', '직접 server child 종료를 확인하지 못했습니다.');
      }
    }
    clearDirectServerOwnership();
  };

  const adoptedIdentityStatus = () => {
    const identity = serverIdentity;
    if (!identity) throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 identity가 없습니다.');
    if (!processAlive(identity.pid)) return 'dead';
    const current = startTimeOf(identity.pid);
    if (current === null) {
      throw codedError('SERVER_IDENTITY_UNAVAILABLE', '재사용 서버 startTime 재검증에 실패했습니다.');
    }
    if (current !== identity.startTime) {
      throw codedError('SERVER_IDENTITY_MISMATCH', '재사용 서버 pid가 다른 프로세스로 바뀌었습니다.');
    }
    return 'alive';
  };

  const waitForAdoptedDeath = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!processAlive(serverIdentity.pid)) return true;
      await sleep(pollMs);
    }
    return !processAlive(serverIdentity.pid);
  };

  const signalAdoptedServer = (signal) => {
    if (adoptedIdentityStatus() === 'dead') return false;
    try {
      signalProcess(serverIdentity.pid, signal);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw codedError('SERVER_SIGNAL_FAILED', `재사용 서버 ${signal} 전송에 실패했습니다.`, { cause: error });
    }
  };

  const stopServer = async ({ boundToFinalizationDeadline = false } = {}) => {
    if (!serverAdopted) {
      await stopDirectServerChild({ boundToFinalizationDeadline });
      return;
    }
    if (adoptedIdentityStatus() === 'dead') return;
    signalAdoptedServer('SIGTERM');
    if (!await waitForAdoptedDeath(
      boundToFinalizationDeadline ? assertAndBoundFinalizationMs(1_000) : 1_000,
    )) {
      // pid+startTime을 KILL 직전에 다시 확인한다. unknown/mismatch면 신호 없이 실패한다.
      if (boundToFinalizationDeadline) assertFinalizationDeadline();
      signalAdoptedServer('SIGKILL');
      if (!await waitForAdoptedDeath(
        boundToFinalizationDeadline ? assertAndBoundFinalizationMs(1_000) : 1_000,
      )) {
        throw codedError('SERVER_STOP_UNCONFIRMED', '재사용 서버 종료를 확인하지 못했습니다.');
      }
    }
    serverIdentity = null;
    serverPid = null;
    serverAdopted = false;
  };

  const currentWatchdog = () => {
    // Compatibility for callers injecting the old test budget: t1 becomes the
    // single hard deadline, never an authorization for automatic fallback.
    const injected = opts.watchdog ? { hardMs: opts.watchdog.t1Ms,
      softMs: Math.max(1, Math.floor(opts.watchdog.t1Ms / 2)) } : undefined;
    return playerBudget(readLoopState()?.playerBudget ?? opts.playerBudget ?? injected ?? {});
  };

  const beginAtomicTransition = () => {
    if (stopRequested) throw codedError('STOPPING', '정지 요청 뒤에는 새 step을 시작하지 않습니다.');
    if (atomicTransition) throw codedError('TRANSITION_OVERLAP', 'step+publish 원자 단위가 중첩됐습니다.');
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    const unit = {
      promise,
      finish() {
        if (atomicTransition === unit) atomicTransition = null;
        settle();
      },
    };
    atomicTransition = unit;
    return unit;
  };

  const decideOnce = async (input, timeoutMs, { callNo }) => {
    const started = monotonicNow();
    let code = 'RESPONSE_RECEIVED';
    try {
      // Task 4 adapter owns the child timeout contract: it kills and rejects before
      // this promise settles. Starting a second request before that settlement would
      // let two resume calls race on one persistent player session.
      const result = await playerAdapter.decide({ ...input, timeoutMs });
      return { ok: true, raw: result?.raw, modelMs: Math.max(0, monotonicNow() - started) };
    } catch (error) {
      code = error.code ?? 'CLI_FAILED';
      return { ok: false, error, modelMs: Math.max(0, monotonicNow() - started) };
    } finally {
      log('player-call', { purpose:'decision', decisionId: readLoopState()?.pendingDecision?.decisionId ?? null,
        generation: readLoopState()?.pendingDecision?.generation ?? null,
        runtime: playerAdapter.kind, model: RUNTIME_TABLE[playerAdapter.kind]?.player ?? null,
        callNo, timeoutMs, elapsedMs: Math.max(0, monotonicNow() - started), code,
        category: code === 'RESPONSE_RECEIVED' ? 'response' : playerFailureCategory(code),
        censored: code === 'TIMEOUT' });
    }
  };

  const decideWithPolicy = async (next, stateVersion) => {
    const peek = await runCli([
      'decision-peek', '--for', next.toAct, '--expect-version', String(stateVersion),
    ]);
    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    const players = readJsonOptional(playersPath, 'PLAYERS');
    if (!engine?.policySeed) throw codedError('NO_POLICY_SEED', 'policySeed가 없습니다.');
    if (!Array.isArray(players)) throw codedError('BAD_PLAYERS', 'players.json이 배열이 아닙니다.');
    const seat = players.find((player) => player.playerId === next.toAct);
    if (!seat?.policy) throw codedError('NO_POLICY', `플레이어 ${next.toAct}에 policy가 없습니다.`);
    const startedAt = monotonicNow();
    const choice = decidePolicy({
      snapshot: peek.snapshot,
      legal: peek.legal,
      policy: seat.policy,
      policySeed: engine.policySeed,
      gameEpoch: gameEpochOf(engine.sessionToken),
      derived: readDerivedPolicyConfigs(root),
    });
    const stepArgs = ['step', next.toAct, choice.action];
    if (choice.action === 'raise') stepArgs.push(String(choice.amount));
    stepArgs.push('--expect-version', String(stateVersion));
    stepArgs.push('--policy-meta', JSON.stringify({
      policyId: choice.policyId,
      policyVersion: choice.policyVersion,
      sampledProbability: choice.sampledProbability,
      reasonCode: choice.reasonCode,
    }));
    const stepStarted = monotonicNow();
    const atomicUnit = beginAtomicTransition();
    try {
      const envelope = await runCli(stepArgs);
      return {
        envelope,
        atomicUnit,
        startedAt,
        outcome: 'policy_accepted',
        modelMs: 0,
        parseMs: 0,
        stepMs: Math.max(0, monotonicNow() - stepStarted),
        sessionRepaired: false,
      };
    } catch (error) {
      atomicUnit.finish();
      throw error;
    }
  };

  const quarantineDiagnostics = (pending, reason) => {
    const {diagnostics: _diagnostics, freshAuthorization: _freshAuthorization, ...rest} = pending;
    const cleaned = {...rest, diagnosticsQuarantined:true};
    writeLoopState({pendingDecision:cleaned});
    log('player-diagnostics-quarantined', {decisionId:pending.decisionId, generation:pending.generation, reason});
    return cleaned;
  };

  const decideWithWatchdog = async (next, stateVersion) => {
    if (!playerAdapter || typeof playerAdapter.decide !== 'function') {
      throw codedError('NO_PLAYER_RUNTIME', 'AI 결정을 수행할 플레이어 어댑터가 없습니다.');
    }
    playerSessions ??= readJsonOptional(sessionsPath, 'PLAYER_SESSIONS');
    let session = playerSessions?.[next.toAct];
    if (!session || typeof session.sessionId !== 'string' || session.sessionId === '') {
      throw codedError('NO_SESSION', `플레이어 ${next.toAct} 세션이 없습니다.`);
    }
    if (!isArgvSafeSessionId(session.sessionId)) {
      throw codedError('INVALID_SESSION_ID', `플레이어 ${next.toAct} 세션 id 형식이 안전하지 않습니다.`);
    }
    const watchdog = currentWatchdog();
    let previous = readLoopState()?.pendingDecision;
    if (previous) {
      const check = validateDiagnostics(previous.diagnostics, previous);
      if (!check.ok) previous = quarantineDiagnostics(previous, check.reason);
    }
    if (previous && previous.status !== 'retry_authorized') {
      return { kind: 'recovery_required' };
    }
    if (previous && (previous.decisionId !== next.decisionId || previous.stateVersion !== stateVersion
      || previous.gameEpoch !== readLoopState().gameEpoch || previous.playerId !== next.toAct)) {
      throw codedError('STALE_PLAYER_DECISION', '저장된 미해결 결정과 현재 엔진 차례가 다릅니다.');
    }
    const freshRequested = previous?.status === 'retry_authorized'
      && previous.freshAuthorization
      && typeof previous.freshAuthorization === 'object'
      && !Array.isArray(previous.freshAuthorization);
    const inherited = !freshRequested && retryWillCorrect(previous)
      ? projectRejectionForSink(previous.diagnostics.lastRejection, previous) : null;
    const attemptMessage = inherited ? correctionMessage(next.message, inherited, previous) : next.message;
    let record = { schemaVersion: 2, gameEpoch: readLoopState().gameEpoch,
      decisionId: next.decisionId, stateVersion, playerId: next.toAct,
      generation: (previous?.generation ?? 0) + 1, status: 'running',
      budget: watchdog, startedAt: isoNow(now), diagnostics: { v:1, callNo:1, corrections:0, ...(inherited ? {lastRejection:inherited} : {}) } };
    const beginPending = () => {
      writeLoopState({ pendingDecision: record, playerBudget: watchdog });
      ownedPlayerAttempt = record;
    };
    const commitPending = (patch, { drop = [] } = {}) => {
      const current = readLoopState()?.pendingDecision;
      if (!current || ['generation', 'decisionId', 'gameEpoch', 'stateVersion', 'playerId'].some(key => current[key] !== record[key])) {
        throw codedError('STALE_PLAYER_DECISION', '이전 세대의 기록은 갱신하지 않습니다.');
      }
      record = { ...record, ...patch };
      for (const key of drop) delete record[key];
      writeLoopState({ pendingDecision: record });
      return record;
    };
    beginPending();
    let callNo = 1;
    let lastRejection = inherited;
    let candidate = null;
    let corrections = 0;
    let deadlineAt;
    let softDeadlineAt;
    const floor = Math.min(minRepairFloorMs, Math.ceil(watchdog.hardMs / 8));
    const correctionSkip = () => {
      if (stopRequested) return 'stop';
      if (pauseRequested) return 'pause';
      const remaining = deadlineAt - monotonicNow();
      return remaining <= 0 || remaining < floor ? 'budget' : null;
    };
    const logSkipped = reason => log('player-correction-skipped', {decisionId:next.decisionId,
      generation:record.generation, reason, remainingMs:Math.ceil(deadlineAt - monotonicNow())});
    const rejectionContext = {generation:record.generation, decisionId:record.decisionId, gameEpoch:record.gameEpoch};
    const rejectDecision = (rejection) => {
      lastRejection = projectRejectionForSink({v:1, ...rejectionContext, callNo, code:rejection.code,
        detail:rejection.detail, projection:rejection.projection, at:isoNow(now)}, rejectionContext);
      if (!lastRejection) throw new TypeError('Invalid classified rejection');
      log('player-decision-rejected', {...lastRejection,
        ...(validateRawDiagnostics(rejection.raw).ok ? {raw:rejection.raw} : {})});
      commitPending({diagnostics:{...record.diagnostics, lastRejection}});
      failureCode = rejection.code;
      if (corrections === 0 && CORRECTABLE_DETAILS.has(lastRejection.detail)) {
        const skip = correctionSkip();
        if (skip) logSkipped(skip);
        else candidate = lastRejection;
      }
    };
    let failureCode = 'INVALID_DECISION';
    const startedAt = monotonicNow();
    let modelMs = 0;
    let parseMs = 0;
    let stepMs = 0;
    let sessionRepaired = false;
    let freshSessionUsed = false;
    const applyDecision = async (action) => {
      if (readLoopState()?.pendingDecision?.generation !== record.generation) {
        throw codedError('STALE_PLAYER_DECISION', '이전 세대의 응답은 적용하지 않습니다.');
      }
      const stepArgs = ['step', next.toAct];
      {
        stepArgs.push(action.action);
        if (action.action === 'raise') stepArgs.push(String(action.amount));
        if (action.reason) {
          const metaPath = path.join(root, '.decision-meta.json');
          writeJsonAtomic(metaPath, { decisionId: next.decisionId, reason: action.reason });
          stepArgs.push('--meta-file', metaPath);
        }
      }
      stepArgs.push('--expect-version', String(stateVersion));
      commitPending({ closeConfirmed:true, proposedAction:{ action:action.action,
        ...(action.action === 'raise' ? {amount:action.amount} : {}) } });
      const stepStarted = monotonicNow();
      const atomicUnit = beginAtomicTransition();
      try {
        const envelope = await runCli(stepArgs);
        writeLoopState({ pendingDecision: undefined });
        reportDecisionMetaDropped(envelope, next.toAct);
        return { envelope, atomicUnit };
      } catch (error) {
        atomicUnit.finish();
        throw error;
      } finally {
        stepMs += Math.max(0, monotonicNow() - stepStarted);
      }
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let timeoutMs = watchdog.hardMs;
      let message = attemptMessage;
      if (attempt > 0) {
        if (!candidate) break;
        const skip = correctionSkip();
        if (skip) { logSkipped(skip); break; }
        callNo += 1;
        corrections = 1;
        commitPending({status:'running', diagnostics:{v:1, callNo, corrections, lastRejection}},
          {drop:['closeConfirmed', 'proposedAction']});
        log('player-correction', {decisionId:next.decisionId, generation:record.generation,
          callNo, detail:lastRejection.detail, remainingMs:Math.ceil(deadlineAt - monotonicNow())});
        message = correctionMessage(next.message, lastRejection, rejectionContext);
        timeoutMs = Math.ceil(deadlineAt - monotonicNow());
        const finalSkip = stopRequested ? 'stop' : pauseRequested ? 'pause' : timeoutMs <= 0 || timeoutMs < floor ? 'budget_after_commit' : null;
        if (finalSkip) {
          callNo -= 1; corrections = 0;
          commitPending({diagnostics:{...record.diagnostics, callNo, corrections}});
          logSkipped(finalSkip);
          break;
        }
      } else {
        deadlineAt = monotonicNow() + watchdog.hardMs;
        softDeadlineAt = monotonicNow() + watchdog.softMs;
      }
      const softTimer = setTimeout(() => {
        if (stopRequested || readLoopState()?.pendingDecision?.generation !== record.generation) return;
        if (record.proposedAction || record.softWait) return;
        try { commitPending({softWait:true}); }
        catch (error) {
          // The awaited decision path reports stale identity. A timer must not
          // turn that recoverable rejection into an uncaught process exception.
          if (error.code === 'STALE_PLAYER_DECISION') return;
          throw error;
        }
        log('player-soft-wait', { decisionId: next.decisionId, budget: watchdog });
      }, Math.max(0, softDeadlineAt - monotonicNow()));
      let round;
      try {
      if (stopRequested) return { kind: 'recovery_required' };
      if (attempt === 0 && freshRequested && !freshSessionUsed) {
        if (stopRequested) return { kind: 'recovery_required' };
        try {
          session = await recreatePlayerSession(next.toAct, {
            deadlineAt,
            reason: 'user_fresh_session',
            onWarmupClosed: async (freshSessionId) => commitPending({
              closeConfirmed: true,
              freshSessionReady: true,
              freshSessionId,
            }),
          });
        } catch (error) {
          if (error.code === 'STOPPING' || stopRequested) return { kind: 'recovery_required' };
          if (isFatalRuntimeFailure(error) || isFatalRepairFailure(error)) {
            commitPending({status:'unsafe', code:error.code ?? 'REPAIR_FAILED'});
            throw error;
          }
          failureCode = error.code ?? 'REPAIR_FAILED';
          log('player-session-recreate-failed', {
            playerId: next.toAct,
            code: failureCode,
            reason: 'user_fresh_session',
          });
          break;
        }
        sessionRepaired = true;
        freshSessionUsed = true;
        if (stopRequested) return { kind: 'recovery_required' };
        const remainingAfterWarmup = Math.ceil(deadlineAt - monotonicNow());
        if (remainingAfterWarmup <= 0) {
          round = {ok:false, error:codedError('TIMEOUT', '새 세션 생성 뒤 결정 예산이 만료됐습니다.'), modelMs:0};
        } else {
          // The close receipt was durably recorded before the child-session file. A
          // fresh child decision must start with that marker removed; a crash after this
          // point is intentionally unsafe rather than silently replayed.
          commitPending({}, {drop:['closeConfirmed']});
          timeoutMs = Math.ceil(deadlineAt - monotonicNow());
          if (timeoutMs <= 0) {
            round = {ok:false, error:codedError('TIMEOUT', '새 세션 기록 뒤 결정 예산이 만료됐습니다.'), modelMs:0};
          } else {
            round = await decideOnce({
              playerId: next.toAct,
              sessionId: session.sessionId,
              message,
            }, timeoutMs, { callNo });
          }
        }
      } else {
        round = await decideOnce({
          playerId: next.toAct,
          sessionId: session.sessionId,
          message,
        }, timeoutMs, { callNo });
      }
      modelMs += round.modelMs;
      // Disposal is part of an owned stop, not evidence that a live decision
      // became unsafe. Leave the running record for the stop owner's final patch.
      if (stopRequested && (!round.ok && ['STOPPING', 'RUNTIME_CLOSED'].includes(round.error?.code))) {
        return { kind: 'recovery_required' };
      }
      failureCode = round.error?.code ?? 'INVALID_DECISION';
      log('player-attempt', { callNo, decisionId: next.decisionId, generation: record.generation,
        runtime: playerAdapter.kind, model: RUNTIME_TABLE[playerAdapter.kind]?.player ?? null,
        budget: watchdog, elapsedMs: round.modelMs, code: round.ok ? 'RESPONSE_RECEIVED' : failureCode,
        category: round.ok ? 'response' : playerFailureCategory(failureCode),
        closeConfirmed: round.ok || !isFatalRuntimeFailure(round.error), censored: failureCode === 'TIMEOUT' });
      if (
        !round.ok
        && !isFatalRuntimeFailure(round.error)
        && RESTORED_SESSION_REJECTION_CODES.has(round.error?.code)
        && restoredPlayerSessions.has(next.toAct)
      ) {
        const minRepairMs = Math.min(minRepairFloorMs, Math.ceil(watchdog.hardMs / 8));
        const remainingBeforeRepair = Math.max(0, Math.ceil(deadlineAt - monotonicNow()));
        if (remainingBeforeRepair < minRepairMs) continue;
        let repaired = null;
        try {
          repaired = await repairRestoredPlayerSession(next.toAct, { deadlineAt });
        } catch (error) {
          if (error.code === 'STOPPING') return { kind: 'recovery_required' };
          if (isFatalRepairFailure(error)) throw error;
          if (stopRequested) return { kind: 'recovery_required' };
          failureCode = error.code ?? 'REPAIR_FAILED';
          log('player-session-repair-failed', {
            playerId: next.toAct,
            code: error.code ?? 'REPAIR_FAILED',
          });
          continue;
        }
        if (repaired) {
          if (stopRequested) return { kind: 'recovery_required' };
          session = repaired;
          sessionRepaired = true;
          const remainingBeforeRetry = Math.max(0, Math.ceil(deadlineAt - monotonicNow()));
          if (remainingBeforeRetry > 0) {
            callNo += 1;
            commitPending({diagnostics:{...record.diagnostics, callNo}});
            // Persisting the call number consumes budget too. Recheck at the
            // dispatch boundary, and count only calls that actually start.
            const remainingForCall = Math.max(0, Math.ceil(deadlineAt - monotonicNow()));
            if (remainingForCall > 0) {
              round = await decideOnce({
                playerId: next.toAct,
                sessionId: session.sessionId,
                message: attemptMessage,
              }, remainingForCall, { callNo });
              modelMs += round.modelMs;
            } else {
              callNo -= 1;
              commitPending({diagnostics:{...record.diagnostics, callNo}});
              round = { ok:false, error:codedError('TIMEOUT', 'session repair 기록 뒤 재결정 예산이 만료됐습니다.'), modelMs:0 };
            }
          } else {
            round = { ok: false, error: codedError('TIMEOUT', 'session repair 뒤 재결정 예산이 만료됐습니다.'), modelMs: 0 };
          }
        }
      } else if (round.ok) {
        // A successful call proves the restored remote session is usable; later transient
        // failures must follow the ordinary watchdog rather than trigger recreation.
        restoredPlayerSessions.delete(next.toAct);
      }
      if (!round.ok) {
        failureCode = round.error?.code ?? 'CLI_FAILED';
        if (stopRequested && ['STOPPING', 'RUNTIME_CLOSED'].includes(failureCode)) return { kind: 'recovery_required' };
        if (isFatalRuntimeFailure(round.error)) {
          commitPending({status:'unsafe', code:failureCode});
          throw round.error;
        }
        continue;
      }
      const parseStarted = monotonicNow();
      const classified = classifyDecision(round.raw, next);
      const action = classified.action;
      parseMs += Math.max(0, monotonicNow() - parseStarted);
      if (action) {
        if (action.normalizedFrom) log('player-decision-normalized', {decisionId:next.decisionId, generation:record.generation, callNo, from:'bet', to:'raise', amount:action.amount});
        let applied;
        try {
          applied = await applyDecision(action);
        } catch (error) {
          if (error.code === 'ILLEGAL_ACTION') {
            rejectDecision({code:error.code, detail:'engine_rejected', projection:{action:action.action,
              ...(Number.isSafeInteger(action.amount) ? {amount:action.amount} : {}), decisionIdMatches:true}});
            continue;
          }
          throw error;
        }
        return {
          envelope: applied.envelope,
          atomicUnit: applied.atomicUnit,
          outcome: attempt === 0 && !sessionRepaired && !previous ? 'accepted' : 'retried_accepted',
          sessionRepaired,
          freshSession: freshSessionUsed,
          corrected: Boolean(inherited) || corrections === 1,
          startedAt,
          modelMs,
          parseMs,
          stepMs,
        };
      } else rejectDecision(classified.rejection);
      } finally { clearTimeout(softTimer); }
    }
    // The runtime contract settles failed calls only after positive child close;
    // termination/identity failures above are the fail-closed exception. This
    // also applies to repair warmup calls through the same runtime.runOnce.
    commitPending({ status: 'recovery_required', code: failureCode,
      category: playerFailureCategory(failureCode), elapsedMs: Math.max(0, monotonicNow() - startedAt),
      closeConfirmed: true, sessionRepaired, diagnostics:{...record.diagnostics,
        ...(lastRejection && ['INVALID_DECISION','ILLEGAL_ACTION'].includes(failureCode) ? {detail:lastRejection.detail} : {})} });
    log('player-recovery-required', { decisionId: next.decisionId, generation: record.generation, code: failureCode,
      detail:record.diagnostics.detail, corrections:record.diagnostics.corrections, callNo });
    return { kind: 'recovery_required' };
  };

  const recoverServerForPublish = async () => {
    assertNotStopping();
    const state = readLoopState();
    const sessionToken = state?.sessionToken;
    if (typeof sessionToken !== 'string' || sessionToken === '') {
      throw codedError('NO_GAME', '게시 복구에 필요한 sessionToken이 없습니다.');
    }
    const pin = openServerLockPin();
    const expected = pin?.lock ?? null;
    const actualPort = expected?.port
      ?? (Number.isSafeInteger(state?.port) && state.port > 0 ? state.port : requestedPort);
    try {
      if (expected) {
        if (expected.sessionToken !== sessionToken) {
          throw codedError('SERVER_LOCK_MISMATCH', '게시 복구 server lock의 sessionToken이 현재 게임과 다릅니다.');
        }
        const healthy = await serverHealthy(expected.port, { stopAware: true });
        d9Checkpoint('after-health');
        if (healthy) {
          // health만으로는 신뢰하지 않는다. adoption과 동일하게 listener,
          // wrong-token/real-token, startTime, pinned lock을 두 번 맞춘 서버만 재사용한다.
          const port = await ensureServer(sessionToken, {
            port: actualPort,
            pin,
            stopAware: true,
            recovery: true,
          });
          d9Checkpoint('after-verified-reuse');
          writeLoopState({ port });
          log('server-recovery-verified', { port, serverPid });
          return port;
        }

        if (processAlive(expected.serverPid)) {
          if (expected.serverPid !== serverPid) {
            throw codedError('SERVER_IDENTITY_CHANGED', '게시 복구 중 검증하지 못한 server lock 소유자가 살아 있습니다.');
          }
          assertPinnedServerLock(pin);
          await stopServer({ boundToFinalizationDeadline: true });
          d9Checkpoint('after-stop-server');
        } else if (serverChild?.pid === expected.serverPid) {
          serverChild = null;
          serverIdentity = null;
          serverPid = null;
          serverAdopted = false;
          serverStartupIdentityMissing = false;
        }

        const confirmed = assertPinnedServerLock(pin);
        if (processAlive(confirmed.serverPid)) {
          throw codedError('SERVER_STOP_UNCONFIRMED', '기존 서버가 살아 있어 lock을 지울 수 없습니다.');
        }
        d9Checkpoint('before-retire');
        retirePinnedServerLock(pin);
      }

      d9Checkpoint('before-ensure-server');
      const port = await ensureServer(sessionToken, {
        port: actualPort,
        stopAware: true,
        recovery: true,
      });
      d9Checkpoint('after-ensure-server');
      writeLoopState({ port });
      log('server-recovered', { port, serverPid });
      return port;
    } finally {
      closeServerLockPin(pin);
    }
  };

  const consumeTrainingNow = async () => {
    if (!trainingOn || !storeDir) return;
    try {
      const consumed = await createTrainingControl({ storeDir })
        .consumeTrainingItems(root, { storeDir });
      if ((consumed.failed ?? 0) > 0) {
        log('training-consume-failed', { failed: consumed.failed });
      }
    } catch (error) {
      log('training-consume-error', { code: error.code ?? 'ERROR' });
    }
  };

  const bindTrainingAttempt = (key, handle) => {
    if (!handle || typeof handle.terminate !== 'function') return handle;
    trainingAttempts.set(key, handle);
    Promise.resolve(handle.promise)
      .catch(() => {})
      .finally(() => {
        if (trainingAttempts.get(key) === handle) trainingAttempts.delete(key);
      });
    return handle;
  };

  const publishStopped = () => (
    finalizationDeadlineNs !== null && remainingMsUntil(finalizationDeadlineNs) <= 0
  );

  let machinePublishHalt = null;
  let annotationPublishHalt = null;

  const flushTrainingPublish = async () => {
    if (!trainingOn) return;
    if (machinePublishHalt) return;
    const loop = readLoopState();
    try {
      await flushMachinePublish(root, {
        gameEpoch: loop?.gameEpoch,
        storeDir,
        shouldStop: publishStopped,
        executePublish,
      });
    } catch (error) {
      log('training-publish-error', {
        code: error.code ?? 'ERROR',
        ...(error.details ? { details: error.details } : {}),
      });
      if (error.code === 'TRAINING_MARK_FAILED'
        || error.code === 'TRAINING_FLUSH_NO_PROGRESS') {
        machinePublishHalt = error.code;
        appendNotice(`training machine publish halt: ${error.code}`);
      }
    }
  };

  const flushAnnotationPublish = async () => {
    if (!trainingOn) return;
    if (annotationPublishHalt) return;
    const loop = readLoopState();
    try {
      await flushAnnotationEnvelope(root, {
        gameEpoch: loop?.gameEpoch,
        storeDir,
        shouldStop: publishStopped,
        executePublish,
        onNotice: appendNotice,
      });
    } catch (error) {
      log('training-annotation-publish-error', {
        code: error.code ?? 'ERROR',
        ...(error.details ? { details: error.details } : {}),
      });
      if (error.code === 'TRAINING_MARK_FAILED'
        || error.code === 'TRAINING_FLUSH_NO_PROGRESS') {
        annotationPublishHalt = error.code;
        appendNotice(`training annotation publish halt: ${error.code}`);
      }
    }
  };

  const retryUnresolvedTrainingAttempt = async () => {
    if (machinePublishHalt || annotationPublishHalt) return;
    try {
      await retryTrainingAttempt(root, { executePublish, storeDir });
    } catch (error) {
      if (error.code === 'NO_ATTEMPT') return;
      log('training-attempt-retry-error', { code: error.code ?? 'ERROR' });
      if (error.code === 'TRAINING_MARK_FAILED'
        || error.code === 'TRAINING_FLUSH_NO_PROGRESS') {
        machinePublishHalt = error.code;
        annotationPublishHalt = error.code;
        appendNotice(`training retry publish halt: ${error.code}`);
        throw error;
      }
    }
  };

  const solveInFlight = new Set();

  const trackTrainingTask = (handNo, work) => {
    let task;
    task = Promise.resolve()
      .then(() => (typeof work === 'function' ? work() : work))
      .catch((error) => {
        log('training-error', { handNo, code: error.code ?? 'ERROR' });
      })
      .finally(() => trainingTasks.delete(task));
    trainingTasks.add(task);
    return task;
  };

  const evaluateForPipeline = (sessionDir, handNo, options = {}) => {
    const raw = typeof trainingHooks.evaluate === 'function'
      ? trainingHooks.evaluate(sessionDir, handNo, options)
      : defaultEvaluate(sessionDir, handNo, options);
    return bindTrainingAttempt(`${handNo}:evaluate`, toRunnerHandle(raw));
  };

  // solve 자식도 evaluate/explain과 같은 attempt 표에 올린다 — cutoff의 종료
  // 확인 절차가 그 표를 훑기 때문이다.
  const solveForPipeline = (task) => {
    const raw = typeof trainingHooks.solve === 'function'
      ? trainingHooks.solve(task)
      : defaultSolve(task);
    return bindTrainingAttempt(`${task.decisionId}:solve`, toRunnerHandle(raw));
  };

  const explainForPipeline = (evaluation) => {
    if (typeof trainingHooks.explain === 'function') {
      return bindTrainingAttempt(
        `${evaluation.evaluationId}:explain`,
        toRunnerHandle(trainingHooks.explain(evaluation)),
      );
    }
    if (!upperAdapter || typeof upperAdapter.oneshotStart !== 'function') {
      return { promise: Promise.resolve(null), terminate: async () => ({ confirmed: true }) };
    }
    const handle = upperAdapter.oneshotStart({
      tier: 'upper',
      prompt: buildExplanationPrompt(evaluation),
      timeoutMs: 20_000,
    });
    const wrapped = {
      promise: Promise.resolve(handle.done).then((completed) => {
        try {
          const parsed = JSON.parse(String(completed?.raw ?? '').trim());
          if (parsed.evaluationId !== evaluation.evaluationId) return null;
          return parsed.explanation;
        } catch {
          return null;
        }
      }),
      terminate: async () => {
        if (typeof handle.terminate !== 'function') return { confirmed: true };
        return handle.terminate();
      },
    };
    return bindTrainingAttempt(`${evaluation.evaluationId}:explain`, wrapped);
  };

  const startSolveTask = (task) => {
    if (!trainingOn) return;
    // 권위의 solveTasks는 자식이 실제로 뜬 뒤에야 보인다. 그 사이에 같은
    // 파이프라인이 다시 돌면 같은 결정에 두 자식이 뜨므로 로컬 in-flight 집합이
    // 먼저 막는다.
    if (solveInFlight.has(task.decisionId)) return;
    solveInFlight.add(task.decisionId);
    const loop = readLoopState();
    trackTrainingTask(task.handNo, () => runSolveTask({
      ...task,
      gameEpoch: task.gameEpoch ?? loop?.gameEpoch,
      owner: task.owner ?? loop?.ownerSessionId,
      storeDir,
      solve: solveForPipeline,
      shouldStop: () => stopRequested || finalizationCutoff,
      publish: async (kind) => {
        if (kind === 'machine') await flushTrainingPublish();
        if (kind === 'annotation') await flushAnnotationPublish();
      },
      consume: consumeTrainingNow,
    }).finally(() => solveInFlight.delete(task.decisionId)));
  };

  const runTrainingPipeline = async (handNo) => {
    const loop = readLoopState();
    const result = await runHandPipeline({
      sessionDir: root,
      handNo,
      gameEpoch: loop.gameEpoch,
      owner: loop.ownerSessionId,
      storeDir,
      evaluate: evaluateForPipeline,
      explain: explainForPipeline,
      solverAdapterId,
      startSolve: startSolveTask,
      publish: async (kind) => {
        if (kind === 'machine') await flushTrainingPublish();
        if (kind === 'annotation') await flushAnnotationPublish();
      },
      consume: consumeTrainingNow,
    });
    if (!result.ok) log('training-evaluate-failed', { handNo, code: result.code });
    return result;
  };

  const launchTrainingPipeline = (handNo) => {
    if (!trainingOn) return;
    if (trainingInFlightHands.has(handNo)) return;
    trainingInFlightHands.add(handNo);
    trackTrainingTask(handNo, async () => {
      try {
        return await runTrainingPipeline(handNo);
      } finally {
        trainingInFlightHands.delete(handNo);
      }
    });
  };

  const settleTrainingTasks = async (deadlineNs) => {
    log('training-settle-start', {
      size: trainingTasks.size,
      producerOpen: trainingProducerOpen,
    });
    for (;;) {
      if (!trainingProducerOpen && trainingTasks.size === 0) {
        log('training-settle-return', { empty: true });
        return true;
      }
      const remaining = remainingMsUntil(deadlineNs);
      if (remaining <= 0) {
        log('training-settle-return', { timeout: true, pending: trainingTasks.size });
        return false;
      }
      if (trainingProducerOpen && trainingTasks.size === 0) {
        await settleOrTimeout(sleep(20), remaining);
        continue;
      }
      await settleOrTimeout(Promise.allSettled([...trainingTasks]), remaining);
    }
  };

  // R8/#25. training settle 직후·cutoff 마커 기록 전에 돈다. reveal 단계는 마커
  // 이후라 마지막 핸드 item이 pending이면 ANNOTATION_ORPHAN이 되고 리뷰 LLM과
  // 예산을 경합한다. 게시는 cutoff 뒤 annotation flush가 함께 처리한다.
  const sealExploitAtCutoff = async () => {
    if (!trainingOn) return;
    try {
      const players = readJsonOptional(playersPath, 'PLAYERS');
      const result = await sealExploitAnnotations({
        sessionDir: root,
        storeDir,
        players: Array.isArray(players) ? players : [],
      });
      log('training-exploit-sealed', result);
      if (result.skipped > 0) {
        appendNotice(`exploit 평가를 남기지 못한 결정 ${result.skipped}건 (상대 정책 없음 또는 평가 불가).`);
      }
    } catch (error) {
      // exploit annotation은 additive UI 정보다. cutoff 마커와 달리 없다고 해서
      // 계약이 깨지지는 않으므로 종료를 중단하지 않는다. 다만 조용히 사라지지도
      // 않게 사용자에게 notice로 남긴다.
      log('training-exploit-error', { code: error.code ?? 'ERROR' });
      appendNotice(`exploit 평가 실패: ${error.code ?? 'ERROR'}`);
    }
  };

  const sealUnfinishedExplanations = async () => {
    if (!trainingOn) return;
    let auth;
    try {
      auth = createTrainingControl({ storeDir }).loadAuthority(root);
    } catch (error) {
      log('training-unavailable-seal-error', { code: error.code ?? 'ERROR' });
      return;
    }
    if (!auth) return;
    for (const item of Object.values(auth.items)) {
      if (item.status !== 'evaluated' && item.status !== 'published') continue;
      const status = item.annotations?.explanation?.status;
      if (status === 'ready' || status === 'unavailable') continue;
      try {
        await createTrainingControl({ storeDir }).sealAnnotation(
          root,
          item.evaluationId,
          'explanation',
          'unavailable',
          { sealReason: 'cutoff' },
        );
      } catch (error) {
        log('training-unavailable-seal-error', { code: error.code ?? 'ERROR' });
      }
    }
  };

  const terminateTrainingChildren = async (deadlineNs) => {
    const handles = [...trainingAttempts.values()];
    const outcomes = await Promise.all(handles.map(async (handle) => {
      let invocation;
      try {
        invocation = handle.terminate();
      } catch (error) {
        invocation = Promise.reject(error);
      }
      const settled = await settleValueBeforeDeadline(invocation, deadlineNs);
      if (settled.error) {
        log('training-terminate-error', { code: settled.error.code ?? 'ERROR' });
      }
      return {
        confirmed: settled.settled && !settled.error && settled.value?.confirmed === true,
      };
    }));
    const confirmed = outcomes.every((row) => row.confirmed);
    const tasksSettled = await settleTrainingTasks(deadlineNs);
    let persisted = readPersistedSolver(root);
    if (persisted.state === 'live' || persisted.state === 'unreadable') {
      const killed = await settleValueBeforeDeadline(
        killSolverGroup(persisted.record?.pid, persisted.record?.startTime),
        deadlineNs,
      );
      if (killed.error) {
        log('training-solver-terminate-error', { code: killed.error.code ?? 'ERROR' });
      }
      persisted = readPersistedSolver(root);
    }
    const solverConfirmed = persisted.state === 'absent' || persisted.state === 'dead';
    if (!solverConfirmed) {
      log('training-solver-terminate-unconfirmed', { state: persisted.state });
    }
    return confirmed && tasksSettled && solverConfirmed;
  };

  const reconcileTrainingNow = async () => {
    if (!trainingOn) return;
    trainingProducerOpen = true;
    try {
      // 이 프로세스가 들고 있지 않은 solve 점유는 죽은 사이드카의 잔해다.
      // 거두지 않으면 resume이 그 결정의 solve를 영원히 다시 열지 못하고
      // rollback guard도 영원히 닫힌다.
      try {
        const reaped = await createTrainingControl({ storeDir })
          .reapSolveTasks(root, { keepDecisionIds: [...solveInFlight] });
        if (reaped.reaped > 0) log('training-solve-task-reaped', reaped);
      } catch (error) {
        log('training-solve-task-reap-error', { code: error.code ?? 'ERROR' });
      }
      await retryUnresolvedTrainingAttempt();
      const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      const loop = readLoopState();
      const recon = await reconcileSession({
        sessionDir: root,
        gameEpoch: loop.gameEpoch,
        owner: loop.ownerSessionId,
        lastHand: engine?.lastHand ?? null,
      });
      const pendingHands = new Set();
      for (const miss of recon?.missing ?? []) {
        if (Number.isInteger(miss.handNo)) pendingHands.add(miss.handNo);
      }
      const pendingMap = recon?.pending ?? recon?.authority?.pending ?? {};
      for (const entry of Object.values(pendingMap)) {
        if (Number.isInteger(entry?.handNo)) pendingHands.add(entry.handNo);
      }
      const lastHandNo = engine?.lastHand?.handNo;
      if (Number.isInteger(lastHandNo) && lastHandNo >= 1) pendingHands.add(lastHandNo);
      for (const handNo of pendingHands) launchTrainingPipeline(handNo);
      log('training-reconcile-registered', { hands: [...pendingHands] });
      await consumeTrainingNow();
    } catch (error) {
      log('training-reconcile-error', { code: error.code ?? 'ERROR' });
    } finally {
      trainingProducerOpen = false;
    }
  };

  let publishTail = Promise.resolve();
  const executePublish = async (args) => {
    let release;
    const slot = new Promise((resolve) => { release = resolve; });
    const prev = publishTail;
    publishTail = slot;
    await prev.catch(() => {});
    try {
      return await executePublishUnlocked(args);
    } finally {
      release();
    }
  };

  const executePublishUnlocked = async (args) => {
    try {
      const out = await runPublish(args);
      reportHandReplay(out);
      if (out.hintDisposition === 'unverifiable') hintReadyLatch = false;
      return out;
    } catch (error) {
      if (error.code !== 'PUBLISH_FAILED' && error.code !== 'PUBLISH_REJECTED') throw error;
      if (finalizationDeadlineNs !== null && remainingMsUntil(finalizationDeadlineNs) <= 0) {
        throw codedError(
          'FINALIZATION_DEADLINE_EXCEEDED',
          'finalization 공통 deadline이 만료됐습니다.',
          { cause: error },
        );
      }
      try {
        await recoverServerForPublish();
      } catch (recoveryError) {
        if (finalizationDeadlineNs !== null && remainingMsUntil(finalizationDeadlineNs) <= 0) {
          throw codedError(
            'FINALIZATION_DEADLINE_EXCEEDED',
            'finalization 공통 deadline이 만료됐습니다.',
            { cause: recoveryError },
          );
        }
        throw recoveryError;
      }
      d9Checkpoint('before-retry');
      const retryArgs = args.includes('--retry') ? args : [...args, '--retry'];
      const retried = await runPublish(retryArgs);
      reportHandReplay(retried);
      return retried;
    }
  };

  let hintReadyLatch = true;
  const hintControl = createHintControl({sessionDir:root,runCli:args=>runCliBeforeResultCutoff(args),
    enabled:()=>opts.hints==='on',
    isFatal:isFatalRuntimeFailure,
    assertActive:()=>{assertNotStopping();if(finalizationCutoff) throw codedError('PLAYTIME_PUBLISH_STOPPED','hint cutoff');},log,
    ready:async()=>{
      try {
        const lock=readJsonOptional(path.join(root,'lock.json'),'SERVER_LOCK');
        if (!lock?.port) return false;
        const response=await fetch(`http://127.0.0.1:${lock.port}/api/health`,{headers:{'x-session-token':lock.sessionToken},signal:AbortSignal.timeout(1000)});
        const health=await response.json();
        hintReadyLatch=response.ok && health.capabilities?.preActionHints===1 && health.capabilities?.preActionHintsReady===true;
      } catch {hintReadyLatch=false;}
      return hintReadyLatch;
    }});
  const prepareHintEnvelope = envelope => hintControl.prepare(envelope);
  const turnPath = path.join(root, '.turn.json');

  const snapshotViewGameOver = () => (
    readJsonOptional(coachSnapshotPath, 'UI_SNAPSHOT')?.view?.gameOver === true
  );

  const ensureGameOverViewPublished = async () => {
    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (engine?.gameOver !== true) return;
    for (let step = 0; step < 4; step += 1) {
      if (snapshotViewGameOver()) return;
      try {
        if (fs.existsSync(publishAttemptPath)) {
          if (!fs.existsSync(turnPath)) writeJsonAtomic(turnPath, { ok: true });
          await executePublish(['--from', turnPath, '--retry']);
          continue;
        }
        const envelope = await runCli(['step']);
        writeJsonAtomic(turnPath, envelope);
        await executePublish(['--from', turnPath, '--view-only']);
      } catch (error) {
        if (error.code === 'ATTEMPT_PENDING') continue;
        appendNotice(`gameOver 뷰 게시 실패: ${error.code ?? 'ERROR'}`);
        return;
      }
    }
  };

  const publishEnvelope = async (envelope, flags = []) => {
    // §9.2 (3): the cutoff stops new play-time publishers locally, before the authority
    // flag exists. Coach seals keep flowing through executeCoachPublish under a deadline.
    if (finalizationCutoff) {
      throw codedError('PLAYTIME_PUBLISH_STOPPED', 'game-over cutoff 이후 play-time 게시를 시작하지 않습니다.');
    }
    envelope = await prepareHintEnvelope(envelope);
    writeJsonAtomic(turnPath, envelope);
    let currentArgs = ['--from', turnPath, ...flags];
    let args = currentArgs;
    let resolvingPending = false;
    const recovered = new Set();
    let out;
    for (;;) {
      try {
        // A retry with a still-present record publishes the old exact body; once that
        // succeeds the current transition must still publish. If the record vanished
        // before invocation, --retry publishes the current turn itself and is terminal.
        const resolvingRecordedBody = resolvingPending
          && fs.existsSync(path.join(root, '.publish-attempt.json'));
        out = await executePublish(args);
        if (resolvingPending && resolvingRecordedBody) {
          resolvingPending = false;
          args = currentArgs;
          continue;
        }
        break;
      } catch (error) {
        const code = error.code;
        if (code === 'NO_ATTEMPT' && resolvingPending) {
          resolvingPending = false;
          args = currentArgs;
          continue;
        }
        if (recovered.has(code)) throw error;
        if (code === 'ATTEMPT_PENDING') {
          recovered.add(code);
          assertNotStopping();
          await opts.attemptPendingCheckpoint?.();
          assertNotStopping();
          resolvingPending = true;
          args = ['--from', turnPath, '--retry'];
          continue;
        }
        if (code === 'BAD_ATTEMPT' || code === 'BAD_ATTEMPT_VERSION') {
          recovered.add(code);
          assertNotStopping();
          const pendingPath = path.join(root, '.publish-attempt.json');
          try { fs.unlinkSync(pendingPath); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
          assertNotStopping();
          const synchronized = await runCli(['step']);
          assertNotStopping();
          writeJsonAtomic(turnPath, await prepareHintEnvelope(synchronized));
          const lastNo = readJsonOptional(engineStatePath, 'ENGINE_STATE')?.lastHand?.handNo;
          if (Number.isInteger(lastNo) && lastNo >= 1) unionReplayPending([lastNo]);
          const recoveryFlags = flags.filter((flag) => flag !== '--retry' && flag !== '--view-only');
          currentArgs = ['--from', turnPath, '--view-only', ...recoveryFlags];
          args = currentArgs;
          resolvingPending = false;
          log('publish-recovery', { code, mode: 'view-only-resync' });
          continue;
        }
        if (code === 'BAD_SNAPSHOT') {
          recovered.add(code);
          await recoverServerForPublish();
          assertNotStopping();
          const snapshotPath = path.join(root, 'ui-snapshot.json');
          try { fs.unlinkSync(snapshotPath); } catch (unlinkError) {
            if (unlinkError.code !== 'ENOENT') throw unlinkError;
          }
          assertNotStopping();
          log('publish-recovery', { code, mode: 'snapshot-rebuild' });
          continue;
        }
        if (code === 'PUBLISH_ID_REUSED') {
          recovered.add(code);
          assertNotStopping();
          appendNotice('publishId 재사용 감지: 새 id로 재게시');
          log('publish-recovery', { code, mode: 'fresh-id-republish' });
          continue;
        }
        if (code === 'LOCK_TIMEOUT') {
          recovered.add(code);
          assertNotStopping();
          log('publish-recovery', { code, mode: 'retry-once' });
          continue;
        }
        if (code === 'NO_LOCK') {
          recovered.add(code);
          await recoverServerForPublish();
          assertNotStopping();
          log('publish-recovery', { code, mode: 'server-lock-rebuild' });
          continue;
        }
        throw error;
      }
    }
    const patch = {};
    if (Number.isInteger(out.publishId)) patch.lastPublishId = out.publishId;
    if (Number.isInteger(out.handNo)) patch.handNo = out.handNo;
    if (Object.keys(patch).length) writeLoopState(patch);
    return out;
  };

  const runAtomicStepPublish = async (stepArgs, publishFlags = [], actionAck) => {
    const atomicUnit = beginAtomicTransition();
    try {
      const envelope = await runCli(stepArgs);
      reportDecisionMetaDropped(envelope, stepArgs[1]);
      const flags = typeof publishFlags === 'function' ? publishFlags(envelope) : publishFlags;
      return await publishEnvelope(actionAck ? { ...envelope, actionAck } : envelope, flags);
    } finally {
      atomicUnit.finish();
    }
  };

  const waitFlags = () => managed ? [] : ['--wait', '--wait-ms', String(waitMs)];

  const coachSnapshotPath = path.join(root, 'ui-snapshot.json');
  const coachStatsPath = (handNo) => path.join(root, `.coach-stats-${handNo}.json`);
  const coachHandPath = (handNo) => path.join(root, `.coach-hand-${handNo}-redacted.json`);
  const coachReplayPath = (handNo) => path.join(root, `.coach-hand-${handNo}-replay.json`);
  const coachDenyPath = (handNo) => path.join(root, `.coach-deny-${handNo}.json`);
  const coachAuthorityPath = path.join(root, '.coach-authority.json');
  const coachAttemptKey = (handNo, generation) => `${handNo}:${generation}`;

  // #192 E2: the spawn sidecar for one attempt's exact result path. Always resolved
  // against the CURRENT game root by basename alone — the row's own stored absolute
  // directory is never trusted, so an archived/relocated game or a legacy `--game-dir`
  // row can never resolve someone else's sidecar by accident.
  const coachSpawnEvidencePath = (exactResultPath) => {
    if (typeof exactResultPath !== 'string') return null;
    const base = path.basename(exactResultPath);
    if (!base.endsWith('.result.json')) return null;
    return path.join(root, base.replace(/\.result\.json$/, '.spawn.json'));
  };

  // D2/FO-1: the single transition every coach-attempt termination site must go
  // through. A record leaves coachAttempts only on confirmed close evidence (or when
  // it never had a handle); a rejected/unconfirmed terminate() leaves it in place so a
  // later terminate attempt (heartbeat remediation, finalize cutoff, persisted
  // reclaim) can still confirm it. `finally` blocks must not delete unconditionally.
  const settleCoachAttemptRecord = (record, termination) => {
    if (!record) return record;
    const confirmed = !record.handle || termination?.confirmed === true;
    if (confirmed) {
      const key = coachAttemptKey(record.handNo, record.generation);
      if (coachAttempts.get(key) === record) coachAttempts.delete(key);
    }
    return record;
  };

  // #192 I3: the single entry point every coach-attempt termination site must call instead
  // of `record.handle.terminate()` directly. Two sites can race to terminate the exact same
  // attempt (e.g. the pipeline's own null-identity branch awaiting its termination while
  // `terminateLiveCoachGenerations` independently terminates the same record at finalize) —
  // without sharing, both would call the underlying `terminate()` a second time for one
  // child. This stores the in-flight promise on the record itself so every concurrent
  // caller gets the exact same result from one underlying call, applies
  // `settleCoachAttemptRecord` when it settles, and — only when the result is unconfirmed
  // (including a rejection) — clears the in-flight promise so a later, sequential call (a
  // different call site, after this one has already returned) can still retry. A confirmed
  // result is left in place: the record is already gone from `coachAttempts` at that point,
  // and a stray later call on the same record object should never re-invoke terminate().
  const terminateCoachAttempt = (record) => {
    if (!record) return Promise.resolve({ confirmed: false });
    if (!record.handle || typeof record.handle.terminate !== 'function') {
      const termination = { confirmed: false };
      settleCoachAttemptRecord(record, termination);
      return Promise.resolve(termination);
    }
    if (record.terminating) return record.terminating;
    const shared = (async () => record.handle.terminate())().then(
      (termination) => {
        settleCoachAttemptRecord(record, termination);
        if (termination?.confirmed === true) {
          // #192 O2: this attempt never reached bind-handle (identity was never durably
          // provable), so the authority row still has a null handle. Without this, the row's
          // only persisted evidence is `intent`/`identity-unavailable`, and a later,
          // independent classifier pass (this instance's own persisted closure, or a future
          // resume) has no way to know this exact instance already confirmed the close — it
          // judges the row unresolved (e) and finalize halts despite the child being gone.
          if (record.bound !== true && record.exactResultPath && record.spawnTuple) {
            const sidecarPath = coachSpawnEvidencePath(record.exactResultPath);
            if (sidecarPath) {
              try {
                writeSpawnEvidence(sidecarPath, { phase: 'closed-confirmed', ...record.spawnTuple });
              } catch { /* best effort; the classifier's own fail-closed (e) still applies */ }
            }
          }
        } else {
          record.terminating = null;
        }
        return termination;
      },
      (error) => {
        record.terminating = null;
        throw error;
      },
    );
    record.terminating = shared;
    return shared;
  };

  const semanticChildPayload = (envelope) => {
    const payload = { ...envelope };
    delete payload.ok;
    delete payload.events;
    delete payload.stateVersion;
    return payload;
  };

  const appendNotice = (message) => {
    const state = readLoopState();
    if (!state) return;
    const notices = Array.isArray(state.notices) ? [...state.notices] : [];
    if (!notices.includes(message)) notices.push(message);
    writeLoopState({ notices });
  };

  const replayPendingPath = path.join(root, '.replay-pending.json');

  const readReplayPendingNos = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(replayPendingPath, 'utf8'));
      if (!Array.isArray(raw?.handNos)) return [];
      return raw.handNos.filter((value) => Number.isInteger(value) && value >= 1);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      log('replay-pending-unreadable', { code: error.code ?? 'PARSE' });
      appendNotice('replay-pending unreadable; treated as empty');
      return [];
    }
  };

  const unionReplayPending = (handNos) => {
    const seen = new Set();
    const next = [];
    for (const value of [...readReplayPendingNos(), ...(handNos ?? [])]) {
      if (!Number.isInteger(value) || value < 1 || seen.has(value)) continue;
      seen.add(value);
      next.push(value);
    }
    writeJsonAtomic(replayPendingPath, { handNos: next });
    return next;
  };

  const completedReplayHandNos = (engine) => {
    const nos = [];
    const handsDir = path.join(root, 'hands');
    try {
      for (const name of fs.readdirSync(handsDir)) {
        const match = /^hand-(\d+)\.json$/.exec(name);
        if (match) nos.push(Number(match[1]));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const lastNo = engine?.lastHand?.handNo;
    if (Number.isInteger(lastNo) && lastNo >= 1) nos.push(lastNo);
    return nos;
  };

  const reportDecisionMetaDropped = (envelope, playerId) => {
    const code = envelope?.meta?.dropped;
    if (typeof code !== 'string' || code === '') return;
    log('decision-meta-dropped', { code, playerId });
    appendNotice(`decision-meta dropped: ${code}`);
  };

  const reportHandReplay = (out) => {
    const report = out?.handReplay;
    if (!report || typeof report !== 'object') return;
    for (const entry of report.markers ?? []) {
      const handNo = entry?.handNo ?? entry;
      const reason = entry?.reason ?? 'REPLAY_UNAVAILABLE';
      log('hand-replay-marker', { handNo, reason });
      appendNotice(`handReplay marker hand ${handNo}: ${reason}`);
    }
    for (const handNo of report.conflicts ?? []) {
      log('hand-replay-conflict', { handNo });
      appendNotice(`handReplay conflict hand ${handNo}`);
    }
  };

  const captureCoachStats = async (label, { beforeResultCutoff = false } = {}) => {
    const runner = beforeResultCutoff ? runCliBeforeResultCutoff : runCli;
    const captured = semanticChildPayload(await runner(['stats']));
    const filePath = label === 'owner'
      ? path.join(root, '.coach-owner-stats.json')
      : coachStatsPath(label);
    writeJsonAtomic(filePath, captured);
    return { path: filePath, raw: fs.readFileSync(filePath, 'utf8') };
  };

  const captureCoachHand = async (handNo, { beforeResultCutoff = false } = {}) => {
    const runner = beforeResultCutoff ? runCliBeforeResultCutoff : runCli;
    const captured = semanticChildPayload(await runner(['hand', String(handNo), '--redacted']));
    const filePath = coachHandPath(handNo);
    writeJsonAtomic(filePath, captured);
    return { path: filePath, raw: fs.readFileSync(filePath, 'utf8') };
  };

  const captureCoachReplay = async (handNo, { beforeResultCutoff = false } = {}) => {
    const runner = beforeResultCutoff ? runCliBeforeResultCutoff : runCli;
    const captured = semanticChildPayload(await runner(['hand', String(handNo), '--replay']));
    const filePath = coachReplayPath(handNo);
    writeJsonAtomic(filePath, captured);
    return { path: filePath, raw: fs.readFileSync(filePath, 'utf8') };
  };

  const captureCoachInputs = async (handNo, prepared = null) => {
    if (prepared) return prepared;
    // reserve consumes the stats file synchronously. Captures therefore finish before
    // the first reservation, and the exact bytes written here are reused in the prompt.
    const hand = await captureCoachHand(handNo, { beforeResultCutoff: true });
    const replay = await captureCoachReplay(handNo, { beforeResultCutoff: true });
    const stats = await captureCoachStats(handNo, { beforeResultCutoff: true });
    return { hand, replay, stats };
  };

  const fullHandRecord = (handNo) => {
    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (engine?.lastHand?.handNo === handNo) return engine.lastHand;
    const archivePath = path.join(root, 'hands', `hand-${String(handNo).padStart(4, '0')}.json`);
    return readJsonOptional(archivePath, 'HAND_RECORD');
  };

  // 규칙 자체는 게시 계약이 갖는다 — 서버의 deny 수집기와 같은 코드여야 한다.
  const coachForbiddenDetailed = (handNo) => collectPrivateLiteralsDetailed({
    players: readJsonOptional(playersPath, 'PLAYERS'),
    engineState: readJsonOptional(engineStatePath, 'ENGINE_STATE'),
    records: [fullHandRecord(handNo)],
  });

  const coachForbiddenLiterals = (handNo) => {
    const { cards, others } = coachForbiddenDetailed(handNo);
    return [...new Set([...cards, ...others])];
  };

  const replayPublicCards = (replay) => {
    const cards = new Set();
    for (const row of Object.values(replay?.holes ?? {})) {
      for (const card of row ?? []) cards.add(String(card));
    }
    for (const card of replay?.board ?? []) cards.add(String(card));
    return cards;
  };

  const writeCoachDeny = (handNo) => {
    const literals = coachForbiddenLiterals(handNo);
    if (literals.length === 0) {
      throw codedError('BAD_COACH_DENY', `핸드 ${handNo} private literal deny 목록이 비어 있습니다.`);
    }
    const filePath = coachDenyPath(handNo);
    writeJsonAtomic(filePath, literals);
    return { path: filePath, literals };
  };

  const parseCapturedHand = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const processPracticeFocus = (raw) => {
    try {
      const parsed = JSON.parse(raw);
      const goal = parsed?.goal && typeof parsed.goal === 'object' && !Array.isArray(parsed.goal)
        ? {
          id: parsed.goal.id ?? null,
          recommendedDrill: parsed.goal.recommendedDrill ?? null,
          severity: parsed.goal.severity ?? null,
          sampleWeight: parsed.goal.sampleWeight ?? parsed.goal.confidence ?? null,
          reason: parsed.goal.reason ?? null,
        }
        : null;
      return JSON.stringify({
        origin: parsed?.origin ?? null,
        focus: parsed?.focus ?? null,
        goal,
      });
    } catch {
      return '없음';
    }
  };

  const eligibleProcessInput = (input) => ({
    schemaVersion: input.schemaVersion,
    hands: input.hands.map((hand) => ({
      schemaVersion: hand.schemaVersion, handNo: hand.handNo,
      decisions: hand.decisions.filter((decision) => decision.processStatus === 'available'),
    })).filter((hand) => hand.decisions.length > 0),
  });

  const unavailableProcessNotice = (input) => {
    if (input.unavailableReasons.length === 0) return '';
    const hands = [...new Set(input.unavailableReasons.map((row) => row.handNo).filter(Number.isSafeInteger))];
    return `과정 판정 불가: ${hands.length ? `핸드 ${hands.join(', ')}` : '일부 결정'}의 결정 시점 증거가 없거나 올바르지 않아 해당 결정은 평가에서 제외했습니다.`;
  };

  const buildCoachPrompt = ({ handNo, inputs, overfoldReserved, retry = false }) => {
    const practiceFocus = processPracticeFocus(readInstalledPracticeFocus(root) ?? 'null');
    const prompt = [
      '너는 공정한 홀덤 코치다. 아래에 인라인된 입력만 사용한다. 다른 파일·도구·네트워크를 조회하지 마라.',
      '입력에 없는 상대 홀카드·덱·아키타입·스타일을 추측하거나 언급하지 마라.',
      '',
      `hand ${handNo} (redacted):`,
      inputs.hand.raw,
      '',
      `hand ${handNo} (replay):`,
      inputs.replay.raw,
      '',
      'practiceFocus:',
      practiceFocus,
      '',
      `과폴드 코멘트: ${overfoldReserved ? '허용' : '금지'}`,
      '',
      '할 일: 사용자의 주요 결정 1~2개를 한국어 1~2줄로 평가한다. 프리플랍 폴드도 예외가 아니다.',
      '(a) 왜 그 액션을 했다고 보는가. note가 있으면 인용하고 자기 해석과 구분한다.',
      '(b) 결과적으로 왜 잃었는가/접게 됐는가. 공개된 카드·보드·액션만 근거로 삼는다.',
      '(c) 대안 라인 한 줄과 근거. heuristic 방향만 제시한다.',
      'reasonKind가 model인 상대 사유는 "모델이 밝힌 사유"로 인용한다.',
      '폴드가 타당하면 포지션·홀카드·선행 액션 중 의미 있는 공개 근거로 무난한 폴드라고 평가한다.',
      '특별한 누수가 없다면 억지로 비판하거나 존재하지 않는 상대 레인지·숫자를 만들지 마라.',
      '팟 오즈가 실제 결정에 의미 있을 때만 숫자를 사용한다.',
      '정성적 과정 코칭만 제공한다. 검증된 최적·확정 누수·정답이나 EV 수치를 주장하지 마라.',
      overfoldReserved
        ? '이 핸드는 과폴드 누수 코멘트를 한 번 사용할 수 있고, 사용하면 "overfold":true를 추가한다.'
        : '이 핸드에서는 과폴드 누수 코멘트를 사용하지 마라.',
      '',
      `출력은 JSON 한 줄만: {"handNo":${handNo},"text":"...","decisions":[{"decisionId":"d-${handNo}-<street>-<k>","why":"...","outcome":"...","alternative":"..."}]}`,
      'decisions는 선택이며 최대 12개다. 각 필드는 비어 있지 않은 문자열이다.',
      'text.trim()은 비어 있으면 안 되고, 설명·마크다운·코드펜스·추가 필드는 금지한다.',
    ].join('\n');
    return retry
      ? `${prompt}\n재시도 사유: 직전 출력이 기계적 JSON 계약을 만족하지 못했다. 부분 출력은 무시하고 동일 입력으로 새로 작성하라.`
      : prompt;
  };

  const validateCoachNote = (raw, handNo, { forbiddenDetailed, replay } = {}) => {
    const note = typeof raw === 'string' ? extractJsonLine(raw) : raw;
    if (!note || typeof note !== 'object' || Array.isArray(note)) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력이 JSON 객체가 아닙니다.');
    }
    const allowed = new Set(['handNo', 'text', 'overfold', 'unavailable', 'decisions']);
    if (
      note.handNo !== handNo
      || typeof note.text !== 'string'
      || note.text.trim() === ''
      || (note.overfold !== undefined && note.overfold !== true)
      || (note.unavailable !== undefined && note.unavailable !== true)
      || Object.keys(note).some((field) => !allowed.has(field))
    ) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력 필드 계약이 올바르지 않습니다.');
    }
    if (note.decisions !== undefined) {
      const reason = validateCoachDecisions(note.decisions, handNo);
      if (reason) {
        throw codedError('INVALID_COACH_OUTPUT', `코치 decisions 계약이 올바르지 않습니다 (${reason}).`);
      }
      const allowedIds = new Set((replay?.decisions ?? []).map((row) => row.decisionId));
      for (const row of note.decisions) {
        if (!allowedIds.has(row.decisionId)) {
          throw codedError('INVALID_COACH_OUTPUT', 'decisionId가 replay user 결정 집합에 없습니다.');
        }
      }
    }
    if (!referenceClaimAllowed(note.text)) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력이 근거 범위를 벗어납니다.');
    }
    const strings = coachNoteStrings(note);
    const others = forbiddenDetailed?.others ?? new Set();
    if ([...others].some((literal) => literal && strings.some((value) => value.includes(literal)))) {
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력에 private literal이 포함됐습니다.');
    }
    const cards = forbiddenDetailed?.cards ?? new Set();
    const cardsHit = [...cards].filter((literal) => (
      literal && strings.some((value) => value.includes(literal))
    ));
    if (cardsHit.length) {
      const publicCards = replayPublicCards(replay);
      if (cardsHit.every((card) => publicCards.has(card))) {
        throw codedError('DEFER_COACH_OUTPUT', '카드 인용이 진행 중 핸드와 겹칩니다.', { note });
      }
      throw codedError('INVALID_COACH_OUTPUT', '코치 출력이 replay 공개 범위 밖 카드를 인용합니다.');
    }
    return note;
  };

  const readCoachAuthority = () => readJsonOptional(coachAuthorityPath, 'COACH_AUTHORITY');

  const canonicalCoachAuthorityEpoch = () => {
    const loopState = readLoopState();
    const engineState = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (typeof engineState?.sessionToken !== 'string' || engineState.sessionToken === '') {
      throw codedError('COACH_EPOCH_UNVERIFIABLE', 'engine의 canonical game epoch를 확인할 수 없습니다.');
    }
    const canonicalEpoch = gameEpochOf(engineState.sessionToken);
    if (
      loopState?.sessionToken !== engineState.sessionToken
      || loopState?.gameEpoch !== canonicalEpoch
    ) {
      throw codedError('COACH_EPOCH_UNVERIFIABLE', 'loop-state와 engine의 canonical game epoch가 일치하지 않습니다.');
    }
    return canonicalEpoch;
  };

  const parsePersistedCoachHandle = (raw) => {
    if (typeof raw !== 'string') return null;
    const separator = raw.indexOf(':');
    if (separator <= 0 || separator === raw.length - 1) return null;
    const pid = Number(raw.slice(0, separator));
    // Windows start times contain colons, so everything after the first separator is
    // preserved verbatim for a valid value — only the literal sentinels a lost/unverifiable
    // startTime would stringify to (`"null"`, `"undefined"`) or blank text are rejected.
    const startTime = raw.slice(separator + 1);
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    const trimmed = startTime.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
    return { pid, startTime };
  };

  const persistedCoachIdentityState = ({ pid, startTime }) => {
    if (!processAlive(pid)) return 'dead';
    const current = startTimeOf(pid);
    if (current === null) return 'unknown';
    return current === startTime ? 'alive' : 'mismatch';
  };

  const waitForPersistedCoachDeath = async (identity, maxWaitMs, deadlineNs) => {
    const phaseDeadline = monotonicNs() + BigInt(Math.max(0, maxWaitMs)) * 1_000_000n;
    const deadline = phaseDeadline < deadlineNs ? phaseDeadline : deadlineNs;
    for (;;) {
      const state = persistedCoachIdentityState(identity);
      if (state === 'dead' || state === 'mismatch') return state;
      const remaining = remainingMsUntil(deadline);
      if (remaining <= 0) return persistedCoachIdentityState(identity);
      await sleep(Math.min(pollMs, remaining));
    }
  };

  const waitForPersistedCoachIdentity = async (identity, deadlineNs) => {
    for (;;) {
      const state = persistedCoachIdentityState(identity);
      if (state !== 'unknown') return state;
      const remaining = remainingMsUntil(deadlineNs);
      if (remaining <= 0) return 'unknown';
      await sleep(Math.min(pollMs, remaining));
    }
  };

  // #192 E2/S2b/I2: read the per-attempt spawn sidecar. The fd this reads from is pinned to
  // the exact inode the checks below validate — a separate `lstat` followed by a re-open by
  // pathname leaves a TOCTOU window where the path can be replaced (hard link, swapped file)
  // between the check and the read. Where `O_NOFOLLOW` is defined, opening with it refuses a
  // symlink atomically at the syscall; where the platform has no such flag, a pre-open
  // `lstat` symlink check is the (strictly weaker) fallback. Missing is only ever classified
  // `absent` — the strongest "we would have seen it" claim — when ENOENT AND the root
  // directory itself still stats; an unmounted/relocated root must never masquerade as
  // "confirmed no spawn happened". Any other failure (not a regular file, hard-linked
  // (`nlink !== 1`), oversized, unreadable, unparseable) is `invalid`.
  const SIDECAR_MAX_BYTES = 64 * 1024;
  const readCoachSpawnSidecar = (exactResultPath) => {
    const sidecarPath = coachSpawnEvidencePath(exactResultPath);
    if (!sidecarPath) return { phase: 'invalid', data: null, path: null };
    const invalid = () => ({ phase: 'invalid', data: null, path: sidecarPath });
    const absentOrInvalid = () => {
      try {
        statGameRoot(root);
        return { phase: 'absent', data: null, path: sidecarPath };
      } catch {
        return invalid();
      }
    };
    const classify = (text) => {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return invalid();
      }
      const phase = typeof data?.phase === 'string' ? data.phase : null;
      if (!['intent', 'aborted-before-spawn', 'identity', 'identity-unavailable', 'closed-confirmed'].includes(phase)) {
        return { phase: 'invalid', data, path: sidecarPath };
      }
      return { phase, data, path: sidecarPath };
    };
    if (sidecarNoFollowFlag === undefined) {
      // #192 sJ5/oK1: no atomic open-refusing-a-symlink exists here. The fallback reader
      // pins the opened fd to the inode `lstat` saw, so a swap between the two calls is
      // `invalid` while an untouched regular file is still readable evidence.
      const read = readSidecarFileWithoutNoFollow(sidecarPath, { maxBytes: SIDECAR_MAX_BYTES });
      if (read.status === 'absent') return absentOrInvalid();
      if (read.status !== 'ok') return invalid();
      return classify(read.text);
    }
    let fd;
    try {
      fd = fs.openSync(sidecarPath, fs.constants.O_RDONLY | sidecarNoFollowFlag);
    } catch (error) {
      return error.code === 'ENOENT' ? absentOrInvalid() : invalid();
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > SIDECAR_MAX_BYTES) return invalid();
      let text;
      try {
        text = fs.readFileSync(fd, 'utf8');
      } catch {
        return invalid();
      }
      return classify(text);
    } finally {
      fs.closeSync(fd);
    }
  };

  // E2: a row's stored exactResultPath is only trusted for identity/NOT_SPAWNED purposes
  // when its directory still resolves to the current root. Any error (missing, moved,
  // permission) means not attributable.
  const coachEvidenceAttributable = (exactResultPath) => {
    if (typeof exactResultPath !== 'string' || exactResultPath === '') return false;
    try {
      return fs.realpathSync(path.dirname(exactResultPath)) === fs.realpathSync(root);
    } catch {
      return false;
    }
  };

  // §D1-equivalent validation for the sidecar's own {pid, startTime} pair: a positive
  // integer pid and a non-empty startTime that is not the literal "null"/"undefined".
  const validSidecarIdentity = (data) => {
    const pid = data?.pid;
    const startTime = data?.startTime;
    if (!Number.isSafeInteger(pid) || pid < 1) return null;
    if (typeof startTime !== 'string') return null;
    const trimmed = startTime.trim();
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
    return { pid, startTime };
  };

  // #192 O7: phases that must never be downgraded back to `intent`/`aborted-before-spawn` by
  // a later (e.g. duplicate or overlapping) pipeline run for the exact same attempt path —
  // each already proves a live child was spawned or a confirmed close was observed.
  const SIDECAR_REGRESSION_GUARDED_PHASES = new Set(['identity', 'identity-unavailable', 'closed-confirmed']);

  // Re-reads the sidecar with the same pinned read as I2 immediately before a write, and
  // reports whether it already carries this exact attempt's tuple at one of the phases
  // above — a stale tuple from a different attempt (or generation) never blocks the write,
  // only an exact match does, per judgment 0's own tuple-match rule.
  const sidecarPhaseRegressed = (exactResultPath, tuple) => {
    const current = readCoachSpawnSidecar(exactResultPath);
    if (!SIDECAR_REGRESSION_GUARDED_PHASES.has(current.phase)) return false;
    const data = current.data;
    return Boolean(data)
      && data.gameEpoch === tuple.gameEpoch
      && data.owner === tuple.owner
      && data.handNo === tuple.handNo
      && data.generation === tuple.generation
      && data.attempt === tuple.attempt;
  };

  // a/b: resolve one already-parsed identity (from the authority handle or, absent that, a
  // tuple-matched sidecar) through the same poll/signal/poll sequence either source uses.
  // H2: when the very first lookup is `unknown`, consult c/f evidence before spending any of
  // the poll budget — if it closes the row, begin-owner never waits out a dead identity poll
  // for nothing. The same consultation runs again if polling itself never resolves, since c/f
  // evidence can arrive while this attempt was busy waiting.
  const resolvePersistedCoachIdentity = async (identity, deadlineNs, identityDeadlineNs, attempt, closures, sidecar) => {
    const initial = persistedCoachIdentityState(identity);
    let state;
    if (initial === 'unknown') {
      const hook = consultCoachCloseEvidence(attempt, closures, sidecar);
      if (hook) return { outcome: 'released', reason: hook.reason };
      state = await waitForPersistedCoachIdentity(identity, identityDeadlineNs);
    } else {
      state = initial;
    }
    if (state === 'dead') return { outcome: 'released' };
    // A different startTime proves that the recorded process identity is gone. Never
    // signal the replacement pid; close the stale record as released instead.
    if (state === 'mismatch') return { outcome: 'released', reason: 'IDENTITY_REPLACED' };
    if (state !== 'alive') {
      const hook = consultCoachCloseEvidence(attempt, closures, sidecar);
      if (hook) return { outcome: 'released', reason: hook.reason };
      return { outcome: 'unconfirmed', reason: 'IDENTITY_UNKNOWN' };
    }

    // Once alive is confirmed, any failure to prove termination is final here — it never
    // falls through to c/f/d below.
    try {
      signalProcess(identity.pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') return { outcome: 'unconfirmed', reason: 'SIGNAL_FAILED' };
    }
    state = await waitForPersistedCoachDeath(identity, orphanTerminateGraceMs, deadlineNs);
    if (state === 'dead') return { outcome: 'released' };
    if (state === 'mismatch') return { outcome: 'released', reason: 'IDENTITY_REPLACED' };
    if (state !== 'alive') return { outcome: 'unconfirmed', reason: 'IDENTITY_UNKNOWN' };
    if (remainingMsUntil(deadlineNs) <= 0) return { outcome: 'unconfirmed', reason: 'DEADLINE_EXCEEDED' };

    try {
      signalProcess(identity.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') return { outcome: 'unconfirmed', reason: 'SIGNAL_FAILED' };
    }
    state = await waitForPersistedCoachDeath(identity, orphanTerminateKillWaitMs, deadlineNs);
    if (state === 'dead') return { outcome: 'released' };
    if (state === 'mismatch') return { outcome: 'released', reason: 'IDENTITY_REPLACED' };
    return {
      outcome: 'unconfirmed',
      reason: state === 'alive' ? 'STILL_ALIVE' : 'IDENTITY_UNKNOWN',
    };
  };

  // #192 E2/E3 evidence classifier (design docs/design/2026-09-13-issue-192-…, §3 판정 순서).
  // Replaces the removed in-memory `allowCurrentReservedWithoutHandle` shortcut: whether a
  // handle-less row may be released now depends only on durable evidence (the spawn sidecar,
  // the `spawnEvidence` stamp, and path attribution), never on which call site is asking.
  const terminatePersistedCoachAttempt = async (attempt, deadlineNs, {
    identityDeadlineNs = deadlineNs,
    gameEpoch = null,
    closures = null,
    getLegacyScan = null,
  } = {}) => {
    const sidecar = readCoachSpawnSidecar(attempt.exactResultPath);
    const attributable = coachEvidenceAttributable(attempt.exactResultPath);
    const evidence = {
      hasHandle: typeof attempt.agentHandle === 'string' && attempt.agentHandle.length > 0,
      spawnEvidence: attempt.spawnEvidence === 1,
      sidecar: sidecar.phase,
      attributable,
    };
    const withEvidence = (result) => ({ ...result, evidence });

    const authorityIdentity = parsePersistedCoachHandle(attempt.agentHandle);
    const sidecarIdentity = sidecar.phase === 'identity' ? validSidecarIdentity(sidecar.data) : null;

    // Step 0: any sidecar carrying a tuple must match this exact row/epoch before it can be
    // trusted for anything below. A stale or replayed tuple can never resolve to a/b/c/d/f;
    // fail closed instead of trusting foreign evidence.
    if (sidecar.data && typeof sidecar.data === 'object') {
      const tuple = sidecar.data;
      const tupleMismatch = tuple.gameEpoch !== gameEpoch
        || tuple.owner !== attempt.ownerSessionId
        || tuple.handNo !== attempt.handNo
        || tuple.generation !== attempt.generation
        || tuple.attempt !== attempt.attempt;
      if (tupleMismatch) {
        return withEvidence({
          confirmed: false, reason: 'SPAWN_EVIDENCE_MISMATCH', cleanupState: 'termination_unconfirmed',
        });
      }
    }
    if (authorityIdentity && sidecarIdentity && (
      authorityIdentity.pid !== sidecarIdentity.pid || authorityIdentity.startTime !== sidecarIdentity.startTime
    )) {
      return withEvidence({
        confirmed: false, reason: 'IDENTITY_CONFLICT', cleanupState: 'termination_unconfirmed',
      });
    }

    // a: the authority handle itself parses. b: it does not, but a tuple-matched (step 0
    // already passed) sidecar identity does — resolve through the same path either way.
    const identity = authorityIdentity ?? sidecarIdentity;
    if (identity) {
      const outcome = await resolvePersistedCoachIdentity(identity, deadlineNs, identityDeadlineNs, attempt, closures, sidecar);
      return withEvidence(outcome.outcome === 'released'
        ? { confirmed: true, ...(outcome.reason ? { reason: outcome.reason } : {}), cleanupState: 'released' }
        : { confirmed: false, reason: outcome.reason, cleanupState: 'termination_unconfirmed' });
    }

    // Neither a nor b: c/f evidence (including #192 O2's closed-confirmed) can still close
    // this row without any identity at all.
    const hook = consultCoachCloseEvidence(attempt, closures, sidecar);
    if (hook) return withEvidence({ confirmed: true, reason: hook.reason, cleanupState: 'released' });

    // d: no handle was ever recorded (a malformed string handle does not count — only a
    // genuinely absent one), the new-protocol stamp is present, the row is attributable to
    // this root, and the sidecar proves the spawn step itself was never reached.
    const handleIsNullish = attempt.agentHandle === null || attempt.agentHandle === undefined;
    const notSpawnedSidecar = sidecar.phase === 'absent' || sidecar.phase === 'aborted-before-spawn';
    if (handleIsNullish && attempt.spawnEvidence === 1 && attributable && notSpawnedSidecar) {
      return withEvidence({ confirmed: true, reason: 'NOT_SPAWNED', cleanupState: 'released' });
    }

    // g: #192 O1/L1 부록 v3.2 — legacy 행 자동 복구. identity는 이미 위에서 null로
    // 확인됐다(핸들 없음, 파싱 불가 핸들, "pid:null" 포함 모두 여기 도달한다). 새
    // 프로토콜 행(spawnEvidence===1)·acceptEvidence가 있는 행·sidecar가 한 번이라도
    // 관측된 행(‘absent’가 아닌 모든 phase)·경로 귀속 안 되는 행은 절대 g를 타지
    // 않는다. closure당 한 번만 lazy하게 스캔한다(`getLegacyScan`이 그 캐시를 쥔다).
    const legacyEligible = attempt.spawnEvidence !== 1
      && attempt.acceptEvidence == null
      && sidecar.phase === 'absent'
      && attributable;
    if (legacyEligible && getLegacyScan) {
      // #192 J4: bound the scan by the same identity deadline the classifier already uses
      // elsewhere in this function — an unbounded `await` here can otherwise push a
      // following `cleanup-result` past the closure's own deadline, surfacing a generic
      // deadline-exceeded halt instead of this row's actual scan evidence.
      const settled = await settleValueBeforeDeadline(getLegacyScan(), identityDeadlineNs);
      if (!settled.settled) {
        evidence.legacyScanDetail = 'SCAN_DEADLINE';
        return withEvidence({
          confirmed: false, reason: 'LEGACY_SCAN_UNAVAILABLE', cleanupState: 'termination_unconfirmed',
        });
      }
      // #192 sJ3: verify the lock again right before trusting the scan to release a row —
      // the first re-check (immediately after the scan settled, inside `getLegacyScan`
      // itself) catches loss during the scan; this one catches loss in the time between the
      // scan settling and this specific row's own release decision.
      if (!ownedLockStillVerified()) {
        evidence.legacyScanDetail = 'LOCK_LOST_DURING_SCAN';
        return withEvidence({
          confirmed: false, reason: 'LEGACY_SCAN_UNAVAILABLE', cleanupState: 'termination_unconfirmed',
        });
      }
      if (settled.error) {
        // #192 oK5: the scan chain itself rejected after the scanner settled.
        evidence.legacyScanDetail = 'SCAN_THREW';
        return withEvidence({
          confirmed: false, reason: 'LEGACY_SCAN_UNAVAILABLE', cleanupState: 'termination_unconfirmed',
        });
      }
      const scan = settled.value;
      if (scan.status === 'clean') {
        return withEvidence({ confirmed: true, reason: 'LEGACY_NO_RUNTIME_PROCESS', cleanupState: 'released' });
      }
      if (scan.status === 'candidates') {
        evidence.legacyScanPids = scan.candidates.map((candidate) => candidate.pid);
        return withEvidence({
          confirmed: false, reason: 'LEGACY_RUNTIME_PROCESS_PRESENT', cleanupState: 'termination_unconfirmed',
        });
      }
      evidence.legacyScanDetail = scan.reason ?? null;
      return withEvidence({
        confirmed: false, reason: 'LEGACY_SCAN_UNAVAILABLE', cleanupState: 'termination_unconfirmed',
      });
    }

    // e: everything else — intent-only, identity-unavailable, invalid/corrupt sidecar,
    // unattributable path, or a legacy row with no stamp at all.
    const fallbackReason = !attributable
      ? 'NOT_ATTRIBUTABLE'
      : sidecar.phase === 'invalid'
        ? 'SPAWN_EVIDENCE_INVALID'
        : sidecar.phase === 'intent'
          ? 'SPAWN_INTENT_ONLY'
          : 'IDENTITY_UNAVAILABLE';
    return withEvidence({ confirmed: false, reason: fallbackReason, cleanupState: 'termination_unconfirmed' });
  };

  const persistedCoachAttempts = () => {
    const auth = readCoachAuthority();
    if (!auth) return { owner: null, attempts: [], authorityPresent: false };
    const owner = auth.activeOwnerSessionId;
    let canonicalEpoch;
    try {
      canonicalEpoch = canonicalCoachAuthorityEpoch();
    } catch (error) {
      return {
        owner,
        attempts: [],
        authorityError: {
          reason: error.code ?? 'COACH_EPOCH_UNVERIFIABLE',
          expectedGameEpoch: null,
          actualGameEpoch: auth.gameEpoch ?? null,
        },
      };
    }
    if (auth.gameEpoch !== canonicalEpoch) {
      return {
        owner,
        attempts: [],
        authorityError: {
          reason: 'STALE_GAME_EPOCH',
          expectedGameEpoch: canonicalEpoch,
          actualGameEpoch: auth.gameEpoch ?? null,
        },
      };
    }
    const attempts = [];
    for (const [handKey, hand] of Object.entries(auth.hands ?? {})) {
      if (!['reserved', 'running'].includes(hand?.status)
        && !(hand?.status === 'terminal' && hand?.resultState === 'unread')) continue;
      attempts.push({
        source: 'active',
        handNo: Number(handKey),
        generation: hand.generation,
        status: hand.status,
        agentHandle: hand.agentHandle,
        exactResultPath: hand.exactResultPath,
        attempt: hand.attempt,
        spawnEvidence: hand.spawnEvidence,
        acceptEvidence: hand.acceptEvidence,
        ownerSessionId: hand.ownerSessionId,
        cleanupAuthorized: true,
      });
    }
    // #192 D3 (G5): every retired row that isn't already `released` gets judged, with no
    // filtering on handle presence or reclaimability first — a foreign row this owner can't
    // write to can still be closed by evidence (c/f), or halt unresolved (e), instead of
    // being silently skipped as it was before. `cleanupAuthorized` is the *write* permission
    // only, and must mirror `recordCleanup`'s own row-match predicate exactly (see
    // `recordCleanup` in tools/coach-control.js: `entry.ownerSessionId === owner
    // || entry.cleanupEligible`) — a row failing it is still classified below, it just never
    // gets a `cleanup-result` call (`closePersistedCoachWorkersCore` gates that separately).
    for (const row of auth.retiredAttempts ?? []) {
      if (row?.cleanupState === 'released') continue;
      const cleanupAuthorized = row?.ownerSessionId === owner || row?.cleanupEligible === true;
      attempts.push({
        source: 'retired',
        handNo: row.handNo,
        generation: row.generation,
        status: row.cleanupState,
        agentHandle: row.agentHandle,
        exactResultPath: row.exactResultPath,
        attempt: row.attempt,
        spawnEvidence: row.spawnEvidence,
        acceptEvidence: row.acceptEvidence,
        ownerSessionId: row.ownerSessionId,
        cleanupAuthorized,
      });
    }
    return {
      owner, attempts, authorityPresent: true, gameEpoch: canonicalEpoch, adapterState: auth.adapterState,
    };
  };

  const closePersistedCoachWorkersCore = async ({
    deadlineNs,
    identityDeadlineNs,
    deadlineError,
    reasonPrefix,
  }) => {
    const {
      owner, attempts, authorityError, authorityPresent = true, gameEpoch = null, adapterState = null,
    } = persistedCoachAttempts();
    // #192 D4: read the owner-runtime-closure receipt list exactly once, at the very start of
    // this closure, before any of this closure's own writes (cleanup-result can flip
    // `auth.adapterState` to 'disabled' as a side effect — see coach-control.js's
    // `recordCleanup` — so reading `adapterState` here, before that happens, captures the
    // closure-start value D4 needs, not a value this same closure just produced). Every
    // attempt row's classification below consults this same array — never re-reading
    // loop-state.json per row or per consultation.
    const closures = readLoopState()?.coachRuntimeClosures;
    if (authorityError) {
      return {
        confirmed: false,
        owner,
        authorityPresent,
        unresolved: [{
          handNo: null,
          generation: null,
          cleanupAuthorized: false,
          ...authorityError,
        }],
      };
    }
    if (attempts.length === 0) {
      return { confirmed: true, owner, unresolved: [], authorityPresent };
    }
    if (typeof owner !== 'string' || owner === '') {
      return {
        confirmed: false,
        owner,
        authorityPresent,
        unresolved: [{
          handNo: null,
          generation: null,
          reason: 'NO_COACH_OWNER',
          cleanupAuthorized: false,
        }],
      };
    }
    // #192 O1/L1: the legacy-row scan runs at most once per closure, lazily — created only
    // if some attempt actually turns out to need it (judgment g's own eligibility check),
    // and only while this instance still owns the loop lock (never for an instance that has
    // lost lock ownership mid-flight, e.g. after a lock-identity check like I5's).
    let legacyScanPromise = null;
    const getLegacyScan = () => {
      if (!legacyScanPromise) {
        legacyScanPromise = (ownedLockStillVerified()
          ? Promise.resolve().then(() => scanCoachRuntimeProcessesFn())
          : Promise.resolve({ status: 'unavailable', reason: 'LOCK_NOT_OWNED' })
        ).catch(() => ({ status: 'unavailable', reason: 'SCAN_THREW' })).then((scan) => {
          log('coach-legacy-scan', {
            status: scan.status,
            candidateCount: scan.status === 'candidates' ? scan.candidates.length : 0,
          });
          // #192 sJ3: the lock was only checked before the scan started — the scan itself is
          // an asynchronous lsof exec that can outlive this instance's ownership of the lock
          // (reclaimed by another instance mid-flight). Re-verify immediately once the scan
          // settles; a lost lock discards the result no matter what it says.
          if (!ownedLockStillVerified()) {
            return { status: 'unavailable', reason: 'LOCK_LOST_DURING_SCAN' };
          }
          return scan;
        });
      }
      return legacyScanPromise;
    };
    const outcomes = await Promise.all(attempts.map(async (attempt) => ({
      attempt,
      result: await terminatePersistedCoachAttempt(attempt, deadlineNs, {
        identityDeadlineNs,
        gameEpoch,
        closures,
        getLegacyScan,
      }),
    })));

    // Each hand preserves fence→cleanup ordering, but all hand closures start together.
    // The authority lock serializes its tiny critical sections while the parent keeps one
    // absolute deadline instead of multiplying child timeouts by the hand count.
    const closed = await Promise.all(outcomes.map(async ({ attempt, result }) => {
      let childFailure = null;
      if (attempt.source === 'active') {
        try {
          await runCoach([
            'fence', '--owner', owner,
            '--hand', String(attempt.handNo),
            '--generation', String(attempt.generation),
            '--reason', result.confirmed ? `${reasonPrefix}-closed` : `${reasonPrefix}-unconfirmed`,
          ], { deadlineNs, deadlineError });
        } catch (error) {
          if (error.code === deadlineError().code) throw error;
          if (error.code !== 'STALE_GENERATION') {
            childFailure = { reason: 'FENCE_CHILD_FAILED', cleanupAuthorized: false };
          }
        }
      }
      // #192 D4: a retired row's `attempt.status` is its `cleanupState` as captured by
      // `persistedCoachAttempts()` at this closure's very start (an active row was never
      // retired yet, so it has no prior cleanupState to compare against and always writes
      // its first transition). Writing the identical state again on a later resume would
      // only add a redundant trace entry with no semantic change — skip it. A row whose
      // judgment changed (e.g. termination_unconfirmed → released once identity dies) is
      // unaffected and still writes.
      const cleanupStateUnchanged = attempt.source === 'retired' && attempt.status === result.cleanupState;
      if (attempt.cleanupAuthorized && childFailure === null && !cleanupStateUnchanged) {
        try {
          await runCoach([
            'cleanup-result', '--owner', owner,
            '--hand', String(attempt.handNo),
            '--generation', String(attempt.generation),
            '--cleanup-state', result.cleanupState,
          ], { deadlineNs, deadlineError });
        } catch (error) {
          if (error.code === deadlineError().code) throw error;
          childFailure = { reason: 'CLEANUP_CHILD_FAILED', cleanupAuthorized: true };
        }
      }
      const effectiveResult = childFailure === null
        ? result
        : {
            confirmed: false,
            reason: childFailure.reason,
            cleanupState: 'termination_unconfirmed',
            cleanupAuthorized: childFailure.cleanupAuthorized,
            evidence: result.evidence,
          };
      if (effectiveResult.confirmed !== true) {
        log(`${reasonPrefix}-unconfirmed`, {
          handNo: attempt.handNo,
          generation: attempt.generation,
          reason: effectiveResult.reason,
        });
      }
      return { attempt, result: effectiveResult };
    }));
    const unresolved = closed
      .filter(({ result }) => result.confirmed !== true)
      .map(({ attempt, result }) => ({
        handNo: attempt.handNo,
        generation: attempt.generation,
        reason: result.reason,
        cleanupAuthorized: result.cleanupAuthorized ?? attempt.cleanupAuthorized,
        evidence: result.evidence,
        // #192 O1/L1: only used by `persistedCoachRecovery` to build a foreign row's
        // operator-confirmed recovery command; never affects classification.
        ownerSessionId: attempt.ownerSessionId,
      }));
    const confirmed = unresolved.length === 0;
    if (!confirmed) {
      // #192 D4: call adapter-disable only when the authority's `adapterState` captured at
      // this closure's very start was not already 'disabled'. The very first unresolved
      // closure always sees a non-disabled start state and calls this exactly once; every
      // later closure over the same still-unresolved row(s) sees 'disabled' already and
      // skips the redundant child call and trace entry, while still reflecting the disabled
      // state in this process's own in-memory flag.
      if (adapterState === 'disabled') {
        coachAdapterDisabled = true;
      } else {
        try {
          await runCoach([
            'adapter-disable', '--owner', owner,
            '--reason', `${reasonPrefix}-termination-unconfirmed`,
          ], { deadlineNs, deadlineError });
          coachAdapterDisabled = true;
        } catch (error) {
          if (error.code === deadlineError().code) throw error;
          unresolved.push({
            handNo: null,
            generation: null,
            reason: 'ADAPTER_DISABLE_CHILD_FAILED',
            cleanupAuthorized: false,
          });
        }
      }
    }
    return { confirmed: unresolved.length === 0, owner, unresolved, authorityPresent };
  };

  const closePersistedCoachWorkers = async () => {
    const deadlineNs = ensureFinalizationDeadline();
    return closePersistedCoachWorkersCore({
      deadlineNs,
      identityDeadlineNs: finalizeResultWaitCutoffNs ?? deadlineNs,
      deadlineError: finalizationDeadlineError,
      reasonPrefix: 'finalize-persisted',
    });
  };

  const resumeReclaimDeadlineError = () => codedError(
    'RESUME_RECLAIM_DEADLINE_EXCEEDED',
    'playing resume persisted coach 회수 deadline이 만료됐습니다.',
  );

  const reclaimPersistedCoachWorkersForResume = async (completedHands, { policyMode = false } = {}) => {
    const budgetMs = orphanTerminateGraceMs + orphanTerminateKillWaitMs + resumeReclaimResidualMs;
    const deadlineNs = monotonicNs() + BigInt(budgetMs) * 1_000_000n;
    const identityDeadlineNs = deadlineNs - BigInt(resumeReclaimResidualMs) * 1_000_000n;
    let result;
    try {
      result = await closePersistedCoachWorkersCore({
        deadlineNs,
        identityDeadlineNs,
        deadlineError: resumeReclaimDeadlineError,
        reasonPrefix: 'resume-persisted',
      });
    } catch (error) {
      if (error.code !== 'RESUME_RECLAIM_DEADLINE_EXCEEDED') throw error;
      result = {
        confirmed: false,
        owner: persistedCoachAttempts().owner,
        authorityPresent: persistedCoachAttempts().authorityPresent ?? false,
        unresolved: [{
          handNo: null,
          generation: null,
          reason: error.code,
          cleanupAuthorized: false,
        }],
      };
    }
    // #192 R1: a policy game whose upper adapter never engaged coach (or reserved a
    // hand) has no `.coach-authority.json` at all — that is expected, not evidence loss.
    // Keep reclaiming every recorded persisted row exactly as above; only skip the
    // "authority file itself is missing" halt for policy games. llm playing resume keeps
    // raising AUTHORITY_MISSING unchanged.
    if (!policyMode && result.authorityPresent === false && completedHands >= 1) {
      return {
        ...result,
        confirmed: false,
        unresolved: [...result.unresolved, {
          handNo: null,
          generation: null,
          reason: 'AUTHORITY_MISSING',
          cleanupAuthorized: false,
        }],
      };
    }
    return result;
  };

  const coachEnvelopePathFor = (handNo, fallback = null) => (
    readCoachAuthority()?.publishQueue?.[String(handNo)]?.exactEnvelopePath
    ?? fallback
  );

  const ensureCoachPublishReconciled = async (handNo) => {
    let queued = readCoachAuthority()?.publishQueue?.[String(handNo)];
    if (!queued) return;
    await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
    queued = readCoachAuthority()?.publishQueue?.[String(handNo)];
    if (queued) {
      throw codedError(
        'COACH_RECONCILE_PENDING',
        `핸드 ${handNo} 코치 게시 후 reconcile 증명을 확인하지 못했습니다.`,
      );
    }
  };

  const executeCoachPublish = async (handNo, exactEnvelopePath) => {
    const args = ['--from', exactEnvelopePath];
    try {
      const published = await executePublish(args);
      await ensureCoachPublishReconciled(handNo);
      return published;
    } catch (error) {
      if (error.code === 'COACH_RECONCILE_PENDING') throw error;
      if (error.code === 'LOCK_TIMEOUT') {
        const published = await executePublish(args);
        await ensureCoachPublishReconciled(handNo);
        return published;
      }
      if (error.code !== 'ATTEMPT_PENDING') throw error;
      let attemptedCoachQueueId = null;
      let attemptedPublishId = null;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, '.publish-attempt.json'), 'utf8'));
        attemptedCoachQueueId = record?.coachAuthority?.queueId ?? null;
        attemptedPublishId = Number.isInteger(record?.body?.publishId) ? record.body.publishId : null;
      } catch { /* publish.js owns malformed/stale attempt classification */ }
      let retried;
      try {
        retried = await executePublish([...args, '--retry']);
      } catch (retryError) {
        if (retryError.code !== 'NO_ATTEMPT') throw retryError;
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${handNo} 코치 retry 직전 attempt가 사라져 반영 여부를 확인하지 못했습니다.`,
        );
      }
      await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
      const auth = readCoachAuthority();
      if (auth?.publishedSeals?.[String(handNo)]) return { ok: true, reconciled: true };
      const currentQueueId = auth?.publishQueue?.[String(handNo)]?.queueId ?? null;
      const retryPublishedCurrent = (
        (attemptedCoachQueueId && attemptedCoachQueueId === currentQueueId)
        || (!attemptedCoachQueueId && retried?.hadCoach === true)
      );
      if (retryPublishedCurrent || retried?.reconcilePending === true) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${handNo} 코치 retry 후 reconcile 증명을 확인하지 못했습니다.`,
        );
      }
      let recordedBodyProven = false;
      if (attemptedPublishId !== null) {
        try {
          recordedBodyProven = Number(readJsonOptional(coachSnapshotPath, 'COACH_SNAPSHOT')?.publishId) >= attemptedPublishId;
        } catch { /* an unavailable snapshot is not publication proof */ }
      }
      if (!attemptedCoachQueueId && !recordedBodyProven) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${handNo} 코치 retry 중 recorded body 반영을 확인하지 못했습니다.`,
        );
      }
      const published = await executePublish(args);
      await ensureCoachPublishReconciled(handNo);
      return published;
    }
  };

  const completeCoachUnavailable = async ({
    owner, handNo, generation, reason, fallbackEnvelopePath = null, replaceDeferred = false,
  }) => {
    // Past the cutoff the single finalize-cutoff transaction owns every remaining seal;
    // a racing per-hand seal would fight it for the same handNo.
    if (finalizationCutoff) return;
    const args = [
      'complete-unavailable',
      '--owner', owner,
      '--hand', String(handNo),
      ...(generation == null ? [] : ['--generation', String(generation)]),
      '--reason', reason,
      '--snapshot-file', coachSnapshotPath,
      ...(replaceDeferred ? ['--replace-deferred'] : []),
    ];
    await runCoachBeforeResultCutoff(args);
    const exactEnvelopePath = coachEnvelopePathFor(handNo, fallbackEnvelopePath);
    if (!exactEnvelopePath) throw codedError('NO_COACH_ENVELOPE', `핸드 ${handNo} unavailable envelope이 없습니다.`);
    if (coachPublicationDeferred()) return;
    await executeCoachPublish(handNo, exactEnvelopePath);
  };

  const reserveCoach = (owner, handNo, attempt, statsPath) => runCoachBeforeResultCutoff([
    'reserve',
    '--owner', owner,
    '--hand', String(handNo),
    '--attempt', String(attempt),
    '--consider-overfold',
    '--stats-file', statsPath,
    '--snapshot-file', coachSnapshotPath,
    '--spawn-evidence', '1',
  ]);

  const coachPipeline = async (handNo, { descriptor: initialDescriptor = null, prepared = null } = {}) => {
    if (coachWorkSuspended()) return;
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') throw codedError('NO_COACH_OWNER', '코치 ownerSessionId가 없습니다.');
    const upperUsable = upperAdapter && typeof upperAdapter.oneshotStart === 'function';
    if (coachAdapterDisabled || upperAdapter === null) {
      appendNotice(`상위 모델 런타임이 없어 핸드 ${handNo}은 고정 코치 문구로 대체합니다.`);
      await completeCoachUnavailable({
        owner,
        handNo,
        generation: initialDescriptor?.generation,
        reason: coachAdapterDisabled ? 'adapter-disabled' : 'upper-unavailable',
        fallbackEnvelopePath: initialDescriptor?.exactEnvelopePath,
      });
      return;
    }
    // A non-null object that does not implement the probed interface is not a truthful
    // upper-null result. It still must seal the hand; a live descriptor requires its
    // exact generation, while a play-time hand without a reservation uses fallback.
    if (!upperUsable) {
      coachAdapterDisabled = true;
      appendNotice(`핸드 ${handNo} 코치 adapter 인터페이스가 없어 고정 문구로 대체합니다.`);
      await completeCoachUnavailable({
        owner,
        handNo,
        generation: initialDescriptor?.generation,
        reason: 'upper-interface-unavailable',
        fallbackEnvelopePath: initialDescriptor?.exactEnvelopePath,
      });
      return;
    }

    const inputs = await captureCoachInputs(handNo, prepared);
    if (typeof opts.coachCaptureCheckpoint === 'function') {
      await opts.coachCaptureCheckpoint({ handNo });
    }
    if (coachWorkSuspended()) return;
    const denyDetailed = coachForbiddenDetailed(handNo);
    const deny = writeCoachDeny(handNo);
    let descriptor = initialDescriptor;
    if (!descriptor) {
      if (coachWorkSuspended()) return;
      try {
        descriptor = await reserveCoach(owner, handNo, 1, inputs.stats.path);
      } catch (reserveError) {
        if (reserveError.code !== 'ADAPTER_DISABLED') throw reserveError;
        // Adapter authority can change while the redacted captures are running. No
        // generation exists when the initial reserve is rejected, so use the explicit
        // generation-less fallback instead of degrading to a log-only coach gap.
        coachAdapterDisabled = true;
        appendNotice(`핸드 ${handNo} 코치 reserve 전 adapter가 disabled되어 고정 문구로 대체합니다.`);
        await completeCoachUnavailable({
          owner,
          handNo,
          reason: 'adapter-disabled-before-reserve',
        });
        return;
      }
    }
    if (coachWorkSuspended()) return;
    const processInput = buildProcessInput([parseCapturedHand(inputs.hand.raw)]);
    if (eligibleProcessInput(processInput).hands.length === 0) {
      await completeCoachUnavailable({ owner, handNo, generation: descriptor.generation,
        reason: 'process-evidence-unavailable', fallbackEnvelopePath: descriptor.exactEnvelopePath });
      return;
    }
    for (let attempt = Number(descriptor.attempt ?? 1); attempt <= 2; attempt += 1) {
      const currentDescriptor = descriptor;
      if (attempt > 1 && !coachReplacementAllowed()) {
        appendNotice(`핸드 ${handNo} 코치 교체 시작 경계에서 예산(5초)이 남지 않아 고정 문구로 대체합니다.`);
        await completeCoachUnavailable({
          owner,
          handNo,
          generation: currentDescriptor.generation,
          reason: 'finalize-no-replacement-budget',
          fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
        });
        return;
      }
      const prompt = buildCoachPrompt({
        handNo,
        inputs,
        overfoldReserved: currentDescriptor.overfoldReserved === true,
        retry: attempt === 2,
      });
      let handle = null;
      let record = null;
      let accepted = false;
      let heartbeatTimedOut = false;
      // #192 S2b: once a failure inside the spawn sequence below has already resolved this
      // attempt's termination (e.g. the null-identity branch's own handle.terminate()), the
      // outer catch must reuse that result instead of invoking terminate() a second time for
      // the same failure.
      let terminationOutcome = null;
      // #192 S3: set alongside `terminationOutcome` the instant the null-identity branch
      // settles this attempt, so the outer catch can tell "this failure originated inside
      // the identity-unavailable branch" apart from an ordinary confirmed-termination
      // failure elsewhere in the try. The two must not be treated the same: a confirmed
      // identity-unavailable termination never earns a replacement attempt, even when a
      // later step in that same branch (e.g. fenceCurrentGeneration()) throws.
      let identityUnavailableReason = null;
      try {
        if (coachWorkSuspended()) return;
        if (typeof opts.coachSpawnCheckpoint === 'function') {
          const checkpointResult = await opts.coachSpawnCheckpoint({ handNo, attempt });
          // #192 O4: narrow test seam — a real `pause()` winning the race while this
          // checkpoint was awaited flips this same internal flag before its own await
          // resolves; driving the full managed control protocol synchronously inside a test
          // is impractical (`pause()` requires `managed` mode and the `playing` phase, which
          // this coach-only finalize fixture is never in). A checkpoint resolving to
          // `{ pauseRequested: true }` exercises the exact same `coachWorkSuspended()` branch
          // below a real pause would.
          if (checkpointResult?.pauseRequested) pauseRequested = true;
          // #192 O4: narrow test seam — genuinely reproducing "loop-state still names this
          // owner, but this instance never actually issued it" needs a second real loop
          // instance racing this one (every real `resume()`/`bootstrap()` immediately adds
          // its own freshly-minted owner to `issuedOwners`). A checkpoint resolving to
          // `{ retractIssuedOwner: true }` removes the just-captured `owner` from
          // `issuedOwners` in-process, exercising the `issuedOwners.has(owner)` half of the
          // re-check below in isolation from the `ownerSessionId !== owner` half.
          if (checkpointResult?.retractIssuedOwner) issuedOwners.delete(owner);
        }
        // E2 §3a: re-validate synchronously the instant the checkpoint releases. A
        // pause/stop that arrived while it was awaited must never spawn and must never
        // write even the `intent` sidecar — treat it exactly like the pre-checkpoint
        // suspension check above. An owner handoff during the checkpoint is the same:
        // do not spawn on behalf of an owner this loop instance no longer holds.
        // #192 S4 E1: also require that this exact instance is the one that minted
        // `owner` (`issuedOwners`), not merely that loop-state's `ownerSessionId` still
        // reads back the same string this coachPipeline call started with.
        if (coachWorkSuspended()) return;
        assertBeforeResultWaitCutoff();
        const spawnLoopState = readLoopState();
        if (spawnLoopState?.ownerSessionId !== owner || !issuedOwners.has(owner)) return;

        const spawnTuple = {
          gameEpoch: spawnLoopState?.gameEpoch,
          owner,
          handNo,
          generation: currentDescriptor.generation,
          attempt,
        };
        const sidecarPath = coachSpawnEvidencePath(currentDescriptor.exactResultPath);
        // #192 O7: never downgrade a sidecar that already proves a live/closed child for
        // this exact attempt back to `intent` — a second pipeline run for the same attempt
        // path (duplicate/overlapping call) must not spawn a second child nor blind a later
        // reader to the first one. Re-read is pinned the same way I2 pins it.
        if (sidecarPath && sidecarPhaseRegressed(currentDescriptor.exactResultPath, spawnTuple)) {
          log('coach-spawn-evidence-regression', {
            handNo, generation: currentDescriptor.generation, attempt, phase: 'intent',
          });
          return;
        }
        // E2 §3b: record intent synchronously before ever spawning. An unwritable sidecar
        // can never later prove NOT_SPAWNED, so fail exactly as a pre-spawn cutoff would.
        if (sidecarPath) {
          try {
            writeSpawnEvidence(sidecarPath, { phase: 'intent', ...spawnTuple });
          } catch {
            await completeCoachUnavailable({
              owner,
              handNo,
              generation: currentDescriptor.generation,
              reason: 'spawn-evidence-unwritable',
              fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
            });
            return;
          }
        }
        // E2 §3c: the intent write can itself spend real time (commitTmp's rename
        // retries). Re-check the cutoff/suspension boundary before ever calling
        // oneshotStart, and record the abort so a later reader never mistakes a
        // crash-during-write for "never attempted".
        let crossedCutoff = null;
        try {
          assertBeforeResultWaitCutoff();
        } catch (cutoffError) {
          crossedCutoff = cutoffError;
        }
        if (crossedCutoff || coachWorkSuspended()) {
          // #192 O7: same guard as above, immediately before the aborted-before-spawn write
          // — a concurrent pipeline run for this same attempt could have progressed the
          // sidecar to `identity` in the gap since the intent write just above.
          if (sidecarPath && sidecarPhaseRegressed(currentDescriptor.exactResultPath, spawnTuple)) {
            log('coach-spawn-evidence-regression', {
              handNo, generation: currentDescriptor.generation, attempt, phase: 'aborted-before-spawn',
            });
          } else if (sidecarPath) {
            try {
              writeSpawnEvidence(sidecarPath, { phase: 'aborted-before-spawn', ...spawnTuple });
            } catch { /* the intent record already on disk still proves no spawn happened */ }
          }
          if (crossedCutoff) throw crossedCutoff;
          return;
        }

        handle = upperAdapter.oneshotStart({
          tier: 'upper',
          prompt,
          timeoutMs: COACH_GENERATION_MS,
        });
        let interrupt;
        const interrupted = new Promise((_, reject) => {
          interrupt = (code = 'COACH_HEARTBEAT_TIMEOUT') => reject(codedError(
            code,
            code === 'COACH_RESULT_ACCEPTED'
              ? '코치 heartbeat가 준비된 결과를 승격했습니다.'
              : '코치 heartbeat deadline이 만료됐습니다.',
          ));
        });
        // bind-handle is awaited before Promise.race below. Observe the interrupt Promise
        // immediately so a cutoff/heartbeat rejection during that child cannot be unhandled.
        interrupted.catch(() => {});
        // D2/FO-1: register the attempt record immediately after the child exists, before
        // any later step (including the null-identity branch below and bind-handle) can
        // throw and lose track of a live handle.
        // #192 O2: `exactResultPath`/`spawnTuple` let a confirmed termination for an
        // attempt that never reaches `bound: true` (bind-handle never ran) persist a
        // `closed-confirmed` sidecar from inside terminateCoachAttempt itself.
        record = {
          handNo, generation: currentDescriptor.generation, attempt, handle, interrupt,
          exactResultPath: currentDescriptor.exactResultPath, spawnTuple, bound: false,
        };
        coachAttempts.set(coachAttemptKey(handNo, currentDescriptor.generation), record);

        // E2 §3e: identity must be durably provable before bind-handle ever attempts to
        // persist it. #192 O6: reuse the exact same validator the sidecar reader applies
        // (`validSidecarIdentity`) so a blank/whitespace-only startTime can never be written
        // to the identity sidecar or bound as `pid:<blank>` — a plain non-null check let
        // that through even though the parser (`parsePersistedCoachHandle`) rejects it.
        const validIdentity = validSidecarIdentity({ pid: handle.pid, startTime: handle.startTime }) !== null;
        let identityWriteFailed = false;
        if (validIdentity && sidecarPath) {
          try {
            writeSpawnEvidence(sidecarPath, {
              phase: 'identity', ...spawnTuple, pid: handle.pid, startTime: String(handle.startTime),
            });
          } catch {
            identityWriteFailed = true;
          }
        }
        if (!validIdentity || identityWriteFailed) {
          if (sidecarPath) {
            try {
              writeSpawnEvidence(sidecarPath, { phase: 'identity-unavailable', ...spawnTuple });
            } catch { /* best effort; the fail-closed branch below does not depend on it */ }
          }
          // FO-2: a runtime can report a live child without a resolvable pid/startTime, or
          // the identity write itself can fail after a genuinely valid identity. Either way,
          // binding "<pid>:null" (or an identity nobody durably recorded) would let a later
          // resume trust an identity it never actually confirmed (fail-open). Never bind an
          // unverifiable handle — settle this attempt here instead.
          const identityFailureReason = identityWriteFailed ? 'spawn-evidence-unwritable' : 'identity-unavailable';
          // #192 I3: shared with any concurrent caller (e.g. terminateLiveCoachGenerations)
          // that reaches this exact record while this termination is still in flight.
          const termination = await terminateCoachAttempt(record);
          terminationOutcome = termination;
          identityUnavailableReason = identityFailureReason;
          const confirmed = termination?.confirmed === true;
          log('coach-identity-unavailable', {
            handNo,
            generation: currentDescriptor.generation,
            confirmed,
            reason: identityFailureReason,
          });
          const fenceCurrentGeneration = async () => {
            try {
              await runCoachBeforeResultCutoff([
                'fence',
                '--owner', owner,
                '--hand', String(handNo),
                '--generation', String(currentDescriptor.generation),
                '--reason', identityFailureReason,
              ]);
            } catch (fenceError) {
              // heartbeat may retire this exact generation independently; STALE_GENERATION
              // then means there is no live generation left to fence, not a failure.
              if (fenceError.code !== 'STALE_GENERATION') throw fenceError;
              log('coach-fence-already-retired', {
                handNo,
                generation: currentDescriptor.generation,
              });
            }
          };
          if (confirmed) {
            await fenceCurrentGeneration();
            await completeCoachUnavailable({
              owner,
              handNo,
              generation: currentDescriptor.generation,
              reason: identityFailureReason,
              fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
            });
            return;
          }
          await fenceCurrentGeneration();
          await runCoachBeforeResultCutoff([
            'adapter-disable',
            '--owner', owner,
            '--reason', identityFailureReason,
          ]);
          coachAdapterDisabled = true;
          await completeCoachUnavailable({
            owner,
            handNo,
            generation: currentDescriptor.generation,
            reason: identityFailureReason,
            fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
          });
          return;
        }
        await runCoachBeforeResultCutoff([
          'bind-handle',
          '--owner', owner,
          '--hand', String(handNo),
          '--generation', String(currentDescriptor.generation),
          '--handle', `${handle.pid}:${handle.startTime}`,
          '--spawn-evidence', '1',
        ]);
        // #192 O2: bind-handle succeeded — the authority row now carries a real handle, so a
        // later confirmed termination never needs (or should write) a `closed-confirmed`
        // sidecar for this attempt.
        record.bound = true;
        const completed = await Promise.race([handle.done, interrupted]);
        assertBeforeResultWaitCutoff();
        const note = validateCoachNote(completed?.raw, handNo, {
          forbiddenDetailed: denyDetailed,
          replay: parseCapturedHand(inputs.replay.raw),
        });
        const unavailableNotice = unavailableProcessNotice(processInput);
        if (unavailableNotice) note.text += `\n${unavailableNotice}`;
        writeJsonAtomic(currentDescriptor.exactResultPath, note);
        // #192 E3 f: the result was read only after `Promise.race([handle.done, …])`
        // resolved via `done` — the child's own close was observed before this accept.
        await runCoachBeforeResultCutoff([
          'accept',
          '--owner', owner,
          '--hand', String(handNo),
          '--generation', String(currentDescriptor.generation),
          '--forbidden-file', deny.path,
          '--accept-evidence', 'closed-child',
        ]);
        accepted = true;
        // The child's own result was read after `done` resolved (closed-child evidence);
        // treat the attempt as settled regardless of whether anyone calls terminate().
        settleCoachAttemptRecord(record, { confirmed: true });
        // A cutoff between accept and publish leaves this hand in the authority Q; the
        // post-cutoff residual drain owns it from there.
        if (!coachPublicationDeferred()) await executeCoachPublish(handNo, currentDescriptor.exactEnvelopePath);
        return;
      } catch (error) {
        if (error.code === 'DEFER_COACH_OUTPUT') {
          writeJsonAtomic(currentDescriptor.exactResultPath, error.note);
          await runCoachBeforeResultCutoff([
            'defer',
            '--owner', owner,
            '--hand', String(handNo),
            '--generation', String(currentDescriptor.generation),
            '--note-file', currentDescriptor.exactResultPath,
          ]);
          // #192 I3: shared — see the null-identity branch above.
          await terminateCoachAttempt(record);
          return;
        }
        if (error.code === 'COACH_RESULT_ACCEPTED') return;
        // COACH_FINALIZE_CUTOFF is only raised by terminateLiveCoachGenerations, which
        // already awaited handle.terminate() and settled this record before interrupting
        // this race. Terminating again here would call terminate() twice for the same
        // cutoff.
        if (error.code === 'COACH_FINALIZE_CUTOFF') return;
        heartbeatTimedOut = error.code === 'COACH_HEARTBEAT_TIMEOUT';
        if (accepted) throw error;
        // #192 S2b: the null-identity branch above already resolved this attempt's
        // termination when a later step in it threw (e.g. fenceCurrentGeneration()
        // rejecting with a non-STALE_GENERATION error). Reuse that result instead of
        // invoking terminate() a second time for the same failure. #192 I3: when it has
        // not, terminateCoachAttempt() shares any concurrent caller's in-flight call.
        const termination = terminationOutcome ?? await terminateCoachAttempt(record);
        if (coachWorkSuspended()) return;
        // Only the boolean confirmation authorizes replacement. `reason` is diagnostic,
        // never a hidden success signal.
        if (termination?.confirmed !== true) {
          if (!heartbeatTimedOut) {
            try {
              await runCoachBeforeResultCutoff([
                'fence',
                '--owner', owner,
                '--hand', String(handNo),
                '--generation', String(currentDescriptor.generation),
                '--reason', 'termination-unconfirmed',
              ]);
            } catch (fenceError) {
              // heartbeat may retire this exact generation while terminate() is still
              // pending. STALE_GENERATION then means there is no live generation left to
              // fence; it must not skip the fail-closed adapter transition below.
              if (fenceError.code !== 'STALE_GENERATION') throw fenceError;
              log('coach-fence-already-retired', {
                handNo,
                generation: currentDescriptor.generation,
              });
            }
          }
          await runCoachBeforeResultCutoff([
            'adapter-disable',
            '--owner', owner,
            '--reason', 'termination-unconfirmed',
          ]);
          coachAdapterDisabled = true;
          await completeCoachUnavailable({
            owner,
            handNo,
            generation: currentDescriptor.generation,
            reason: 'termination-unconfirmed',
            fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
          });
          return;
        }
        // #192 S3: a confirmed termination that originated inside the null-identity branch
        // (fenceCurrentGeneration() or a later step in that branch threw) is not an ordinary
        // confirmed failure — it is the exact same identity-unavailable condition the branch
        // itself would have sealed as unavailable had its own fence call succeeded. It must
        // never fall through to the attempt===1 replacement below; seal it here instead.
        if (identityUnavailableReason !== null) {
          await completeCoachUnavailable({
            owner,
            handNo,
            generation: currentDescriptor.generation,
            reason: identityUnavailableReason,
            fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
          });
          return;
        }
        if (coachWorkSuspended()) return;
        if (attempt === 1) {
          if (!coachReplacementAllowed()) {
            appendNotice(`핸드 ${handNo} 코치 교체 예산(5초)이 남지 않아 고정 문구로 대체합니다.`);
            await completeCoachUnavailable({
              owner,
              handNo,
              generation: currentDescriptor.generation,
              reason: 'finalize-no-replacement-budget',
              fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
            });
            return;
          }
          try {
            if (coachWorkSuspended()) return;
            descriptor = await reserveCoach(owner, handNo, 2, inputs.stats.path);
          } catch (reserveError) {
            if (reserveError.code !== 'ADAPTER_DISABLED') throw reserveError;
            coachAdapterDisabled = true;
            try {
              await runCoachBeforeResultCutoff([
                'fence',
                '--owner', owner,
                '--hand', String(handNo),
                '--generation', String(currentDescriptor.generation),
                '--reason', 'adapter-disabled-before-attempt-2',
              ]);
            } catch (fenceError) {
              if (fenceError.code !== 'STALE_GENERATION') throw fenceError;
            }
            await completeCoachUnavailable({
              owner,
              handNo,
              generation: currentDescriptor.generation,
              reason: 'adapter-disabled-before-attempt-2',
              fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
            });
            return;
          }
          continue;
        }
        await completeCoachUnavailable({
          owner,
          handNo,
          generation: currentDescriptor.generation,
          reason: error.code ?? 'invalid-coach-output',
          fallbackEnvelopePath: currentDescriptor.exactEnvelopePath,
        });
        return;
      }
      // No `finally` here: every return/throw/continue path above already routed its
      // termination result (if any) through settleCoachAttemptRecord. A record survives
      // this attempt exactly when its last known termination was unconfirmed, so a later
      // terminate (heartbeat remediation, finalize cutoff, persisted reclaim) can still
      // confirm and remove it.
    }
  };

  const trackCoachTask = (handNo, work) => {
    let task;
    task = Promise.resolve()
      .then(() => (typeof work === 'function' ? work() : work))
      .catch((error) => {
        appendNotice(`핸드 ${handNo} 코치 파이프라인 오류: ${error.code ?? 'ERROR'}`);
        log('coach-error', { handNo, code: error.code ?? 'ERROR' });
      })
      .finally(() => coachTasks.delete(task));
    coachTasks.add(task);
    return task;
  };

  const launchCoachPipeline = (handNo, options = {}) => (
    trackCoachTask(handNo, () => coachPipeline(handNo, options))
  );

  const publishQueuedCoachHand = async (handNo) => {
    const exactEnvelopePath = coachEnvelopePathFor(handNo);
    if (exactEnvelopePath && !coachPublicationDeferred()) await executeCoachPublish(handNo, exactEnvelopePath);
  };

  const drainQueuedCoachPublications = async ({ reconcileOnly = false } = {}) => {
    const attemptPath = path.join(root, '.publish-attempt.json');
    // begin-owner also reconciles under the authority lock, but keep this boundary
    // explicit: no queued envelope may reach the network before the latest snapshot has
    // had a reconcile-only chance to prove it was already published.
    await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
    for (;;) {
      const auth = readCoachAuthority();
      const queued = Object.values(auth?.publishQueue ?? {})
        .sort((left, right) => left.handNo - right.handNo)[0];
      if (!queued) return;
      if (reconcileOnly) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${queued.handNo} 코치 Q의 reconcile 증명을 아직 확인하지 못했습니다.`,
        );
      }
      if (fs.existsSync(attemptPath)) {
        let attemptedCoachQueueId = null;
        try {
          const record = JSON.parse(fs.readFileSync(attemptPath, 'utf8'));
          if (typeof record?.coachAuthority?.queueId === 'string') {
            attemptedCoachQueueId = record.coachAuthority.queueId;
          }
        } catch {
          // publish.js owns malformed/stale attempt classification and recovery codes.
        }
        // The recorded body owns the current publishId regardless of which queued hand
        // supplied --from. Retry it first, then re-read authority before choosing a Q.
        await executePublish(['--from', queued.exactEnvelopePath, '--retry']);
        await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
        if (attemptedCoachQueueId) {
          const pending = Object.values(readCoachAuthority()?.publishQueue ?? {})
            .find((item) => item.queueId === attemptedCoachQueueId);
          if (pending) {
            throw codedError(
              'COACH_RECONCILE_PENDING',
              `핸드 ${pending.handNo} 코치 게시는 응답했지만 reconcile 증명을 확인하지 못했습니다.`,
            );
          }
        }
        continue;
      }
      await executeCoachPublish(queued.handNo, queued.exactEnvelopePath);
      let remaining = readCoachAuthority()?.publishQueue?.[String(queued.handNo)];
      if (remaining?.queueId === queued.queueId) {
        await runCoach(['reconcile', '--snapshot-file', coachSnapshotPath]);
        remaining = readCoachAuthority()?.publishQueue?.[String(queued.handNo)];
      }
      if (remaining?.queueId === queued.queueId) {
        throw codedError(
          'COACH_RECONCILE_PENDING',
          `핸드 ${queued.handNo} 코치 Q 게시 후 reconcile 증명을 확인하지 못했습니다.`,
        );
      }
    }
  };

  const beginCoachOwner = async (completed, { drainQueued = true } = {}) => {
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') throw codedError('NO_COACH_OWNER', '코치 ownerSessionId가 없습니다.');
    const reconcileOnly = readLoopState()?.halt?.code === 'COACH_RECONCILE_PENDING';
    const stats = await captureCoachStats('owner', { beforeResultCutoff: true });
    const begun = await runCoachBeforeResultCutoff([
      'begin-owner',
      '--owner', owner,
      '--completed', String(completed),
      '--stats-file', stats.path,
      '--snapshot-file', coachSnapshotPath,
      '--spawn-evidence', '1',
    ]);
    if (begun.adapterState === 'disabled' || begun.adapterState === 'unavailable') {
      coachAdapterDisabled = true;
    }
    // begin-owner has already reconciled the snapshot and atomically selected missing
    // descriptors. Existing owner-neutral Q must become visible before any new worker or
    // turn publication can overtake it; sealedSkipped is never a spawn list.
    if (drainQueued) {
      try {
        await drainQueuedCoachPublications({ reconcileOnly });
      } catch (error) {
        if (error.code === 'COACH_RECONCILE_PENDING') {
          writeLoopState({
            halt: {
              code: 'COACH_RECONCILE_PENDING',
              message: error.message,
            },
          });
        }
        throw error;
      }
      if (readLoopState()?.halt?.code === 'COACH_RECONCILE_PENDING') {
        writeLoopState({ halt: undefined });
      }
    }
    for (const descriptor of begun.descriptors ?? []) {
      if (stopRequested) break;
      const hand = await captureCoachHand(descriptor.handNo, { beforeResultCutoff: true });
      if (stopRequested) break;
      const replay = await captureCoachReplay(descriptor.handNo, { beforeResultCutoff: true });
      if (stopRequested) break;
      launchCoachPipeline(descriptor.handNo, {
        descriptor,
        prepared: { hand, replay, stats },
      });
    }
    for (const handNo of begun.unavailableSealed ?? []) {
      if (stopRequested) break;
      trackCoachTask(handNo, () => publishQueuedCoachHand(handNo));
    }
    return begun;
  };

  const fenceHeartbeatGeneration = async (owner, action, reason, { beforeResultCutoff = false } = {}) => {
    try {
      const runner = beforeResultCutoff ? runCoachBeforeResultCutoff : runCoach;
      await runner([
        'fence',
        '--owner', owner,
        '--hand', String(action.handNo),
        '--generation', String(action.generation),
        '--reason', reason,
      ]);
    } catch (error) {
      if (error.code !== 'STALE_GENERATION') throw error;
    }
  };

  const remediateHeartbeatAction = async (owner, action) => {
    assertBeforeResultWaitCutoff();
    const record = coachAttempts.get(coachAttemptKey(action.handNo, action.generation));
    if (action.action === 'timeout-fence') {
      if (record) record.interrupt();
      else {
        await completeCoachUnavailable({
          owner,
          handNo: action.handNo,
          generation: action.generation,
          reason: 'heartbeat-timeout',
        });
      }
      return;
    }
    if (action.action !== 'result-ready') return;

    let accepted = false;
    try {
      const deny = writeCoachDeny(action.handNo);
      const replayRaw = fs.existsSync(coachReplayPath(action.handNo))
        ? fs.readFileSync(coachReplayPath(action.handNo), 'utf8')
        : (await captureCoachReplay(action.handNo, { beforeResultCutoff: true })).raw;
      validateCoachNote(fs.readFileSync(action.exactResultPath, 'utf8'), action.handNo, {
        forbiddenDetailed: coachForbiddenDetailed(action.handNo),
        replay: parseCapturedHand(replayRaw),
      });
      // #192 E3 f: a `result-ready` heartbeat action only ever targets a result file the
      // pipeline itself wrote after `handle.done` resolved — same closed-child evidence.
      await runCoachBeforeResultCutoff([
        'accept',
        '--owner', owner,
        '--hand', String(action.handNo),
        '--generation', String(action.generation),
        '--forbidden-file', deny.path,
        '--accept-evidence', 'closed-child',
      ]);
      accepted = true;
      await publishQueuedCoachHand(action.handNo);
    } catch (error) {
      if (error.code === 'DEFER_COACH_OUTPUT') {
        writeJsonAtomic(action.exactResultPath, error.note);
        await runCoachBeforeResultCutoff([
          'defer',
          '--owner', owner,
          '--hand', String(action.handNo),
          '--generation', String(action.generation),
          '--note-file', action.exactResultPath,
        ]);
        return;
      }
      if (!record) throw error;
      // #192 I3: shared with any concurrent caller for this exact record.
      const termination = await terminateCoachAttempt(record);
      if (accepted) {
        if (termination?.confirmed !== true) {
          await runCoachBeforeResultCutoff([
            'adapter-disable',
            '--owner', owner,
            '--reason', 'result-ready-termination-unconfirmed',
          ]);
          coachAdapterDisabled = true;
        }
        record.interrupt('COACH_RESULT_ACCEPTED');
        throw error;
      }
      await fenceHeartbeatGeneration(owner, action, 'result-ready-accept-failed', { beforeResultCutoff: true });
      if (termination?.confirmed !== true) {
        await runCoachBeforeResultCutoff([
          'adapter-disable',
          '--owner', owner,
          '--reason', 'result-ready-termination-unconfirmed',
        ]);
        coachAdapterDisabled = true;
      }
      await completeCoachUnavailable({
        owner,
        handNo: action.handNo,
        generation: action.generation,
        reason: error.code ?? 'result-ready-accept-failed',
      });
      record.interrupt('COACH_RESULT_ACCEPTED');
      return;
    }

    if (record) {
      // #192 I3: shared with any concurrent caller for this exact record.
      const termination = await terminateCoachAttempt(record);
      if (termination?.confirmed !== true) {
        await runCoachBeforeResultCutoff([
          'adapter-disable',
          '--owner', owner,
          '--reason', 'result-ready-termination-unconfirmed',
        ]);
        coachAdapterDisabled = true;
      }
      record.interrupt('COACH_RESULT_ACCEPTED');
    }
  };

  const flushDeferredCoachNotes = async ({ finalizing = false } = {}) => {
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') return;
    const auth = readCoachAuthority();
    const sealFlushFailure = async (handNo, entry, reason) => {
      await completeCoachUnavailable({
        owner,
        handNo,
        generation: entry?.generation,
        reason,
        fallbackEnvelopePath: entry?.exactEnvelopePath ?? null,
        replaceDeferred: true,
      });
    };
    for (const [key, entry] of Object.entries(auth?.deferred ?? {})) {
      if (stopRequested) return;
      const handNo = Number(key);
      const note = entry?.note ?? entry;
      let replayRaw;
      try {
        replayRaw = fs.existsSync(coachReplayPath(handNo))
          ? fs.readFileSync(coachReplayPath(handNo), 'utf8')
          : (await captureCoachReplay(handNo, { beforeResultCutoff: true })).raw;
      } catch (error) {
        if (finalizing) await sealFlushFailure(handNo, entry, error.code ?? 'deferred-replay-missing');
        continue;
      }
      try {
        validateCoachNote(JSON.stringify(note), handNo, {
          forbiddenDetailed: coachForbiddenDetailed(handNo),
          replay: parseCapturedHand(replayRaw),
        });
      } catch (error) {
        if (error.code === 'DEFER_COACH_OUTPUT' && !finalizing) continue;
        if (finalizing) {
          await sealFlushFailure(handNo, entry, error.code ?? 'deferred-flush-failed');
          continue;
        }
        if (error.code === 'INVALID_COACH_OUTPUT' || error.code === 'DEFER_COACH_OUTPUT') continue;
        throw error;
      }
      const live = readCoachAuthority()?.hands?.[key];
      let generation = entry.generation ?? live?.generation;
      let resultPath = entry.exactResultPath ?? live?.exactResultPath;
      let envelopePath = entry.exactEnvelopePath ?? live?.exactEnvelopePath;
      // #192 E3 f: a deferred note is always the record of an already-closed child. If the
      // live generation still matches, this accept reuses that same closed-child evidence;
      // if it doesn't (the generation below was reserved fresh, with no child spawned for
      // it), the evidence is `no-spawn` instead.
      let acceptEvidence = 'closed-child';
      if (!live || live.generation !== generation) {
        const stats = await captureCoachStats(handNo, { beforeResultCutoff: true });
        const reserved = await reserveCoach(owner, handNo, 1, stats.path);
        generation = reserved.generation;
        resultPath = reserved.exactResultPath;
        envelopePath = reserved.exactEnvelopePath;
        acceptEvidence = 'no-spawn';
      }
      writeJsonAtomic(resultPath, note);
      const deny = writeCoachDeny(handNo);
      await runCoachBeforeResultCutoff([
        'accept',
        '--owner', owner,
        '--hand', String(handNo),
        '--generation', String(generation),
        '--forbidden-file', deny.path,
        '--accept-evidence', acceptEvidence,
      ]);
      if (!coachPublicationDeferred()) await executeCoachPublish(handNo, envelopePath);
    }
  };

  const heartbeatCoach = async () => {
    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') return;
    // A fresh game has no authority until its first reserve/unavailable seal. There is
    // nothing to heartbeat before then, and manufacturing it during bootstrap would make
    // game startup depend on the publication lock.
    if (!fs.existsSync(coachAuthorityPath)) return;
    const heartbeat = await runCoachBeforeResultCutoff(['heartbeat', '--owner', owner]);
    if (stopRequested) return;
    await flushDeferredCoachNotes({
      finalizing: readLoopState()?.phase === 'finalizing',
    });
    const latest = readCoachAuthority();
    for (const action of heartbeat.actions ?? []) {
      if (stopRequested) break;
      const key = String(action.handNo);
      if (action.action === 'result-ready' && (
        latest?.deferred?.[key] || latest?.publishQueue?.[key] || latest?.publishedSeals?.[key]
      )) {
        continue;
      }
      log('coach-heartbeat', {
        handNo: action.handNo,
        action: action.action,
        generation: action.generation,
      });
      trackCoachTask(action.handNo, () => remediateHeartbeatAction(owner, action));
    }
  };

  const settleCoachTasks = async (deadlineNs) => {
    for (;;) {
      if (coachTasks.size === 0) return true;
      const remaining = remainingMsUntil(deadlineNs);
      if (remaining <= 0) return false;
      await settleOrTimeout(Promise.allSettled([...coachTasks]), remaining);
    }
  };

  // §9.2 (3): the sidecar owns termination; coach-control only records the boolean the
  // sidecar proves here. Only a positive confirmation authorizes an open review gate —
  // an unconfirmed worker is fenced and disables the adapter exactly as in play time.
  const terminateLiveCoachGenerations = async (owner, deadlineNs) => {
    const records = [...coachAttempts.values()];
    const outcomes = await Promise.all(records.map(async (record) => {
      // #192 I3: shares the in-flight termination with any other concurrent caller for this
      // exact record (e.g. the pipeline's own null-identity branch) instead of invoking
      // `terminate()` a second time. `settleCoachAttemptRecord` is applied inside
      // `terminateCoachAttempt` itself, using the real eventual result rather than the
      // deadline-bounded boolean this call alone observes.
      const invocation = terminateCoachAttempt(record);
      const settled = await settleValueBeforeDeadline(invocation, deadlineNs);
      if (settled.error) {
        log('finalize-terminate-error', {
          handNo: record.handNo,
          code: settled.error.code ?? 'ERROR',
        });
      }
      const confirmed = settled.settled && !settled.error && settled.value?.confirmed === true;
      return { record, confirmed };
    }));

    let confirmed = true;
    for (const outcome of outcomes) {
      if (!outcome.confirmed) confirmed = false;
      outcome.record.interrupt('COACH_FINALIZE_CUTOFF');
    }
    if (!confirmed && remainingMsUntil(deadlineNs) > 0) {
      for (const outcome of outcomes.filter((row) => !row.confirmed)) {
        await fenceHeartbeatGeneration(
          owner,
          { handNo: outcome.record.handNo, generation: outcome.record.generation },
          'finalize-termination-unconfirmed',
        );
      }
      await runCoach([
        'adapter-disable',
        '--owner', owner,
        '--reason', 'finalize-termination-unconfirmed',
      ]);
      coachAdapterDisabled = true;
    }
    const tasksSettled = await settleCoachTasks(deadlineNs);
    return confirmed
      && tasksSettled
      && coachAttempts.size === 0
      && coachTasks.size === 0;
  };

  const haltFinalization = (code, message, extra = {}) => {
    appendNotice(message);
    writeLoopState({ halt: { code, message, ...extra } });
    log('finalize-halt', { code });
    return codedError(code, message, extra);
  };

  const persistedCoachRecovery = ({ owner, unresolved }) => {
    const commands = unresolved.flatMap((attempt) => {
      if (attempt.handNo == null || attempt.generation == null) return [];
      const base = [
        COACH_CLI, 'cleanup-result',
        '--owner', owner,
        '--hand', String(attempt.handNo),
        '--generation', String(attempt.generation),
        '--cleanup-state', 'released',
      ];
      // #192 J5/K1: a `LEGACY_RUNTIME_PROCESS_PRESENT` row already named its candidate pids
      // (see `unresolvedEvidenceGuidance`). The correct recovery action there is to stop
      // those processes and resume, never a `cleanup-result` command. This holds for a
      // write-authorized row too, so the check runs before the authorized branch and no
      // command is emitted at all.
      if (attempt.reason === 'LEGACY_RUNTIME_PROCESS_PRESENT') return [];
      if (attempt.cleanupAuthorized) {
        return [{ program: process.execPath, args: [...base, '--game-dir', root] }];
      }
      // #192 O1/L1/J5: a genuinely foreign row (its own ownerSessionId differs from the
      // current owner, and it is not cleanupEligible — e.g. a legacy row judgment g could
      // not auto-recover) gets a recovery command naming its actual owner — mirrors
      // coach-control.js's recordCleanup `--row-owner` escape hatch, which the loop itself
      // never runs on its own. `cleanupAuthorized` can also be false for a *same*-owner row
      // whose write attempt itself failed for an unrelated reason (e.g. FENCE_CHILD_FAILED)
      // — that is not a foreign-row case, and must not fabricate a `--row-owner` command
      // for it.
      if (
        typeof attempt.ownerSessionId === 'string'
        && attempt.ownerSessionId
        && attempt.ownerSessionId !== owner
      ) {
        // #192 J5: never pre-fill `--operator-confirmed 1` — that would let an operator run
        // the emitted command verbatim without ever having verified that no coach CLI
        // process of this game remains. `requiresOperatorConfirmation` flags the command so
        // the halt message can say so; the operator must append the flag themselves.
        return [{
          program: process.execPath,
          args: [
            ...base,
            '--row-owner', attempt.ownerSessionId,
            '--game-dir', root,
          ],
          requiresOperatorConfirmation: true,
        }];
      }
      return [];
    });
    return {
      code: 'COACH_HANDLE_UNRESOLVED',
      owner,
      attempts: unresolved,
      prerequisites: {
        authenticatedServerLock: true,
        sessionToken: readLoopState()?.sessionToken ?? null,
      },
      commands,
      ...(commands.some((cmd) => cmd.requiresOperatorConfirmation === true)
        ? { requiresOperatorConfirmation: true }
        : {}),
    };
  };

  const haltForPersistedCoachRecovery = ({ owner, unresolved }) => {
    const recovery = persistedCoachRecovery({ owner, unresolved });
    const commands = recovery.commands;
    const base = commands.length > 0
      ? 'persisted 코치 handle identity를 확인할 수 없어 owner 교대를 중단합니다. 같은 sessionToken의 인증 server lock을 복구하고 halt.recovery.commands를 검토·실행한 뒤 resume하세요.'
      : 'persisted 코치 handle identity와 cleanup owner를 확인할 수 없어 owner 교대를 중단합니다. authority 수동 복구가 필요합니다.';
    // #192 D5: append operator guidance that distinguishes a row whose spawn sidecar shows
    // `intent` (a spawn may genuinely have happened) from a row with no evidence at all
    // (legacy pre-stamp, or a synthetic authority-level failure row) — each needs a
    // different manual check before resuming.
    const guidance = unresolvedEvidenceGuidance(unresolved);
    // #192 J5: when at least one emitted command still needs `--operator-confirmed 1`
    // appended by hand, say so explicitly — the command itself deliberately no longer
    // carries that flag pre-filled.
    const confirmationNote = recovery.requiresOperatorConfirmation
      ? '--row-owner 명령에는 --operator-confirmed 1이 빠져 있습니다. 이 게임의 coach CLI 자식이 남아있지 않은지 확인한 뒤 그 값을 추가해 실행하세요.'
      : null;
    const message = [base, guidance, confirmationNote].filter(Boolean).join(' ');
    appendNotice(message);
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed: false,
          reason: 'persisted_worker_unresolved',
          reviewGate: 'closed',
        },
        recovery,
      },
      halt: { code: 'FINALIZATION_ABORTED', message, recovery },
    });
    log('finalize-halt', { code: 'FINALIZATION_ABORTED', reason: 'persisted_worker_unresolved' });
    return codedError('FINALIZATION_ABORTED', message, { recovery });
  };

  const haltForPlayingCoachRecovery = ({ owner, unresolved }) => {
    const recovery = persistedCoachRecovery({ owner, unresolved });
    const base = recovery.commands.length > 0
      ? 'persisted 코치 handle identity를 확인할 수 없어 playing owner 교대를 중단합니다. 인증 server lock 아래 cleanup-result를 검토·실행한 뒤 resume하세요.'
      : 'persisted 코치 authority 또는 handle을 확인할 수 없어 playing owner 교대를 중단합니다. 수동 복구가 필요합니다.';
    // #192 D5: same intent-vs-no-evidence guidance as haltForPersistedCoachRecovery.
    const guidance = unresolvedEvidenceGuidance(unresolved);
    // #192 J5: same operator-confirmation note as haltForPersistedCoachRecovery.
    const confirmationNote = recovery.requiresOperatorConfirmation
      ? '--row-owner 명령에는 --operator-confirmed 1이 빠져 있습니다. 이 게임의 coach CLI 자식이 남아있지 않은지 확인한 뒤 그 값을 추가해 실행하세요.'
      : null;
    const message = [base, guidance, confirmationNote].filter(Boolean).join(' ');
    appendNotice(message);
    writeLoopState({ halt: { code: 'COACH_HANDLE_UNRESOLVED', message, recovery } });
    log('resume-halt', { code: 'COACH_HANDLE_UNRESOLVED' });
    return codedError('COACH_HANDLE_UNRESOLVED', message, { recovery });
  };

  const clearPlayingCoachRecoveryHalt = () => {
    if (readLoopState()?.halt?.code === 'COACH_HANDLE_UNRESOLVED') {
      writeLoopState({ halt: undefined });
    }
  };

  const baseFinalizationCheckpoint = () => ({
    startedAt: finalizationDeadlineStartedAt ?? isoNow(now),
    budgetMs: finalizeBudgetMs,
    resultWaitMs: finalizeBudgetMs - finalizeCutoffLeadMs,
  });

  const enterReviewGenerationScope = async (completed) => {
    // The 20-second coach-cutoff budget ends at the open review gate. Evaluator and
    // synthesizer calls in Task 7B own independent 300-second generation deadlines.
    finalizationDeadlineNs = null;
    finalizationDeadlineStartedAt = null;
    finalizeResultWaitCutoffNs = null;
    publishDeadlineNs = null;
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        deadlineScope: 'review_generation',
        reviewGenerationTimeoutMs: REVIEW_GENERATION_MS,
      },
    });
    await opts.reviewGateCheckpoint?.();
    // A fresh child after the reset is the handoff proof: it must not inherit the expired
    // cutoff supervisor timeout, and it revalidates the durable authority gate for 7B.
    const handoff = await runCoach(['completeness', '--completed', String(completed)]);
    if (handoff.reviewGateOpen !== true) {
      throw haltFinalization(
        'REVIEW_GATE_CLOSED',
        'Task 7B handoff에서 코치 completeness review gate를 재확인하지 못했습니다.',
      );
    }
    const refreshed = readLoopState()?.finalization ?? {};
    writeLoopState({
      finalization: {
        ...refreshed,
        reviewHandoff: { at: isoNow(now), reviewGateOpen: true },
      },
    });
    return handoff;
  };

  const validateReviewOutput = (raw, { requireHeadings = false } = {}) => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw codedError('EMPTY_REVIEW_OUTPUT', '리뷰 모델 출력이 비어 있습니다.');
    }
    const text = raw.trim();
    if (!referenceClaimAllowed(text)) {
      throw codedError('REVIEW_CLAIM_REJECTED', '리뷰 출력이 근거 범위를 벗어납니다.');
    }
    if (requireHeadings && REVIEW_HEADING_PATTERNS.some((pattern) => !pattern.test(text))) {
      throw codedError('REVIEW_HEADINGS_MISSING', '종합 리뷰에 필수 한국어 heading 네 개가 없습니다.');
    }
    return text;
  };

  const terminateReviewAttempt = async (handle) => {
    if (!handle) return { confirmed: true, reason: 'NOT_SPAWNED' };
    if (typeof handle.terminate !== 'function') {
      return { confirmed: false, reason: 'TERMINATE_UNAVAILABLE' };
    }
    try {
      const result = await handle.terminate();
      return result && typeof result === 'object'
        ? result
        : { confirmed: false, reason: 'BAD_TERMINATE_RESULT' };
    } catch (error) {
      return { confirmed: false, reason: error.code ?? 'TERMINATE_FAILED' };
    }
  };

  const runReviewStage = async ({ stage, prompt, requireHeadings = false }) => {
    // Only static instructions cross attempts; rejected output and error messages
    // remain private diagnostics and can never become a subsequent model input.
    const corrections = new Map([
      ['EMPTY_REVIEW_OUTPUT', '빈 출력이 거절되었습니다. 요청한 한국어 평가 본문을 작성하세요.'],
      ['REVIEW_CLAIM_REJECTED', '근거 범위를 벗어난 주장이 감지되었습니다. 최적·정답·GTO·확정 누수·EV 주장을 피하고 관측 사실과 정성적 과정 평가만 작성하세요. 한계는 "공개 정보에 근거한 정성적 과정 평가입니다."처럼 표현하세요.'],
      ['REVIEW_HEADINGS_MISSING', '필수 제목이 누락되었습니다. 원래 요청에 명시된 한국어 제목 네 개를 모두 포함하세요.'],
    ]);
    let correctionCode = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      let handle = null;
      let failure = null;
      let raw;
      try {
        handle = upperAdapter.oneshotStart({
          tier: 'upper',
          prompt: correctionCode
            ? `${prompt}\n\n교정 안내 (${correctionCode}): ${corrections.get(correctionCode)}`
            : prompt,
          timeoutMs: REVIEW_GENERATION_MS,
        });
        if (!handle || !handle.done || typeof handle.done.then !== 'function') {
          throw codedError('INVALID_REVIEW_HANDLE', `${stage} oneshot handle 계약이 올바르지 않습니다.`);
        }
        const completed = await handle.done;
        raw = completed?.raw;
        return validateReviewOutput(raw, { requireHeadings });
      } catch (error) {
        if (error?.code === 'CLI_FAILED' && error?.exitCode === 0 && error?.outputKind === 'empty') {
          raw = '';
          failure = codedError('EMPTY_REVIEW_OUTPUT', '리뷰 모델 출력이 비어 있습니다.');
        } else failure = error;
      }

      // Each failed attempt owns a distinct child and distinct 300-second adapter timer.
      // A second child may start only after the first child has positively terminated.
      const termination = await terminateReviewAttempt(handle);
      const secrets = [readLoopState()?.sessionToken];
      correctionCode = corrections.has(failure?.code) ? failure.code : null;
      log('review-attempt-failed', {
        stage,
        attempt,
        code: failure?.code ?? 'ERROR',
        message: sanitizeReviewDiagnostic(failure?.message, secrets, 512),
        terminationConfirmed: termination.confirmed === true,
        retryCorrectionCode: attempt === 1 && termination.confirmed === true ? correctionCode : null,
        ...preserveReviewFailure(root, { stage, attempt, raw, secrets }),
      });
      if (termination.confirmed !== true) {
        throw codedError(
          'REVIEW_TERMINATION_UNCONFIRMED',
          `${stage} ${attempt}번째 시도 종료를 확인하지 못해 리뷰를 중단합니다.`,
          { cause: failure, stage, attempt },
        );
      }
      if (attempt === 1) continue;
      throw codedError(
        'REVIEW_ATTEMPTS_EXHAUSTED',
        `${stage} 출력이 두 번 모두 계약을 만족하지 못했습니다.`,
        { cause: failure, stage, terminationConfirmed: true },
      );
    }
    throw codedError('REVIEW_ATTEMPTS_EXHAUSTED', `${stage} 시도를 완료하지 못했습니다.`);
  };

  const buildEvaluatorPrompt = ({ completed, processInput }) => [
    '역할: 격리 evaluator',
    '아래 인라인 입력만 사용하고 파일·도구·네트워크를 조회하지 마라.',
    '각 결정 시점에 사용자가 볼 수 있었던 공개 정보만으로 과정 품질을 한국어로 평가하라.',
    '실제 게임 결과와 players.json/상대 아키타입은 제공되지 않았으며 추측하거나 언급하지 마라.',
    '표본이 30핸드 미만이면 반드시 참고용이라고 명시하라.',
    ...(trainingOn ? [
      '',
      'training aggregate (qualified reference grades = exactComparable only, independent of chip result; projected references are ungraded):',
      JSON.stringify(trainingAggregate(root)),
    ] : []),
    '',
    `completed hands: ${completed}`,
    'decision-time process input:',
    JSON.stringify(eligibleProcessInput(processInput)),
    '',
    '정성적 과정 평가만 제공한다. 검증된 최적·확정 누수·정답이나 EV 수치를 주장하지 마라.',
    '출력은 비어 있지 않은 한국어 과정 평가 본문만 작성하라.',
  ].join('\n');

  const exploitReveal = (players) => Object.entries(modelsFromPlayers(players, {
    derived: readDerivedPolicyConfigs(root),
  })).map(([playerId, model]) => ({
    playerId,
    opponentModelId: model.opponentModelId,
    policyVersion: model.policyVersion,
    deviations: (model.deviations ?? []).map((row) => ({
      street: row.selector?.street ?? null,
      from: row.from,
      to: row.to,
    })),
  }));

  const outcomeRecord = (record) => {
    const out = {};
    for (const key of [
      'handNo', 'board', 'endStacks', 'pots', 'showdown', 'folded', 'allIn', 'uncalledReturns',
      'holes', 'positions', 'actions',
    ]) {
      if (Object.hasOwn(record ?? {}, key)) out[key] = structuredClone(record[key]);
    }
    return out;
  };

  const buildSynthesizerPrompt = ({ evaluator, result, outcomeRecords, playersRaw, exploitRaw, selfOpponentsRaw }) => [
    '역할: 종합자',
    '아래 인라인 입력만 사용하고 파일·도구·네트워크를 조회하지 마라.',
    'evaluator의 결과 독립적 과정 평가를 보존한 뒤 게임 결과와 실제 AI 아키타입을 분리해 해석하라.',
    '결과가 좋았다고 나쁜 과정을 칭찬하거나 결과가 나쁘다고 좋은 과정을 비난하지 마라.',
    '정성적 과정 코칭만 제공한다. 검증된 최적·확정 누수·정답이나 EV 수치를 주장하지 마라.',
    '',
    'evaluator output:',
    evaluator,
    '',
    'game result:',
    JSON.stringify({ result }),
    '',
    'replay outcome records (핸드 종료 후 공개 범위, provided only after evaluator completion):',
    JSON.stringify(outcomeRecords),
    '',
    'players.json:',
    playersRaw,
    '',
    'exploit policies (post-game only, heuristic, no EV):',
    exploitRaw ?? '[]',
    '',
    'selfOpponents:',
    selfOpponentsRaw ?? 'null',
    '',
    "self-mirror 좌석이 있으면 '각 AI의 실제 아키타입 공개' 절에서 어느 좌석이 사용자 복제였는지와 사용자가 그것을 알아챘을 만한 단서를 평가하라. 수치는 selfOpponents의 것만 인용하고 유사도를 실력으로 해석하지 마라.",
    '',
    '마크다운 본문에 다음 네 heading을 모두 그대로 포함하라:',
    '## 내 성향 통계',
    '## 결정적 핸드 2~3개 리플레이',
    '## 각 AI의 실제 아키타입 공개 + 읽기 평가',
    '## 다음 게임에서 연습할 것',
    '마지막 항목에는 다음 게임에서 연습할 것 1~2가지를 제시하라.',
  ].join('\n');

  const machineReview = ({ statsRaw, players, result }) => {
    const stats = JSON.parse(statsRaw).perPlayer;
    const user = stats?.user;
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? String(value) : '확인 불가';
    const percent = (value, sample) => Number.isFinite(value) && value >= 0 && value <= 1 && sample > 0
      ? `${(100 * value).toFixed(1)}%` : '표본 없음';
    const chips = Number.isSafeInteger(user?.net)
      ? `${user.net > 0 ? '+' : ''}${user.net}칩` : '확인 불가';
    const labels = { TAG: '신중한 공격형 (TAG)', LAG: '폭넓은 공격형 (LAG)', Nit: '매우 신중한 유형 (Nit)',
      CallingStation: '콜을 선호하는 유형 (CallingStation)', Maniac: '매우 공격적인 유형 (Maniac)',
      Trickster: '변화를 섞는 유형 (Trickster)',
      SelfMirror: '나를 닮은 복제 상대 (self-mirror)',
      SelfExploiter: '나를 공략하는 상대 (self-exploiter)' };
    const names = sanitizePlayersForReview(players, {
      gameOver: true, derived: readDerivedPolicyConfigs(root),
    })
      .filter((player) => player.playerId !== 'user').map((player) => {
        const observed = stats?.[player.playerId];
        const name = String(player.name ?? '이름 미확인').replace(/[\\`*_[\]<>|\r\n]/g, ' ');
        return `- ${name} — 설정된 성향: ${labels[player.archetype] ?? '확인 불가'}. `
          + `관찰 기록: ${count(observed?.sample)}핸드, 자발적 참여 ${percent(observed?.vpip, observed?.sample)}, `
          + `프리플롭 레이즈 ${percent(observed?.pfr, observed?.sample)}.`;
      });
    const resultText = { completed: '예정 핸드 완료', abort: '중단', win: '승리', lose: '패배' }[result] ?? '종료';
    return [
      '## 내 성향 통계', '',
      `- 플레이한 핸드: ${count(user?.sample)}핸드`,
      `- 자발적 프리플롭 참여: ${percent(user?.vpip, user?.sample)}`,
      `- 프리플롭 레이즈: ${percent(user?.pfr, user?.sample)}`,
      `- 칩 증감: ${chips}`,
      `- 게임 결과: ${resultText}`, '',
      '이 값은 이번 세션의 관찰 기록입니다. 실력이나 전략의 우열을 판정하지 않습니다.', '',
      '## 결정적 핸드 2~3개 리플레이', '',
      'LLM 설명을 제공할 수 없습니다. 결정적 핸드 선정과 과정 해설은 생성하지 않았습니다. 핸드별 기록과 지원 범위 내 휴리스틱 기준표 비교를 확인하세요.', '',
      '## 각 AI의 실제 아키타입 공개 + 읽기 평가', '',
      '설정된 성향은 게임 시작 시의 정책 설정입니다. 아래 관찰 기록만으로 그 성향이 입증되거나 상대 읽기가 정확했다고 판단할 수는 없습니다.',
      ...(names.length ? names : ['AI 성향 기록을 확인할 수 없습니다.']), '',
      '## 다음 게임에서 연습할 것', '',
      '이 자동 요약만으로는 개별 연습 목표를 확정할 근거가 부족합니다. 학습 페이지에서 지원되는 결정과 제외 이유를 먼저 확인하세요.',
    ].join('\n');
  };

  const appendTrainingPendingToReview = (text) => {
    let section = '';
    try {
      const players = readJsonOptional(playersPath, 'PLAYERS') ?? [];
      section = buildSelfOpponentSection({
        root,
        players,
        derived: readDerivedPolicyConfigs(root),
      });
    } catch (error) {
      section = `자기 상대 비교를 만들지 못했습니다 (${error.code ?? 'ERROR'})`;
    }
    const withSection = section ? `${text}\n\n${section}` : text;
    if (!trainingOn) return withSection;
    const pending = trainingAggregate(root).pending ?? 0;
    return `${withSection}\n\n미완료 학습 평가: ${pending}건`;
  };

  const generateReview = async ({ completed, statsRaw }) => {
    const fallback = (reason) => {
      const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      const players = readJsonOptional(playersPath, 'PLAYERS');
      if (engine?.gameOver !== true || !['completed', 'abort', 'win', 'lose'].includes(engine.result)) {
        throw codedError('BAD_REVIEW_RESULT', '기계 리뷰에 필요한 종료 결과가 올바르지 않습니다.');
      }
      if (!Array.isArray(players) || !players.some((player) => player?.playerId === 'user')
        || players.some((player) => !player || typeof player.playerId !== 'string')) {
        throw codedError('BAD_PLAYERS', '기계 리뷰에 필요한 플레이어 정보가 올바르지 않습니다.');
      }
      const stats = JSON.parse(statsRaw)?.perPlayer;
      // A missing measurement can be displayed as unavailable, but a present
      // malformed player row is corrupt evidence, including non-user rows.
      if (!stats || typeof stats !== 'object' || Array.isArray(stats) || !stats.user
        || Object.values(stats).some((row) => !row || !Number.isSafeInteger(row.sample) || row.sample < 0
          || (row.net != null && !Number.isSafeInteger(row.net))
          || ['vpip', 'pfr'].some((key) => row[key] != null && (!Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1)))) {
        throw codedError('BAD_REVIEW_STATS', '기계 리뷰에 필요한 관찰 통계가 올바르지 않습니다.');
      }
      const cutoff = readLoopState()?.finalization?.cutoff;
      if (cutoff?.reviewGate !== 'open' || cutoff.terminationConfirmed !== true
        || cutoff.completed !== completed || engine.lastHand?.handNo !== completed
        || stats.user.sample !== completed) {
        throw codedError('BAD_REVIEW_EVIDENCE', '종료 체크포인트와 기계 리뷰의 핸드 수가 일치하지 않습니다.');
      }
      // Read derived evidence before optional sections can downgrade its errors.
      readDerivedPolicyConfigs(root);
      const review = validateReviewOutput(appendTrainingPendingToReview(machineReview({
        statsRaw, players, result: engine.result,
      })), { requireHeadings: true });
      appendNotice('LLM 종합 리뷰를 제공할 수 없어 이번 세션의 관찰 기록으로 기계 리뷰를 작성했습니다.');
      log('review-machine-fallback', { reason });
      return review;
    };
    try {
      if (!upperAdapter || typeof upperAdapter.oneshotStart !== 'function') {
        return fallback('UPPER_ADAPTER_UNAVAILABLE');
      }
      const hands = [];
      for (let handNo = 1; handNo <= completed; handNo += 1) {
        const captured = semanticChildPayload(await runCli(['hand', String(handNo), '--redacted']));
        hands.push({ handNo, raw: JSON.stringify(captured) });
      }
      const processInput = buildProcessInput(hands.map(({ raw }) => parseCapturedHand(raw)));
      const eligibleHands = new Set(eligibleProcessInput(processInput).hands.map((hand) => hand.handNo));
      const unavailableNotice = unavailableProcessNotice(processInput);
      if (eligibleHands.size === 0) {
        return appendTrainingPendingToReview([
          '## 내 성향 통계', '과정 평가는 판정 불가입니다.',
          '## 결정적 핸드 2~3개 리플레이', unavailableNotice,
          '## 각 AI의 실제 아키타입 공개 + 읽기 평가', '결정 시점 증거가 없어 읽기 평가는 제공할 수 없습니다.',
          '## 다음 게임에서 연습할 것', '다음 게임에서 결정 시점의 공개 정보와 합법 액션을 확인하세요.',
        ].join('\n'));
      }
      const evaluatorPrompt = buildEvaluatorPrompt({ completed: eligibleHands.size, processInput });
      const evaluator = await runReviewStage({
        stage: 'evaluator',
        prompt: evaluatorPrompt,
      });

      const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      const players = readJsonOptional(playersPath, 'PLAYERS');
      if (!engine || engine.gameOver !== true || typeof engine.result !== 'string') {
        throw codedError('BAD_REVIEW_RESULT', '종합 리뷰에 필요한 종료 결과가 없습니다.');
      }
      if (!Array.isArray(players)) {
        throw codedError('BAD_PLAYERS', '종합 리뷰에 필요한 players.json이 배열이 아닙니다.');
      }
      const replayRecords = [];
      for (const handNo of [...eligibleHands].sort((a, b) => a - b)) {
        const captured = semanticChildPayload(await runCli(['hand', String(handNo), '--replay']));
        const filePath = path.join(root, `.review-hand-${handNo}-replay.json`);
        writeJsonAtomic(filePath, captured);
        replayRecords.push(outcomeRecord(parseCapturedHand(fs.readFileSync(filePath, 'utf8'))));
      }
      const trimmed = trimReviewReplays(replayRecords);
      if (trimmed.stage) log('review-replay-budget', { stage: trimmed.stage, bytes: Buffer.byteLength(JSON.stringify(trimmed.records)) });
      const synthesizerPrompt = buildSynthesizerPrompt({
        evaluator,
        result: engine.result,
        outcomeRecords: trimmed.records,
        playersRaw: JSON.stringify(sanitizePlayersForReview(players, {
          gameOver: true, derived: readDerivedPolicyConfigs(root),
        })),
        exploitRaw: JSON.stringify(exploitReveal(players)),
        selfOpponentsRaw: (() => {
          try {
            return JSON.stringify(buildSelfOpponentsRaw({
              root,
              players,
              derived: readDerivedPolicyConfigs(root),
            }));
          } catch {
            return 'null';
          }
        })(),
      });
      const synthesized = await runReviewStage({
        stage: 'synthesizer',
        prompt: synthesizerPrompt,
        requireHeadings: true,
      });
      return appendTrainingPendingToReview([synthesized, unavailableNotice].filter(Boolean).join('\n\n'));
    } catch (error) {
      if (error.code === 'REVIEW_ATTEMPTS_EXHAUSTED' && error.terminationConfirmed === true) {
        try { return fallback(error.code); } catch (fallbackError) { error = fallbackError; }
      }
      throw haltFinalization(
        'REVIEW_FAILED',
        `종합 리뷰 생성을 완료하지 못했습니다(${error.code ?? 'ERROR'}). 게임 상태와 코치 노트는 그대로 남습니다.`,
        { reason: error.code ?? 'ERROR' },
      );
    }
  };

  const checkpointGeneratedReview = (review) => {
    validateReviewOutput(review, { requireHeadings: true });
    writeTextAtomic(reviewPath, review);
    const persisted = fs.readFileSync(reviewPath, 'utf8');
    const reviewSha256 = sha256Text(persisted);
    return writeLoopState({
      phase: 'review_generated',
      reviewSha256,
      halt: undefined,
    });
  };

  const readGeneratedReview = () => {
    const state = readLoopState();
    let review;
    try {
      review = fs.readFileSync(reviewPath, 'utf8');
    } catch (error) {
      throw haltFinalization(
        'REVIEW_FAILED',
        `review_generated 체크포인트의 review.md를 읽지 못했습니다(${error.code ?? 'ERROR'}). 재생성하지 않습니다.`,
      );
    }
    let validated;
    try {
      validated = validateReviewOutput(review, { requireHeadings: true });
    } catch (error) {
      throw haltFinalization(
        'REVIEW_FAILED',
        `review_generated 체크포인트의 review.md가 검증에 실패했습니다(${error.code ?? 'ERROR'}). 재생성하지 않습니다.`,
      );
    }
    if (validated !== review || state?.reviewSha256 !== sha256Text(review)) {
      throw haltFinalization(
        'REVIEW_FAILED',
        'review_generated 체크포인트의 review.md digest가 일치하지 않아 재생성·게시하지 않습니다.',
      );
    }
    return { review, reviewSha256: state.reviewSha256 };
  };

  const snapshotReviewStatus = (reviewSha256) => {
    const snapshot = readJsonOptional(coachSnapshotPath, 'UI_SNAPSHOT');
    const matches = typeof snapshot?.review === 'string'
      && sha256Text(snapshot.review) === reviewSha256;
    return {
      matches,
      publishId: Number.isInteger(snapshot?.publishId) ? snapshot.publishId : null,
    };
  };

  const checkpointReviewPublished = ({ publishId = null } = {}) => writeLoopState({
    phase: 'review_published',
    ...(Number.isInteger(publishId) ? { lastPublishId: publishId } : {}),
    halt: undefined,
  });

  const publishGeneratedReview = async () => {
    await ensureGameOverViewPublished();
    if (readJsonOptional(engineStatePath, 'ENGINE_STATE')?.gameOver === true
      && !snapshotViewGameOver()) {
      throw haltFinalization(
        'REVIEW_FAILED',
        '스냅샷 view.gameOver가 아니라 리뷰 오버레이를 게시하지 않습니다. review_generated에서 재개할 수 있습니다.',
      );
    }
    const generated = readGeneratedReview();
    writeJsonAtomic(reviewEnvelopePath, { review: generated.review });

    // One loop step resolves either an already-recorded exact body or creates the review
    // attempt. Before every new body, compare the durable snapshot digest so an ack that
    // landed before the phase write never burns a second publishId.
    for (let step = 0; step < 4; step += 1) {
      const retry = fs.existsSync(publishAttemptPath);
      if (!retry) {
        const before = snapshotReviewStatus(generated.reviewSha256);
        if (before.matches) {
          // postPublish() persists the snapshot before publish.js removes its attempt.
          // Recheck that no recorded body appeared across the digest read; such a body
          // must be retried (same publishId) rather than abandoned at done.
          if (fs.existsSync(publishAttemptPath)) continue;
          return checkpointReviewPublished({ publishId: before.publishId });
        }
      }
      let published;
      try {
        published = await executePublish([
          '--from', reviewEnvelopePath,
          ...(retry ? ['--retry'] : []),
        ]);
      } catch (error) {
        // A publisher may win the attempt-file race after the check above. The next loop
        // iteration sees that record and resolves it with --retry before our review body.
        if (error.code === 'ATTEMPT_PENDING') continue;
        let kind = '';
        try {
          const pending = JSON.parse(fs.readFileSync(publishAttemptPath, 'utf8'));
          if (pending?.body && typeof pending.body === 'object' && !Array.isArray(pending.body)) {
            kind = Object.keys(pending.body).filter((key) => key !== 'publishId').join(',');
          }
        } catch { /* malformed leftover attempt must not replace REVIEW_FAILED */ }
        throw haltFinalization(
          'REVIEW_FAILED',
          `종합 리뷰 게시를 완료하지 못했습니다(${error.code ?? 'ERROR'}${kind ? `, attempt=${kind}` : ''}). review_generated에서 재개할 수 있습니다.`,
        );
      }
      if (Number.isInteger(published?.publishId)) writeLoopState({ lastPublishId: published.publishId });
      if (!retry) {
        const afterPublish = snapshotReviewStatus(generated.reviewSha256);
        if (!afterPublish.matches) {
          throw haltFinalization(
            'REVIEW_FAILED',
            '종합 리뷰 non-retry 게시 응답 뒤 ui-snapshot digest가 일치하지 않아 새 publishId 없이 review_generated에서 멈춥니다.',
          );
        }
        return checkpointReviewPublished({ publishId: afterPublish.publishId });
      }
    }

    const after = snapshotReviewStatus(generated.reviewSha256);
    if (!after.matches) {
      throw haltFinalization(
        'REVIEW_FAILED',
        '종합 리뷰 게시 응답 뒤 ui-snapshot digest를 확인하지 못해 review_generated에서 멈춥니다.',
      );
    }
    return checkpointReviewPublished({ publishId: after.publishId });
  };

  const finishDoneLifecycle = async () => {
    const current = readLoopState();
    if (storeDir && !doneResumeNoTrainingWrite) {
      try {
        const profile = await createProfileStore(storeDir).show();
        writePracticeFocus(storeDir, profile);
      } catch (error) {
        log('practice-focus-error', { code: error.code ?? 'ERROR' });
      }
    }
    try {
      fs.unlinkSync(sessionsPath);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        persistCleanupFailure(error);
        throw error;
      }
    }
    playerSessions = null;
    restoredPlayerSessions.clear();
    const finalStatePatch = () => ({
      phase: 'done',
      pendingDecision: undefined,
      finishedAt: current?.finishedAt ?? isoNow(now),
      halt: undefined,
    });
    if (typeof opts.beforeDoneRequestStop === 'function') opts.beforeDoneRequestStop();
    await requestStop({ finalStatePatch });
    return readLoopState() ?? current;
  };

  const abortExpiredFinalization = ({ cause = null } = {}) => {
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed: false,
          reason: 'deadline_exceeded',
          cause: cause?.code ?? null,
          reviewGate: 'closed',
        },
      },
    });
    return haltFinalization(
      'FINALIZATION_ABORTED',
      'finalization 공통 deadline이 만료돼 리뷰 게이트를 열지 않습니다.',
      { causeCode: cause?.code ?? null },
    );
  };

  const abortResultWaitCutoff = () => {
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed: false,
          reason: 'result_wait_cutoff_exceeded',
          reviewGate: 'closed',
        },
      },
    });
    return haltFinalization(
      'FINALIZATION_ABORTED',
      'finalization result-wait cutoff 안에 owner/coach 사전 작업을 완료하지 못해 중단합니다.',
    );
  };

  const abortCompletedHandAuthority = (reason, message, terminationConfirmed) => {
    const current = readLoopState()?.finalization ?? baseFinalizationCheckpoint();
    writeLoopState({
      finalization: {
        ...current,
        cutoff: {
          ...(current.cutoff ?? {}),
          at: isoNow(now),
          terminationConfirmed,
          reason,
          reviewGate: 'closed',
        },
      },
    });
    return haltFinalization('FINALIZATION_ABORTED', message);
  };

  const completedHandFromEngine = (terminationConfirmed) => {
    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    const completed = engine?.lastHand?.handNo;
    if (!Number.isSafeInteger(completed) || completed < 0) {
      throw abortCompletedHandAuthority(
        'invalid_engine_last_hand',
        '종료 engine lastHand.handNo가 안전한 0 이상 정수가 아니어서 리뷰 게이트를 열지 않습니다.',
        terminationConfirmed,
      );
    }
    return completed;
  };

  const assertStatsCompletedHand = (completed, statsRaw, terminationConfirmed) => {
    let sample;
    try {
      sample = JSON.parse(statsRaw)?.perPlayer?.user?.sample;
    } catch {
      sample = undefined;
    }
    if (!Number.isSafeInteger(sample) || sample < 0) {
      throw abortCompletedHandAuthority(
        'invalid_stats_sample',
        'stats user.sample이 안전한 0 이상 정수가 아니어서 리뷰 게이트를 열지 않습니다.',
        terminationConfirmed,
      );
    }
    if (sample !== completed) {
      throw abortCompletedHandAuthority(
        'completed_stats_disagreement',
        `engine lastHand.handNo(${completed})와 stats user.sample(${sample})이 일치하지 않아 리뷰 게이트를 열지 않습니다.`,
        terminationConfirmed,
      );
    }
  };

  const translateFinalizationDeadline = (error) => {
    if (error?.code === 'FINALIZATION_RESULT_WAIT_CUTOFF') return abortResultWaitCutoff();
    if (error?.code !== 'FINALIZATION_DEADLINE_EXCEEDED') return error;
    return abortExpiredFinalization({ cause: error.cause ?? null });
  };

  // 종료 시퀀스 §5/§9.2. Phase는 이미 finalizing이고, 각 단계가 loop-state 체크포인트다.
  const finalize = async () => {
    if (readLoopState()?.phase !== 'finalizing') {
      throw codedError(
        'BAD_LOOP_PHASE',
        'finalize는 finalizing phase에서만 실행할 수 있습니다.',
      );
    }
    // finalDeadline/resultWaitCutoff는 owner transfer를 포함한 이 종료 시도에서 한
    // 번만 정한다. finalizing resume은 begin-owner 전에 이미 같은 값을 설치한다.
    const {
      deadlineNs: finalDeadlineNs,
      resultWaitCutoffNs,
    } = ensureFinalizationResultWaitCutoff();
    const checkpoint = baseFinalizationCheckpoint();
    writeLoopState({ finalization: checkpoint });
    log('finalize-start', { budgetMs: finalizeBudgetMs, resultWaitMs: checkpoint.resultWaitMs });
    await reconcileTrainingNow();

    const owner = readLoopState()?.ownerSessionId;
    if (typeof owner !== 'string' || owner === '') {
      throw codedError('NO_COACH_OWNER', '코치 ownerSessionId가 없습니다.');
    }

    // (1) heartbeat의 result-ready/timeout-fence와 이미 쓰인 result를 먼저 소비한다.
    try {
      await heartbeatCoach();
    } catch (error) {
      appendNotice(`코치 heartbeat 오류: ${error.code ?? 'ERROR'}`);
      log('coach-heartbeat-error', { phase: 'finalizing', code: error.code ?? 'ERROR' });
    }
    if (stopRequested) return readLoopState();

    // (2) running generation과 training settle은 같은 result-wait cutoff를 공유한다.
    const [settled, trainingSettled] = await Promise.all([
      settleCoachTasks(resultWaitCutoffNs),
      settleTrainingTasks(resultWaitCutoffNs),
    ]);
    log('finalize-coach-settled', { settled, pending: coachTasks.size });
    log('finalize-training-settled', { settled: trainingSettled, pending: trainingTasks.size });
    if (stopRequested) return readLoopState();
    try {
      await flushDeferredCoachNotes({ finalizing: true });
    } catch (error) {
      appendNotice(`코치 deferred flush 오류: ${error.code ?? 'ERROR'}`);
      log('coach-deferred-flush-error', { phase: 'finalizing', code: error.code ?? 'ERROR' });
    }
    if (stopRequested) return readLoopState();

    // (3) cutoff: 새 play-time publisher 금지 + live worker 종료 확인.
    finalizationCutoff = true;
    await sealExploitAtCutoff();
    let trainingTerminationConfirmed = true;
    if (trainingOn) {
      enterExplanationCutoff(root);
      try {
        await createTrainingControl({ storeDir }).writeCutoffMarker(root);
      } catch (error) {
        try {
          trainingTerminationConfirmed = await terminateTrainingChildren(finalDeadlineNs);
        } catch (terminateError) {
          trainingTerminationConfirmed = false;
          log('training-terminate-error', { code: terminateError.code ?? 'ERROR' });
        }
        throw haltFinalization(
          'FINALIZATION_ABORTED',
          'training cutoff marker를 기록하지 못해 종료를 중단합니다.',
          { cause: error.code ?? 'ERROR' },
        );
      }
      log('training-cutoff-marker', { at: isoNow(now) });
      await sealUnfinishedExplanations();
      trainingTerminationConfirmed = await terminateTrainingChildren(finalDeadlineNs);
      // settle이 timeout으로 끝났으면 첫 스캔 이후에도 in-flight evaluate/solve가
      // item을 accept할 수 있다. 자식 종료가 확인된 지금이 생산자 집합이 실제로
      // 닫히는 시점이므로 한 번 더 훑어 늦게 온 item이 exploit 없이 게시되는 것을
      // 막는다. seal은 이미 붙은 annotation을 건너뛰므로 멱등이고, cutoff 마커는
      // explanation 전용이라 이 시점의 exploit ready seal은 정상 경로다.
      await sealExploitAtCutoff();
    }
    const signalAuthority = persistedCoachAttempts();
    if (signalAuthority.authorityError) {
      throw haltForPersistedCoachRecovery({
        owner: signalAuthority.owner,
        unresolved: [{
          handNo: null,
          generation: null,
          cleanupAuthorized: false,
          ...signalAuthority.authorityError,
        }],
      });
    }
    const trackedTerminationConfirmed = await terminateLiveCoachGenerations(owner, finalDeadlineNs);
    const postCutoffPersisted = remainingMsUntil(finalDeadlineNs) > 0
      ? await closePersistedCoachWorkers()
      : { confirmed: false, unresolved: [] };
    const terminationConfirmed = finalizationPriorTerminationConfirmed
      && trackedTerminationConfirmed
      && postCutoffPersisted.confirmed
      && trainingTerminationConfirmed
      && coachAttempts.size === 0
      && coachTasks.size === 0;
    assertFinalizationDeadline();

    // (4) 한 transaction으로 missing 전체를 fence + unavailable Q seal.
    const completed = completedHandFromEngine(terminationConfirmed);
    const stats = await captureCoachStats('final');
    assertStatsCompletedHand(completed, stats.raw, terminationConfirmed);
    let cutoff;
    try {
      cutoff = await runCoach([
        'finalize-cutoff',
        '--owner', owner,
        '--completed', String(completed),
        '--stats-file', stats.path,
        '--snapshot-file', coachSnapshotPath,
        '--termination-confirmed', terminationConfirmed ? 'true' : 'false',
      ]);
    } catch (error) {
      if (error.code !== 'FINALIZATION_ABORTED') throw error;
      const reason = error.envelope?.reason ?? 'unknown';
      writeLoopState({
        finalization: {
          ...checkpoint,
          cutoff: { at: isoNow(now), terminationConfirmed, reason, reviewGate: 'closed' },
        },
      });
      throw haltFinalization(
        'FINALIZATION_ABORTED',
        `코치 finalization이 ${reason}로 중단돼 리뷰 게이트를 열지 않습니다.`,
      );
    }
    const completeness = cutoff.completeness ?? {};
    writeLoopState({
      finalization: {
        ...checkpoint,
        cutoff: {
          at: isoNow(now),
          terminationConfirmed,
          completed,
          sealed: cutoff.sealed ?? [],
          reviewGate: cutoff.reviewGate ?? 'closed',
          pending: completeness.pending ?? [],
          missing: completeness.missing ?? [],
        },
      },
    });
    log('finalize-cutoff', {
      completed,
      sealed: cutoff.sealed ?? [],
      reviewGate: cutoff.reviewGate ?? 'closed',
    });

    // (5) 그 다음에만 남은 예산으로 attempt/Q를 해소한다.
    publishDeadlineNs = finalDeadlineNs;
    try {
      await retryUnresolvedTrainingAttempt();
      await ensureGameOverViewPublished();
      await drainQueuedCoachPublications();
      await flushTrainingPublish();
      await flushAnnotationPublish();
      await consumeTrainingNow();
    } catch (error) {
      if (error.code === 'COACH_RECONCILE_PENDING') {
        writeLoopState({
          halt: { code: 'COACH_RECONCILE_PENDING', message: error.message },
        });
      }
      throw error;
    } finally {
      publishDeadlineNs = null;
    }
    log('finalize-drained', { remainingMs: remainingMsUntil(finalDeadlineNs) });
    const leftoverPending = trainingOn ? (trainingAggregate(root).pending ?? 0) : 0;
    if (leftoverPending > 0) appendNotice(`학습 평가 미완 ${leftoverPending}건`);

    // (6) missing handNo를 성공처럼 숨기지 않는다.
    if ((cutoff.reviewGate ?? 'closed') !== 'open') {
      const missing = completeness.missing ?? [];
      throw haltFinalization(
        'REVIEW_GATE_CLOSED',
        `코치 봉인이 1..${completed} 핸드를 덮지 못해(누락 ${missing.join(',') || '불명'}) 리뷰를 시작하지 않습니다.`,
      );
    }
    const machineOnly = !upperAdapter || typeof upperAdapter.oneshotStart !== 'function';
    if (!machineOnly) await enterReviewGenerationScope(completed);
    const review = await generateReview({ completed, statsRaw: stats.raw });
    return checkpointGeneratedReview(review);
  };

  const checkArchivePending = async (out) => {
    if (!out?.archivePending) return;
    const handNo = Number(out.handNo);
    if (archiveCheckedHands.has(handNo)) return;
    archiveCheckedHands.add(handNo);
    const checked = await runCli(['resume-check']);
    log('archive-resume-check', { handNo, archiveStatus: checked.archiveStatus });
    if (checked.archiveStatus !== 'repair_failed') return;
    const message = `핸드 ${handNo} 아카이브 복구에 실패해 새 핸드를 시작하지 않습니다.`;
    writeLoopState({
      handNo,
      halt: { code: 'repair_failed', message },
    });
    throw codedError('repair_failed', message);
  };

  const appendMetric = (metric) => {
    const state = readLoopState();
    const metrics = Array.isArray(state?.metrics) ? [...state.metrics, metric] : [metric];
    writeLoopState({ metrics });
  };

  const waitOnlyForUser = async (out, { drain = false } = {}) => {
    if (!managed) return executePublish(['--from', turnPath, '--wait-only', '--wait-ms', String(waitMs)]);
    const current = out ?? await runCli(['step']);
    if (current.next?.kind !== 'user') return current;
    if (pauseRequested && !drain) return { ...current, controlInterrupted: true };
    const pin=openServerLockPin();
    let lock;
    try {
      lock=assertPinnedServerLock(pin);
      if(!serverIdentity || startTimeOf(lock.serverPid)!==serverIdentity.startTime)throw codedError('SERVER_IDENTITY_UNAVAILABLE','relay identity changed');
      await assertServerBinding(lock);
      lock=assertPinnedServerLock(pin);
    } catch(error){if(drain)throw error;return {...current,waitError:error.code??'WAIT_FAILED'};} finally {closeServerLockPin(pin);}
    if (!lock || lock.sessionToken !== readLoopState()?.sessionToken || lock.serverPid !== serverPid) throw codedError('SERVER_IDENTITY_UNAVAILABLE', 'relay identity unavailable');
    if(pauseRequested&&!drain)return {...current,controlInterrupted:true};
    const controller = new AbortController();
    if (!drain) waitController = controller;
    const query = new URLSearchParams({token:lock.sessionToken, expectDecisionId:current.next.decisionId, timeoutMs:String(drain ? 0 : waitMs)});
    try {
      const response = await fetch(`http://127.0.0.1:${lock.port}/api/wait-action?${query}`, {signal:AbortSignal.any([controller.signal,AbortSignal.timeout((drain ? 0 : waitMs)+10000)])});
      if (!response.ok) throw codedError('WAIT_FAILED', 'relay wait failed');
      return { ...current, userAction: await response.json(), controlInterrupted: undefined, waitError: undefined };
    } catch (error) {
      if (controller.signal.aborted && (pauseRequested || stopRequested)) return { ...current, controlInterrupted: true };
      if(drain)throw error;
      return {...current,waitError:error.code??'WAIT_FAILED'};
    } finally { if (waitController === controller) waitController = null; }
  };

  const pause = () => {
    if (!managed || readLoopState()?.phase !== 'playing' || terminalOperation || stopRequested) throw codedError('INVALID_TRANSITION', '현재 상태에서는 일시정지할 수 없습니다.');
    if (pauseCompletion) return pauseCompletion;
    if(control.read().playState==='paused')return Promise.resolve({state:'paused'});
    pauseCompletion = (async()=>{
      await retryControlWrite(()=>control.set('pausing',{pauseIntent:true}));
      if(stopRequested)return {state:'stopped'};
      if(readLoopState()?.phase!=='playing')return {state:'finalizing'};
      pauseRequested=true;
      const ack=new Promise(resolve=>{resolvePause=resolve;});
      waitController?.abort();
      return ack;
    })().catch(error=>{pauseCompletion=null;throw error;});
    return pauseCompletion;
  };
  const resumePlay = async () => {
    if (!managed || control?.read().playState !== 'paused' || terminalOperation) throw codedError('INVALID_TRANSITION','일시정지 상태가 아닙니다.');
    if (readLoopState()?.pendingDecision && readLoopState().pendingDecision.status !== 'retry_authorized') {
      throw codedError('PLAYER_RECOVERY_REQUIRED', 'LLM 결정을 재시도하거나 게임을 종료하세요.');
    }
    const current = await runCli(['step']);
    await publishEnvelope(current, ['--view-only']);
    await retryControlWrite(()=>control.set('playing', {pauseIntent:false}));
    assertNotStopping();
    pauseRequested = false;
    pauseCompletion = null;
    parkWake?.();
  };
  const retryDecision = async (decisionId, { freshAuthorization = null } = {}) => {
    if (stopRequested || terminalOperation || (managed && control?.read().playState !== 'paused')) {
      throw codedError('INVALID_TRANSITION', '복구 대기 상태에서만 재시도할 수 있습니다.');
    }
    let pending = readLoopState()?.pendingDecision;
    if (!pending || ![1, 2].includes(pending.schemaVersion) || pending.status !== 'recovery_required'
      || pending.closeConfirmed !== true || pending.decisionId !== decisionId) {
      throw codedError('PLAYER_RECOVERY_REQUIRED', '종료 확인된 미해결 결정이 필요합니다.');
    }
    if (freshAuthorization !== null && (
      typeof freshAuthorization !== 'object'
      || Array.isArray(freshAuthorization)
      || !['app', 'legacy', 'api'].includes(freshAuthorization.source)
      || !(typeof freshAuthorization.requestId === 'string' || freshAuthorization.requestId === null)
    )) throw codedError('BAD_FRESH_AUTHORIZATION', '새 세션 재시도 권한이 올바르지 않습니다.');
    const check = validateDiagnostics(pending.diagnostics, pending);
    if (!check.ok) pending = quarantineDiagnostics(pending, check.reason);
    const current = await runCli(['step']);
    if (current.next?.decisionId !== pending.decisionId || current.next?.toAct !== pending.playerId
      || current.stateVersion !== pending.stateVersion || readLoopState().gameEpoch !== pending.gameEpoch) {
      throw codedError('STALE_PLAYER_DECISION', '엔진 결정이 변경되어 재시도하지 않았습니다.');
    }
    if (stopRequested || terminalOperation || (managed && control?.read().playState !== 'paused')) {
      throw codedError('INVALID_TRANSITION', '정지 또는 상태 전환 뒤에는 재시도를 인가하지 않습니다.');
    }
    const latest = readLoopState()?.pendingDecision;
    const samePendingIdentity = (candidate) => candidate &&
      ['schemaVersion', 'gameEpoch', 'decisionId', 'playerId', 'stateVersion', 'generation']
        .every(key => candidate[key] === pending[key]);
    if (!samePendingIdentity(latest) || latest.status !== 'recovery_required') {
      throw codedError('INVALID_TRANSITION', '이미 재시도 중입니다.');
    }
    if (latest.closeConfirmed !== true) {
      throw codedError('PLAYER_RECOVERY_REQUIRED', '종료 확인된 미해결 결정이 필요합니다.');
    }
    const {freshAuthorization: _staleAuthorization, ...base} = pending;
    const authorized = {
      ...base,
      status: 'retry_authorized',
      ...(freshAuthorization === null ? {} : {freshAuthorization: {
        source: freshAuthorization.source,
        requestId: freshAuthorization.requestId,
      }}),
    };
    writeLoopState({ pendingDecision: authorized,
      playerBudget: playerBudget({ ...(readLoopState().playerBudget ?? pending.budget), ...(opts.retryBudget ?? {}) }) });
    if (managed) {
      try { await resumePlay(); }
      catch (error) {
        const authorizedRecord = readLoopState()?.pendingDecision;
        if (authorizedRecord?.status === 'retry_authorized' && samePendingIdentity(authorizedRecord)) {
          writeLoopState({ pendingDecision: { ...base, softWait: false } });
        }
        throw error;
      }
    }
  };
  const endGame = async (operationId) => {
    if (!managed || control?.read().playState !== 'paused') throw codedError('INVALID_TRANSITION','종료 전에 일시정지가 필요합니다.');
    await retryControlWrite(()=>control.set('stopping', {terminalIntent:{operationId,kind:'end'}}));
    assertNotStopping();
    terminalOperation = operationId;
    parkWake?.();
  };
  const pauseBarrier = async (out) => {
    if (!managed || !pauseRequested || stopRequested) return out;
    const pending = readLoopState()?.pendingDecision;
    // An accepted retry is one decision unit, even across the restored run-entry
    // publishes. Park after consuming that grant, never between grant and warmup.
    if (pending?.status === 'retry_authorized' && pending.closeConfirmed === true
      && out?.next?.kind === 'ai' && pending.decisionId === out.next.decisionId
      && pending.playerId === out.next.toAct && pending.stateVersion === out.stateVersion
      && pending.gameEpoch === readLoopState()?.gameEpoch) return out;
    // Gate is durable before draining a receipt. Delivered replies may be read again.
    if (out?.next?.kind === 'user') {
      let drained;
      try {drained=await waitOnlyForUser(out,{drain:true});}
      catch {
        await recoverServerForPublish();assertNotStopping();
        const current=await runCli(['step']);
        await publishEnvelope(current,['--view-only']);
        drained=await waitOnlyForUser(current,{drain:true});
      }
      if (drained.userAction && !drained.userAction.timeout) out = await handleUserTurn(drained);
    }
    await Promise.allSettled([...coachTasks, ...trainingTasks, ...auxiliaryTasks]);
    if (stopRequested) return out;
    if (out?.gameOver || readJsonOptional(engineStatePath,'ENGINE_STATE')?.gameOver) {
      pauseRequested = false;
      resolvePause?.({state:'finalizing'}); resolvePause = null;
      return out;
    }
    await retryControlWrite(()=>control.set('paused'));
    if(stopRequested)return out;
    const parked = new Promise(resolve => {parkWake = resolve;});
    resolvePause?.({state:'paused'}); resolvePause = null;
    await parked;
    parkWake = null;
    if (terminalOperation && !stopRequested) {
      await runCli(['end','--result','abort','--operation-id',terminalOperation]);
      writeLoopState({phase:'aborted',result:'abort',pendingDecision:undefined,endedAt:isoNow(now)});
      await retryControlWrite(()=>control.set('aborted'));
      await requestStop();
      return null;
    }
    return out ? await publishEnvelope(await runCli(['step']), ['--view-only']) : out;
  };

  const userActionAck = (submitted, phase, reason) => {
    const { gameEpoch, decisionId, requestId, digest } = submitted;
    try {
      return validateActionAck({ gameEpoch, decisionId, requestId, digest, phase, reason }, {
        gameEpoch: readLoopState()?.gameEpoch,
        view: { legal: { decisionId: phase === 'rejected' ? decisionId : null } },
      });
    } catch {
      throw codedError('BAD_ACTION_RECEIPT', '접수 identity가 없는 사용자 액션은 적용하지 않습니다.');
    }
  };

  const republishAfterRejectedUserAction = async (code, submitted) => {
    const synchronized = await runCli(['step']);
    const narration = code === 'VERSION_MISMATCH'
      ? '게임 상태가 변경되어 최신 결정으로 다시 기다립니다.'
      : '입력한 액션이 허용되지 않아 같은 결정을 다시 기다립니다.';
    const phase = synchronized.next?.decisionId === submitted.decisionId ? 'rejected' : 'consumed';
    const actionAck = userActionAck(submitted, phase, code);
    log('user-action-rejected', { code, decisionId: synchronized.next?.decisionId ?? null });
    return publishEnvelope({ ...synchronized, actionAck }, ['--narration', narration, ...waitFlags()]);
  };

  const handleUserTurn = async (out) => {
    const next = out.next;
    if (out.waitError) {
      log('user-wait-error', { decisionId: next.decisionId, message: out.waitError });
      if (stopRequested) return null;
      // health만 맞는 foreign listener에 view-only state를 게시하지 않는다. D9와 같은
      // pid↔port↔token↔startTime↔pinned-lock 전체 증명을 통과한 server만 재사용한다.
      await recoverServerForPublish();
      assertNotStopping();
      const synchronized = await runCli(['step']);
      assertNotStopping();
      await publishEnvelope(synchronized, ['--view-only']);
      assertNotStopping();
      log('user-view-republished', { decisionId: synchronized.next?.decisionId ?? null });
      return waitOnlyForUser(out);
    }

    const submitted = out.userAction;
    if (!submitted || submitted.timeout) {
      log('user-wait-timeout', { decisionId: next.decisionId });
      return waitOnlyForUser(out);
    }
    if (submitted.decisionId !== next.decisionId) {
      log('user-stale-decision', {
        expectedDecisionId: next.decisionId,
        receivedDecisionId: submitted.decisionId ?? null,
      });
      return republishAfterRejectedUserAction('STALE_DECISION', submitted);
    }

    // Relay payload는 외부 입력이다. action/amount를 semantic argv로 검증한 뒤에만
    // engine 인자를 만든다. 특히 `--force-default`가 user 경로에서 flag가 될 수 없다.
    const action = validatedUserAction(submitted);
    if (!action) {
      if (stopRequested) return null;
      return republishAfterRejectedUserAction('ILLEGAL_ACTION', submitted);
    }
    if (submitted.note !== undefined && typeof submitted.note !== 'string') {
      log('user-note-ignored', { type: typeof submitted.note });
    }

    const stepArgs = ['step', 'user', action.action];
    if (action.amount !== undefined) stepArgs.push(String(action.amount));
    stepArgs.push('--expect-version', String(out.stateVersion));
    if (action.note) {
      const metaPath = path.join(root, '.decision-meta.json');
      writeJsonAtomic(metaPath, { decisionId: next.decisionId, note: action.note });
      stepArgs.push('--meta-file', metaPath);
    }
    const actionAck = userActionAck(submitted, 'consumed', 'ACTION_APPLIED');
    try {
      return await runAtomicStepPublish(stepArgs, waitFlags(), actionAck);
    } catch (error) {
      if (error.code !== 'ILLEGAL_ACTION' && error.code !== 'VERSION_MISMATCH') throw error;
      if (stopRequested) return null;
      return republishAfterRejectedUserAction(error.code, submitted);
    }
  };

  const waitForChildExit = async (child, timeoutMs) => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    let exited = false;
    const exit = new Promise((resolve) => child.once('exit', () => {
      exited = true;
      resolve();
    }));
    await Promise.race([exit, sleep(timeoutMs)]);
    return exited || child.exitCode !== null || child.signalCode !== null;
  };

  const terminateActiveChildren = async () => {
    const children = [...activeChildren];
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      if (await waitForChildExit(child, 500)) return;
      child.kill('SIGKILL');
      if (!await waitForChildExit(child, 500)) {
        throw codedError('CHILD_STOP_UNCONFIRMED', `자식 pid ${child.pid} 종료를 확인하지 못했습니다.`);
      }
    }));
  };

  // #192 oK2: `verifyOwnedLock` rethrows non-ENOENT errors (EACCES, EMFILE, win32 EPERM).
  // Every caller needs a yes/no answer and must keep cleaning up, so an unverifiable lock
  // counts as not owned: nothing is written on its behalf and nothing is released by scan.
  const ownedLockStillVerified = () => {
    if (!lockHandle) return false;
    try {
      return verifyOwnedLock(lockHandle);
    } catch (error) {
      log('loop-lock-verify-failed', { code: error?.code ?? null });
      return false;
    }
  };

  // #192 L2 (design memo §11, appendix v3.3): best-effort `loop-lock-lost-on-stop` log,
  // mirroring persistCleanupFailure's own openLog/log/closeSync handling below — the normal
  // log descriptor may already be closed by the time either caller reaches this point.
  const logLoopLockLostOnStop = () => {
    try {
      openLog();
      log('loop-lock-lost-on-stop', {});
      fs.closeSync(logFd);
      logFd = null;
    } catch { /* best-effort, mirrors persistCleanupFailure's log handling */ }
  };

  const loopLockLostError = () => codedError(
    'LOOP_LOCK_LOST',
    'loop 락을 잃어 stop 결과를 기록하지 않았습니다.',
  );

  const persistCleanupFailure = (error) => {
    if (!lifecycleStarted) return null;
    // #192 L2: re-validate lock ownership before writing a cleanupError, exactly like the
    // success path does before its own final writeLoopState (design memo §11) — a stale
    // `lockHandle` must not let this instance overwrite another owner's loop-state. The
    // sticky `lockLostPermanently` flag keeps a retried `requestStop()` (its `lockHandle`
    // already nulled by the first attempt's own `releaseLock()`) on this same path.
    // #197: losing the lock suppresses the *write*, never the error. The cleanup failure
    // that actually happened is still logged and still returned to the caller (`null` here
    // means "no replacement error"), so a recovery exit keeps reporting its own cause. Only
    // the success path, which has no other error to report, fails with LOOP_LOCK_LOST.
    const lockLost = Boolean(lockLostPermanently || (lockHandle && !ownedLockStillVerified()));
    if (lockLost) {
      lockLostPermanently = true;
      logLoopLockLostOnStop();
    }
    const cleanupError = {
      code: error.code ?? 'ERROR',
      message: error.message ?? String(error),
      ...(error.details ? { details: error.details } : {}),
    };
    try {
      // requestStop may already have closed the normal log descriptor.
      openLog();
      log('cleanup-failed', cleanupError);
      fs.closeSync(logFd);
      logFd = null;
    } catch { /* Persist state even when the log is unavailable. */ }
    if (lockLost) return null;
    try {
      if (preserveLoopState || !fs.existsSync(loopStatePath)) return null;
      writeLoopState({
        stopping: true,
        stoppedAt: undefined,
        cleanupFailedAt: isoNow(now),
        cleanupError,
      });
    } catch { /* 원래 cleanup failure와 lock ownership을 보존한다 */ }
    return null;
  };

  const requestStop = ({ finalStatePatch = null } = {}) => {
    if (finalStatePatch !== null) pendingFinalStatePatch = finalStatePatch;
    if (stopPromise) return stopPromise;
    stopRequested = true;
    waitController?.abort();
    parkWake?.();
    resolvePause?.({state:"stopped"});
    const attempt = (async () => {
      let stopError = null;
      // #192 L2: even the "stopping" marker is a write into loop-state. An instance whose
      // loop lock was removed or replaced must not stamp it onto the state of whichever
      // instance owns the game now. Remember the loss so the final block below refuses too.
      if (lockLostPermanently || (lockHandle && !ownedLockStillVerified())) {
        lockLostPermanently = true;
      } else {
        try {
          if (lifecycleStarted && !preserveLoopState && fs.existsSync(loopStatePath)) {
            writeLoopState({ stopping: true, stoppedAt: undefined, stopRequestedAt: isoNow(now) });
          }
        } catch (error) {
          stopError = error;
        }
      }
      const inFlight = atomicTransition;
      if (inFlight) {
        // The mutation and its matching publish are one recoverable unit. Its own
        // error is observed by run(); shutdown still proceeds after it settles.
        await inFlight.promise;
      }
      const resolving = resolverPromise;
      // 먼저 현재까지 생성된 adapter를 닫아 in-flight probe를 취소한다. resolver가
      // fallback adapter를 더 만들면 registerAdapter가 즉시 그 adapter도 닫는다.
      for (const adapter of adapters) startAdapterDisposal(adapter);
      if (resolving) {
        try { await resolving; } catch { /* bootstrap/resume 호출자가 원래 오류를 관찰한다 */ }
      }
      if (studyPromise) {
        // Study has an independent lifetime, but parent attachment must settle
        // before this process releases the store-loop ownership it attests.
        try { await studyPromise; } catch { /* caller observes the startup error */ }
      }
      // resolver settlement 뒤에는 더 이상 새 adapter가 생기지 않는다. 전부 settle한
      // 뒤에만 loop lock을 풀어 probe child가 ownership 밖으로 탈출하지 못하게 한다.
      for (const adapter of adapters) startAdapterDisposal(adapter);
      // #192 I1/sJ4: `startAdapterDisposal` treats an adapter with no `dispose` at all the
      // same as one that disposed successfully — but a coach-capable adapter (`oneshotStart`)
      // with no `dispose` never actually confirms its spawned children are closed. `dispose`
      // merely *existing* is not enough either (sJ4): a `dispose()` that resolves without ever
      // actually confirming its registry's children closed would let this receipt overclaim
      // just as badly, so a coach-capable adapter is only trusted when it explicitly declares
      // `disposeConfirmsChildren === true`. Snapshot both checks now, before `adapters.clear()`
      // below empties the set, so a coach-runtime-closure receipt is only ever written when
      // every such adapter's disposal was truly confirmed.
      const coachCapableAdapters = [...adapters].filter((adapter) => (
        adapter && typeof adapter.oneshotStart === 'function'
      ));
      const hasCoachAdapterWithoutDispose = coachCapableAdapters.some((adapter) => (
        typeof adapter.dispose !== 'function'
      ));
      const hasCoachAdapterWithUndeclaredConfirmation = coachCapableAdapters.some((adapter) => (
        typeof adapter.dispose === 'function' && adapter.disposeConfirmsChildren !== true
      ));
      const undisposableCoachAdapter = hasCoachAdapterWithoutDispose || hasCoachAdapterWithUndeclaredConfirmation;
      const disposalResults = await Promise.allSettled([...adapterDisposals.values()]);
      const disposalFailure = disposalResults.find((result) => result.status === 'rejected');
      if (disposalFailure) stopError ??= disposalFailure.reason;
      // Coach work is nonblocking only with respect to the next hand. Shutdown still owns
      // every task until the upper adapter has cancelled it and its authority/file work settles.
      for (const handle of trainingAttempts.values()) {
        try { handle.terminate(); } catch { /* best-effort */ }
      }
      await Promise.allSettled([...coachTasks]);
      await Promise.allSettled([...trainingTasks, ...auxiliaryTasks]);
      try {
        await terminateActiveChildren();
      } catch (error) {
        stopError ??= error;
      }
      try {
        await stopServer();
      } catch (error) {
        stopError ??= error;
      }
      if (!disposalFailure) adapters.clear();
      for (const canary of [...canaries]) {
        try { fs.unlinkSync(canary); } catch (error) {
          if (error.code !== 'ENOENT') {
            stopError ??= error;
            continue;
          }
        }
        canaries.delete(canary);
      }

      if (logFd !== null) {
        try {
          fs.closeSync(logFd);
          logFd = null;
        } catch (error) {
          stopError ??= error;
        }
      }
      if (stopError) {
        throw persistCleanupFailure(stopError) ?? stopError;
      }

      // #192 L2: read again after the try/catch settles, to decide whether this attempt must
      // still reject even though nothing threw.
      let lockLostOnStop = false;
      try {
        // #192 I5: `lockHandle` being non-null only proves this instance acquired the loop
        // lock at SOME point in the past — not that it still owns it now. Re-validate the
        // exact identity `releaseOwnedLock` itself checks (same inode, pid file pid and
        // startTime) right before trusting it for anything as consequential as a
        // coach-runtime-closure receipt or the stop's own success write (#192 L2).
        // #192 L2: `lockLostPermanently` keeps a retried `requestStop()` (its `lockHandle`
        // already nulled by the first attempt's own `releaseLock()`) failing closed instead
        // of looking like an instance that never held the lock at all.
        // #192 K2: decided before and independently of whether loop-state exists. A missing
        // file only means there is nothing to write; it must never turn a lock-lost stop
        // into a success.
        const lockStillOwned = ownedLockStillVerified();
        lockLostOnStop = lockLostPermanently || (Boolean(lockHandle) && !lockStillOwned);
        if (lockLostOnStop) {
          lockLostPermanently = true;
          log('coach-runtime-closure-lock-lost', {});
        } else if (lifecycleStarted && !preserveLoopState && fs.existsSync(loopStatePath)) {
          const resolvedFinalStatePatch = typeof pendingFinalStatePatch === 'function'
            ? pendingFinalStatePatch()
            : (pendingFinalStatePatch ?? {});
          // #192 S4 E1: reaching this line already proves every disposal, coach/training
          // task settle, terminateActiveChildren, and stopServer step above succeeded (the
          // `stopError` branch a few lines up throws before this point otherwise). The only
          // remaining gate is this instance's own in-memory lock ownership — `lockHandle` is
          // still set here, one line before `releaseLock()` nulls it — and whether this
          // instance ever actually issued an owner at all. A lock-failed instance, or a
          // resume that failed before owner issuance, has an empty `issuedOwners` and writes
          // nothing. Existing entries (from earlier instances, preserved by `writeLoopState`'s
          // merge) are kept verbatim and never duplicated for an owner already listed.
          const existingClosures = Array.isArray(readLoopState()?.coachRuntimeClosures)
            ? readLoopState().coachRuntimeClosures
            : [];
          const alreadyClosed = new Set(existingClosures.map((entry) => entry?.ownerSessionId));
          // #192 I1/sJ4: an unconfirmed coach adapter disposal means this instance cannot
          // attest that every coach child it may have spawned is actually gone — skip the
          // receipt entirely rather than write one that overclaims. Stop itself still
          // succeeds.
          if (undisposableCoachAdapter) {
            log('coach-runtime-closure-skipped', {
              reason: hasCoachAdapterWithoutDispose ? 'ADAPTER_DISPOSE_UNCONFIRMED' : 'DISPOSE_CONFIRMATION_UNDECLARED',
            });
          }
          const newClosures = !undisposableCoachAdapter
            ? [...issuedOwners]
              .filter((ownerSessionId) => !alreadyClosed.has(ownerSessionId))
              .map((ownerSessionId) => ({ ownerSessionId, confirmedAt: isoNow(now) }))
            : [];
          const currentPending = readLoopState()?.pendingDecision;
          let pendingPatch = {};
          if (currentPending) {
            const {freshAuthorization: _freshAuthorization, ...pending} = currentPending;
            const interrupted = ownedPlayerAttempt
              && ['gameEpoch','decisionId','generation'].every(key => pending[key] === ownedPlayerAttempt[key])
              && pending.status === 'running';
            pendingPatch = {pendingDecision: interrupted
              ? {...pending, status: 'recovery_required', code: 'INTERRUPTED', closeConfirmed: true, softWait: false}
              : pending};
          }
          writeLoopState({
            stopping: true,
            stoppedAt: isoNow(now),
            cleanupFailedAt: undefined,
            cleanupError: undefined,
            ...pendingPatch,
            ...(newClosures.length > 0
              ? { coachRuntimeClosures: [...existingClosures, ...newClosures] }
              : {}),
            ...resolvedFinalStatePatch,
          });
        }
        // #192 L2: kept unconditional exactly as before — releaseOwnedLock() already no-ops
        // silently when the on-disk identity no longer matches this handle, so calling it
        // here even when `lockLostOnStop` is true is harmless.
        releaseLock();
      } catch (error) {
        throw persistCleanupFailure(error) ?? error;
      }
      if (lockLostOnStop) {
        // #192 L2: thrown *outside* the try/catch above so this never routes back through
        // persistCleanupFailure — that would try to write a cleanupError, which is exactly
        // what "do not write loop-state when the lock is lost" forbids.
        logLoopLockLostOnStop();
        throw loopLockLostError();
      }
    })();
    stopPromise = attempt;
    attempt.catch(() => {
      // A failed attempt keeps ownership/resources but may be retried after the external
      // condition changes (child exits, signal works, filesystem recovers). Concurrent
      // callers during this attempt still shared the exact same Promise above.
      if (stopPromise === attempt) stopPromise = null;
    });
    return attempt;
  };

  const bootstrap = async ({
    ai,
    stack,
    levelEvery,
    blinds,
    mode,
    stackBb,
    hands,
    force = false,
    practiceFocusFile,
    preinitialized,
    skipLock = false,
    opponentRuntime,
    showdownPolicy,
    replayReveal,
    hints,
    dealBias,
  } = {}) => {
    if (skipLock) {
      if (!lockHandle) throw codedError('LOCKED', 'launcher loop lock handle이 없습니다.');
    } else {
      await acquireLoopLock({ mode: 'bootstrap', force });
    }
    try {
      if (force) {
        // force는 loop 유무와 무관하게 sidecar의 pid+startTime+listener+token
        // 사다리를 수행한다. 이 후 lock 부재가 증명된 상태에서만 init한다.
        await stopRereadServerForForce();
      }
      // engine init의 legacy readLock은 malformed/falsy 값을 부재로 접는다. 파괴적
      // archive/init 경계에 들어가기 전에 sidecar의 strict schema로 먼저 차단한다.
      readServerLock();
      let sweepNotices = [];
      let sweepFailed = 0;
      let sweepDetails = [];
      if (storeDir) {
        try {
          const swept = await sweepStore(storeDir, {
            evaluate: (sessionDir, handNo) => evaluateForPipeline(sessionDir, handNo),
            solve: typeof trainingHooks.solve === 'function' ? trainingHooks.solve : undefined,
          });
          sweepNotices = swept.notices ?? [];
          sweepFailed = swept.failed ?? 0;
          sweepDetails = [...(swept.skipped ?? []).map((row) => ({ event: 'profile-sweep-skipped', ...row })),
            ...(swept.errors ?? []).map((row) => ({ event: 'profile-sweep-error', ...row }))];
          if (sweepFailed > 0) {
            sweepNotices.push(`profile sweep consumer 실패: ${sweepFailed}건`);
          }
        } catch (error) {
          sweepNotices = [`profile sweep 실패: ${error.code ?? 'ERROR'}`];
          log('profile-sweep-error', { code: error.code ?? 'ERROR' });
        }
      }
      const initArgs = ['init', '--ai', String(ai), ...engineInitFlags({
        stack, levelEvery, blinds, mode, stackBb, hands,
        opponentRuntime: opponentRuntime ?? opponentRuntimeOf(),
        showdownPolicy,
        replayReveal,
        hints,
        dealBias,
      })];
      // Engine의 legacy --force는 PID-only server 정지를 포함한다. sidecar가
      // 안전하게 server lock을 없앤 후이므로 init에 force를 위임하지 않는다.
      const initialized = preinitialized ?? await runCli(initArgs);
      if (storeDir) resolveSessionReference(root, { createNew: true });
      openLog();
      for (const { event, ...detail } of sweepDetails) log(event, detail);
      lifecycleStarted = true;
      const startedAt = isoNow(now);
      const bootstrapOwnerSessionId = randomUUID();
      writeLoopState({
        phase: 'bootstrap',
        handNo: 0,
        port: null,
        sessionToken: initialized.sessionToken,
        gameEpoch: gameEpochOf(initialized.sessionToken),
        opponentRuntime: opponentRuntimeOf(),
        ownerSessionId: bootstrapOwnerSessionId,
        lastPublishId: null,
        playerRuntime: null,
        upperRuntime: null,
        startedAt,
        ...(initialized.archivedTo ? { archivedTo: initialized.archivedTo } : {}),
        notices: [],
        metrics: [],
        playerBudget: undefined,
      });
      // #192 S4 E1: only an owner this instance itself just durably wrote counts —
      // writeLoopState throwing above (e.g. a write failure) leaves this line unreached.
      issuedOwners.add(bootstrapOwnerSessionId);
      if(opponentRuntimeOf() !== 'policy') writeLoopState({playerBudget:currentWatchdog()});
      log('bootstrap-initialized', { sessionToken: initialized.sessionToken });
      if (sweepFailed > 0) log('profile-sweep-consume-failed', { failed: sweepFailed });

      const policyMode = opponentRuntimeOf() === 'policy';
      const requestedSelf = selfOpponentRequest?.requested;
      let assignedSelf = null;
      if (requestedSelf?.mirror || requestedSelf?.exploiter) {
        const sourceHands = selfOpponentRequest.tendency?.hands ?? 0;
        const sourceSessions = Array.isArray(selfOpponentRequest.sources)
          ? selfOpponentRequest.sources.length
          : 0;
        writeLoopState({
          selfOpponents: {
            requested: { mirror: !!requestedSelf.mirror, exploiter: !!requestedSelf.exploiter },
            sourceHands,
            sourceSessions,
          },
        });
        assignedSelf = assignSelfOpponents({
          root,
          players: readJsonOptional(playersPath, 'PLAYERS') ?? [],
          tendency: selfOpponentRequest.tendency,
          sources: selfOpponentRequest.sources ?? [],
          requested: requestedSelf,
          chooseSeat: selfOpponentRequest.chooseSeat,
        });
      }
      if (policyMode) stampPlayerPolicies(root, { onNotice: appendNotice });
      if (assignedSelf) {
        const sourceHands = selfOpponentRequest.tendency?.hands ?? 0;
        const sourceSessions = Array.isArray(selfOpponentRequest.sources)
          ? selfOpponentRequest.sources.length
          : 0;
        writeLoopState({
          selfOpponents: {
            requested: { mirror: !!requestedSelf.mirror, exploiter: !!requestedSelf.exploiter },
            assigned: {
              mirror: !!assignedSelf.assigned.mirror,
              exploiter: !!assignedSelf.assigned.exploiter,
            },
            sourceHands,
            sourceSessions,
          },
        });
        for (const notice of selfOpponentNotices({
          assigned: assignedSelf.assigned,
          sources: selfOpponentRequest.sources ?? [],
          targets: assignedSelf.targets ?? [],
        })) {
          appendNotice(notice);
        }
      }
      const resolved = await createCanaryAndResolve(policyMode ? 'upper-only' : 'player+upper');
      const gtoNotice = gtoEvalNotice(readJsonOptional(engineStatePath, 'ENGINE_STATE')?.config);
      const existingNotices = Array.isArray(readLoopState()?.notices) ? readLoopState().notices : [];
      const notices = [
        ...existingNotices,
        ...(Array.isArray(resolved?.notices) ? resolved.notices : []),
        ...sweepNotices,
        ...(gtoNotice ? [gtoNotice] : []),
        // 레거시 --game-dir는 training이 꺼진 채로 도는데, 지금까지는 아무 말도
        // 하지 않아 평가가 왜 비어 있는지 알 길이 없었다.
        ...(trainingOn ? [] : ['이 세션은 레거시 --game-dir라 training이 꺼져 있습니다. 학습 평가를 남기려면 --store-dir로 시작하세요.']),
      ];
      selectAdapters(resolved ?? {});
      writeLoopState({
        notices,
        playerRuntime: playerAdapter?.kind ?? null,
        upperRuntime: upperAdapter?.kind ?? null,
        opponentRuntime: opponentRuntimeOf(),
      });
      if (!policyMode && !playerAdapter) await haltNoPlayer(notices);

      const port = await ensureServer(initialized.sessionToken);
      writeLoopState({ port });
      installPracticeFocus({
        destRoot: root,
        storeDir,
        practiceFocusFile,
        onNotice: appendNotice,
      });
      if (!policyMode) await warmPlayers();
      const state = writeLoopState({ phase: 'playing' });
      log('bootstrap-playing', { port });
      return state;
    } catch (error) {
      try {
        await requestStop();
      } catch (stopError) {
        // #192 L2: same rule as resume — a lost loop lock must not hide why bootstrap
        // failed; other cleanup failures keep surfacing as before.
        if (stopError?.code !== 'LOOP_LOCK_LOST') throw stopError;
        log('bootstrap-cleanup-lock-lost', {});
      }
      throw error;
    }
  };

  const adoptAbortedRelay = async (engineState) => {
    const pin = openServerLockPin();
    try {
      if (pin && processAlive(pin.lock.serverPid)) {
        const lock = assertPinnedServerLock(pin);
        if (lock.sessionToken !== engineState.sessionToken) throw codedError('SERVER_LOCK_MISMATCH', '종료 게임 relay identity 불일치');
        const startTime = startTimeOf(lock.serverPid);
        if (!startTime) throw codedError('SERVER_IDENTITY_UNAVAILABLE', '종료 게임 relay identity 미확인');
        await assertServerBinding(lock);
        assertPinnedServerLock(pin);
        if (startTimeOf(lock.serverPid) !== startTime) throw codedError('SERVER_IDENTITY_MISMATCH', '종료 게임 relay identity 변경');
        serverPid = lock.serverPid; serverIdentity = {pid:serverPid,startTime};serverAdopted = true;
      }
    } finally {closeServerLockPin(pin);}
  };
  const logAbandonedRecovery = audit => log('player-recovery-abandoned', {
    operationId:audit.operationId,mode:audit.mode,sidecar:audit.sidecar,sha256:audit.sha256,
    reason:audit.reason,unverifiedSnapshot:audit.unverifiedSnapshot,abandonedAt:audit.abandonedAt,
  });
  const finishAbortedLifecycle = async (engineState, state = readLoopState()) => {
    let checkpoint = null;
    if (state?.aborting) {
      checkpoint = validateAbortingCheckpoint(root, engineState, state);
      if (!checkpoint) throw codedError('BAD_ABORT_CHECKPOINT','복구 종료 체크포인트를 검증할 수 없습니다.');
    }
    lifecycleStarted = true;
    assertNotStopping();
    const unit=beginAtomicTransition();
    try {
      if (checkpoint) {
        openLog();
        logAbandonedRecovery(state.abandonedPendingDecision);
      }
      await adoptAbortedRelay(engineState);
      writeLoopState({phase:'aborted',result:'abort',pendingDecision:undefined,aborting:undefined,endedAt:readLoopState()?.endedAt ?? isoNow(now)});
    } finally {unit.finish();}
    await requestStop();
    return {ok:true,code:'GAME_ENDED',resumed:false,phase:'aborted'};
  };

  const abandonUnverifiedRecovery = async (engineState, state) => {
    let checkpoint;
    // Rejected checkpoint bytes are evidence too; cleanup must not rewrite them.
    preserveLoopState=true;
    if (state?.aborting) {
      checkpoint=validateAbortingCheckpoint(root,engineState,state);
      if (!checkpoint) throw codedError('BAD_ABORT_CHECKPOINT','복구 종료 체크포인트를 검증할 수 없습니다.');
      preserveLoopState=false;
      logAbandonedRecovery(state.abandonedPendingDecision);
    } else {
      // Until the raw evidence is durably published, cleanup must not serialize it.
      preserveLoopState=true;
      const operationId=opts.abortUnrecoverable?.operationId;
      const mode=abortModeFor(engineState,state);
      if (!validRecoveryOperation(operationId)) throw codedError('BAD_OPERATION_ID','복구 종료 operationId가 올바르지 않습니다.');
      if (!mode) throw codedError('BAD_LOOP_PHASE','복구 종료 대상 상태가 아닙니다.');
      const snapshotPath=path.join(root,'loop-state.unverified.json');
      const unverifiedSnapshot=fs.existsSync(snapshotPath);
      const bytes=unverifiedSnapshot ? openContained(root,['loop-state.unverified.json'],{maxBytes:Number.MAX_SAFE_INTEGER}) : fs.readFileSync(loopStatePath);
      const sha256=createHash('sha256').update(bytes).digest('hex');
      const sidecar=`loop-state.abandoned.${operationId}.json`;
      try {writeContained(root,[sidecar],bytes,{mode:'create'});}
      catch(error) {
        if (error.code!=='EXISTS') throw error;
        let matches=false;
        try {matches=createHash('sha256').update(openContained(root,[sidecar],{maxBytes:Number.MAX_SAFE_INTEGER})).digest('hex')===sha256;}catch{}
        if (!matches) throw codedError('ABANDON_SIDECAR_CONFLICT','기존 감사 파일이 달라 덮어쓰지 않습니다.');
      }
      checkpoint={operationId,mode};
      const audit={...checkpoint,sidecar,sha256,unverifiedSnapshot,abandonedAt:isoNow(now),reason:'BAD_PLAYER_RECOVERY'};
      state=writeLoopState({pendingDecision:undefined,aborting:checkpoint,abandonedPendingDecision:audit});
      preserveLoopState=false;
      logAbandonedRecovery(audit);
    }
    assertNotStopping();
    const unit=beginAtomicTransition();
    try {
      if (checkpoint.mode==='abort') {
        await runCli(['end','--result','abort','--operation-id',checkpoint.operationId]);
        await adoptAbortedRelay(engineState);
        writeLoopState({phase:'aborted',result:'abort',endedAt:isoNow(now),aborting:undefined});
      } else writeLoopState({aborting:undefined});
    } finally {unit.finish();}
    if (checkpoint.mode==='abort') {
      await requestStop();
      return {ok:true,code:'GAME_ENDED',resumed:false,phase:'aborted'};
    }
    return null;
  };

  const resolveForPhase = async (phase, engineState, existingState, {
    beforePlayingResume = null,
  } = {}) => {
    if (phase === 'aborted' || engineState?.result === 'abort') return finishAbortedLifecycle(engineState, existingState);
    if (FINAL_PHASES.has(phase)) {
      if (!engineState) throw codedError('NO_GAME', 'engine state가 없습니다.');
      const policyMode = opponentRuntimeOf() === 'policy'
        || existingState.opponentRuntime === 'policy';
      const resolved = await createCanaryAndResolve('upper-only');
      selectAdapters(resolved ?? {});
      const notices = [
        ...(Array.isArray(existingState.notices) ? existingState.notices : []),
        ...(Array.isArray(resolved?.notices) ? resolved.notices : []),
      ];
      writeLoopState({
        notices,
        upperRuntime: upperAdapter?.kind ?? null,
        ...(RESUMABLE_FINAL_HALTS.has(existingState.halt?.code) ? { halt: undefined } : {}),
      });
      // 종료 시퀀스도 잔여 Q·리뷰를 게시해야 한다. 플레이어 워밍업은 여전히 생략하지만
      // 서버는 이 지점부터 살아 있어야 한다.
      const desiredPort = Number.isSafeInteger(existingState.port) && existingState.port > 0
        ? existingState.port
        : requestedPort;
      if (policyMode) {
        const players = readJsonOptional(playersPath, 'PLAYERS') ?? [];
        assertSelfOpponentsConsistent({ root, players });
        stampPlayerPolicies(root, { onNotice: appendNotice });
      }
      const port = await ensureServer(engineState.sessionToken, { port: desiredPort });
      return writeLoopState({ port });
    }
    if (phase === 'done') {
      await ensureStudyForOwner();
      const liveLock = readServerLock();
      if (liveLock && processAlive(liveLock.serverPid)) {
        const port = await ensureServer(engineState.sessionToken, { port: liveLock.port });
        return writeLoopState({ port });
      }
      return existingState;
    }
    if (phase !== 'bootstrap' && phase !== 'playing') {
      throw codedError('BAD_LOOP_PHASE', `알 수 없는 loop phase: ${phase}`);
    }
    if (!engineState) throw codedError('NO_GAME', 'engine state가 없습니다.');

    const policyMode = opponentRuntimeOf() === 'policy' || existingState.opponentRuntime === 'policy';
    const resolved = await createCanaryAndResolve(policyMode ? 'upper-only' : 'player+upper');
    selectAdapters(resolved ?? {});
    const notices = [
      ...(Array.isArray(existingState.notices) ? existingState.notices : []),
      ...(Array.isArray(resolved?.notices) ? resolved.notices : []),
    ];
    writeLoopState({
      notices,
      playerRuntime: playerAdapter?.kind ?? null,
      upperRuntime: upperAdapter?.kind ?? null,
      opponentRuntime: policyMode ? 'policy' : (existingState.opponentRuntime ?? 'llm'),
      ...(existingState.halt?.code === 'NO_PLAYER_RUNTIME' && playerAdapter ? { halt: undefined } : {}),
    });
    if (!policyMode && !playerAdapter) await haltNoPlayer(notices);
    const desiredPort = Number.isSafeInteger(existingState.port) && existingState.port > 0
      ? existingState.port
      : requestedPort;
    const port = await ensureServer(engineState.sessionToken, { port: desiredPort });
    writeLoopState({ port });
    // #192 D6 (FO-3): persisted-coach reclaim is a playing-resume step, not a player-restore
    // step — it must run once here for policy and llm resumes alike, after the server is up
    // and before either policy stamping or player restore, and always before `resume()`'s
    // later `beginCoachOwner` call. Skipping it for policy games (the old bug) let a policy
    // resume start a replacement coach owner while an old game's coach child was still alive.
    if (phase === 'playing' && typeof beforePlayingResume === 'function') await beforePlayingResume();
    if (policyMode) {
      const players = readJsonOptional(playersPath, 'PLAYERS') ?? [];
      assertSelfOpponentsConsistent({ root, players });
      stampPlayerPolicies(root, { onNotice: appendNotice });
    } else {
      await restorePlayers();
    }
    return writeLoopState({ phase: 'playing' });
  };

  const resume = async ({ skipLock = false } = {}) => {
    recoveringControl = true;
    if (skipLock) {
      if (!lockHandle) throw codedError('LOCKED', 'launcher loop lock handle이 없습니다.');
    } else {
      await acquireLoopLock({ mode: 'resume' });
    }
    let trainingMigrationNotices = [];
    let trainingMigrationError = null;
    try {
      const engineState = readJsonOptional(engineStatePath, 'ENGINE_STATE');
      let state = readLoopState();
      if (!engineState) throw codedError('NO_GAME', 'resume할 engine 상태가 없습니다.');
      if (typeof engineState.sessionToken !== 'string' || engineState.sessionToken === '') {
        throw codedError('BAD_ENGINE_IDENTITY', 'resume할 engine sessionToken이 없습니다.');
      }
      const canonicalEpoch = gameEpochOf(engineState.sessionToken);
      if (state && (
        state.sessionToken !== engineState.sessionToken
        || state.gameEpoch !== canonicalEpoch
      )) {
        throw codedError(
          'LOOP_STATE_IDENTITY_MISMATCH',
          'loop-state sessionToken/gameEpoch가 engine identity와 일치하지 않습니다.',
        );
      }
      if (state?.phase === 'aborted' && engineState.result !== 'abort') throw codedError('LOOP_STATE_IDENTITY_MISMATCH','종료 상태가 엔진과 일치하지 않습니다.');
      if (engineState.result === 'abort') return finishAbortedLifecycle(engineState, state);
      openLog();
      lifecycleStarted = true;
      if (opts.abortUnrecoverable || state?.aborting) {
        const ended=await abandonUnverifiedRecovery(engineState,state);
        if (ended) return ended;
        state=readLoopState();
      }
      // Preserve an invalid pending record before configuration checks or the
      // first hint capability await can enter shutdown and serialize its bytes.
      if (state?.phase !== 'done' && state?.pendingDecision) {
        const p = state.pendingDecision;
        if (![1, 2].includes(p.schemaVersion) || p.gameEpoch !== canonicalEpoch || !Number.isSafeInteger(p.generation) || p.generation < 1
          || !['running', 'recovery_required', 'retry_authorized', 'unsafe'].includes(p.status)) {
          try {
            writeContained(root,['loop-state.unverified.json'],fs.readFileSync(loopStatePath),{mode:'create'});
          } catch(error) {
            if (error.code==='EXISTS') {
              try {openContained(root,['loop-state.unverified.json'],{maxBytes:Number.MAX_SAFE_INTEGER});}
              catch {preserveLoopState=true;}
            } else preserveLoopState=true;
          }
          throw codedError('BAD_PLAYER_RECOVERY', '미해결 결정 기록을 검증할 수 없습니다.');
        }
      }
      opts.hints=checkHintResume(engineState.config, opts.hints);
      opts.dealBias=checkDealBiasResume(engineState.config,opts.dealBias);
      if (engineState.config?.hintContractVersion === 1) await assertHintEngine();
      openLog();
      lifecycleStarted = true;
      if (state?.phase === 'done' && state.pendingDecision) state = writeLoopState({ pendingDecision: undefined });
      if (state?.pendingDecision) {
        let p = state.pendingDecision;
        // A fresh-session grant only authorizes the immediately following in-process
        // retry. Resume never inherits it, regardless of the persisted status.
        if (Object.hasOwn(p, 'freshAuthorization')) {
          const {freshAuthorization: _freshAuthorization, ...withoutAuthorization} = p;
          p = withoutAuthorization;
          state = writeLoopState({pendingDecision:p});
        }
        const check = validateDiagnostics(p.diagnostics, p);
        if (!check.ok) { p = quarantineDiagnostics(p, check.reason); state = readLoopState(); }
        const applied = [...(engineState.hand?.actions ?? []), ...(engineState.lastHand?.actions ?? [])]
          .find((action) => action.decisionId === p.decisionId && action.playerId === p.playerId);
        if (applied && p.proposedAction && p.closeConfirmed === true
          && applied.action === p.proposedAction.action
          && (applied.action !== 'raise' || applied.amount === p.proposedAction.amount)) {
          state = writeLoopState({ pendingDecision: undefined });
          log('player-decision-reconciled', { decisionId: p.decisionId, generation: p.generation });
        } else {
        // A persisted running child has no post-crash close receipt. Do not
        // convert parent death into permission to spawn another model call.
        if (p.status === 'running') state = writeLoopState({ pendingDecision: { ...p, softWait: false,
          status: p.closeConfirmed === true ? 'recovery_required' : 'unsafe',
          code: p.closeConfirmed === true ? 'INTERRUPTED' : 'CHILD_CLOSE_UNCONFIRMED' } });
        if (p.status === 'retry_authorized') state = writeLoopState({ pendingDecision: { ...p, softWait: false, status: 'recovery_required' } });
        if (managed) pauseRequested = true;
        }
      }
      if (state?.playerBudget) playerBudget(state.playerBudget);

      if (state?.phase === 'done') {
        if (state.halt?.source === 'training-migration') {
          state = writeLoopState({ halt: undefined });
        }
        doneResumeNoTrainingWrite = true;
        const resumed = await resolveForPhase('done', engineState, state);
        log('resume-ready', { phase: resumed.phase });
        return resumed;
      }

      if (trainingOn) {
        try {
          const migration = await createTrainingControl({ storeDir }).migrateAuthority(root, {
            ...(typeof state?.ownerSessionId === 'string' && state.ownerSessionId !== ''
              ? { recoverOwnerId: state.ownerSessionId }
              : {}),
          });
          trainingMigrationNotices = migration?.notices ?? [];
        } catch (error) {
          trainingMigrationError = error;
          trainingMigrationNotices = [
            `training migration halt: ${error.code ?? 'ERROR'}`,
          ];
        }
      }

      const resumeNotices = [...new Set([
        ...(Array.isArray(state?.notices)
          ? state.notices.filter((notice) => (
            trainingMigrationError || !String(notice).startsWith('training migration halt:')
          ))
          : []),
        ...trainingMigrationNotices,
      ])];
      if (trainingMigrationError) {
        const code = trainingMigrationError.code ?? 'TRAINING_MIGRATION_FAILED';
        const message = `training authority 마이그레이션을 완료할 수 없습니다 (${code}).`;
        state = writeLoopState({
          halt: { code, message, source: 'training-migration' },
          notices: resumeNotices,
        });
        log('training-migration-halt', { code });
        return state;
      }

      const ownerSessionId = randomUUID();
      if (!state) {
        const phase = engineState.gameOver ? 'finalizing' : 'playing';
        state = writeLoopState({
          phase,
          handNo: engineState.handNo ?? 0,
          port: null,
          sessionToken: engineState.sessionToken,
          gameEpoch: canonicalEpoch,
          ownerSessionId,
          stopping: false,
          lastPublishId: null,
          playerRuntime: null,
          upperRuntime: null,
          startedAt: isoNow(now),
          notices: resumeNotices,
          metrics: [],
          opponentRuntime: engineState.policySeed ? 'policy' : requestedOpponentRuntime,
        });
      } else {
        state = writeLoopState({ ownerSessionId, stopping: false, notices: resumeNotices });
      }
      // #192 S4 E1: same rule as bootstrap — only after the write above has actually
      // succeeded does this instance count `ownerSessionId` as its own issued owner. A
      // throw from either `writeLoopState` call leaves this line unreached, and everything
      // in `resume()` before this point (training migration, `pendingDecision` validation,
      // `lifecycleStarted`) runs before any owner is issued at all.
      issuedOwners.add(ownerSessionId);

      if (state.halt?.source === 'training-migration') {
        state = writeLoopState({ halt: undefined });
      }

      if (trainingOn) {
        try {
          const takeover = await createTrainingControl({ storeDir })
            .takeoverOwner(root, ownerSessionId, { reason: 'resume' });
          log('training-owner-transferred', {
            ownerSessionId,
            transferred: takeover.transferred,
          });
        } catch (error) {
          const code = error.code ?? 'TRAINING_OWNER_TAKEOVER_FAILED';
          const message = `training owner 교대를 완료할 수 없습니다 (${code}).`;
          const notices = [...new Set([
            ...resumeNotices,
            `training owner halt: ${code}`,
          ])];
          state = writeLoopState({
            halt: { code, message, source: 'training-owner' },
            notices,
          });
          log('training-owner-halt', { code });
          return state;
        }
        if (state.halt?.source === 'training-owner') {
          state = writeLoopState({ halt: undefined });
        }
      }

      if (storeDir) {
        try {
          await completeSessionStoreMigration(storeDir, root);
        } catch (error) {
          log('profile-migration-error', { code: error.code ?? 'ERROR' });
        }
        await consumeTrainingNow();
      }

      let phase = state.phase;
      if (phase === 'playing' && engineState?.gameOver) {
        phase = 'finalizing';
        state = writeLoopState({ phase });
      }
      const priorPlayingRecoveryHalt = state.halt?.code === 'COACH_HANDLE_UNRESOLVED';
      let resumed = await resolveForPhase(phase, engineState, state, {
        beforePlayingResume: phase === 'playing'
          ? async () => {
            const persisted = await reclaimPersistedCoachWorkersForResume(
              Number(engineState.lastHand?.handNo ?? 0),
              { policyMode: opponentRuntimeOf() === 'policy' },
            );
            if (!persisted.confirmed) throw haltForPlayingCoachRecovery(persisted);
            if (priorPlayingRecoveryHalt && persisted.authorityPresent !== true) {
              throw codedError(
                'COACH_HANDLE_UNRESOLVED',
                readLoopState()?.halt?.message ?? 'persisted coach recovery evidence가 부족합니다.',
              );
            }
            clearPlayingCoachRecoveryHalt();
          }
          : null,
      });
      // §5 finalizing 1: --resume으로 종료 국면에 들어온 경우에만 owner를 교체한다.
      // begin-owner가 seal/Q에 없는 핸드만 새 descriptor로 돌려주므로, 살아 있는
      // generation이 없는 크래시 재개에서만 그 핸드를 다시 스폰한다.
      if (resumed.phase === 'playing') {
        await beginCoachOwner(Number(engineState.lastHand?.handNo ?? 0));
        await reconcileTrainingNow();
        resumed = readLoopState();
      } else if (resumed.phase === 'finalizing') {
        ensureFinalizationResultWaitCutoff();
        const persisted = await closePersistedCoachWorkers();
        finalizationPriorTerminationConfirmed = persisted.confirmed;
        if (!persisted.confirmed) throw haltForPersistedCoachRecovery(persisted);
        await beginCoachOwner(
          Number(engineState.lastHand?.handNo ?? 0),
          { drainQueued: false },
        );
        resumed = readLoopState();
      }
      resumeEntryPending = resumed.phase === 'playing';
      log('resume-ready', { phase: resumed.phase });
      return resumed;
    } catch (error) {
      const translated = translateFinalizationDeadline(error);
      // #192 L2: this cleanup stop is best-effort — a failure here (e.g. `LOOP_LOCK_LOST`,
      // surfaced once `requestStop` itself started re-checking lock ownership) must not mask
      // the original halt/finalization reason `translated` already carries.
      try {
        if (lifecycleStarted) await requestStop();
        else releaseLock();
      } catch (stopError) {
        // #192 L2: only a lost loop lock is swallowed here, so the halt that ended this
        // resume (for example FINALIZATION_ABORTED) stays the reported error. Any other
        // cleanup failure keeps surfacing exactly as before this slice.
        if (stopError?.code !== 'LOOP_LOCK_LOST') throw stopError;
        log('resume-cleanup-lock-lost', {});
      }
      throw translated;
    }
  };

  const runFinalization = async () => {
    try {
      let state = readLoopState();
      if (state?.phase === 'finalizing') {
        await finalize();
        state = readLoopState();
      }
      if (state?.phase === 'review_generated') {
        await publishGeneratedReview();
        state = readLoopState();
      }
      if (state?.phase === 'review_published') return finishDoneLifecycle();
      if (state?.phase === 'done') return finishDoneLifecycle();
      if (stopRequested) return readLoopState() ?? state;
      throw codedError('BAD_LOOP_PHASE', `종료 시퀀스를 재개할 수 없는 phase: ${state?.phase ?? '없음'}`);
    } catch (error) {
      throw translateFinalizationDeadline(error);
    }
  };

  const run = async () => {
    let state = readLoopState();
    if (!state) throw codedError('NOT_BOOTSTRAPPED', 'bootstrap 또는 resume이 필요합니다.');
    if (state.aborting) throw codedError('BAD_LOOP_PHASE','복구 종료 체크포인트는 resume으로 마무리해야 합니다.');
    const engineForPending = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (engineForPending) unionReplayPending(completedReplayHandNos(engineForPending));
    const repairingOnResume = resumeEntryPending && state.halt?.code === 'repair_failed';
    if (state.halt?.code && !repairingOnResume) throw codedError(state.halt.code, state.halt.message);
    if (state.phase === 'aborted' || engineForPending?.result === 'abort') { await finishAbortedLifecycle(engineForPending, state); return readLoopState(); }
    if (FINAL_PHASES.has(state.phase)) return runFinalization();
    if (state.phase === 'done') return finishDoneLifecycle();
    if (state.phase !== 'playing') {
      throw codedError('BOOTSTRAP_INCOMPLETE', `run할 수 없는 phase: ${state.phase}`);
    }

    const engine = readJsonOptional(engineStatePath, 'ENGINE_STATE');
    if (!engine) throw codedError('NO_GAME', 'engine state가 없습니다.');
    if (engine.gameOver) {
      writeLoopState({ phase: 'finalizing', handNo: engine.handNo ?? state.handNo });
      return runFinalization();
    }

    let out;
    if(opts.retryDecisionId && !state.pendingDecision) throw codedError('PLAYER_RECOVERY_REQUIRED','재시도할 미해결 결정이 없습니다.');
    if (state.pendingDecision && state.pendingDecision.status !== 'retry_authorized' && !managed) {
      if (!opts.retryDecisionId) throw codedError('PLAYER_RECOVERY_REQUIRED', '미해결 결정을 보존했습니다. --resume --retry-decision <decisionId>로 재시도하세요.');
      await retryDecision(opts.retryDecisionId, {freshAuthorization: opts.freshAuthorization ?? null});
    }
    if (managed && pauseRequested) { await pauseBarrier(await runCli(['step'])); if (stopRequested) return readLoopState(); }
    if (resumeEntryPending) {
      const current = await runCli(['step']);
      if (fs.existsSync(path.join(root, '.publish-attempt.json'))) {
        await publishEnvelope(current, ['--retry']);
      }
      const checked = await runCli(['resume-check']);
      const checkedHandNo = Number(engine.lastHand?.handNo ?? 0);
      if (Number.isSafeInteger(checkedHandNo) && checkedHandNo >= 0) {
        archiveCheckedHands.add(checkedHandNo);
      }
      log('resume-archive-check', { handNo: checkedHandNo, archiveStatus: checked.archiveStatus });
      if (checked.archiveStatus === 'repair_failed') {
        const message = 'resume 중 아카이브 복구에 실패해 게임을 중단합니다.';
        writeLoopState({ halt: { code: 'repair_failed', message } });
        throw codedError('repair_failed', message);
      }
      if (readLoopState()?.halt?.code === 'repair_failed') writeLoopState({ halt: undefined });
      resumeEntryPending = false;
      if (engine.hand) {
        out = await publishEnvelope(current, ['--view-only', ...waitFlags()]);
      } else {
        out = await runAtomicStepPublish(['step', '--new-hand'], waitFlags());
      }
    } else if (engine.hand) {
      const synchronized = await runCli(['step']);
      out = await publishEnvelope(synchronized, ['--view-only', ...waitFlags()]);
    } else {
      out = await runAtomicStepPublish(['step', '--new-hand'], waitFlags());
    }

      while (!stopRequested) {
      out = await pauseBarrier(out);
      if (stopRequested || out === null) break;
      await checkArchivePending(out);
      if (out.handOver) {
        const userBusted = Array.isArray(out.control?.bust) && out.control.bust.includes('user');
        const ending = out.gameOver || userBusted;
        if (ending) ensureFinalizationResultWaitCutoff();
        launchTrainingPipeline(out.handNo);
        trackAuxiliary(consumeTrainingNow()).catch(() => {});
        try {
          await heartbeatCoach();
        } catch (error) {
          appendNotice(`코치 heartbeat 오류: ${error.code ?? 'ERROR'}`);
          log('coach-heartbeat-error', { handNo: out.handNo, code: error.code ?? 'ERROR' });
        }
        if (stopRequested) break;
        launchCoachPipeline(out.handNo);
        if (ending) {
          pauseRequested=false;resolvePause?.({state:'finalizing'});resolvePause=null;
          // §5 finalizing 1: handOver 분기가 이미 async로 띄운 마지막 핸드 generation을
          // 그대로 둔다. 여기서 reserve를 다시 부르면 그 prior가 discard된다.
          writeLoopState({ phase: 'finalizing', handNo: out.handNo });
          return await runFinalization();
        }
        if (stopRequested) break;
        out = await pauseBarrier(out);
        if (stopRequested || out === null) break;
        out = await runAtomicStepPublish(['step', '--new-hand'], (started) => {
          const narration = started.events?.find((event) => event.type === 'level_up');
          return narration
            ? ['--narration', `블라인드 ${narration.sb}/${narration.bb}`, ...waitFlags()]
            : waitFlags();
        });
        continue;
      }

      if (out.next?.kind === 'user') {
        try {
          out = await handleUserTurn(out);
        } catch (error) {
          if (stopRequested && error.code !== 'STOPPING') break;
          throw error;
        }
        if (out === null) break;
        continue;
      }
      if (out.next?.kind !== 'ai') {
        throw codedError('BAD_NEXT', '다음 행동자 계약이 ai/user가 아닙니다.');
      }

      const next = out.next;
      let decision;
      try {
        decision = opponentRuntimeOf() === 'policy'
          ? await decideWithPolicy(next, out.stateVersion)
          : await decideWithWatchdog(next, out.stateVersion);
      } catch (error) {
        if (stopRequested && error.code !== 'STOPPING') break;
        if (error.code !== 'VERSION_MISMATCH') throw error;
        const synchronized = await runCli(['step']);
        writeLoopState({ pendingDecision: undefined });
        log('version-resync', {
          staleDecisionId: next.decisionId,
          stateVersion: synchronized.stateVersion,
        });
        out = await publishEnvelope(synchronized, ['--view-only', ...waitFlags()]);
        continue;
      }
      if (decision.kind === 'recovery_required') {
        if (stopRequested) break;
        if (!managed) throw codedError('PLAYER_RECOVERY_REQUIRED', 'LLM 결정이 미해결 상태로 저장되었습니다. 명시적으로 재시도하거나 종료하세요.');
        pauseRequested = true;
        await retryControlWrite(() => control.set('pausing', { pauseIntent: true }));
        out = await publishEnvelope(await runCli(['step']), ['--view-only']);
        continue;
      }
      const elapsedMs = Math.max(0, monotonicNow() - decision.startedAt);
      const publishStarted = monotonicNow();
      const metric = {
        playerId: next.toAct,
        decisionId: next.decisionId,
        runtime: opponentRuntimeOf() === 'policy' ? 'policy' : playerAdapter.kind,
        outcome: decision.outcome,
        elapsedMs,
        modelMs: decision.modelMs,
        parseMs: decision.parseMs,
        stepMs: decision.stepMs,
        ...(decision.sessionRepaired ? { sessionRepaired: true } : {}),
        ...(decision.freshSession ? { freshSession: true } : {}),
        ...(decision.corrected ? { corrected: true } : {}),
      };
      try {
        out = await publishEnvelope(decision.envelope, waitFlags());
        const publishMs = Math.max(0, monotonicNow() - publishStarted);
        appendMetric({ ...metric, publishMs });
      } catch (error) {
        // Engine step이 적용된 이상 게시 실패로 표본을 숨기지 않는다.
        // outcome은 모델 결정 결과를 그대로 두고, 게시 경계는 별도 code로 정직하게 표시한다.
        appendMetric({
          ...metric,
          publishMs: Math.max(0, monotonicNow() - publishStarted),
          publishError: error.code ?? 'ERROR',
        });
        throw error;
      } finally {
        decision.atomicUnit.finish();
      }
    }
    return readLoopState();
  };

  return {
    bootstrap,
    resume,
    run,
    coachPipeline,
    pause, resumePlay, retryDecision, endGame,
    get pendingDecision() { return readLoopState()?.pendingDecision ?? null; },
    get playState() { return control?.read().playState ?? null; },
    requestStop,
    get stopping() { return stopRequested; },
    get serverPid() { return serverPid; },
  };
}

export async function initializePreparedSession(gameDir, args) {
  if (args.hints !== undefined) {
    await new Promise((resolve,reject)=>execFile(process.execPath,[ENGINE_CLI,'capabilities'],childSpawnOptions({encoding:'utf8',timeout:5000,maxBuffer:4096}),(error,stdout)=>{
      let caps;try{caps=JSON.parse(stdout);}catch{}
      if(error || caps?.preActionHints!==1 || caps?.hintContractVersion!==1) reject(codedError('HINT_CAPABILITY_UNAVAILABLE','engine hint capability missing'));else resolve();
    }));
  }
  const initArgs = ['init', '--ai', String(args.ai), '--game-dir', gameDir, ...engineInitFlags(args)];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [ENGINE_CLI, ...initArgs], childSpawnOptions({
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }), (error, stdout, stderr) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim()); } catch { /* classified below */ }
      if (error || envelope?.ok !== true) {
        reject(codedError(
          envelope?.code ?? error?.code ?? 'CHILD_FAILED',
          envelope?.message || String(stderr).trim() || 'engine init이 실패했습니다.',
          { cause: error, envelope },
        ));
        return;
      }
      resolve(envelope);
    });
  });
}

export async function prepareGameSession(args, { resolver, loopOptions = {}, onReserve } = {}) {
  loopOptions = { ...loopOptions, dealBias:args.dealBias, retryDecisionId: args.retryDecisionId,
    ...(args.abortUnrecoverableId !== undefined ? {abortUnrecoverable:{operationId:args.abortUnrecoverableId}} : {}),
    ...(args.freshSession ? {freshAuthorization:{source:'legacy',requestId:null}} : {}),
    retryBudget: { ...(args.playerSoftMs !== undefined ? { softMs: args.playerSoftMs } : {}),
      ...(args.playerHardMs !== undefined ? { hardMs: args.playerHardMs } : {}) },
    playerBudget: args.resume ? undefined : playerBudget({ ...(args.playerSoftMs !== undefined ? { softMs: args.playerSoftMs } : {}),
      ...(args.playerHardMs !== undefined ? { hardMs: args.playerHardMs } : {}) }) };
  let loop = null;
  let preparedInitialization = null;
  let resolvedCurrent = null;
    if (args.storeDir !== undefined) {
      if (args.force) throw codedError('FORCE_UNAVAILABLE', '--store-dir MVP에서는 --force를 지원하지 않습니다.');
      // Process entrypoints restrict umask; the shared launcher never changes
      // process-wide settings or chmods caller-owned directories.

      let selfOpponentSource = null;
      if (!args.resume && (args.mirrorSelf || args.exploitSelf)) {
        selfOpponentSource = requireStoreTendency(args.storeDir);
      }
      ensureSessionStore(args.storeDir);
      let storeLockHandle;
      try {
        storeLockHandle = acquireOwnedLock(args.storeDir, LOOP_LOCK);
      } catch (error) {
        if (error.code === 'LOCKED') throw codedError('ACTIVE_GAME', '이미 진행 중인 게임이 있습니다.');
        throw error;
      }
      try {
        if (args.resume) {
          const current = resolveCurrentSession(args.storeDir);
          if (!current) throw codedError('NO_GAME', '재개할 current session이 없습니다.');
          const storedEngine=JSON.parse(openContained(current.sessionDir,['state.json'],{maxBytes:2*1024*1024}));
          if (args.expectedCurrent) {
            const expected=args.expectedCurrent;
            if (current.gameId!==expected.gameId || current.selectionVersion!==expected.selectionVersion
              || typeof storedEngine.sessionToken!=='string' || gameEpochOf(storedEngine.sessionToken)!==expected.gameEpoch) {
              throw codedError('CURRENT_CHANGED','복구 종료 대상 게임이 변경됐습니다.');
            }
          }
          resolvedCurrent=current;
          const storedConfig=storedEngine.config;
          checkHintResume(storedConfig,args.hints);
          checkDealBiasResume(storedConfig,args.dealBias);
          resolveSessionReference(current.sessionDir);
          loop = createGameLoop({
            gameDir: current.sessionDir,
            lockDir: args.storeDir,
            initialLockHandle: storeLockHandle,
            resolver,
            opts: {
              ...loopOptions,
              port: args.port,
              hints: args.hints,
              trainingEnabled: true,
              storeDir: args.storeDir,
              opponentRuntime: args.opponentRuntime,
              solverAdapterId: args.solverAdapterId,
            },
          });
        } else {
          const previous = resolveCurrentSession(args.storeDir);
          const previousServer = previous ? readStrictServerLock(previous.sessionDir) : null;
          if (previousServer && isAlive(previousServer.serverPid)) {
            throw codedError('ACTIVE_GAME', '이전 session server가 아직 실행 중입니다.');
          }
          const reservation = onReserve ? await onReserve(previous) : null;
          const prepared = prepareSession(args.storeDir, reservation);
          const initialized = prepared.recovering ? readPreparation(prepared) : await initializePreparedSession(prepared.stagingDir, args);
          preparedInitialization = initialized;
          if (!prepared.recovering) resolveSessionReference(prepared.stagingDir, { createNew: true });
          if (!prepared.recovering && (args.mirrorSelf || args.exploitSelf)) {
            writeSelfOpponentsMarker(prepared.stagingDir, {
              requested: { mirror: !!args.mirrorSelf, exploiter: !!args.exploitSelf },
              sourceHands: selfOpponentSource?.tendency?.hands ?? 0,
              sourceSessions: selfOpponentSource?.sources?.length ?? 0,
            });
          }
          if (!prepared.recovering && loopOptions.appSetup) writeJsonAtomic(path.join(prepared.stagingDir,'.app-setup.json'),loopOptions.appSetup);
          if (!prepared.recovering) sealPreparation(prepared, initialized);
          const committed = commitSession(args.storeDir, prepared);
          loop = createGameLoop({
            gameDir: committed.sessionDir,
            lockDir: args.storeDir,
            initialLockHandle: storeLockHandle,
            resolver,
            opts: {
              ...loopOptions,
              port: args.port,
              hints: args.hints,
              trainingEnabled: true,
              storeDir: args.storeDir,
              opponentRuntime: args.opponentRuntime,
              solverAdapterId: args.solverAdapterId,
              selfOpponents: (args.mirrorSelf || args.exploitSelf)
                ? {
                  requested: { mirror: !!args.mirrorSelf, exploiter: !!args.exploitSelf },
                  tendency: selfOpponentSource?.tendency,
                  sources: selfOpponentSource?.sources ?? [],
                }
                : null,
            },
          });
        }
      } catch (error) {
        if (!loop) releaseOwnedLock(storeLockHandle);
        throw error;
      }
    } else {
      assertNotSessionCatalogTarget(args.gameDir);
      loop = createGameLoop({
        gameDir: args.gameDir,
        resolver,
        opts: {
              ...loopOptions, port: args.port, opponentRuntime: args.opponentRuntime, solverAdapterId: args.solverAdapterId },
      });
    }
  return { loop, preparedInitialization, current: resolvedCurrent };
}

async function main() {
  process.umask(0o077);
  let loop = null;
  let preparedInitialization = null;
  let caught = null;
  let handlingSignal = false;
  let signalStopPromise = null;
  let signalStopError = null;
  try {
    const args = applyModeDefaults(parseGameLoopArgs(process.argv.slice(2)));
    validateSelfOpponentArgs(args);
    if (!args.resume && args.ai === undefined) throw codedError('USAGE', '--ai가 필요합니다.');
    const resolver = ({ need, canaryAbsPath, registerAdapter }) => resolveRuntimes({
      need,
      canaryAbsPath,
      preferred: args.playerRuntime ?? null,
      onAdapterCreated: registerAdapter,
    });
    ({ loop, preparedInitialization } = await prepareGameSession(args, { resolver }));
    process.once('SIGTERM', () => {
      if (handlingSignal) return;
      handlingSignal = true;
      signalStopPromise = loop.requestStop().catch((error) => {
        signalStopError = error;
      });
    });
    let resumed;
    if (args.resume) {resumed = await loop.resume({ skipLock: args.storeDir !== undefined });if(resumed?.code==='GAME_ENDED')fs.writeSync(1,JSON.stringify(resumed)+'\n');}
    else await loop.bootstrap({
      ai: args.ai,
      stack: args.stack,
      levelEvery: args.levelEvery,
      blinds: args.blinds,
      mode: args.mode,
      stackBb: args.stackBb,
      hands: args.hands,
      force: args.force,
      practiceFocusFile: args.practiceFocusFile,
      preinitialized: preparedInitialization,
      skipLock: args.storeDir !== undefined,
      opponentRuntime: args.opponentRuntime,
      showdownPolicy: args.showdownPolicy,
      replayReveal: args.replayReveal,
      hints: args.hints,
      dealBias: args.dealBias,
    });
    if (resumed?.code!=='GAME_ENDED') await loop.run();
  } catch (error) {
    // 정상 SIGTERM 처리 중의 STOPPING은 실패가 아니다. 다른 runtime/cleanup
    // 실패는 그대로 보고하고 비정상 종료한다.
    if (!(handlingSignal && error.code === 'STOPPING')) caught = error;
  } finally {
    if (loop) {
      try {
        if (signalStopPromise) await signalStopPromise;
        else await loop.requestStop();
      } catch (error) {
        caught ??= error;
      }
    }
    if (signalStopError) caught = signalStopError;
  }
  if (caught) {
    try {
      fs.writeSync(2, `${JSON.stringify({ ok: false, code: caught.code ?? 'ERROR', message: caught.message })}\n`);
    } catch { /* stderr unavailable */ }
  }
  process.exit(exitCodeFor(caught));
}

const isDirectRun = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();
