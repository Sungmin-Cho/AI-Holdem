#!/usr/bin/env node
// Dealer-side publisher: takes an `engine/cli.js step` envelope, posts the public part
// to the relay server, and prints back only what the dealer needs for the next round.
// The engine stays pure; every network call and every publishId lives here.
import fs from 'node:fs';
import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import {
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_ID,
  SUPPORTED_COACH_AUTHORITY_SCHEMAS,
  gameEpochOf,
  payloadSha256,
  utf8ByteLength,
} from '../publish-contract.js';
import { createCoachControl } from './coach-control.js';

// Comfortably past the engine mutex's staleness threshold: a waiter that gives up
// sooner would never reach the point where it may reclaim a dead owner's lock.
const DEFAULT_LOCK_WAIT_MS = 20_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const LOCK_NAME = 'publish.lock.d';
const CONTROL_TYPES = new Set(['bust', 'level_up', 'game_over']);

// fetch keeps its socket pooled, so the loop never drains on its own: write and leave.
function reply(envelope, exitCode) {
  fs.writeSync(1, `${JSON.stringify(envelope)}\n`);
  process.exit(exitCode);
}

class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function bail(code, message) {
  throw new ToolError(code, message);
}

function parseArgs(argv) {
  const out = {
    gameDir: 'game', from: null, narrations: [],
    viewOnly: false, wait: false, waitOnly: false, waitMs: 25_000,
    lockWaitMs: DEFAULT_LOCK_WAIT_MS, retry: false,
    printGameEpoch: false, deadlineMonotonicNs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    const needsValue = (name) => {
      if (next == null) bail('USAGE', `옵션 ${name}의 값이 필요합니다.`);
      i += 1;
      return next;
    };
    const positiveMs = (name) => {
      const value = Number(needsValue(name));
      if (!Number.isFinite(value) || value < 0) bail('USAGE', `${name}는 0 이상의 숫자여야 합니다.`);
      return value;
    };
    if (arg === '--game-dir') out.gameDir = needsValue(arg);
    else if (arg === '--from') out.from = needsValue(arg);
    else if (arg === '--narration') out.narrations.push(needsValue(arg));
    else if (arg === '--view-only') out.viewOnly = true;
    else if (arg === '--retry') out.retry = true;
    else if (arg === '--wait') out.wait = true;
    else if (arg === '--wait-only') { out.wait = true; out.waitOnly = true; }
    else if (arg === '--wait-ms') out.waitMs = positiveMs(arg);
    else if (arg === '--lock-wait-ms') out.lockWaitMs = positiveMs(arg);
    else if (arg === '--print-game-epoch') out.printGameEpoch = true;
    else if (arg === '--deadline-monotonic-ns') {
      try { out.deadlineMonotonicNs = BigInt(needsValue(arg)); }
      catch { bail('USAGE', '--deadline-monotonic-ns는 bigint 나노초여야 합니다.'); }
    }
    else bail('USAGE', `알 수 없는 옵션: ${arg}`);
  }
  if (!out.from && !out.printGameEpoch) bail('USAGE', '--from <파일>이 필요합니다.');
  return out;
}

function readJson(file, code, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    bail(code, `${label}를 읽을 수 없습니다: ${file}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    bail(code, `${label}가 올바른 JSON이 아닙니다: ${file}`);
  }
  return null;
}

function readLock(gameDir) {
  const lock = readJson(path.join(gameDir, 'lock.json'), 'NO_LOCK', 'lock.json');
  const port = Number(lock?.port);
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)
    || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof lock.sessionToken !== 'string' || lock.sessionToken.length === 0) {
    bail('NO_LOCK', 'game/lock.json에서 포트·토큰을 읽지 못했습니다. 서버가 떠 있습니까?');
  }
  return { port, sessionToken: lock.sessionToken };
}

// Fail closed: a malformed or rejected envelope must never consume a publishId.
function checkEnvelope(envelope, file) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    bail('BAD_ENVELOPE', `${file}가 객체가 아닙니다.`);
  }
  if (envelope.ok === false) {
    bail('BAD_ENVELOPE', `거부된 envelope입니다(code=${envelope.code ?? '?'}). 게시하지 않았습니다.`);
  }
  const hasView = envelope.view !== undefined;
  const isSide = Array.isArray(envelope.coach) || envelope.review !== undefined;
  // A step envelope always carries the user view — that is the whole point of it.
  // Accepting one without it lets an empty publish burn a publishId and hand the
  // dealer `next: null`, which its rules read as "hand over".
  if (!hasView && !isSide) {
    bail('BAD_ENVELOPE', `${file}는 step envelope도 coach/review도 아닙니다.`);
  }
  // A non-user view would publish that player's hole cards to everyone. An absent
  // marker is not a pass: only an envelope that positively claims the user's view
  // may be published, so a hand-built or future-engine view cannot slip through.
  if (hasView && envelope.viewFor !== 'user') {
    bail('BAD_ENVELOPE', `사용자 관점 표식이 없는 view는 게시할 수 없습니다(viewFor=${envelope.viewFor ?? '없음'}).`);
  }
  if (!hasView) return;
  // Everything `cli step` always emits. A hollow envelope would burn a publishId and
  // hand back `next: null`, which the dealer's rules read as "hand over".
  if (!Number.isInteger(envelope.stateVersion)
    || typeof envelope.handOver !== 'boolean' || typeof envelope.gameOver !== 'boolean'
    || envelope.view === null || typeof envelope.view !== 'object' || Array.isArray(envelope.view)
    || envelope.view.handNo === undefined
    || (envelope.next !== null && envelope.next !== undefined && typeof envelope.next.toAct !== 'string')) {
    bail('BAD_ENVELOPE', `${file}는 step envelope의 필수 필드를 갖추지 못했습니다.`);
  }
}

function buildBody(envelope, opts) {
  const body = {};
  if (envelope.view !== undefined) body.view = envelope.view;
  // Tells the server this republish re-shows a state rather than acknowledging an
  // action, so a user action whose response was lost survives a dealer's resume.
  if (opts.viewOnly) body.viewOnly = true;
  if (!opts.viewOnly) {
    const events = (envelope.events ?? []).filter((event) => event.visibility === 'public');
    if (events.length) body.events = events;
  }
  const messages = [
    ...opts.narrations.map((text) => ({ type: 'narration', text })),
  ];
  if (messages.length) body.messages = messages;
  if (Array.isArray(envelope.coach) && envelope.coach.length) body.coach = envelope.coach;
  if (envelope.review !== undefined) body.review = envelope.review;
  return body;
}

// Public control events the dealer must act on (§4c), without reopening the view JSON.
function controlOf(envelope) {
  const control = {};
  for (const event of envelope.events ?? []) {
    if (event.visibility !== 'public' || !CONTROL_TYPES.has(event.type)) continue;
    if (event.type === 'bust') (control.bust ??= []).push(event.playerId);
    else if (event.type === 'level_up') control.level_up = { level: event.level, sb: event.sb, bb: event.bb };
    else control.game_over = { result: event.result, bustedPlayerIds: event.bustedPlayerIds ?? [] };
  }
  return Object.keys(control).length ? control : null;
}

function nextForDealer(envelope) {
  const next = envelope.next;
  if (!next) return null;
  const { summary, ...out } = next;
  if (next.kind !== 'ai') return out;
  out.message = summary;
  return out;
}

function remainingMs(deadlineNs) {
  if (deadlineNs == null) return null;
  const left = deadlineNs - process.hrtime.bigint();
  if (left <= 0n) return 0;
  const ms = Number(left / 1_000_000n);
  return Number.isFinite(ms) ? ms : 0;
}

function readAuthority(gameDir) {
  const file = path.join(gameDir, '.coach-authority.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    bail('BAD_AUTHORITY', 'coach authority를 읽지 못했습니다.');
  }
  return null;
}

function assertSupportedAuthority(auth) {
  if (!auth) return;
  if (!SUPPORTED_COACH_AUTHORITY_SCHEMAS.includes(auth.schemaVersion)) {
    bail('UNSUPPORTED_COACH_AUTHORITY', `schema ${auth.schemaVersion}은 이 publisher가 지원하지 않습니다.`);
  }
}

function staleAttemptReason(record, epoch, auth) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'BAD_ATTEMPT';
  if (!Object.prototype.hasOwnProperty.call(record, 'expectedGameEpoch')) return 'BAD_ATTEMPT_VERSION';
  if (record.expectedGameEpoch !== epoch) return 'STALE_GAME_ATTEMPT';
  const itemAuth = record.coachAuthority;
  if (itemAuth) {
    const queued = auth?.publishQueue?.[String(itemAuth.handNo)];
    if (!queued
      || queued.queueId !== itemAuth.queueId
      || queued.exactEnvelopePath !== itemAuth.exactEnvelopePath
      || queued.payloadSha256 !== itemAuth.payloadSha256) {
      return 'STALE_COACH_AUTHORITY';
    }
  }
  return null;
}

function assertCoachQueue(auth, coachAuthority, epoch) {
  if (!coachAuthority) return;
  if (coachAuthority.expectedGameEpoch !== epoch) bail('STALE_COACH_AUTHORITY');
  const queued = auth?.publishQueue?.[String(coachAuthority.handNo)];
  if (!queued
    || queued.queueId !== coachAuthority.queueId
    || queued.exactEnvelopePath !== coachAuthority.exactEnvelopePath
    || queued.payloadSha256 !== coachAuthority.payloadSha256) {
    bail('STALE_COACH_AUTHORITY');
  }
}

// Never interpolate a fetch failure's message: it quotes the URL, and the URL carries
// the session token.
async function postPublish(lock, body, timeoutMs = PUBLISH_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${lock.port}/api/publish?token=${encodeURIComponent(lock.sessionToken)}`;
  const budget = Math.max(1, timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(budget),
    });
  } catch {
    bail('PUBLISH_FAILED', '서버에 게시하지 못했습니다. 서버가 살아 있는지 확인하세요.');
  }
  const json = await res.json().catch(() => null);
  if (res.status !== 200 || !json?.ok) {
    bail('PUBLISH_REJECTED', `서버가 게시를 거부했습니다 (${res.status}).`);
  }
  return json;
}

// The publishId is read-then-incremented, so it must be decided and spent under the
// same lock — otherwise two publishers pick the same id and the server's idempotent
// skip silently drops one of the two bodies.
// A publish that fails leaves the dealer unable to tell whether the server saw it.
// Recording the exact attempt before sending makes the answer irrelevant: `--retry`
// resends the identical id and body, so the server either applies it once or skips it
// as the duplicate it already has.
function attemptPath(gameDir) {
  return path.join(gameDir, '.publish-attempt.json');
}

// A half-written record is worse than none: --retry would read it and stop the game.
function writeAttempt(gameDir, record) {
  const target = attemptPath(gameDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, target);
}

async function publishOnce(gameDir, lock, envelope, opts) {
  const beforeLock = remainingMs(opts.deadlineMonotonicNs);
  if (beforeLock === 0) bail('DEADLINE_EXPIRED', '게시 deadline이 이미 만료됐습니다.');
  const lockWaitMs = beforeLock == null ? opts.lockWaitMs : Math.min(opts.lockWaitMs, beforeLock);
  try {
    const published = await withNamedLock(gameDir, LOCK_NAME, async () => {
      const liveLock = readLock(gameDir);
      Object.assign(lock, liveLock);
      const epoch = gameEpochOf(lock.sessionToken);
      const auth = readAuthority(gameDir);
      assertSupportedAuthority(auth);
      if (auth?.noNewPlayTimePublishers && opts.deadlineMonotonicNs == null
        && !opts.viewOnly && !opts.retry && envelope.review === undefined) {
        bail('PLAYTIME_PUBLISH_STOPPED', 'game-over cutoff 이후 play-time 게시는 중단됐습니다.');
      }

      let body = null;
      let coachAuthority = envelope.coachAuthority ?? null;
      const pendingPath = attemptPath(gameDir);
      const pending = fs.existsSync(pendingPath);
      if (pending) {
        const record = readJson(pendingPath, 'BAD_ATTEMPT', '직전 게시 시도');
        const stale = staleAttemptReason(record, epoch, auth);
        if (stale === 'BAD_ATTEMPT' || stale === 'BAD_ATTEMPT_VERSION') {
          bail(stale, '재시도 기록이 온전하지 않습니다. 그 파일을 지운 뒤 §4 표를 따르세요.');
        }
        if (stale) {
          try { fs.unlinkSync(pendingPath); } catch { /* already gone */ }
          if (opts.retry) bail(stale, 'stale 게시는 전송하지 않았습니다.');
        } else if (!opts.retry) {
          // Overwriting an unresolved attempt would make its --retry resend somebody
          // else's body — a coach note published as if it were the turn's transition.
          bail('ATTEMPT_PENDING', '해소되지 않은 게시 시도가 있습니다. 먼저 --retry로 그것을 끝내세요.');
        } else {
          body = record.body;
          coachAuthority = record.coachAuthority ?? null;
          if (!body || typeof body !== 'object' || Array.isArray(body)
            || !Number.isInteger(body.publishId) || body.publishId < 1
            || body.publishId > MAX_PUBLISH_ID) {
            bail('BAD_ATTEMPT', '재시도 기록이 온전하지 않습니다. 그 파일을 지운 뒤 §4 표를 따르세요.');
          }
        }
      }
      if (!body) {
        const snapshotPath = path.join(gameDir, 'ui-snapshot.json');
        const snapshot = fs.existsSync(snapshotPath)
          ? readJson(snapshotPath, 'BAD_SNAPSHOT', 'ui-snapshot.json')
          : {};
        const nextId = (Number(snapshot.publishId) || 0) + 1;
        if (!Number.isInteger(nextId) || nextId < 1 || nextId > MAX_PUBLISH_ID) {
          bail('PUBLISH_ID_OVERFLOW', '다음 publishId가 허용 범위를 넘습니다.');
        }
        body = { publishId: nextId, ...buildBody(envelope, opts) };
      }
      assertCoachQueue(auth, coachAuthority, epoch);
      if (coachAuthority && !opts.retry) {
        const fromPath = path.resolve(opts.from);
        if (path.resolve(coachAuthority.exactEnvelopePath) !== fromPath) {
          bail('STALE_COACH_AUTHORITY', 'envelope 경로가 queue exactEnvelopePath와 다릅니다.');
        }
        const st = fs.lstatSync(fromPath);
        if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
          bail('UNSAFE_PATH', 'coach envelope 경로가 안전하지 않습니다.');
        }
      }
      if (coachAuthority) {
        const notes = body.coach;
        const note = Array.isArray(notes) ? notes[0] : null;
        if (!note || notes.length !== 1) {
          bail('STALE_COACH_AUTHORITY', 'coach body shape이 올바르지 않습니다.');
        }
        const digest = payloadSha256({
          handNo: note.handNo,
          text: note.text,
          overfold: note.overfold === true,
          unavailable: note.unavailable === true,
        });
        const queued = auth.publishQueue[String(coachAuthority.handNo)];
        if (digest !== coachAuthority.payloadSha256
          || digest !== queued?.payloadSha256
          || note.coachProof?.payloadSha256 !== digest
          || note.coachProof?.id !== queued?.publicProofId) {
          bail('STALE_COACH_AUTHORITY', 'envelope semantic digest가 queue와 일치하지 않습니다.');
        }
      }
      const serialized = JSON.stringify(body);
      if (utf8ByteLength(serialized) > MAX_PUBLISH_BODY_BYTES) {
        bail('PAYLOAD_TOO_LARGE', '게시 본문이 공유 상한을 넘습니다.');
      }
      const attemptRecord = { body, expectedGameEpoch: epoch };
      if (coachAuthority) attemptRecord.coachAuthority = coachAuthority;
      writeAttempt(gameDir, attemptRecord);
      const afterLock = remainingMs(opts.deadlineMonotonicNs);
      if (afterLock === 0) bail('DEADLINE_EXPIRED', '락 획득 뒤 게시 deadline이 만료됐습니다.');
      const httpMs = afterLock == null ? PUBLISH_TIMEOUT_MS : Math.min(PUBLISH_TIMEOUT_MS, afterLock);
      const json = await postPublish(lock, body, httpMs);
      try { fs.unlinkSync(attemptPath(gameDir)); } catch { /* already gone */ }
      return { publishId: body.publishId, revision: json.revision, hadCoach: Array.isArray(body.coach) };
    }, { timeoutMs: lockWaitMs });
    if (published.hadCoach) {
      const snapshotFile = path.join(gameDir, 'ui-snapshot.json');
      const left = remainingMs(opts.deadlineMonotonicNs);
      try {
        const rec = await createCoachControl({
          lockTimeoutMs: left == null ? 5_000 : Math.min(5_000, Math.max(1, left)),
        }).reconcile({ gameDir, snapshotFile });
        published.reconciled = rec.reconciled ?? [];
      } catch {
        published.reconcilePending = true;
      }
    }
    return published;
  } catch (error) {
    if (error?.code === 'LOCKED') bail('LOCK_TIMEOUT', '다른 게시가 락을 붙잡고 있습니다.');
    throw error;
  }
}

// Waiting happens after the publish is already durable, so a wait failure must not
// discard it: the dealer still needs publishId/stateVersion/next to make progress.
async function waitForUser(lock, envelope, opts, out) {
  const query = new URLSearchParams({
    token: lock.sessionToken,
    timeoutMs: String(opts.waitMs),
    expectDecisionId: envelope.next.decisionId ?? '',
  });
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${lock.port}/api/wait-action?${query}`, {
      signal: AbortSignal.timeout(opts.waitMs + 10_000),
    });
  } catch {
    out.waitError = '액션 대기에 실패했습니다. 게시는 이미 끝났으니 --wait-only로 다시 기다리세요.';
    return;
  }
  if (res.status !== 200) {
    out.waitError = `액션 대기가 거부됐습니다 (${res.status}).`;
    return;
  }
  const action = await res.json().catch(() => null);
  if (!action || typeof action !== 'object' || (!action.timeout && typeof action.decisionId !== 'string')) {
    out.waitError = '액션 대기 응답을 해석하지 못했습니다.';
    return;
  }
  out.userAction = action;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const gameDir = path.resolve(opts.gameDir);
  if (opts.printGameEpoch) {
    const lock = readLock(gameDir);
    reply({ ok: true, gameEpoch: gameEpochOf(lock.sessionToken) }, 0);
  }
  const envelope = readJson(opts.from, 'BAD_ENVELOPE', 'envelope');
  // A --retry that resolves a pending attempt sends the recorded body, never this
  // envelope — and the file is often a rejection envelope by then, which would
  // otherwise block the very recovery the dealer was told to run.
  const resolvingAttempt = opts.retry && fs.existsSync(attemptPath(gameDir));
  if (!resolvingAttempt) checkEnvelope(envelope, opts.from);

  const lock = readLock(gameDir);

  const published = opts.waitOnly ? null : await publishOnce(gameDir, lock, envelope, opts);

  const out = { ok: true };
  if (published) {
    out.publishId = published.publishId;
    out.revision = published.revision;
  }
  // The dealer never reopens the envelope file, so its next command's inputs ship here.
  if (envelope.stateVersion !== undefined) out.stateVersion = envelope.stateVersion;
  if (envelope.view?.handNo !== undefined) out.handNo = envelope.view.handNo;
  out.handOver = Boolean(envelope.handOver);
  out.gameOver = Boolean(envelope.gameOver);
  // A hand whose archive did not land is lost for good once the next hand replaces it.
  if (envelope.archivePending) out.archivePending = true;
  const control = controlOf(envelope);
  if (control) out.control = control;
  out.next = nextForDealer(envelope);

  // The user's turn is publish-then-wait; doing both here spares the dealer a round.
  if (opts.wait && envelope.next?.kind === 'user') await waitForUser(lock, envelope, opts, out);

  reply(out, 0);
}

try {
  await main();
} catch (error) {
  if (error instanceof ToolError) reply({ ok: false, code: error.code, message: error.message }, 1);
  reply({ ok: false, code: 'INTERNAL', message: error?.message ?? '알 수 없는 오류' }, 1);
}
