#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withNamedLock, writeJsonAtomic } from '../engine/state.js';
import { readPersistedSolver } from './solver-runtime.js';
import {
  MAX_PUBLISH_BODY_BYTES,
  SUPPORTED_COACH_AUTHORITY_SCHEMAS,
  canonicalPayloadJson,
  gameEpochOf,
  payloadSha256,
  proofBearingCoachNote,
  publicProofId,
  publishBodyByteLength,
} from '../publish-contract.js';

export const UNAVAILABLE_TEXT = '이 핸드의 코치 응답을 생성하지 못했습니다. 종합 리뷰에서 해당 핸드를 다시 확인합니다.';
export const LOCK_NAME = 'publish.lock.d';
const AUTH_FILE = '.coach-authority.json';
export const DEFAULT_ATTEMPT_MS = 120_000;

export class CoachError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoachError(code, message);
}

function isPlainMap(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function mapKeys(value) {
  return isPlainMap(value) ? Object.keys(value) : [];
}

function collectionHasEntries(value) {
  if (Array.isArray(value)) return value.length > 0;
  return mapKeys(value).length > 0;
}

function queueHasLeftovers(queue) {
  if (!isPlainMap(queue)) return false;
  return Object.keys(queue).some((key) => {
    const fields = queue[key];
    if (fields == null) return false;
    if (typeof fields !== 'object') return true;
    if (Array.isArray(fields)) return fields.length > 0;
    return Object.keys(fields).length > 0;
  });
}

function authPath(gameDir) {
  return path.join(gameDir, AUTH_FILE);
}

function dehydrate(auth) {
  return JSON.parse(JSON.stringify(auth, (_, value) => (
    typeof value === 'bigint' ? value.toString() : value
  )));
}

function reviveHand(hand) {
  if (!hand) return hand;
  if (hand.startedMono != null) hand.startedMono = BigInt(hand.startedMono);
  if (hand.deadlineMono != null) hand.deadlineMono = BigInt(hand.deadlineMono);
  return hand;
}

function revive(auth) {
  if (!auth) return null;
  for (const hand of Object.values(auth.hands ?? {})) reviveHand(hand);
  return auth;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function canStartReplacement(nowMono, resultWaitCutoffMono) {
  return (resultWaitCutoffMono - nowMono) >= 5_000_000_000n;
}

export async function terminateProcessGroup(pid, { confirmMs = 800 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { confirmed: false, reason: 'invalid-pid' };
  }
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  };
  if (!alive()) return { confirmed: true };
  try { process.kill(pid, 'SIGTERM'); } catch (error) {
    if (error.code === 'ESRCH') return { confirmed: true };
  }
  const deadline = Date.now() + confirmMs;
  while (Date.now() < deadline) {
    if (!alive()) return { confirmed: true };
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try { process.kill(pid, 'SIGKILL'); } catch (error) {
    if (error.code === 'ESRCH') return { confirmed: true };
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return alive()
    ? { confirmed: false, reason: 'termination_unconfirmed' }
    : { confirmed: true };
}

export function hasLiveLockHolder(gameDir) {
  const pidPath = path.join(gameDir, LOCK_NAME, 'pid');
  try {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function sessionTokenOf(gameDir) {
  const lock = readJsonFile(path.join(gameDir, 'lock.json'));
  if (!lock || typeof lock.sessionToken !== 'string' || !lock.sessionToken) {
    fail('NO_LOCK', 'lock.json에서 sessionToken을 읽지 못했습니다.');
  }
  return lock.sessionToken;
}

function currentEpoch(gameDir) {
  return gameEpochOf(sessionTokenOf(gameDir));
}

function freshAuthority(epoch, owner) {
  return {
    schemaVersion: 2,
    gameEpoch: epoch,
    activeOwnerSessionId: owner,
    adapterState: 'enabled',
    legacyMigrationCompleted: false,
    overfoldLease: null,
    hands: {},
    retiredAttempts: [],
    publishQueue: {},
    publishedSeals: {},
    noNewPlayTimePublishers: false,
    finalization: null,
  };
}

function assertSupported(auth) {
  if (!auth) return;
  if (!SUPPORTED_COACH_AUTHORITY_SCHEMAS.includes(auth.schemaVersion)) {
    fail('UNSUPPORTED_COACH_AUTHORITY', `schema ${auth.schemaVersion}은 지원하지 않습니다.`);
  }
}

function loadAuthorityFile(gameDir) {
  const file = authPath(gameDir);
  if (!fs.existsSync(file)) return null;
  const auth = revive(readJsonFile(file));
  assertSupported(auth);
  return auth;
}

function keyOf(handNo) {
  return String(handNo);
}

function coachPaths(gameDir, epoch, owner, handNo, generation, attempt) {
  const base = path.join(
    gameDir,
    `.coach-${epoch.slice(0, 12)}-${owner}-h${handNo}-g${generation}-a${attempt}`,
  );
  return {
    exactResultPath: `${base}.result.json`,
    exactEnvelopePath: `${base}.envelope.json`,
  };
}

function migrationEnvelopePath(gameDir, epoch, handNo, digest) {
  return path.join(
    gameDir,
    `.coach-${epoch.slice(0, 12)}-migration-h${handNo}-${digest.slice(0, 12)}.envelope.json`,
  );
}

function nextGeneration(auth, handNo) {
  const live = auth.hands[keyOf(handNo)]?.generation ?? 0;
  let retired = 0;
  for (const row of auth.retiredAttempts) {
    if (row.handNo === handNo && row.generation > retired) retired = row.generation;
  }
  const queued = auth.publishQueue[keyOf(handNo)]?.generation ?? 0;
  return Math.max(live, retired, queued) + 1;
}

function retireActive(auth, handNo, fields) {
  const hand = auth.hands[keyOf(handNo)];
  if (!hand) return;
  auth.retiredAttempts.push({
    ownerSessionId: hand.ownerSessionId,
    handNo,
    generation: hand.generation,
    attempt: hand.attempt,
    agentHandle: hand.agentHandle,
    resultState: fields.resultState,
    exactResultPath: hand.exactResultPath,
    exactEnvelopePath: hand.exactEnvelopePath,
    cleanupEligible: Boolean(fields.cleanupEligible),
    replacementGeneration: fields.replacementGeneration ?? null,
    cleanupState: fields.cleanupState ?? 'pending',
  });
  delete auth.hands[keyOf(handNo)];
}

function readStats(statsFile) {
  const json = readJsonFile(statsFile);
  const user = json.perPlayer?.user ?? {};
  return { sample: Number(user.sample) || 0, vpip: Number(user.vpip) || 0 };
}

function readSnapshot(snapshotFile) {
  try {
    return readJsonFile(snapshotFile);
  } catch {
    return null;
  }
}

function tupleOf(note) {
  return {
    handNo: note.handNo,
    text: note.text,
    overfold: note.overfold === true,
    unavailable: note.unavailable === true,
  };
}

function overfoldUsed(auth, snapshot) {
  const lease = auth.overfoldLease;
  if (lease && ['active', 'queued', 'spent'].includes(lease.state)) return true;
  for (const note of snapshot?.coach ?? []) {
    if (note.overfold === true) return true;
  }
  for (const item of Object.values(auth.publishQueue)) {
    if (item.overfold) return true;
  }
  for (const item of Object.values(auth.publishedSeals)) {
    if (item.overfold) return true;
  }
  return false;
}

function overfoldEligible(stats) {
  return stats.sample >= 12 && stats.vpip < 0.12;
}

function matchingCaller(hand, owner, generation) {
  return Boolean(
    hand
    && hand.ownerSessionId === owner
    && (generation == null || hand.generation === generation),
  );
}

function assertExactFile(gameDir, filePath) {
  const root = `${path.resolve(gameDir)}${path.sep}`;
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(root)) fail('UNSAFE_PATH', `${filePath}가 gameDir 밖입니다.`);
  let st;
  try {
    st = fs.lstatSync(resolved);
  } catch {
    fail('MISSING_PATH', `${filePath}를 읽을 수 없습니다.`);
  }
  if (st.isSymbolicLink()) fail('SYMLINK_PATH');
  if (!st.isFile()) fail('NOT_FILE');
  if (st.nlink !== 1) fail('MULTI_LINK_PATH');
}

function peekCoachResult(gameDir, hand, handNo) {
  try {
    assertExactFile(gameDir, hand.exactResultPath);
  } catch (error) {
    if (error instanceof CoachError) {
      return { ok: false, code: error.code === 'MISSING_PATH' ? 'NO_RESULT' : error.code };
    }
    throw error;
  }
  const raw = fs.readFileSync(hand.exactResultPath, 'utf8');
  return validateCoachOutput(raw, handNo);
}

function occupiedReject(auth, handNo, owner, generation, code) {
  const key = keyOf(handNo);
  const item = auth.publishQueue[key] ?? auth.publishedSeals[key];
  const hand = auth.hands[key];
  const matching = matchingCaller(hand, owner, generation) && generation != null;
  if (item?.overfold) {
    auth.overfoldLease = {
      handNo,
      generation: item.generation ?? auth.overfoldLease?.generation ?? 0,
      ownerSessionId: item.sourceOwnerSessionId ?? 'seal',
      state: auth.publishQueue[key] ? 'queued' : 'spent',
      queueId: item.queueId,
    };
  } else if (matching && auth.overfoldLease?.handNo === handNo && auth.overfoldLease.state === 'active') {
    auth.overfoldLease = null;
  }
  if (matching) {
    retireActive(auth, handNo, { resultState: 'discarded', cleanupEligible: true });
  }
  return { ok: false, code };
}

function writeEnvelope(filePath, envelope) {
  writeJsonAtomic(filePath, envelope);
}

function coachEnvelope(tuple, proof, authority) {
  return {
    coach: [proofBearingCoachNote(tuple, proof)],
    coachAuthority: authority,
  };
}

function queueItem({
  queueId, epoch, handNo, generation, owner, attempt, noteKind, exactEnvelopePath, digest, proofId, overfold,
}) {
  return {
    queueId,
    gameEpoch: epoch,
    handNo,
    generation,
    sourceOwnerSessionId: owner,
    sourceAttempt: attempt,
    noteKind,
    exactEnvelopePath,
    payloadSha256: digest,
    publicProofId: proofId,
    publicationState: 'pending',
    overfold: Boolean(overfold),
  };
}

function insertReservation(auth, {
  gameDir, epoch, owner, handNo, attempt, deadlineMs, now,
}) {
  const generation = nextGeneration(auth, handNo);
  const paths = coachPaths(gameDir, epoch, owner, handNo, generation, attempt);
  auth.hands[keyOf(handNo)] = {
    generation,
    attempt,
    ownerSessionId: owner,
    agentHandle: null,
    startedMono: now,
    deadlineMono: now + BigInt(deadlineMs) * 1_000_000n,
    status: 'reserved',
    resultState: 'unread',
    exactResultPath: paths.exactResultPath,
    exactEnvelopePath: paths.exactEnvelopePath,
    cleanupEligible: false,
    replacementGeneration: null,
  };
  return {
    handNo,
    generation,
    attempt,
    exactResultPath: paths.exactResultPath,
    exactEnvelopePath: paths.exactEnvelopePath,
    overfoldReserved: false,
  };
}

function validLegacyNote(note) {
  if (!note || !Number.isInteger(note.handNo) || typeof note.text !== 'string' || !note.text.trim()) {
    return false;
  }
  if (note.overfold !== undefined && note.overfold !== true && note.overfold !== false) return false;
  if (note.unavailable !== undefined && note.unavailable !== true && note.unavailable !== false) {
    return false;
  }
  return true;
}

function migrateLocked(gameDir, auth, snapshotFile) {
  if (auth.legacyMigrationCompleted) return auth;
  const snapshot = readSnapshot(snapshotFile) ?? { coach: [] };
  const epoch = auth.gameEpoch;
  for (const note of snapshot.coach ?? []) {
    const key = keyOf(note.handNo);
    if (auth.publishQueue[key] || auth.publishedSeals[key]) continue;
    if (!validLegacyNote(note)) continue;
    const tuple = tupleOf(note);
    const digest = payloadSha256(tuple);
    const queueId = `${epoch}:migration:${note.handNo}:${digest}`;
    const proof = { id: publicProofId(queueId), payloadSha256: digest };
    if (publishBodyByteLength(tuple, proof) > MAX_PUBLISH_BODY_BYTES) continue;
    const envPath = migrationEnvelopePath(gameDir, epoch, note.handNo, digest);
    const envelope = coachEnvelope(tuple, proof, {
      expectedGameEpoch: epoch,
      queueId,
      handNo: note.handNo,
      generation: 0,
      exactEnvelopePath: envPath,
      payloadSha256: digest,
    });
    if (fs.existsSync(envPath)) {
      let existing;
      try { existing = JSON.parse(fs.readFileSync(envPath, 'utf8')); }
      catch { existing = null; }
      if (existing?.coachAuthority?.payloadSha256 !== digest) {
        writeEnvelope(envPath, envelope);
      }
    } else {
      writeEnvelope(envPath, envelope);
    }
    auth.publishQueue[key] = queueItem({
      queueId,
      epoch,
      handNo: note.handNo,
      generation: 0,
      owner: 'migration',
      attempt: 0,
      noteKind: tuple.unavailable ? 'unavailable' : 'coach',
      exactEnvelopePath: envPath,
      digest,
      proofId: proof.id,
      overfold: tuple.overfold,
    });
    if (tuple.overfold) {
      auth.overfoldLease = {
        handNo: note.handNo,
        generation: 0,
        ownerSessionId: 'migration',
        state: 'queued',
        queueId,
      };
    }
  }
  auth.legacyMigrationCompleted = true;
  return auth;
}

function reconcileLocked(auth, snapshotFile) {
  const snapshot = readSnapshot(snapshotFile);
  if (!snapshot) return { reconciled: [] };
  const reconciled = [];
  for (const [key, item] of Object.entries(auth.publishQueue)) {
    const note = (snapshot.coach ?? []).find((entry) => entry.handNo === item.handNo);
    if (!note?.coachProof) continue;
    const recomputed = payloadSha256(tupleOf(note));
    if (recomputed !== item.payloadSha256) continue;
    if (note.coachProof.payloadSha256 !== item.payloadSha256) continue;
    if (note.coachProof.id !== item.publicProofId) continue;
    auth.publishedSeals[key] = {
      queueId: item.queueId,
      handNo: item.handNo,
      noteKind: item.noteKind,
      payloadSha256: item.payloadSha256,
      publicProofId: item.publicProofId,
      overfold: Boolean(item.overfold),
      publishedAtRevision: snapshot.revision ?? null,
    };
    delete auth.publishQueue[key];
    if (auth.overfoldLease?.queueId === item.queueId) auth.overfoldLease.state = 'spent';
    for (const row of auth.retiredAttempts) {
      if (row.exactEnvelopePath === item.exactEnvelopePath) row.cleanupEligible = true;
    }
    reconciled.push(item.handNo);
  }
  return { reconciled };
}

function completenessOf(auth, sample) {
  const publishedSealHandNos = Object.keys(auth?.publishedSeals ?? {}).map(Number).sort((a, b) => a - b);
  const pendingItems = Object.values(auth?.publishQueue ?? {});
  const publishQueueHandNos = pendingItems.map((item) => item.handNo).sort((a, b) => a - b);
  const pending = pendingItems
    .map((item) => ({ handNo: item.handNo, noteKind: item.noteKind }))
    .sort((a, b) => a.handNo - b.handNo);
  const unionSet = new Set([...publishedSealHandNos, ...publishQueueHandNos]);
  const expected = Array.from({ length: sample }, (_, i) => i + 1);
  const missing = expected.filter((handNo) => !unionSet.has(handNo));
  const extra = [...unionSet].filter((handNo) => handNo < 1 || handNo > sample);
  const disjoint = publishedSealHandNos.every((handNo) => !publishQueueHandNos.includes(handNo));
  const covers = missing.length === 0 && extra.length === 0;
  const ok = disjoint && covers && sample >= 0;
  const reviewGateOpen = ok && auth?.finalization?.status === 'SEALED';
  return {
    ok,
    disjoint,
    covers,
    union: [...unionSet].sort((a, b) => a - b),
    publishedSealHandNos,
    publishQueueHandNos,
    pending,
    missing,
    uiVisibilityClaimed: ok && pending.length === 0,
    reviewGateOpen,
    reviewDisclosure: pending,
  };
}

function validateCoachOutput(raw, handNo) {
  let note;
  try {
    note = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'malformed' };
  }
  if (!note || typeof note !== 'object' || Array.isArray(note)) {
    return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'not-object' };
  }
  if (note.handNo !== handNo) {
    return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'wrong-hand' };
  }
  if (typeof note.text !== 'string' || !note.text.trim()) {
    return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'empty' };
  }
  if (note.overfold !== undefined && note.overfold !== true) {
    return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'overfold' };
  }
  if (note.unavailable !== undefined && note.unavailable !== true) {
    return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'unavailable' };
  }
  const allowed = new Set(['handNo', 'text', 'overfold', 'unavailable']);
  for (const field of Object.keys(note)) {
    if (!allowed.has(field)) {
      return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'extra-field' };
    }
  }
  return { ok: true, note };
}

function migratableLegacyNote(note) {
  if (!validLegacyNote(note)) return false;
  const tuple = tupleOf(note);
  const digest = payloadSha256(tuple);
  const proof = { id: publicProofId('x'), payloadSha256: digest };
  return publishBodyByteLength(tuple, proof) <= MAX_PUBLISH_BODY_BYTES;
}

function snapshotOccupies(snapshotFile, handNo) {
  const snapshot = snapshotFile ? readSnapshot(snapshotFile) : null;
  const note = (snapshot?.coach ?? []).find((entry) => entry.handNo === handNo);
  return Boolean(note && migratableLegacyNote(note));
}

function appendTrace(gameDir, row) {
  fs.appendFileSync(
    path.join(gameDir, '.coach-adapter-trace.jsonl'),
    `${JSON.stringify(row)}\n`,
  );
}

function sealUnavailable(auth, {
  gameDir, epoch, owner, handNo, generation, reason, snapshotFile,
}) {
  const key = keyOf(handNo);
  if (auth.publishQueue[key]) return occupiedReject(auth, handNo, owner, generation, 'QUEUE_ALREADY_SEALED');
  if (auth.publishedSeals[key]) return occupiedReject(auth, handNo, owner, generation, 'HAND_ALREADY_PUBLISHED');
  if (generation == null && snapshotOccupies(snapshotFile, handNo)) {
    return { ok: false, code: 'HAND_SNAPSHOT_OCCUPIED' };
  }
  const hand = auth.hands[key];
  const retired = [...(auth.retiredAttempts ?? [])].reverse().find((entry) => (
    entry.handNo === handNo
    && entry.ownerSessionId === owner
    && (generation == null || entry.generation === generation)
  ));
  let gen = generation;
  let attempt = hand?.attempt ?? retired?.attempt ?? 0;
  let envPath;
  if (gen == null) {
    if (hand) fail('GENERATION_REQUIRED');
    gen = nextGeneration(auth, handNo);
    envPath = coachPaths(gameDir, epoch, owner, handNo, gen, 0).exactEnvelopePath;
  } else if (matchingCaller(hand, owner, gen)) {
    envPath = hand.exactEnvelopePath;
    attempt = hand.attempt;
  } else if (retired && retired.generation === gen) {
    envPath = retired.exactEnvelopePath;
    attempt = retired.attempt;
  } else {
    fail('STALE_GENERATION');
  }
  const tuple = {
    handNo,
    text: UNAVAILABLE_TEXT,
    overfold: false,
    unavailable: true,
  };
  const digest = payloadSha256(tuple);
  const queueId = `${epoch}:${handNo}:${gen}:${digest}`;
  const proof = { id: publicProofId(queueId), payloadSha256: digest };
  writeEnvelope(envPath, coachEnvelope(tuple, proof, {
    expectedGameEpoch: epoch,
    queueId,
    handNo,
    generation: gen,
    exactEnvelopePath: envPath,
    payloadSha256: digest,
    reason,
  }));
  auth.publishQueue[key] = queueItem({
    queueId,
    epoch,
    handNo,
    generation: gen,
    owner,
    attempt,
    noteKind: 'unavailable',
    exactEnvelopePath: envPath,
    digest,
    proofId: proof.id,
    overfold: false,
  });
  if (auth.overfoldLease?.handNo === handNo && auth.overfoldLease.state === 'active') {
    auth.overfoldLease = null;
  }
  if (hand) retireActive(auth, handNo, { resultState: 'discarded', cleanupEligible: false });
  return { ok: true, queueId, noteKind: 'unavailable' };
}

export function createCoachControl(deps = {}) {
  const nowNs = deps.now ?? (() => process.hrtime.bigint());
  const writeAuthority = deps.writeAuthority ?? writeJsonAtomic;
  const lockTimeoutMs = deps.lockTimeoutMs ?? 20_000;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  function persist(gameDir, auth) {
    writeAuthority(authPath(gameDir), dehydrate(auth));
  }

  function loadOrInit(gameDir, owner) {
    const epoch = currentEpoch(gameDir);
    const existing = loadAuthorityFile(gameDir);
    if (!existing) return { epoch, auth: freshAuthority(epoch, owner) };
    if (existing.gameEpoch !== epoch) fail('STALE_GAME_EPOCH');
    return { epoch, auth: existing };
  }

  function requireAuth(gameDir, { owner, requireActiveOwner = true } = {}) {
    const epoch = currentEpoch(gameDir);
    const auth = loadAuthorityFile(gameDir);
    if (!auth) fail('NO_AUTHORITY');
    if (auth.gameEpoch !== epoch) fail('STALE_GAME_EPOCH');
    if (requireActiveOwner && owner && auth.activeOwnerSessionId !== owner) fail('STALE_OWNER');
    return { epoch, auth };
  }

  function withLock(gameDir, fn) {
    return withNamedLock(gameDir, LOCK_NAME, fn, { timeoutMs: lockTimeoutMs });
  }

  function loadAuthority(gameDir) {
    return loadAuthorityFile(gameDir);
  }

  function completeness(gameDir, sample) {
    return completenessOf(loadAuthority(gameDir), sample);
  }

  async function beginOwner({ gameDir, owner, completed, statsFile, snapshotFile }) {
    return withLock(gameDir, () => {
      const { epoch, auth } = loadOrInit(gameDir, owner);
      migrateLocked(gameDir, auth, snapshotFile);
      reconcileLocked(auth, snapshotFile);
      auth.activeOwnerSessionId = owner;
      const descriptors = [];
      const sealedSkipped = [];
      const leaseHand = auth.overfoldLease?.state === 'active' ? auth.overfoldLease.handNo : null;
      for (let handNo = 1; handNo <= completed; handNo += 1) {
        const key = keyOf(handNo);
        if (auth.publishedSeals[key] || auth.publishQueue[key]) {
          sealedSkipped.push(handNo);
          continue;
        }
        const prior = auth.hands[key];
        const transfer = leaseHand === handNo;
        if (prior && (
          prior.status === 'reserved'
          || prior.status === 'running'
          || (prior.status === 'terminal' && prior.resultState === 'unread')
        )) {
          retireActive(auth, handNo, {
            resultState: 'discarded',
            cleanupEligible: true,
            replacementGeneration: nextGeneration(auth, handNo),
          });
        }
        const descriptor = insertReservation(auth, {
          gameDir,
          epoch,
          owner,
          handNo,
          attempt: 1,
          deadlineMs: DEFAULT_ATTEMPT_MS,
          now: nowNs(),
        });
        if (transfer) {
          descriptor.overfoldReserved = true;
          auth.overfoldLease = {
            ...auth.overfoldLease,
            handNo,
            generation: descriptor.generation,
            ownerSessionId: owner,
          };
        }
        descriptors.push(descriptor);
      }
      const stats = readStats(statsFile);
      const snapshot = readSnapshot(snapshotFile);
      if (overfoldEligible(stats) && !overfoldUsed(auth, snapshot)) {
        const fresh = descriptors.find((row) => !row.overfoldReserved);
        if (fresh) {
          auth.overfoldLease = {
            handNo: fresh.handNo,
            generation: fresh.generation,
            ownerSessionId: owner,
            state: 'active',
            queueId: null,
          };
          fresh.overfoldReserved = true;
        }
      }
      if (auth.adapterState === 'disabled' || auth.adapterState === 'unavailable') {
        const unavailableSealed = [];
        for (const descriptor of descriptors) {
          const result = sealUnavailable(auth, {
            gameDir,
            epoch,
            owner,
            handNo: descriptor.handNo,
            generation: descriptor.generation,
            reason: 'adapter-disabled',
            snapshotFile,
          });
          if (result.ok) unavailableSealed.push(descriptor.handNo);
        }
        persist(gameDir, auth);
        return {
          ok: true,
          owner,
          descriptors: [],
          sealedSkipped,
          unavailableSealed,
          adapterState: auth.adapterState,
        };
      }
      persist(gameDir, auth);
      return { ok: true, owner, descriptors, sealedSkipped };
    });
  }

  async function reserve({
    gameDir, owner, handNo, attempt = 1, deadlineMs = DEFAULT_ATTEMPT_MS,
    considerOverfold = false, statsFile, snapshotFile,
  }) {
    return withLock(gameDir, () => {
      const { epoch, auth } = loadOrInit(gameDir, owner);
      if (auth.activeOwnerSessionId !== owner) fail('STALE_OWNER');
      if (auth.adapterState === 'disabled' || auth.adapterState === 'unavailable') {
        return { ok: false, code: 'ADAPTER_DISABLED' };
      }
      const key = keyOf(handNo);
      if (auth.publishQueue[key]) return { ok: false, code: 'QUEUE_ALREADY_SEALED' };
      if (auth.publishedSeals[key]) return { ok: false, code: 'HAND_ALREADY_PUBLISHED' };
      const prior = auth.hands[key];
      if (prior) {
        retireActive(auth, handNo, {
          resultState: 'discarded',
          cleanupEligible: false,
          replacementGeneration: nextGeneration(auth, handNo),
        });
      }
      const descriptor = insertReservation(auth, {
        gameDir, epoch, owner, handNo, attempt, deadlineMs, now: nowNs(),
      });
      if (considerOverfold) {
        const stats = readStats(statsFile);
        const snapshot = readSnapshot(snapshotFile);
        const transfer = auth.overfoldLease?.state === 'active' && auth.overfoldLease.handNo === handNo;
        if (transfer) {
          auth.overfoldLease = {
            ...auth.overfoldLease,
            generation: descriptor.generation,
            ownerSessionId: owner,
          };
          descriptor.overfoldReserved = true;
        } else if (overfoldEligible(stats) && !overfoldUsed(auth, snapshot)) {
          auth.overfoldLease = {
            handNo,
            generation: descriptor.generation,
            ownerSessionId: owner,
            state: 'active',
            queueId: null,
          };
          descriptor.overfoldReserved = true;
        }
      }
      persist(gameDir, auth);
      return { ok: true, ...descriptor };
    });
  }

  async function bindHandle({ gameDir, owner, handNo, generation, handle }) {
    return withLock(gameDir, () => {
      const { auth } = requireAuth(gameDir, { owner });
      const hand = auth.hands[keyOf(handNo)];
      if (!matchingCaller(hand, owner, generation)) {
        return { ok: false, code: 'SUPERSEDED', discard: true };
      }
      hand.agentHandle = handle;
      hand.status = 'running';
      persist(gameDir, auth);
      appendTrace(gameDir, {
        gameEpoch: auth.gameEpoch, ownerSessionId: owner, operation: 'bind-handle',
        handNo, generation, handle, outcome: 'ok',
      });
      return { ok: true };
    });
  }

  async function accept({ gameDir, owner, handNo, generation, forbiddenLiterals = [] }) {
    return withLock(gameDir, () => {
      const { epoch, auth } = requireAuth(gameDir, { owner });
      const key = keyOf(handNo);
      if (auth.publishQueue[key]) {
        const result = occupiedReject(auth, handNo, owner, generation, 'QUEUE_ALREADY_SEALED');
        persist(gameDir, auth);
        return result;
      }
      if (auth.publishedSeals[key]) {
        const result = occupiedReject(auth, handNo, owner, generation, 'HAND_ALREADY_PUBLISHED');
        persist(gameDir, auth);
        return result;
      }
      const hand = auth.hands[key];
      if (!matchingCaller(hand, owner, generation)) fail('STALE_GENERATION');
      const peeked = peekCoachResult(gameDir, hand, handNo);
      if (!peeked.ok) {
        if (peeked.code === 'INVALID_COACH_OUTPUT') return peeked;
        if (!(nowNs() < hand.deadlineMono)) {
          retireActive(auth, handNo, {
            resultState: 'discarded',
            cleanupEligible: false,
            cleanupState: 'pending',
          });
          persist(gameDir, auth);
          return { ok: false, code: 'ATTEMPT_TIMEOUT' };
        }
        fail('MISSING_PATH', `${hand.exactResultPath}를 읽을 수 없습니다.`);
      }
      const parsed = peeked;
      for (const lit of forbiddenLiterals) {
        if (lit && parsed.note.text.includes(lit)) {
          return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'forbidden-literal' };
        }
      }
      const tuple = tupleOf(parsed.note);
      const digest = payloadSha256(tuple);
      const queueId = `${epoch}:${handNo}:${generation}:${digest}`;
      const proof = { id: publicProofId(queueId), payloadSha256: digest };
      if (publishBodyByteLength(tuple, proof) > MAX_PUBLISH_BODY_BYTES) {
        return { ok: false, code: 'INVALID_COACH_OUTPUT', reason: 'oversize' };
      }
      const envelope = coachEnvelope(tuple, proof, {
        expectedGameEpoch: epoch,
        queueId,
        handNo,
        generation,
        exactEnvelopePath: hand.exactEnvelopePath,
        payloadSha256: digest,
      });
      writeEnvelope(hand.exactEnvelopePath, envelope);
      assertExactFile(gameDir, hand.exactEnvelopePath);
      auth.publishQueue[key] = queueItem({
        queueId,
        epoch,
        handNo,
        generation,
        owner,
        attempt: hand.attempt,
        noteKind: tuple.unavailable ? 'unavailable' : 'coach',
        exactEnvelopePath: hand.exactEnvelopePath,
        digest,
        proofId: proof.id,
        overfold: tuple.overfold,
      });
      if (tuple.overfold) {
        auth.overfoldLease = {
          handNo,
          generation,
          ownerSessionId: owner,
          state: 'queued',
          queueId,
        };
      } else if (auth.overfoldLease?.handNo === handNo && auth.overfoldLease.state === 'active') {
        auth.overfoldLease = null;
      }
      retireActive(auth, handNo, { resultState: 'consumed', cleanupEligible: false });
      persist(gameDir, auth);
      return { ok: true, queueId };
    });
  }

  async function watchAccept({
    gameDir, owner, handNo, generation, forbiddenLiterals = [], pollMs = 200, publish = false,
  }) {
    for (;;) {
      let out;
      try {
        out = await accept({ gameDir, owner, handNo, generation, forbiddenLiterals });
      } catch (error) {
        if (error instanceof CoachError && (error.code === 'MISSING_PATH' || error.code === 'NO_RESULT')) {
          out = { ok: false, code: 'NO_RESULT' };
        } else {
          throw error;
        }
      }
      if (out.ok) {
        if (publish) {
          const auth = loadAuthorityFile(gameDir);
          const item = auth.publishQueue[keyOf(handNo)];
          if (!item?.exactEnvelopePath) fail('NO_ENVELOPE');
          const publisher = path.join(path.dirname(fileURLToPath(import.meta.url)), 'publish.js');
          const spawned = spawnSync(process.execPath, [
            publisher, '--from', item.exactEnvelopePath, '--lock-wait-ms', '15000',
          ], { encoding: 'utf8' });
          let published;
          try {
            published = JSON.parse(String(spawned.stdout).trim().split('\n').at(-1));
          } catch {
            published = { ok: false, code: 'PUBLISH_FAILED', stderr: spawned.stderr };
          }
          return { ...out, published };
        }
        return out;
      }
      if (out.code === 'NO_RESULT' || out.code === 'MISSING_PATH') {
        await sleep(pollMs);
        continue;
      }
      return out;
    }
  }

  async function completeUnavailable({ gameDir, owner, handNo, generation, reason, snapshotFile }) {
    return withLock(gameDir, () => {
      const { epoch, auth } = loadOrInit(gameDir, owner);
      if (auth.activeOwnerSessionId && auth.activeOwnerSessionId !== owner) fail('STALE_OWNER');
      if (snapshotFile) migrateLocked(gameDir, auth, snapshotFile);
      if (reason === 'gate0') auth.adapterState = 'unavailable';
      const result = sealUnavailable(auth, {
        gameDir, epoch, owner, handNo, generation, reason, snapshotFile,
      });
      persist(gameDir, auth);
      return result;
    });
  }

  async function reconcile({ gameDir, snapshotFile }) {
    return withLock(gameDir, () => {
      const existing = loadAuthorityFile(gameDir);
      if (!existing) return { ok: true, reconciled: [] };
      if (existing.gameEpoch !== currentEpoch(gameDir)) fail('STALE_GAME_EPOCH');
      const result = reconcileLocked(existing, snapshotFile);
      persist(gameDir, existing);
      return { ok: true, ...result };
    });
  }

  async function heartbeat({ gameDir, owner }) {
    return withLock(gameDir, () => {
      const { auth } = requireAuth(gameDir, { owner });
      const now = nowNs();
      const actions = [];
      for (const [key, hand] of Object.entries(auth.hands)) {
        if (hand.ownerSessionId !== owner) continue;
        if (auth.publishQueue[key] || auth.publishedSeals[key]) continue;
        if (!['reserved', 'running'].includes(hand.status)) continue;
        if (hand.resultState !== 'unread') continue;
        if (now < hand.deadlineMono) continue;
        const handNo = Number(key);
        const generation = hand.generation;
        const agentHandle = hand.agentHandle;
        const exactResultPath = hand.exactResultPath;
        const peeked = peekCoachResult(gameDir, hand, handNo);
        if (peeked.ok) {
          actions.push({
            handNo, action: 'result-ready', generation, agentHandle, exactResultPath,
          });
          continue;
        }
        retireActive(auth, handNo, {
          resultState: 'discarded',
          cleanupEligible: false,
          cleanupState: 'pending',
        });
        actions.push({
          handNo, action: 'timeout-fence', generation, agentHandle, exactResultPath,
        });
      }
      persist(gameDir, auth);
      return { ok: true, owner, actions };
    });
  }

  async function fence({ gameDir, owner, handNo, generation, reason }) {
    return withLock(gameDir, () => {
      const { auth } = requireAuth(gameDir, { owner });
      const hand = auth.hands[keyOf(handNo)];
      if (!matchingCaller(hand, owner, generation)) fail('STALE_GENERATION');
      retireActive(auth, handNo, {
        resultState: 'discarded',
        cleanupEligible: false,
        cleanupState: 'pending',
      });
      persist(gameDir, auth);
      return { ok: true, reason };
    });
  }

  async function adapterDisable({ gameDir, owner, reason }) {
    return withLock(gameDir, () => {
      const { auth } = requireAuth(gameDir, { owner });
      auth.adapterState = 'disabled';
      persist(gameDir, auth);
      appendTrace(gameDir, {
        gameEpoch: auth.gameEpoch, ownerSessionId: owner, operation: 'adapter-disable',
        outcome: 'disabled', reason,
      });
      return { ok: true, adapterState: 'disabled', reason };
    });
  }

  function reclaimableHandles(gameDir) {
    const auth = loadAuthorityFile(gameDir);
    if (!auth) return [];
    return (auth.retiredAttempts ?? []).filter((row) => (
      (row.ownerSessionId === auth.activeOwnerSessionId
        || (row.cleanupEligible && row.replacementGeneration != null))
      && (row.resultState === 'consumed' || row.resultState === 'discarded')
      && typeof row.agentHandle === 'string'
      && row.agentHandle.length > 0
      && !['released', 'termination_unconfirmed', 'release_failed'].includes(row.cleanupState)
    ));
  }

  async function recordCleanup({ gameDir, owner, handNo, generation, cleanupState }) {
    return withLock(gameDir, () => {
      const { auth } = requireAuth(gameDir, { owner });
      const allowed = new Set(['cancelled', 'released', 'termination_unconfirmed', 'release_failed', 'pending']);
      if (!allowed.has(cleanupState)) fail('USAGE', `알 수 없는 cleanupState: ${cleanupState}`);
      const row = [...auth.retiredAttempts].reverse().find((entry) => (
        entry.handNo === handNo
        && (generation == null || entry.generation === generation)
        && (entry.ownerSessionId === owner || entry.cleanupEligible)
      ));
      if (!row) fail('NO_RETIRED', '회수 대상 retired entry가 없습니다.');
      row.cleanupState = cleanupState;
      if (cleanupState === 'termination_unconfirmed' || cleanupState === 'release_failed') {
        auth.adapterState = 'disabled';
      }
      persist(gameDir, auth);
      appendTrace(gameDir, {
        gameEpoch: auth.gameEpoch, ownerSessionId: owner, operation: 'cleanup-result',
        handNo, generation, outcome: cleanupState,
      });
      return { ok: true, cleanupState, adapterState: auth.adapterState };
    });
  }

  async function assertRollbackAllowed(gameDir) {
    return withLock(gameDir, () => {
      const reasons = [];
      const loopStatePath = path.join(gameDir, 'loop-state.json');
      if (!fs.existsSync(loopStatePath)) {
        reasons.push({ code: 'loop_state_unreadable', detail: { error: 'LOOP_STATE_MISSING' } });
      }
      let loopState = null;
      if (fs.existsSync(loopStatePath)) {
        try { loopState = readJsonFile(loopStatePath); } catch {
          reasons.push({ code: 'loop_state_unreadable', detail: { error: 'LOOP_STATE_UNREADABLE' } });
        }
      }
      if (loopState) {
        const phases = new Set(['bootstrap', 'playing', 'finalizing', 'review_generated', 'review_published', 'done']);
        if (!phases.has(loopState.phase)) reasons.push({ code: 'loop_state_unreadable', detail: { error: 'UNKNOWN_PHASE' } });
        if (loopState.cleanupError) reasons.push({ code: 'cleanup_error', detail: { code: loopState.cleanupError.code ?? null } });
        if (['finalizing', 'review_generated', 'review_published'].includes(loopState.phase)) {
          reasons.push({ code: 'phase_incomplete', detail: { phase: loopState.phase } });
        }
      }
      let auth = null;
      const authorityPath = authPath(gameDir);
      if (fs.existsSync(authorityPath)) {
        try {
          auth = loadAuthorityFile(gameDir);
          if (!auth || typeof auth.gameEpoch !== 'string' || !auth.hands || !Array.isArray(auth.retiredAttempts)
            || !auth.publishQueue || !auth.publishedSeals) throw new Error('minimum schema');
        } catch (error) {
          reasons.push({ code: 'coach_authority_unreadable', detail: { error: error.code ?? 'INVALID_SCHEMA' } });
          auth = null;
        }
      } else {
        let completedHands = 1;
        try {
          const engine = readJsonFile(path.join(gameDir, 'state.json'));
          completedHands = engine?.lastHand === null ? 0 : Number(engine?.lastHand?.handNo ?? 1);
        } catch { completedHands = 1; }
        if (completedHands >= 1) reasons.push({ code: 'coach_authority_missing', detail: { completedHands } });
      }
      const attemptPending = fs.existsSync(path.join(gameDir, '.publish-attempt.json'));
      if (attemptPending) reasons.unshift({ code: 'attempt_pending', detail: {} });
      let trainingAttemptPending = false;
      if (attemptPending) {
        try {
          const attempt = readJsonFile(path.join(gameDir, '.publish-attempt.json'));
          if (attempt?.trainingAuthority) trainingAttemptPending = true;
        } catch { /* malformed attempt already covered by attempt_pending */ }
      }
      if (trainingAttemptPending) {
        reasons.push({ code: 'training_attempt_pending', detail: {} });
      }
      const solver = readPersistedSolver(gameDir);
      if (solver.state === 'live') {
        reasons.push({ code: 'solver_child_live', detail: { pid: solver.record?.pid ?? null } });
      } else if (solver.state === 'unreadable') {
        reasons.push({ code: 'solver_record_unreadable', detail: {} });
      }
      const trainingAuthPath = path.join(gameDir, 'training', '.training-authority.json');
      if (fs.existsSync(trainingAuthPath)) {
        try {
          const trainingAuth = readJsonFile(trainingAuthPath);
          if (trainingAuth?.pending != null && !isPlainMap(trainingAuth.pending)) {
            reasons.push({ code: 'pending_training', detail: { error: 'INVALID_SHAPE' } });
          }
          const pendingIds = mapKeys(trainingAuth?.pending);
          if (pendingIds.length) {
            reasons.push({
              code: 'pending_training',
              detail: { decisionIds: pendingIds },
            });
          }
          if (queueHasLeftovers(trainingAuth?.annotationQueue)) {
            reasons.push({
              code: 'pending_annotation',
              detail: { evaluationIds: Object.keys(trainingAuth.annotationQueue) },
            });
          }
          if (collectionHasEntries(trainingAuth?.solveTasks) || deps.hasLiveSolveTasks?.(gameDir)) {
            reasons.push({ code: 'solver_child_live', detail: { source: 'solveTasks' } });
          }
        } catch {
          reasons.push({ code: 'pending_training', detail: { error: 'UNREADABLE' } });
        }
      } else if (deps.hasLiveSolveTasks?.(gameDir)) {
        reasons.push({ code: 'solver_child_live', detail: { source: 'solveTasks' } });
      }
      const activeHands = Object.entries(auth?.hands ?? {}).filter(([, hand]) => (
        hand.status === 'reserved'
        || hand.status === 'running'
        || (hand.status === 'terminal' && hand.resultState === 'unread')
      )).map(([handNo]) => Number(handNo));
      if (activeHands.length) reasons.push({ code: 'active_hands', detail: { handNos: activeHands } });
      const queued = Object.keys(auth?.publishQueue ?? {}).map(Number);
      if (queued.length) reasons.push({ code: 'publish_queue', detail: { handNos: queued } });
      const unresolved = (auth?.retiredAttempts ?? []).filter((row) => ['termination_unconfirmed', 'release_failed'].includes(row.cleanupState));
      const unresolvedSet = new Set(unresolved);
      if (unresolved.length) reasons.push({ code: 'retired_unresolved', detail: unresolved.map(({ handNo, generation, cleanupState }) => ({ handNo, generation, cleanupState })) });
      const reclaimable = (auth?.retiredAttempts ?? []).filter((row) => !unresolvedSet.has(row)
        && row.cleanupState !== 'released' && typeof row.agentHandle === 'string' && row.agentHandle.length > 0);
      const reclaimableSet = new Set(reclaimable);
      if (reclaimable.length) reasons.push({ code: 'retired_reclaimable', detail: reclaimable.map(({ handNo, generation, cleanupState }) => ({ handNo, generation, cleanupState })) });
      const unreclaimed = (auth?.retiredAttempts ?? []).filter((row) => row.cleanupState !== 'released'
        && !unresolvedSet.has(row) && !reclaimableSet.has(row));
      if (unreclaimed.length) reasons.push({ code: 'retired_unreclaimed', detail: unreclaimed.map(({ handNo, generation, cleanupState, agentHandle }) => ({ handNo, generation, cleanupState, hasHandle: typeof agentHandle === 'string' && agentHandle.length > 0 })) });
      if (reasons.length) {
        const order = [
          'attempt_pending', 'active_hands', 'publish_queue',
          'retired_unresolved', 'retired_reclaimable', 'retired_unreclaimed',
          'coach_authority_missing', 'coach_authority_unreadable',
          'cleanup_error', 'phase_incomplete', 'loop_state_unreadable',
          'pending_training', 'pending_annotation', 'training_attempt_pending',
          'solver_child_live', 'solver_record_unreadable',
        ];
        reasons.sort((left, right) => order.indexOf(left.code) - order.indexOf(right.code));
        return { ok: false, code: 'ROLLBACK_REFUSED', reasons };
      }
      return { ok: true };
    });
  }

  async function missing({ gameDir, statsFile }) {
    return withLock(gameDir, () => {
      const stats = readStats(statsFile);
      const auth = loadAuthorityFile(gameDir);
      const sample = stats.sample;
      const out = [];
      for (let handNo = 1; handNo <= sample; handNo += 1) {
        const key = keyOf(handNo);
        if (!auth?.publishedSeals?.[key] && !auth?.publishQueue?.[key]) out.push(handNo);
      }
      return { ok: true, missing: out };
    });
  }

  async function finalizeCutoff({ gameDir, owner, completed, snapshotFile, statsFile, host }) {
    try {
      if (loadAuthorityFile(gameDir)) {
        await withLock(gameDir, () => requireAuth(gameDir, { owner }));
      }
    } catch (error) {
      return {
        ok: false,
        code: 'FINALIZATION_ABORTED',
        reason: error.code ?? error.message,
        reviewGate: 'closed',
      };
    }
    host.stopNewPlayTimePublishers();
    const live = host.listLivePublishers?.() ?? [];
    const term = await host.terminateLive(live);
    if (!term?.confirmed) {
      return {
        ok: false,
        code: 'FINALIZATION_ABORTED',
        reason: term?.reason ?? 'termination_unconfirmed',
        reviewGate: 'closed',
      };
    }
    if (host.hasLiveLockHolder(gameDir)) {
      return {
        ok: false,
        code: 'FINALIZATION_ABORTED',
        reason: 'lock_held',
        reviewGate: 'closed',
      };
    }
    try {
      return await withLock(gameDir, () => {
        const { epoch, auth } = loadOrInit(gameDir, owner);
        if (auth.activeOwnerSessionId && auth.activeOwnerSessionId !== owner) fail('STALE_OWNER');
        if (snapshotFile) {
          migrateLocked(gameDir, auth, snapshotFile);
          reconcileLocked(auth, snapshotFile);
        }
        auth.noNewPlayTimePublishers = true;
        let n = completed;
        if (statsFile) {
          const stats = readStats(statsFile);
          n = stats.sample;
          if (Number.isInteger(completed) && completed !== n) fail('COMPLETED_MISMATCH');
        }
        const missingHands = [];
        for (let handNo = 1; handNo <= n; handNo += 1) {
          const key = keyOf(handNo);
          if (!auth.publishedSeals[key] && !auth.publishQueue[key]) missingHands.push(handNo);
        }
        for (const handNo of missingHands) {
          const hand = auth.hands[keyOf(handNo)];
          const result = sealUnavailable(auth, {
            gameDir,
            epoch,
            owner,
            handNo,
            generation: hand ? hand.generation : null,
            reason: 'game-over-cutoff',
            snapshotFile,
          });
          if (!result.ok) fail(result.code);
        }
        auth.finalization = { status: 'SEALED', completed: n };
        persist(gameDir, auth);
        const completeness = completenessOf(auth, n);
        return {
          ok: true,
          sealed: missingHands,
          reviewGate: completeness.ok ? 'open' : 'closed',
          completeness,
        };
      });
    } catch (error) {
      return {
        ok: false,
        code: 'FINALIZATION_ABORTED',
        reason: error.code ?? error.message,
        reviewGate: 'closed',
      };
    }
  }

  return {
    loadAuthority,
    completeness,
    beginOwner,
    reserve,
    bindHandle,
    accept,
    watchAccept,
    completeUnavailable,
    reconcile,
    heartbeat,
    fence,
    adapterDisable,
    missing,
    finalizeCutoff,
    reclaimableHandles,
    recordCleanup,
    assertRollbackAllowed,
  };
}

function readForbiddenFile(file) {
  if (!file) return [];
  const denyPath = path.resolve(file);
  const st = fs.lstatSync(denyPath);
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) {
    fail('BAD_FORBIDDEN_FILE', 'forbidden-file 경로가 안전하지 않습니다.');
  }
  const parsed = JSON.parse(fs.readFileSync(denyPath, 'utf8'));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail('BAD_FORBIDDEN_FILE', 'forbidden-file은 비어 있지 않은 문자열 배열이어야 합니다.');
  }
  return parsed;
}

function parseCli(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg.startsWith('--') && next != null && !next.startsWith('--')) {
      out[arg.slice(2)] = next;
      i += 1;
    } else if (arg.startsWith('--')) {
      out[arg.slice(2)] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

async function cliMain() {
  const command = process.argv[2];
  const opts = parseCli(process.argv.slice(3));
  const cc = createCoachControl();
  const gameDir = path.resolve(opts['game-dir'] ?? 'game');
  let result;
  if (command === 'begin-owner') {
    result = await cc.beginOwner({
      gameDir,
      owner: opts.owner,
      completed: Number(opts.completed),
      statsFile: opts['stats-file'],
      snapshotFile: opts['snapshot-file'],
    });
  } else if (command === 'reserve') {
    result = await cc.reserve({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      attempt: Number(opts.attempt ?? 1),
      deadlineMs: Number(opts['deadline-ms'] ?? DEFAULT_ATTEMPT_MS),
      considerOverfold: Boolean(opts['consider-overfold']),
      statsFile: opts['stats-file'],
      snapshotFile: opts['snapshot-file'],
    });
  } else if (command === 'bind-handle') {
    result = await cc.bindHandle({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: Number(opts.generation),
      handle: opts.handle,
    });
  } else if (command === 'accept') {
    result = await cc.accept({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: Number(opts.generation),
      forbiddenLiterals: readForbiddenFile(opts['forbidden-file']),
    });
  } else if (command === 'watch-accept') {
    result = await cc.watchAccept({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: Number(opts.generation),
      forbiddenLiterals: readForbiddenFile(opts['forbidden-file']),
      pollMs: Number(opts['poll-ms'] ?? 200),
      publish: Boolean(opts.publish),
    });
  } else if (command === 'complete-unavailable') {
    result = await cc.completeUnavailable({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: opts.generation == null ? undefined : Number(opts.generation),
      reason: opts.reason,
      snapshotFile: opts['snapshot-file'],
    });
  } else if (command === 'finalize-cutoff') {
    result = await cc.finalizeCutoff({
      gameDir,
      owner: opts.owner,
      completed: Number(opts.completed),
      snapshotFile: opts['snapshot-file'],
      statsFile: opts['stats-file'],
      host: {
        stopNewPlayTimePublishers() {},
        listLivePublishers() { return []; },
        async terminateLive() {
          return { confirmed: String(opts['termination-confirmed'] ?? 'true') !== 'false' };
        },
        hasLiveLockHolder,
      },
    });
  } else if (command === 'completeness') {
    result = { ok: true, ...cc.completeness(gameDir, Number(opts.completed ?? opts.sample)) };
  } else if (command === 'reconcile') {
    result = await cc.reconcile({ gameDir, snapshotFile: opts['snapshot-file'] });
  } else if (command === 'heartbeat') {
    result = await cc.heartbeat({ gameDir, owner: opts.owner });
  } else if (command === 'fence') {
    result = await cc.fence({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: Number(opts.generation),
      reason: opts.reason,
    });
  } else if (command === 'adapter-disable') {
    result = await cc.adapterDisable({ gameDir, owner: opts.owner, reason: opts.reason });
  } else if (command === 'missing') {
    result = await cc.missing({
      gameDir,
      statsFile: opts['stats-file'],
      snapshotFile: opts['snapshot-file'],
    });
  } else if (command === 'cleanup-result') {
    result = await cc.recordCleanup({
      gameDir,
      owner: opts.owner,
      handNo: Number(opts.hand),
      generation: opts.generation == null ? undefined : Number(opts.generation),
      cleanupState: opts['cleanup-state'] ?? opts.reason,
    });
  } else if (command === 'rollback-guard') {
    result = await cc.assertRollbackAllowed(gameDir);
  } else {
    fail('USAGE', `알 수 없는 명령: ${command}`);
  }
  fs.writeSync(1, `${JSON.stringify(result)}\n`);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  cliMain().catch((error) => {
    const code = error instanceof CoachError ? error.code : 'INTERNAL';
    fs.writeSync(1, `${JSON.stringify({ ok: false, code, message: error.message })}\n`);
    process.exit(1);
  });
}

export { canonicalPayloadJson };
