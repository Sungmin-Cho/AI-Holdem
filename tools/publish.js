#!/usr/bin/env node
// Dealer-side publisher: takes an `engine/cli.js step` envelope, posts the public part
// to the relay server, and prints back only what the dealer needs for the next round.
// The engine stays pure; every network call and every publishId lives here.
import { projectHint } from '../shared/hint-contract.js';
import fs from 'node:fs';
import path from 'node:path';
import { serverProcessStartTime, withNamedLock, writeJsonAtomic } from '../engine/state.js';
import { createListenerOwnedBy } from './listener-ownership.js';
import {
  appendRejectionRecord, installAttemptDurably, readRetirementEvidence, removeDurably, removeRetirementEvidence,
  writeRetirementEvidence,
} from './rejection-audit.js';
import { readRecordedAttempt } from './rejection-audit.js';
import { syncDirectory } from './training-store.js';
import {
  HAND_REPLAY_TRIGGER_MAX,
  MAX_PUBLISH_BODY_BYTES,
  MAX_PUBLISH_ID,
  SUPPORTED_COACH_AUTHORITY_SCHEMAS,
  SUPPORTED_TRAINING_AUTHORITY_SCHEMAS,
  annotationAttemptSettlementReason,
  gameEpochOf,
  isAnnotationOnlyAttempt,
  isRetirableAnnotationRejection,
  payloadSha256,
  preserveInitialRejection,
  projectTrainingAnnotation,
  projectTrainingSummary,
  sanitizePublishRejection,
  sanitizeRejectionFields,
  sha256Hex,
  utf8ByteLength,
  validateActionAck,
  validateHandReplayTrigger,
} from '../publish-contract.js';
import { createCoachControl } from './coach-control.js';

// Comfortably past the engine mutex's staleness threshold: a waiter that gives up
// sooner would never reach the point where it may reclaim a dead owner's lock.
const DEFAULT_LOCK_WAIT_MS = 20_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const LOCK_NAME = 'publish.lock.d';
const CONTROL_TYPES = new Set(['bust', 'level_up', 'game_over']);

// Let closing fetch sockets drain before exiting (Windows libuv can assert on
// immediate exit). Bound shutdown if pooled sockets keep the event loop alive.
let replied = false;
function reply(envelope, exitCode) {
  if (replied) return;
  replied = true;
  fs.writeSync(1, `${JSON.stringify(envelope)}\n`);
  process.exitCode = exitCode;
  setTimeout(() => process.exit(exitCode), 100).unref();
}

class ToolError extends Error {
  constructor(code, message, extra = null) {
    super(message);
    this.code = code;
    // Closed diagnostic fields only (httpStatus, serverCode) — see sanitizePublishRejection.
    if (extra) Object.assign(this, extra);
  }
}

function bail(code, message, extra = null) {
  throw new ToolError(code, message, extra);
}

function parseArgs(argv) {
  const out = {
    gameDir: 'game', from: null, narrations: [], narrationCodes: [],
    turnDeadline: null, resultHold: null,
    viewOnly: false, wait: false, waitOnly: false, waitMs: 25_000,
    lockWaitMs: DEFAULT_LOCK_WAIT_MS, retry: false, retireRejected: false,
    expectAttemptSha256: null, expectGameEpoch: null,
    relayPid: null, relayStartTime: null, relayPort: null,
    printGameEpoch: false, deadlineMonotonicNs: null, actionAckFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const needsValue = (name) => {
      const value = argv[i + 1];
      if (value == null) bail('USAGE', `옵션 ${name}의 값이 필요합니다.`);
      i += 1;
      return value;
    };
    const positiveMs = (name) => {
      const value = Number(needsValue(name));
      if (!Number.isFinite(value) || value < 0) bail('USAGE', `${name}는 0 이상의 숫자여야 합니다.`);
      return value;
    };
    if (arg === '--game-dir') out.gameDir = needsValue(arg);
    else if (arg === '--from') out.from = needsValue(arg);
    else if (arg === '--action-ack') out.actionAckFile = needsValue(arg);
    else if (arg === '--narration') out.narrations.push(needsValue(arg));
    else if (arg === '--narration-code') {
      const code = needsValue(arg);
      let params = {};
      if (argv[i + 1] === '--narration-params') {
        i += 1;
        try { params = JSON.parse(needsValue('--narration-params')); }
        catch { bail('USAGE', '--narration-params는 JSON이어야 합니다.'); }
      }
      out.narrationCodes.push({ code, params });
    }
    else if (arg === '--turn-deadline') {
      const raw = needsValue(arg);
      const at = raw.indexOf(':');
      if (at < 1) bail('USAGE', '--turn-deadline은 <decisionId>:<iso> 형식입니다.');
      out.turnDeadline = { decisionId: raw.slice(0, at), at: raw.slice(at + 1) };
    }
    else if (arg === '--result-hold') {
      const parts = needsValue(arg).split('|');
      if (parts.length !== 5) bail('USAGE', '--result-hold 형식이 올바르지 않습니다.');
      const [handNo, startAt, until, runoutStepMs, runoutStreets] = parts;
      out.resultHold = { handNo: Number(handNo), startAt, until, runoutStepMs: Number(runoutStepMs), runoutStreets: Number(runoutStreets) };
    }
    else if (arg === '--view-only') out.viewOnly = true;
    else if (arg === '--retry') out.retry = true;
    // Resend the recorded annotation body once; if the relay refuses that exact body for a
    // retirable reason (RETIRABLE_ANNOTATION_REJECTIONS), retire the attempt with durable evidence (#274).
    else if (arg === '--retire-rejected') { out.retry = true; out.retireRejected = true; }
    // The exact attempt and the verified relay the caller expects that resend to reach. A
    // retirement without all of them is refused before anything is read or sent.
    else if (arg === '--expect-attempt-sha256') out.expectAttemptSha256 = needsValue(arg);
    else if (arg === '--expect-game-epoch') out.expectGameEpoch = needsValue(arg);
    else if (arg === '--relay-pid') out.relayPid = Number(needsValue(arg));
    else if (arg === '--relay-start-time') out.relayStartTime = needsValue(arg);
    else if (arg === '--relay-port') out.relayPort = Number(needsValue(arg));
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
  // #274: an ordinary --retry may bind itself to the exact recorded body its caller captured
  // (digest and game epoch, both required together); the resend then refuses any other record
  // before anything is sent, exactly as a retirement does. The options default to null: only
  // an option actually given on the command line is "provided".
  if (!out.retireRejected && (out.expectAttemptSha256 != null || out.expectGameEpoch != null)) {
    const sha = /^[0-9a-f]{64}$/;
    if (!out.retry || !sha.test(out.expectAttemptSha256 ?? '') || !sha.test(out.expectGameEpoch ?? '')) {
      bail('USAGE', '--expect-attempt-sha256와 --expect-game-epoch는 --retry와 함께, 둘 다 64자리 hex로 주어야 합니다.');
    }
  }
  if (out.retireRejected) {
    const sha = /^[0-9a-f]{64}$/;
    if (!sha.test(out.expectAttemptSha256 ?? '') || !sha.test(out.expectGameEpoch ?? '')
      || !Number.isSafeInteger(out.relayPid) || out.relayPid < 1
      || !Number.isInteger(out.relayPort) || out.relayPort < 1 || out.relayPort > 65535
      || typeof out.relayStartTime !== 'string' || out.relayStartTime.length === 0
      || out.relayStartTime.length > 128) {
      bail('RETIRE_BINDING_REQUIRED', '--retire-rejected에는 기대 attempt digest·게임 epoch·검증된 relay identity가 필요합니다.');
    }
  }
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
  if (Array.isArray(envelope.training) && envelope.training.length === 0) {
    bail('BAD_ENVELOPE', 'training: []은 게시할 수 없습니다.');
  }
  if (Array.isArray(envelope.trainingAnnotations) && envelope.trainingAnnotations.length === 0) {
    bail('BAD_ENVELOPE', 'trainingAnnotations: []은 게시할 수 없습니다.');
  }
  const hasView = envelope.view !== undefined;
  const isSide = Array.isArray(envelope.coach)
    || envelope.review !== undefined
    || (Array.isArray(envelope.training) && envelope.training.length > 0)
    || (Array.isArray(envelope.trainingAnnotations) && envelope.trainingAnnotations.length > 0);
  // A step envelope always carries the user view — that is the whole point of it.
  // Accepting one without it lets an empty publish burn a publishId and hand the
  // dealer `next: null`, which its rules read as "hand over".
  if (!hasView && !isSide) {
    bail('BAD_ENVELOPE', `${file}는 step envelope도 coach/review/training도 아닙니다.`);
  }
  // A non-user view would publish that player's hole cards to everyone. An absent
  // marker is not a pass: only an envelope that positively claims the user's view
  // may be published, so a hand-built or future-engine view cannot slip through.
  if (hasView && envelope.viewFor !== 'user') {
    bail('BAD_ENVELOPE', `사용자 관점 표식이 없는 view는 게시할 수 없습니다(viewFor=${envelope.viewFor ?? '없음'}).`);
  }
  if (hasView && envelope.views && JSON.stringify(envelope.views.user) !== JSON.stringify(envelope.view)) {
    bail('BAD_ENVELOPE', 'views.user가 view와 같지 않습니다.');
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
  if (envelope.view !== undefined) {
    body.view = envelope.view;
    if (envelope.views !== undefined) body.views = envelope.views;
    if (envelope.hint !== undefined) body.hint = envelope.hint === null ? null : projectHint(envelope.hint);
  }
  if (opts.turnDeadline) body.turnDeadline = opts.turnDeadline;
  if (opts.resultHold) body.resultHold = opts.resultHold;
  // Tells the server this republish re-shows a state rather than acknowledging an
  // action, so a user action whose response was lost survives a dealer's resume.
  if (opts.viewOnly) body.viewOnly = true;
  const actionAck = opts.actionAck ?? envelope.actionAck;
  if (actionAck !== undefined) body.actionAck = actionAck;
  if (!opts.viewOnly) {
    const events = (envelope.events ?? []).filter((event) => event.visibility === 'public');
    if (events.length) body.events = events;
  }
  const messages = [
    ...opts.narrations.map((text) => ({ type: 'narration', text })),
    ...opts.narrationCodes.map((row) => ({ type: 'narration', code: row.code, params: row.params })),
  ];
  if (messages.length) body.messages = messages;
  if (Array.isArray(envelope.coach) && envelope.coach.length) body.coach = envelope.coach;
  if (envelope.review !== undefined) body.review = envelope.review;
  if (Array.isArray(envelope.training) && envelope.training.length) body.training = envelope.training;
  if (Array.isArray(envelope.trainingAnnotations) && envelope.trainingAnnotations.length) {
    body.trainingAnnotations = envelope.trainingAnnotations;
  }
  if (envelope.handReplay !== undefined) {
    const handNos = validateHandReplayTrigger(envelope.handReplay);
    if (handNos.length) body.handReplay = { handNos };
  }
  return body;
}

// Public control events the dealer must act on (§4c), without reopening the view JSON.
function controlOf(envelope) {
  const control = {};
  for (const event of envelope.events ?? []) {
    if (event.visibility !== 'public' || !CONTROL_TYPES.has(event.type)) continue;
    if (event.type === 'bust') (control.bust ??= []).push(event.playerId);
    else if (event.type === 'level_up') control.level_up = { level: event.level, sb: event.sb, bb: event.bb };
    else control.game_over = { result: event.result, bustedPlayerIds: event.bustedPlayerIds ?? [], ...(event.winnerId ? { winnerId: event.winnerId } : {}) };
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

function readTrainingAuthority(gameDir) {
  const file = path.join(gameDir, 'training', '.training-authority.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    bail('BAD_TRAINING_AUTHORITY', 'training authority를 읽지 못했습니다.');
  }
  return null;
}

function assertTrainingQueue(trainingAuth, trainingAuthority, epoch) {
  if (!trainingAuthority) return;
  if (trainingAuthority.expectedGameEpoch !== epoch) bail('STALE_TRAINING_AUTHORITY');
  if (trainingAuth && !SUPPORTED_TRAINING_AUTHORITY_SCHEMAS.includes(trainingAuth.schemaVersion)) {
    bail('UNSUPPORTED_TRAINING_AUTHORITY', `schema ${trainingAuth.schemaVersion}`);
  }
  const items = trainingAuthority.items;
  if (!Array.isArray(items) || items.length === 0) bail('STALE_TRAINING_AUTHORITY');
  for (const entry of items) {
    const queued = trainingAuth?.publishQueue?.[entry.evaluationId];
    if (!queued || queued.payloadSha256 !== entry.payloadSha256) {
      bail('STALE_TRAINING_AUTHORITY');
    }
  }
}

function assertAnnotationQueue(trainingAuth, annotationAuthority, epoch) {
  if (!annotationAuthority) return;
  if (annotationAuthority.expectedGameEpoch !== epoch) bail('STALE_ANNOTATION_AUTHORITY');
  const items = annotationAuthority.items;
  if (!Array.isArray(items) || items.length === 0) bail('STALE_ANNOTATION_AUTHORITY');
  for (const entry of items) {
    const queued = trainingAuth?.annotationQueue?.[entry.evaluationId]?.[entry.field];
    if (!queued || queued.valueSha256 !== entry.valueSha256) {
      bail('STALE_ANNOTATION_AUTHORITY');
    }
  }
}

function assertSupportedAuthority(auth) {
  if (!auth) return;
  if (!SUPPORTED_COACH_AUTHORITY_SCHEMAS.includes(auth.schemaVersion)) {
    bail('UNSUPPORTED_COACH_AUTHORITY', `schema ${auth.schemaVersion}은 이 publisher가 지원하지 않습니다.`);
  }
}

function staleAttemptReason(record, epoch, auth, trainingAuth) {
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
  const trainingItem = record.trainingAuthority;
  if (trainingItem) {
    if (!Array.isArray(trainingItem.items)) return 'STALE_TRAINING_AUTHORITY';
    for (const entry of trainingItem.items) {
      const queued = trainingAuth?.publishQueue?.[entry.evaluationId];
      if (!queued || queued.payloadSha256 !== entry.payloadSha256) {
        return 'STALE_TRAINING_AUTHORITY';
      }
    }
  }
  const annotationItem = record.annotationAuthority;
  if (annotationItem) {
    if (!Array.isArray(annotationItem.items) || annotationItem.items.length === 0) {
      return 'STALE_ANNOTATION_AUTHORITY';
    }
    for (const entry of annotationItem.items) {
      const queued = trainingAuth?.annotationQueue?.[entry.evaluationId]?.[entry.field];
      if (!queued || queued.valueSha256 !== entry.valueSha256) {
        return 'STALE_ANNOTATION_AUTHORITY';
      }
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
    const rejection = sanitizePublishRejection(res.status, json);
    bail('PUBLISH_REJECTED', `서버가 게시를 거부했습니다 (${rejection.httpStatus}).`, rejection);
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

// #274: a retirement only counts when the refusal came from the relay the caller verified.
// The loop proved that relay (listener, wrong/real token, startTime, pinned lock) and passed
// its identity here; around the exact retiring POST — before it and again after the reply,
// before any mutation — this re-checks that lock.json still names that process, port and
// game, that the process is still the one that started then, and that it still owns the
// listener the POST went to. Any doubt refuses the retirement and keeps the attempt.
let relayListenerOwnedBy = null;
async function assertRelayBinding(gameDir, opts, lock) {
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(gameDir, 'lock.json'), 'utf8'));
  } catch {
    bail('RELAY_BINDING_UNVERIFIED', 'relay lock을 다시 확인할 수 없어 폐기하지 않았습니다.');
  }
  if (!recorded || typeof recorded !== 'object' || Array.isArray(recorded)
    || recorded.serverPid !== opts.relayPid
    || Number(recorded.port) !== opts.relayPort
    || lock.port !== opts.relayPort
    || recorded.sessionToken !== lock.sessionToken
    || gameEpochOf(recorded.sessionToken) !== opts.expectGameEpoch
    || (recorded.serverStartTime !== undefined && recorded.serverStartTime !== opts.relayStartTime)) {
    bail('RELAY_BINDING_CHANGED', 'relay lock이 검증된 relay와 달라 폐기하지 않았습니다.');
  }
  let startTime = null;
  try { startTime = serverProcessStartTime(opts.relayPid); } catch { startTime = null; }
  if (startTime === null) bail('RELAY_BINDING_UNVERIFIED', 'relay 프로세스 identity를 확인할 수 없어 폐기하지 않았습니다.');
  if (startTime !== opts.relayStartTime) bail('RELAY_BINDING_CHANGED', 'relay 프로세스가 검증 이후 바뀌어 폐기하지 않았습니다.');
  relayListenerOwnedBy ??= createListenerOwnedBy();
  let owns;
  try { owns = await relayListenerOwnedBy(opts.relayPid, opts.relayPort); } catch { owns = null; }
  if (owns === null) bail('RELAY_BINDING_UNVERIFIED', 'relay listener 소유를 확인할 수 없어 폐기하지 않았습니다.');
  if (owns !== true) bail('RELAY_BINDING_CHANGED', 'relay listener가 검증된 relay 소유가 아니어서 폐기하지 않았습니다.');
}

function replayPendingPath(gameDir) {
  return path.join(gameDir, '.replay-pending.json');
}

function readReplayPendingNos(gameDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(replayPendingPath(gameDir), 'utf8'));
    if (!Array.isArray(raw?.handNos)) return [];
    return raw.handNos.filter((value) => Number.isInteger(value) && value >= 1);
  } catch {
    return [];
  }
}

function unionHandNos(left, right) {
  const seen = new Set();
  const out = [];
  for (const value of [...left, ...right]) {
    if (!Number.isInteger(value) || value < 1 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function drainReplayPending(gameDir, report, fallbackHandNos = []) {
  const acked = new Set();
  if (report && typeof report === 'object' && !Array.isArray(report)) {
    for (const value of report.stored ?? []) acked.add(value);
    for (const entry of report.markers ?? []) acked.add(entry?.handNo ?? entry);
    for (const value of report.conflicts ?? []) acked.add(value);
  }
  if (acked.size === 0) {
    for (const value of fallbackHandNos) acked.add(value);
  }
  if (acked.size === 0) return;
  const next = readReplayPendingNos(gameDir).filter((value) => !acked.has(value));
  writeJsonAtomic(replayPendingPath(gameDir), { handNos: next });
}

// Ordering seam for regressions only (env AI_HOLDEM_PUBLISH_CHECKPOINT_DIR): at a named point
// the child records that it got there and waits, bounded, for the test to release it, so a
// concurrent settlement can be scheduled exactly between two of its reads. Unset in production:
// a no-op. It pauses only; nothing is skipped or weakened.
function orderingCheckpoint(name) {
  const dir = process.env.AI_HOLDEM_PUBLISH_CHECKPOINT_DIR;
  if (!dir) return;
  try { fs.writeFileSync(path.join(dir, `${name}.reached`), String(process.pid)); } catch { return; }
  const release = path.join(dir, `${name}.release`);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(release) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 25);
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
      // #274 ordering: outstanding retirement evidence is read BEFORE the authorities are
      // captured, under this publish lock. The training control settles evidence by writing
      // the authority first and removing the evidence only afterwards, and no other publisher
      // can install new evidence while this lock is held — so an absence seen here is paired
      // with an authority read that already reflects every settlement that consumed evidence,
      // and a presence seen here refuses every annotation body below (the exact-record retry
      // exception is decided later, against the body). Unreadable evidence fails closed.
      let pendingEvidence = null;
      let pendingEvidenceUnreadable = false;
      try { pendingEvidence = readRetirementEvidence(gameDir); } catch { pendingEvidenceUnreadable = true; }
      const auth = readAuthority(gameDir);
      const trainingAuth = readTrainingAuthority(gameDir);
      orderingCheckpoint('authority-captured');
      assertSupportedAuthority(auth);
      let body = null;
      let coachAuthority = envelope.coachAuthority ?? null;
      let trainingAuthority = envelope.trainingAuthority ?? null;
      let annotationAuthority = envelope.annotationAuthority ?? null;
      const pendingPath = attemptPath(gameDir);
      // The recorded attempt is read only through the bounded, preinspected, non-blocking
      // reader (tools/rejection-audit.js), under the publish lock: a FIFO without a writer, a
      // link, a hard link, an oversize or replaced entry can neither block this process nor
      // read as absent. Such an entry is a durability failure of the record (the same closed
      // classification installAttemptDurably reports), never BAD_ATTEMPT: nothing is sent and
      // nothing is removed. Only a regular file that is not valid JSON is BAD_ATTEMPT.
      let pendingRead;
      try {
        pendingRead = readRecordedAttempt(gameDir);
      } catch (readFailure) {
        bail('ATTEMPT_SYNC_FAILED', '기록된 게시 시도를 안전하게 읽지 못해 보내지 않았습니다.', {
          auditCode: readFailure?.code === 'REJECTION_AUDIT_UNSAFE' ? 'REJECTION_AUDIT_UNSAFE' : 'REJECTION_AUDIT_UNAVAILABLE',
        });
      }
      const pending = !pendingRead.absent;
      if (opts.retry && !pending) {
        bail('NO_ATTEMPT', '재시도할 기록된 게시 시도가 없습니다.');
      }
      if (pending) {
        let record;
        try {
          record = JSON.parse(pendingRead.raw);
        } catch {
          bail('BAD_ATTEMPT', '직전 게시 시도가 올바른 JSON이 아닙니다.');
        }
        // #274: a retirement — and an ordinary retry that declared what it captured — resends
        // only the exact attempt its caller read. Another one — replaced, settled and
        // re-recorded, or from another game — is left exactly as it is, unsent.
        if ((opts.retireRejected || opts.expectAttemptSha256) && (record?.expectedGameEpoch !== opts.expectGameEpoch
          || epoch !== opts.expectGameEpoch
          || sha256Hex(JSON.stringify(record?.body ?? null)) !== opts.expectAttemptSha256)) {
          bail('ATTEMPT_CHANGED', '기록된 게시 시도가 호출자가 읽은 것과 달라 보내지 않았습니다.');
        }
        const stale = staleAttemptReason(record, epoch, auth, trainingAuth);
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
          trainingAuthority = record.trainingAuthority ?? null;
          annotationAuthority = record.annotationAuthority ?? null;
          if (!body || typeof body !== 'object' || Array.isArray(body)
            || !Number.isInteger(body.publishId) || body.publishId < 1
            || body.publishId > MAX_PUBLISH_ID) {
            bail('BAD_ATTEMPT', '재시도 기록이 온전하지 않습니다. 그 파일을 지운 뒤 §4 표를 따르세요.');
          }
        }
      }
      const cutoffBodyAllowed = opts.viewOnly
        || envelope.review !== undefined
        || coachAuthority !== null
        || trainingAuthority !== null
        || annotationAuthority !== null
        || (body && (body.viewOnly === true || body.review !== undefined
          || Array.isArray(body.trainingAnnotations)));
      if (auth?.noNewPlayTimePublishers && !cutoffBodyAllowed) {
        bail('PLAYTIME_PUBLISH_STOPPED', 'game-over cutoff 이후 play-time 게시는 중단됐습니다.');
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
        try {
          body = { publishId: nextId, ...buildBody(envelope, opts) };
        } catch (error) {
          if (error?.code === 'BAD_HAND_REPLAY') bail('BAD_HAND_REPLAY', 'handReplay 트리거가 올바르지 않습니다.');
          throw error;
        }
        if (!opts.retry) {
          const pendingNos = readReplayPendingNos(gameDir);
          const envelopeNos = body.handReplay?.handNos ?? [];
          const allNos = unionHandNos(pendingNos, envelopeNos);
          writeJsonAtomic(replayPendingPath(gameDir), { handNos: allNos });
          const handNos = allNos.slice(0, HAND_REPLAY_TRIGGER_MAX);
          if (handNos.length) body.handReplay = { handNos };
          else delete body.handReplay;
        }
      }
      if (body.actionAck !== undefined) {
        try {
          body.actionAck = validateActionAck(body.actionAck, {
            gameEpoch: epoch, view: body.view, viewOnly: body.viewOnly === true,
          });
        } catch { bail('BAD_ACTION_ACK', '액션 확인이 현재 게임과 authoritative view에 묶이지 않았습니다.'); }
      }
      assertCoachQueue(auth, coachAuthority, epoch);
      assertTrainingQueue(trainingAuth, trainingAuthority, epoch);
      assertAnnotationQueue(trainingAuth, annotationAuthority, epoch);
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
        const digest = payloadSha256(note);
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
      if (trainingAuthority) {
        const notes = body.training;
        if (!Array.isArray(notes) || notes.length === 0) {
          bail('BAD_ENVELOPE', 'training body shape이 올바르지 않습니다.');
        }
        if (!Array.isArray(trainingAuthority.items) || trainingAuthority.items.length !== notes.length) {
          bail('STALE_TRAINING_AUTHORITY', 'trainingAuthority.items가 body와 일치하지 않습니다.');
        }
        for (const note of notes) {
          let projected;
          try {
            projected = projectTrainingSummary(note);
          } catch {
            bail('STALE_TRAINING_AUTHORITY', 'training 항목을 투영하지 못했습니다.');
          }
          const bound = trainingAuthority.items.find((entry) => entry.evaluationId === note.evaluationId);
          if (!bound
            || projected.payloadSha256 !== bound.payloadSha256
            || projected.payloadSha256 !== note.payloadSha256) {
            bail('STALE_TRAINING_AUTHORITY', 'envelope semantic digest가 queue와 일치하지 않습니다.');
          }
        }
      }
      if (annotationAuthority) {
        const notes = body.trainingAnnotations;
        if (!Array.isArray(notes) || notes.length === 0) {
          bail('BAD_ENVELOPE', 'trainingAnnotations body shape이 올바르지 않습니다.');
        }
        if (!Array.isArray(annotationAuthority.items)
          || annotationAuthority.items.length !== notes.length) {
          bail('STALE_ANNOTATION_AUTHORITY', 'annotationAuthority.items가 body와 일치하지 않습니다.');
        }
        for (const note of notes) {
          let projected;
          try {
            projected = projectTrainingAnnotation(note);
          } catch {
            bail('STALE_ANNOTATION_AUTHORITY', 'annotation 항목을 투영하지 못했습니다.');
          }
          const bound = annotationAuthority.items.find((entry) => (
            entry.evaluationId === note.evaluationId && entry.field === note.field
          ));
          if (!bound
            || projected.valueSha256 !== bound.valueSha256
            || projected.valueSha256 !== note.valueSha256) {
            bail('STALE_ANNOTATION_AUTHORITY', 'annotation digest가 queue와 일치하지 않습니다.');
          }
        }
      }
      if (body.hint && utf8ByteLength(JSON.stringify(body)) > MAX_PUBLISH_BODY_BYTES) {
        delete body.hint;
        fs.writeSync(2,'HINT_BODY_BUDGET\n');
      }
      const attemptRecord = { body, expectedGameEpoch: epoch };
      if (coachAuthority) attemptRecord.coachAuthority = coachAuthority;
      if (trainingAuthority) attemptRecord.trainingAuthority = trainingAuthority;
      if (annotationAuthority) attemptRecord.annotationAuthority = annotationAuthority;
      const bodySha256 = sha256Hex(JSON.stringify(body));
      if (Array.isArray(body.trainingAnnotations) && body.trainingAnnotations.length > 0) {
        // #274: outstanding retirement evidence (the snapshot taken above, before the
        // authorities) means a refused explanation's queue settlement has not happened yet (it
        // may be waiting behind another holder of the training lock, or an interrupted
        // process). Until it is settled, no annotation-bearing body may be judged by the relay
        // — with or without the private authority wrapper, which the relay never sees — the
        // relay's answer can change with the hand being played, and a body carrying the
        // retired explanation's notes would be judged again. The one exception is the resend
        // of exactly the recorded body the evidence names (an interrupted retirement of that
        // attempt), which the retirement path and an ordinary retry both settle.
        if (pendingEvidenceUnreadable) {
          bail('REJECTION_EVIDENCE_UNAVAILABLE', '비공개 폐기 증거를 안전하게 읽지 못해 보내지 않았습니다.');
        }
        if (pendingEvidence && !(opts.retry && pendingEvidence.bodySha256 === bodySha256)) {
          bail('REJECTION_EVIDENCE_PENDING', '정리되지 않은 폐기 증거가 남아 있어 annotation을 보내지 않았습니다.');
        }
      }
      if (opts.retry) {
        // #274: a resent recorded body — a retirement or an ordinary retry — may already stand
        // beside unfinished private evidence, and that evidence will point at this exact
        // record: its bytes (not only its directory entry) must be on disk before anything
        // depends on it. The record just read is kept and fsynced through a writable handle
        // when its bytes already are the canonical serialization; otherwise the canonical bytes
        // replace it durably. Links and other unsafe records are refused untouched. A failure
        // here changes nothing and sends nothing.
        try {
          installAttemptDurably(gameDir, path.basename(attemptPath(gameDir)), JSON.stringify(attemptRecord));
        } catch (syncFailure) {
          bail('ATTEMPT_SYNC_FAILED', '기록된 게시 시도를 내구성 있게 보존하지 못해 보내지 않았습니다.', {
            auditCode: ['REJECTION_AUDIT_UNSAFE', 'REJECTION_AUDIT_CHANGED'].includes(syncFailure?.code)
              ? syncFailure.code : 'REJECTION_AUDIT_UNAVAILABLE',
          });
        }
      } else {
        writeAttempt(gameDir, attemptRecord);
      }
      const afterLock = remainingMs(opts.deadlineMonotonicNs);
      if (afterLock === 0) bail('DEADLINE_EXPIRED', '락 획득 뒤 게시 deadline이 만료됐습니다.');
      const httpMs = afterLock == null ? PUBLISH_TIMEOUT_MS : Math.min(PUBLISH_TIMEOUT_MS, afterLock);
      if (opts.expectAttemptSha256 && bodySha256 !== opts.expectAttemptSha256) {
        bail('ATTEMPT_CHANGED', '보낼 본문이 호출자가 읽은 시도와 달라 보내지 않았습니다.');
      }
      if (opts.retireRejected) {
        if (!isAnnotationOnlyAttempt({ body, coachAuthority, trainingAuthority, annotationAuthority })) {
          bail('ATTEMPT_NOT_RETIRABLE', '설명 annotation만 담은 시도만 폐기 경로로 보낼 수 있습니다.');
        }
        // A refusal of this body becomes evidence the training control must be able to
        // settle: every note bound to its authority item by value digest and public proof.
        // Checked here, before anything is sent, so a retirement never removes an attempt
        // whose evidence the verifier would reject.
        const ineligible = annotationAttemptSettlementReason({ body, annotationAuthority });
        if (ineligible) {
          bail('ATTEMPT_NOT_RETIRABLE', `기록된 시도의 annotation 증명이 정산 조건을 만족하지 않아 보내지 않았습니다 (${ineligible}).`);
        }
        // The seal that queued these annotations was a rename into training/, and their
        // canonical files were created in training/annotations: make both directory entries
        // durable before evidence that depends on the queue and on those names exists (POSIX;
        // reported, not claimed, on Windows). A failure here sends nothing.
        try {
          const annotationsDir = path.join(gameDir, 'training', 'annotations');
          if (fs.existsSync(annotationsDir)) syncDirectory(annotationsDir);
          syncDirectory(path.join(gameDir, 'training'));
        } catch {
          bail('ATTEMPT_SYNC_FAILED', 'training authority 디렉터리를 동기화하지 못해 보내지 않았습니다.', {
            auditCode: 'REJECTION_AUDIT_UNAVAILABLE',
          });
        }
        await assertRelayBinding(gameDir, opts, lock);
      }
      let json;
      try {
        json = await postPublish(lock, body, httpMs);
      } catch (error) {
        // The relay answered and judged this exact body. Transport failures (PUBLISH_FAILED)
        // and every refusal outside the retirable set keep the attempt and fail closed.
        if (!(opts.retireRejected && error?.code === 'PUBLISH_REJECTED'
          && isRetirableAnnotationRejection(error.httpStatus, error.serverCode))) {
          // #274: the identity of the recorded body this POST carried travels with the failure
          // (digest, publishId, game epoch — closed fields only), so an automatic resend can be
          // bound to exactly this record and never to whichever record exists later.
          if (error instanceof ToolError && (error.code === 'PUBLISH_FAILED' || error.code === 'PUBLISH_REJECTED')) {
            error.attempt = { bodySha256, publishId: body.publishId, expectedGameEpoch: epoch };
          }
          throw error;
        }
        // The refusal is evidence only if it came from the relay verified before the POST. A
        // binding that no longer holds is the failure, carrying the refusal that was observed.
        try {
          await assertRelayBinding(gameDir, opts, lock);
        } catch (bindingFailure) {
          throw preserveInitialRejection(bindingFailure, error);
        }
        const evidence = {
          schemaVersion: 1,
          at: new Date().toISOString(),
          publishId: body.publishId,
          expectedGameEpoch: epoch,
          bodySha256,
          httpStatus: error.httpStatus,
          serverCode: error.serverCode,
          items: annotationAuthority.items.map((entry) => ({
            evaluationId: entry.evaluationId,
            field: entry.field,
            valueSha256: entry.valueSha256,
          })),
        };
        // Ordered and durable: the private evidence (exact body, authority and verified relay
        // identity), then the digest-only audit line, each with file and directory fsynced,
        // exist before the attempt is removed, and the removal is durable before the caller
        // settles the queue. An interruption after the removal is settled from the evidence
        // (training control) before any new annotation is published. Any failure keeps the
        // attempt exactly as it was and reports only the original refusal's closed fields.
        try {
          writeRetirementEvidence(gameDir, {
            ...evidence,
            body,
            annotationAuthority,
            relayBinding: { pid: opts.relayPid, startTime: opts.relayStartTime, port: opts.relayPort },
          });
          appendRejectionRecord(gameDir, evidence);
        } catch (auditFailure) {
          bail('REJECTION_AUDIT_FAILED', '거절 감사 기록을 안전하게 남기지 못해 시도를 보존했습니다.', {
            httpStatus: error.httpStatus, serverCode: error.serverCode,
            auditCode: ['REJECTION_AUDIT_UNSAFE', 'REJECTION_AUDIT_CHANGED', 'REJECTION_EVIDENCE_PENDING'].includes(auditFailure?.code)
              ? auditFailure.code : 'REJECTION_AUDIT_UNAVAILABLE',
          });
        }
        try {
          removeDurably(gameDir, path.basename(attemptPath(gameDir)));
        } catch {
          bail('REJECTION_AUDIT_FAILED', '거절은 기록했지만 시도 제거를 확정하지 못했습니다.', {
            httpStatus: error.httpStatus, serverCode: error.serverCode, auditCode: 'REJECTION_AUDIT_UNAVAILABLE',
          });
        }
        return { retired: true, evidence };
      }
      // An accepted retirement resend is reported with the identity of what was actually
      // sent, and only from the relay that was verified around it.
      if (opts.retireRejected) await assertRelayBinding(gameDir, opts, lock);
      if (!opts.retry && json.applied === false) {
        try { fs.unlinkSync(attemptPath(gameDir)); } catch { /* already gone */ }
        bail('PUBLISH_ID_REUSED', '이 publishId는 이미 다른 본문이 소비했습니다. 기록을 지웠으니 새 id로 다시 게시하세요.');
      }
      const fallback = opts.retry && json.applied === false ? (body.handReplay?.handNos ?? []) : [];
      drainReplayPending(gameDir, json.handReplay, fallback);
      // #274: the relay took a resend of this exact attempt after all. Evidence an interrupted
      // retirement of the same body left behind no longer proves a refusal; it goes before
      // the attempt, or the attempt stays for another resend.
      if (opts.retry) {
        try { removeRetirementEvidence(gameDir, bodySha256); } catch {
          bail('REJECTION_EVIDENCE_UNAVAILABLE', '이전 폐기 증거를 정리하지 못해 시도를 보존했습니다.');
        }
      }
      try { fs.unlinkSync(attemptPath(gameDir)); } catch { /* already gone */ }
      return {
        publishId: body.publishId,
        bodySha256,
        revision: json.revision,
        hadCoach: Array.isArray(body.coach),
        applied: json.applied !== false,
        handReplay: json.handReplay,
        hintDisposition: json.hintDisposition,
      };
    }, { timeoutMs: lockWaitMs });
    if (published.retired) return published;
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
    return;
  }
  const envelope = readJson(opts.from, 'BAD_ENVELOPE', 'envelope');
  // A --retry that resolves a pending attempt sends the recorded body, never this
  // envelope — and the file is often a rejection envelope by then, which would
  // otherwise block the very recovery the dealer was told to run.
  const resolvingAttempt = opts.retry && fs.existsSync(attemptPath(gameDir));
  if (!resolvingAttempt) checkEnvelope(envelope, opts.from);
  if (!resolvingAttempt && opts.actionAckFile) {
    let fd;
    try {
      fd = fs.openSync(opts.actionAckFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > 1024) throw new Error('unsafe ack file');
      opts.actionAck = JSON.parse(fs.readFileSync(fd, 'utf8'));
    } catch { bail('BAD_ACTION_ACK', '액션 확인 파일을 안전하게 읽지 못했습니다.'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  const lock = readLock(gameDir);

  const published = opts.waitOnly ? null : await publishOnce(gameDir, lock, envelope, opts);

  const out = { ok: true };
  if (published?.retired) {
    out.retired = true;
    out.applied = false;
    out.publishId = published.evidence.publishId;
    const { bodySha256, httpStatus, serverCode, expectedGameEpoch } = published.evidence;
    out.rejection = { publishId: published.evidence.publishId, expectedGameEpoch, bodySha256, httpStatus, serverCode };
    reply(out, 0);
    return;
  }
  if (published) {
    out.publishId = published.publishId;
    out.revision = published.revision;
    out.hadCoach = published.hadCoach === true;
    out.reconcilePending = published.reconcilePending === true;
    out.applied = published.applied;
    // #274: a caller that resent a recorded body settles only what this resend actually carried.
    if (opts.retry) out.bodySha256 = published.bodySha256;
    if (published.hintDisposition) out.hintDisposition = published.hintDisposition;
    if (published.handReplay) out.handReplay = published.handReplay;
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
  if (error instanceof ToolError) {
    // A refusal observed before this failure (preserveInitialRejection) travels as closed
    // status/code pairs only — the first and at most one recheck — whatever the final code.
    const closed = (tuple) => (tuple && typeof tuple === 'object'
      ? sanitizeRejectionFields(tuple.httpStatus, tuple.serverCode) : null);
    const observed = closed(error.rejection);
    const recheck = closed(error.recheckRejection);
    // The recorded body a failed POST carried: closed identity fields only.
    const attempt = error.attempt && typeof error.attempt === 'object'
      && /^[0-9a-f]{64}$/.test(error.attempt.bodySha256 ?? '')
      && Number.isSafeInteger(error.attempt.publishId) && error.attempt.publishId >= 1
      && /^[0-9a-f]{64}$/.test(error.attempt.expectedGameEpoch ?? '')
      ? { bodySha256: error.attempt.bodySha256, publishId: error.attempt.publishId, expectedGameEpoch: error.attempt.expectedGameEpoch }
      : null;
    reply({
      ok: false, code: error.code, message: error.message,
      ...(error.code === 'PUBLISH_REJECTED' || error.code === 'REJECTION_AUDIT_FAILED'
        ? { httpStatus: error.httpStatus, serverCode: error.serverCode } : {}),
      ...(error.code === 'REJECTION_AUDIT_FAILED' || error.code === 'ATTEMPT_SYNC_FAILED' ? { auditCode: error.auditCode } : {}),
      ...(observed && observed.httpStatus !== 0 ? { rejection: observed } : {}),
      ...(recheck && recheck.httpStatus !== 0 ? { recheckRejection: recheck } : {}),
      ...(attempt ? { attempt } : {}),
    }, 1);
  } else reply({ ok: false, code: 'INTERNAL', message: error?.message ?? '알 수 없는 오류' }, 1);
}
