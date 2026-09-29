// Persisted coach-row evidence shared by the game loop (which judges and signals) and the
// coach-control cleanup writer (which re-verifies a release declaration, #214). Both sides
// must judge with the same predicates, so they live here and nowhere else. This module
// imports neither tools/game-loop.js nor tools/coach-control.js (both import it).
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { validWin32StartTime } from '../engine/process-identity.js';

export const SIDECAR_MAX_BYTES = 64 * 1024;
// #192 I2: undefined (not 0) on a platform that has no O_NOFOLLOW (e.g. Windows) so callers
// can tell "no such flag exists" apart from "flag value is 0" and use
// `readSidecarFileWithoutNoFollow` there instead of opening with no protection at all.
export const SIDECAR_NOFOLLOW = fs.constants.O_NOFOLLOW;
export const DEFAULT_LSOF = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? null;

export const RELEASE_REASONS = Object.freeze([
  'IDENTITY_DEAD', 'IDENTITY_REPLACED', 'NOT_SPAWNED', 'OWNER_RUNTIME_CLOSED',
  'CLOSED_CONFIRMED', 'ACCEPT_EVIDENCE', 'LEGACY_NO_RUNTIME_PROCESS',
]);

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

// `"pid:startTime"` as written by `oneshotStart` (tools/player-runtime.js). Windows start
// times contain colons, so everything after the first separator is preserved verbatim for a
// valid value — only the literal sentinels a lost/unverifiable startTime would stringify to
// (`"null"`, `"undefined"`) or blank text are rejected.
export function parsePersistedCoachHandle(raw) {
  if (typeof raw !== 'string') return null;
  const separator = raw.indexOf(':');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const pid = Number(raw.slice(0, separator));
  const startTime = raw.slice(separator + 1);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const trimmed = startTime.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  return { pid, startTime };
}

// §D1-equivalent validation for the sidecar's own {pid, startTime} pair.
export function validSidecarIdentity(data) {
  const pid = data?.pid;
  const startTime = data?.startTime;
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  if (typeof startTime !== 'string') return null;
  const trimmed = startTime.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null;
  return { pid, startTime };
}

// Step 0 of every judgment: a sidecar carrying a tuple must match this exact row and epoch
// before it can be trusted for anything.
export function sidecarTupleMismatch(sidecar, row, gameEpoch) {
  if (!sidecar?.data || typeof sidecar.data !== 'object') return false;
  const tuple = sidecar.data;
  return tuple.gameEpoch !== gameEpoch
    || tuple.owner !== row.ownerSessionId
    || tuple.handNo !== row.handNo
    || tuple.generation !== row.generation
    || tuple.attempt !== row.attempt;
}

// The authority handle identity and the (tuple-matched) sidecar identity of one row.
export function rowIdentities(row, sidecar) {
  const authority = parsePersistedCoachHandle(row?.agentHandle);
  const fromSidecar = sidecar?.phase === 'identity' ? validSidecarIdentity(sidecar.data) : null;
  const conflict = Boolean(authority && fromSidecar
    && (authority.pid !== fromSidecar.pid || authority.startTime !== fromSidecar.startTime));
  return { authority, sidecar: fromSidecar, conflict, selected: authority ?? fromSidecar };
}

// #192 §3/§4 D2: evidence that closes a persisted coach row without any live identity check.
// Order follows the design memo: c → closed-confirmed → f. Every hit releases the row, so
// the order only decides which reason string is reported.
// - c: `closures` is `loop-state.coachRuntimeClosures`, `requestStop`'s success-path receipt
//   (§3 E1). It lists every owner some loop instance durably confirmed fully stopped.
// - closed-confirmed (#192 O2): callers reject a sidecar whose tuple does not match this
//   exact row and epoch before consulting it, so the phase is trusted at face value.
// - f: `acceptEvidence` (`closed-child` or `no-spawn`, written by `accept`).
// Pure function of its inputs. Returns `{ reason }` when evidence closes the row, else null.
export function consultCoachCloseEvidence(attempt, closures, sidecar = null) {
  const [reason] = closeEvidenceReasons(attempt, closures, sidecar);
  return reason ? { reason } : null;
}

// Every close-evidence reason that independently holds for this row (#214: a declaration is
// accepted when it is any of these, not only the one with the highest priority).
export function closeEvidenceReasons(attempt, closures, sidecar = null) {
  const reasons = [];
  if (Array.isArray(closures) && closures.some((entry) => (
    entry && typeof entry === 'object' && entry.ownerSessionId === attempt?.ownerSessionId
  ))) reasons.push('OWNER_RUNTIME_CLOSED');
  if (sidecar?.phase === 'closed-confirmed') reasons.push('CLOSED_CONFIRMED');
  if (attempt?.acceptEvidence === 'closed-child' || attempt?.acceptEvidence === 'no-spawn') reasons.push('ACCEPT_EVIDENCE');
  return reasons;
}

// d: no handle was ever recorded (a malformed string handle does not count — only a
// genuinely absent one), the new-protocol stamp is present, the row is attributable to
// this root, and the sidecar proves the spawn step itself was never reached.
export function notSpawnedHolds(row, sidecar, attributable) {
  const handleIsNullish = row?.agentHandle === null || row?.agentHandle === undefined;
  const notSpawnedSidecar = sidecar?.phase === 'absent' || sidecar?.phase === 'aborted-before-spawn';
  return handleIsNullish && row?.spawnEvidence === 1 && attributable === true && notSpawnedSidecar;
}

// g: a legacy row (no new-protocol stamp, no accept stamp, never-observed sidecar,
// attributable) may be released only on a clean runtime-process scan.
export function legacyEligible(row, sidecar, attributable) {
  return row?.spawnEvidence !== 1
    && row?.acceptEvidence == null
    && sidecar?.phase === 'absent'
    && attributable === true;
}

// POSIX `ps -o lstart=` prints local wall time without a zone (engine/process-identity.js),
// so the same process reads differently from two time zones. Two readings that differ by a
// whole number of 15-minute steps within ±26 hours (UTC−12 … UTC+14) may be one process and
// are never proof of replacement (#214 D4a).
const TZ_STEP_MS = 15 * 60 * 1000;
const TZ_SPAN_MS = 26 * 60 * 60 * 1000;
// Win32 readings are UTC `o` strings with up to seven fraction digits: 100 ns ticks. They
// are compared as text after padding the fraction, never through Date (milliseconds only).
function win32Ticks(value) {
  if (!validWin32StartTime(value)) return null;
  const [whole, fraction = ''] = value.slice(0, -1).split('.');
  return `${whole}.${fraction.padEnd(7, '0')}`;
}
// Compare a recorded start time with a fresh reading of the same pid: 'same', 'different',
// or 'unknown'. A reading either side cannot parse is never proof of anything, even when the
// two strings are equal.
// - win32: equal ticks are the same process, any other tick is not.
// - POSIX: only the identical text is the same process. Different text that parses to the
//   same instant (a DST fold) or differs by a whole number of 15-minute steps within ±26
//   hours may be one process read from another zone: unknown. Anything else is different.
export function compareStartTimes(recorded, current, { platform = process.platform } = {}) {
  if (platform === 'win32') {
    const a = win32Ticks(recorded);
    const b = win32Ticks(current);
    if (a === null || b === null) return 'unknown';
    return a === b ? 'same' : 'different';
  }
  const a = Date.parse(recorded);
  const b = Date.parse(current);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
  if (recorded === current) return 'same';
  const diff = Math.abs(a - b);
  return diff <= TZ_SPAN_MS && diff % TZ_STEP_MS === 0 ? 'unknown' : 'different';
}

// One observation of a recorded {pid, startTime}: 'dead' (kill 0 says gone), 'alive' (same
// start time), 'replaced' (pid reused by a provably different process), or 'unknown'
// (start time unreadable, unparseable, or ambiguous across time zones). Never 'dead' from
// 'unknown'. kill(0) runs first so a dead pid costs no `ps`/PowerShell spawn.
export function observeRecordedIdentity({ pid, startTime }, { processAlive, startTimeOf, platform = process.platform }) {
  if (!processAlive(pid)) return 'dead';
  const current = startTimeOf(pid);
  if (current === null || current === undefined) return 'unknown';
  const compared = compareStartTimes(startTime, current, { platform });
  return compared === 'same' ? 'alive' : compared === 'different' ? 'replaced' : 'unknown';
}

export function processAlive(pid) {
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

// Root-bound readers. `statGameRoot` and `sidecarNoFollowFlag` are the loop's existing seams.
export function createCoachEvidenceReader({ root, statGameRoot = fs.statSync, sidecarNoFollowFlag = SIDECAR_NOFOLLOW }) {
  // #192 E2: the spawn sidecar for one attempt's exact result path, always resolved against
  // the CURRENT game root by basename alone — the row's own stored absolute directory is
  // never trusted.
  const coachSpawnEvidencePath = (exactResultPath) => {
    if (typeof exactResultPath !== 'string') return null;
    const base = path.basename(exactResultPath);
    if (!base.endsWith('.result.json')) return null;
    return path.join(root, base.replace(/\.result\.json$/, '.spawn.json'));
  };

  // #192 E2/S2b/I2: read the per-attempt spawn sidecar from an fd pinned to the inode the
  // checks validate. Missing is only `absent` when ENOENT AND the root still stats; any
  // other failure is `invalid`.
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

  // E2: a row's stored exactResultPath is only trusted when its directory still resolves to
  // the current root.
  const coachEvidenceAttributable = (exactResultPath) => {
    if (typeof exactResultPath !== 'string' || exactResultPath === '') return false;
    try {
      return fs.realpathSync(path.dirname(exactResultPath)) === fs.realpathSync(root);
    } catch {
      return false;
    }
  };

  return { coachSpawnEvidencePath, readCoachSpawnSidecar, coachEvidenceAttributable };
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
