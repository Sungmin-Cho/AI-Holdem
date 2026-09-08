#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createMistakeBank } from './training-stores.js';
import { generateQueue } from '../training/drill-generator.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { nextSchedule } from '../training/spaced-repetition.js';
import { createProfileStore, trainingStoreIo } from './training-stores.js';
import { createMistakeBank as createReadOnlyBank } from '../training/mistake-bank.js';
import { eventFromEvaluation } from '../training/profile-store.js';
import { learningEventKey } from '../training/study-history.js';
import { validateStudyRun } from '../shared/study-contract.js';
import { lookup } from '../training/providers/preflop-json.js';
import { CANONICAL_REFERENCE_SOURCE, LEGACY_REFERENCE_SOURCE, KNOWN_REFERENCE_SOURCES } from '../shared/reference.js';
import { rebuildFromEvents } from '../training/profile-aggregator.js';
import { nativePreflopSnapshot } from '../training/native-preflop-snapshot.js';
import { evaluatePreflopReference } from '../training/preflop-reference.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { ensureDir, openContained, writeContained } from './training-store.js';
import { evaluationIdOf, coded } from '../training/contracts.js';
import { withNamedLock } from '../engine/state.js';
import { studyHistory, retestEligibility } from '../training/study-history.js';

const DRILL_LOCK = 'drill.lock.d';
const SESSION_SEGMENTS = ['drill-session.json'];
const SESSION_MAX_BYTES = 1_048_576;
const PROFILE_EVENTS_MAX_COUNT = 100_000;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function fail(code, message, details = {}) {
  fs.writeSync(1, `${JSON.stringify({ ok: false, code, message, ...details })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const value = argv[i + 1];
    if (value == null || value.startsWith('--')) fail('USAGE', `${arg}의 값이 필요합니다.`);
    flags[arg.slice(2)] = value;
    i += 1;
  }
  return { flags, positional };
}

function trainingRoot(storeDir) {
  return path.join(storeDir, '.training');
}

async function withDrillLock(storeDir, fn) {
  const root = trainingRoot(storeDir);
  ensureDir(root);
  return withNamedLock(root, DRILL_LOCK, fn);
}

function persistSession(storeDir, session) {
  writeContained(trainingRoot(storeDir), SESSION_SEGMENTS, JSON.stringify(session), { mode: 'replace' });
}

function loadSession(storeDir) {
  try {
    const buf = openContained(trainingRoot(storeDir), SESSION_SEGMENTS, { maxBytes: SESSION_MAX_BYTES });
    return JSON.parse(buf.toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadProfileEvents(storeDir) {
  const events = await createProfileStore(storeDir).readEventSnapshot();
  if (events.length > PROFILE_EVENTS_MAX_COUNT) {
    throw coded('STUDY_HISTORY_TOO_LARGE', 'study history exceeds the bounded event count');
  }
  return events;
}

function readOnlyBank(storeDir) {
  return createReadOnlyBank(storeDir, { io: {
    ...trainingStoreIo,
    writeJsonSecure() {
      throw coded('PENDING_UNRESOLVED', 'bank migration must complete before this practice transaction');
    },
  } });
}

function object(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertAnswer(answer, question) {
  if (!object(answer) || !['fold', 'check', 'call', 'bet', 'raise'].includes(answer.action)
    || Object.keys(answer).some((key) => !['action', 'sizeBb'].includes(key))
    || (['bet', 'raise'].includes(answer.action) && answer.sizeBb === undefined)
    || (answer.sizeBb !== undefined && (typeof answer.sizeBb !== 'number'
      || !Number.isFinite(answer.sizeBb) || answer.sizeBb <= 0 || answer.sizeBb > 100
      || !['bet', 'raise'].includes(answer.action)))) {
    throw coded('INVALID_DRILL_ANSWER', 'answer action or size is invalid');
  }
  const offeredKey = answer.sizeBb === undefined ? answer.action : `${answer.action}:${answer.sizeBb}`;
  if (question !== undefined && (!Array.isArray(question?.prompt?.legalActions)
    || !question.prompt.legalActions.includes(offeredKey))) {
    throw coded('INVALID_DRILL_ANSWER', 'answer action and size are not offered by this question');
  }
  return { action: answer.action, ...(answer.sizeBb !== undefined ? { sizeBb: answer.sizeBb } : {}) };
}

function assertSession(session, now = new Date().toISOString()) {
  if (!object(session) || ![1, 2].includes(session.schemaVersion) || !isSessionId(session.sessionId)
    || !['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest'].includes(session.mode)
    || !Array.isArray(session.queue) || session.queue.length > 100
    || !Number.isSafeInteger(session.index) || session.index < 0 || session.index > session.queue.length
    || !Array.isArray(session.answers) || session.answers.length !== session.index) {
    throw coded('PENDING_UNRESOLVED', 'stored drill session is invalid');
  }
  const legacy = session.schemaVersion === 1;
  const source = sourceIdentityOfDataset(loadStoredDataset(legacy ? LEGACY_REFERENCE_SOURCE : session.sourceIdentity));
  if (legacy) {
    if (session.sourceIdentity !== undefined || session.studyRun !== undefined
      || ['assessment', 'retest'].includes(session.mode)) throw coded('PENDING_UNRESOLVED', 'legacy session contains unsupported learning authority');
  } else {
    if (!sameSource(session.sourceIdentity, source)) throw coded('SOURCE_CHANGED', 'stored session source is unavailable');
    if (session.queue.length) {
      const run = validateStudyRun({ ...session.studyRun, index: 0 });
      if (run.total !== session.queue.length || run.mode !== session.mode
        || run.startedAt !== session.studyRun.startedAt
        || Date.parse(run.startedAt) > Date.parse(now)
        || (session.mode === 'retest') !== Boolean(run.assessmentId)) {
        throw coded('PENDING_UNRESOLVED', 'session run does not describe its original queue');
      }
    } else if (session.studyRun !== null) throw coded('PENDING_UNRESOLVED', 'empty queue has a study run');
  }
  const pairs = new Set();
  for (const [index, question] of session.queue.entries()) {
    if (!object(question) || !object(question.prompt) || !object(question.answerPolicy)) throw coded('PENDING_UNRESOLVED', 'stored question is invalid');
    const { spotKey, handClass } = question.prompt;
    const [canonical] = generateQueue({ mode: 'free', source, spotKey, handClass, limit: 1 });
    if (question.questionId !== `drill:${source.version}:${spotKey}:${handClass}:${index + 1}`
      || question.mode !== session.mode || !isDeepStrictEqual(question.prompt, canonical.prompt)
      || (['free', 'leak', 'assessment', 'retest'].includes(session.mode) && pairs.has(`${spotKey}:${handClass}`))) throw coded('PENDING_UNRESOLVED', 'stored question identity or context is inconsistent');
    pairs.add(`${spotKey}:${handClass}`);
    if (legacy) {
      if (question.sourceIdentity !== undefined || question.candidateMistakeId !== undefined
        || !isDeepStrictEqual(question.answerPolicy, { providerId: source.id, providerVersion: source.version })) {
        throw coded('PENDING_UNRESOLVED', 'legacy question does not match the prior producer');
      }
    } else if (!sameSource(question.sourceIdentity, source)
      || !isDeepStrictEqual(question.answerPolicy, { providerId: source.id, providerVersion: source.version, contentSha256: source.contentSha256 })) {
      throw coded('SOURCE_CHANGED', 'stored question source is unavailable');
    }
    if (index < session.index && session.answers[index]?.questionId !== question.questionId) throw coded('PENDING_UNRESOLVED', 'stored answer has a foreign question identity');
  }
  return { legacy, source };
}

// Committed feedback is a projection of the immutable learning journal, not
// authority supplied by the mutable session cache. Validate every prior answer
// before replay can touch any consumer or start can replace the session.
async function committedProof(storeDir, session, now = new Date().toISOString()) {
  let events;
  try {
    if (session?.schemaVersion === 2) events = await loadProfileEvents(storeDir);
    // Recover ownership from each immutable event's original question and
    // attempt, never from the mutable session's run id or remaining queue.
    // The producer hashes sessionId/questionId/attempt; there is no parseable
    // session prefix in that digest, so reproduce the exact derivation.
    if (events && isSessionId(session.sessionId)) {
      for (const prior of events) {
        if (!prior.studyRun || !prior.mixObservation || !['drill', 'retest'].includes(prior.origin)) continue;
        const index = prior.studyRun.index;
        const { spotKey, handClass, sourceIdentity } = prior.mixObservation;
        const questionId = `drill:${prior.providerVersion}:${spotKey}:${handClass}:${index + 1}`;
        const identity = profileEventIdentity(session.sessionId, questionId, index, {
          id: prior.providerId, version: prior.providerVersion,
        });
        if (identity.evaluationId !== prior.evaluationId) continue;
        if (!isDeepStrictEqual(prior.studyRun, { ...session.studyRun, index })
          || session.queue?.[index]?.questionId !== questionId
          || !sameSource(session.sourceIdentity, sourceIdentity)
          || (index >= session.index && !(session.pending && index === session.index))) {
          throw coded('PENDING_UNRESOLVED', 'session omits or reassigns its confirmed learning evidence');
        }
      }
    }
    const contract = assertSession(session, now);
    if (contract.legacy) return { ...contract, events: undefined };
    const byId = new Map(events.map((event) => [event.evaluationId, event]));
    const byIndex = new Map();
    for (const event of events) {
      if (!session.studyRun || event.studyRun?.id !== session.studyRun.id) continue;
      const index = event.studyRun.index;
      if (index >= session.index && !(session.pending && index === session.index)) {
        throw coded('PENDING_UNRESOLVED', 'session omits a confirmed answer');
      }
      if (byIndex.has(index)) throw coded('PENDING_UNRESOLVED', 'run has ambiguous committed answer evidence');
      byIndex.set(index, event);
    }
    for (let index = 0; index < session.index; index += 1) {
      const question = session.queue[index];
      const prior = byIndex.get(index);
      if (!prior) throw coded('PENDING_UNRESOLVED', 'committed answer has no learning evidence');
      const answer = assertAnswer(prior.mixObservation?.chosenAction, question);
      const result = evaluateDrillAnswer(question, answer, lookupStrategy(question));
      const expected = profileEventOf(session, question, index, result, contract.source, answer);
      if (byId.get(expected.evaluationId) !== prior
        || typeof prior.appliedAt !== 'string' || !Number.isFinite(Date.parse(prior.appliedAt))
        || new Date(prior.appliedAt).toISOString() !== prior.appliedAt
        || Date.parse(prior.appliedAt) > Date.parse(now)
        || Date.parse(prior.appliedAt) < Date.parse(session.studyRun.startedAt)
        || learningEventKey(prior) !== learningEventKey(eventFromEvaluation(expected, prior.appliedAt))
        || !isDeepStrictEqual(session.answers[index], result)) {
        throw coded('PENDING_UNRESOLVED', 'committed answer differs from its confirmed learning evidence');
      }
    }
    return { ...contract, events };
  } catch (error) {
    if (error.code === 'PENDING_UNRESOLVED'
      || (error.code === 'SOURCE_CHANGED' && session?.index === 0
        && events && !events.some((event) => event.studyRun?.id === session.studyRun?.id))) throw error;
    throw coded('PENDING_UNRESOLVED', error.message);
  }
}

function loadStoredDataset(source) {
  try { return loadReferenceDataset(source); } catch (e) {
    if (e.code === 'SOURCE_UNAVAILABLE') throw coded('SOURCE_CHANGED', 'Stored reference source is unavailable');
    throw e;
  }
}

function sourceIdentityOfDataset(loaded) {
  return {
    id: loaded.data.id,
    version: loaded.data.version,
    contentSha256: loaded.contentSha256,
  };
}

function sameSource(left, right) {
  return left?.id === right?.id && left?.version === right?.version
    && left?.contentSha256 === right?.contentSha256;
}

function lookupStrategy(question) {
  const { data, contentSha256 } = loadReferenceDataset(question.sourceIdentity ?? LEGACY_REFERENCE_SOURCE);
  return lookup({ data, contentSha256 }, {
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
  });
}

function coerceAttemptNo(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function attemptKeyOf(sessionId, questionId, attemptNo) {
  return `drill:${sessionId}:${questionId}:${attemptNo}`;
}

function profileEventIdentity(sessionId, questionId, attemptNo, source) {
  const digest = createHash('sha256')
    .update(attemptKeyOf(sessionId, questionId, attemptNo))
    .digest('hex');
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: digest,
      decisionId: `d-${attemptNo + 1}-preflop-0`,
      providerId: source.id,
      providerVersion: source.version,
    }),
    payloadSha256: digest,
  };
}

function profileEventOf(session, question, attemptNo, result, source, answer) {
  return {
    ...profileEventIdentity(session.sessionId, question.questionId, attemptNo, source),
    status: 'supported',
    street: 'preflop',
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
    grade: result.grade,
    forced: false,
    evLossBb: null,
    source: {
      id: source.id,
      version: source.version,
      contentSha256: source.contentSha256,
    },
    ...(source.version === '2.0.0' ? {coverage:evaluatePreflopReference(nativePreflopSnapshot(question.prompt.spotKey,question.prompt.handClass,answer),loadReferenceDataset(source)).coverage} : {}),
    recommended: result.recommended,
    chosen: {
      action: answer.action,
      ...(answer.sizeBb !== undefined ? { sizeBb: answer.sizeBb } : {}),
    },
    origin: session.mode === 'retest' ? 'retest' : 'drill',
    ...(session.studyRun ? {
      studyRun: {
        ...session.studyRun,
        index: attemptNo,
      },
    } : {}),
  };
}

async function buildSrsPatch(storeDir, question, result) {
  if (!question.candidateMistakeId) return null;
  const items = await readOnlyBank(storeDir).list();
  const match = items.find((item) => item.mistakeId === question.candidateMistakeId);
  if (!match) throw coded('PENDING_UNRESOLVED', 'practice candidate is no longer available');
  const before = { ...match.reviewState };
  return {
    mistakeId: match.mistakeId,
    before,
    patch: scheduleTarget(before, result, new Date().toISOString()),
  };
}

function scheduleTarget(before, result, at) {
  if (!object(before) || !Number.isSafeInteger(before.attempts) || before.attempts < 0
    || !Number.isSafeInteger(before.intervalDays) || before.intervalDays < 0
    || !Number.isSafeInteger(before.lapses) || before.lapses < 0
    || typeof before.ease !== 'number' || !Number.isFinite(before.ease) || before.ease <= 0
    || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw coded('PENDING_UNRESOLVED', 'SRS pre-state or review time is invalid');
  }
  const target = {
    lastReviewedAt: at, attempts: before.attempts + 1,
    ...nextSchedule({ grade: result.grade, intervalDays: before.intervalDays, ease: before.ease, lapses: before.lapses, now: Date.parse(at) }),
  };
  if (['attempts', 'intervalDays', 'lapses'].some((key) => !Number.isSafeInteger(target[key]) || target[key] < 0)) {
    throw coded('PENDING_UNRESOLVED', 'SRS target exceeds supported counters');
  }
  return target;
}

async function applySrsTarget(storeDir, captured) {
  const target = { ...captured.before, ...captured.patch };
  const bank = createReadOnlyBank(storeDir, { io: {
    ...trainingStoreIo,
    writeJsonSecure(file, data) {
      // This callback executes inside the bank's existing named lock. Recheck
      // the pre-state at the actual write boundary, after other consumers ran.
      const current = trainingStoreIo.readJsonSecure(file).reviewState?.[captured.mistakeId];
      if (isDeepStrictEqual(current, target)) return;
      if (!isDeepStrictEqual(current, captured.before)) throw coded('PENDING_UNRESOLVED', 'SRS schedule changed before commit');
      trainingStoreIo.writeJsonSecure(file, data);
    },
  } });
  await bank.updateReviewState(captured.mistakeId, captured.patch);
}

function commitPending(session) {
  const pending = session.pending;
  if (!pending) return;
  if (session.index === pending.attemptNo) {
    session.answers.push(pending.result);
    session.index += 1;
  }
  session.pending = null;
}

function assertPending(session, now) {
  const pending = session.pending;
  if (!pending || typeof pending !== 'object' || Array.isArray(pending)) {
    throw coded('PENDING_UNRESOLVED', 'pending journal이 올바르지 않습니다.');
  }
  if (!pending.result || typeof pending.result !== 'object' || Array.isArray(pending.result)) {
    throw coded('PENDING_UNRESOLVED', 'pending result가 올바르지 않습니다.');
  }
  if (typeof pending.questionId !== 'string' || !pending.questionId) {
    throw coded('PENDING_UNRESOLVED', 'pending questionId가 올바르지 않습니다.');
  }
  if (!Number.isInteger(pending.attemptNo) || pending.attemptNo < 0) {
    throw coded('PENDING_UNRESOLVED', 'pending attemptNo가 올바르지 않습니다.');
  }
  const { legacy, source } = assertSession(session, now);
  const question = session.queue[session.index];
  if (!question || pending.attemptNo !== session.index || pending.questionId !== question.questionId) {
    throw coded('PENDING_UNRESOLVED', 'pending does not belong to the current question and attempt');
  }
  const answer = assertAnswer(pending.answer, question);
  const strategy = lookupStrategy(question);
  const expectedResult = evaluateDrillAnswer(question, answer, strategy);
  if (!isDeepStrictEqual(pending.result, expectedResult)) throw coded('PENDING_UNRESOLVED', 'pending result does not match its chosen answer');
  const expectedEvent = profileEventOf(session, question, session.index, expectedResult, source, answer);
  if (legacy) {
    delete expectedEvent.recommended;
    delete expectedEvent.chosen;
    delete expectedEvent.source.contentSha256;
    if (pending.bankEvent !== undefined) throw coded('PENDING_UNRESOLVED', 'legacy pending cannot introduce bank evidence');
  } else if (!isDeepStrictEqual(pending.bankEvent, expectedEvent)) {
    throw coded('PENDING_UNRESOLVED', 'pending bank event is not the captured practice evaluation');
  }
  if (!isDeepStrictEqual(pending.profileEvent, expectedEvent)) throw coded('PENDING_UNRESOLVED', 'pending profile event is not the captured practice evaluation');
  const fields = legacy ? ['srs', 'profile'] : ['srs', 'bank', 'profile'];
  if (!object(pending.applied) || Object.keys(pending.applied).length !== fields.length
    || fields.some((key) => typeof pending.applied[key] !== 'boolean')) {
    throw coded('PENDING_UNRESOLVED', 'pending consumer flags are invalid');
  }
  if (!Object.hasOwn(pending, 'srsPatch') || (pending.srsPatch !== null && !object(pending.srsPatch))) {
    throw coded('PENDING_UNRESOLVED', 'pending SRS target is invalid');
  }
  if (!legacy && (question.candidateMistakeId ?? null) !== (pending.srsPatch?.mistakeId ?? null)) {
    throw coded('PENDING_UNRESOLVED', 'pending SRS target belongs to another question');
  }
  // Validate the exact prospective profile payload before touching either store.
  eventFromEvaluation(expectedEvent, now);
  return { legacy, source, question, expectedEvent, expectedResult };
}

async function pendingProof(storeDir, session, eventSnapshot) {
  const serverNow = new Date().toISOString();
  const { legacy, source, question, expectedEvent, expectedResult } = assertPending(session, serverNow);
  const pending = session.pending;
  const events = eventSnapshot ?? await loadProfileEvents(storeDir);
  const prior = events.find((event) => event.evaluationId === expectedEvent.evaluationId);
  if (prior && (typeof prior.appliedAt !== 'string' || !Number.isFinite(Date.parse(prior.appliedAt))
    || Date.parse(prior.appliedAt) > Date.parse(serverNow)
    || learningEventKey(prior) !== learningEventKey(eventFromEvaluation(expectedEvent, prior.appliedAt))
    || (session.studyRun && Date.parse(prior.appliedAt) < Date.parse(session.studyRun.startedAt)))) {
    throw coded('PENDING_UNRESOLVED', 'profile consumer contains different learning evidence');
  }
  if (pending.applied.profile && !prior) throw coded('PENDING_UNRESOLVED', 'profile completion flag has no committed evidence');
  if (session.mode === 'retest') {
    const history = studyHistory(events.filter((event) => event.studyRun?.id !== session.studyRun.id), serverNow);
    const baseline = history.assessments.find((run) => run.id === session.studyRun.assessmentId);
    if (!baseline?.complete || !sameSource(baseline.sourceIdentity, source)
      || !isDeepStrictEqual(baseline.questions.map((q) => [q.spotKey, q.handClass]), session.queue.map((q) => [q.prompt.spotKey, q.prompt.handClass]))
      || !retestEligibility(baseline, session.studyRun.startedAt).eligible) {
      throw coded('PENDING_UNRESOLVED', 'retest pending lacks an eligible matching assessment');
    }
  }
  const items = await readOnlyBank(storeDir).list();
  const evidence = await readOnlyBank(storeDir).listEvidence();
  const shouldBank = !legacy && expectedEvent.grade === 'off-policy';
  const banked = evidence.find((item) => item.evidenceIds.includes(expectedEvent.evaluationId));
  if (banked && (banked.origin !== 'practice' || !sameSource(banked.sourceIdentity, source)
    || banked.spotKey !== expectedEvent.spotKey || banked.handClass !== expectedEvent.handClass
    || banked.evidenceDigests[expectedEvent.evaluationId] !== expectedEvent.payloadSha256
    || !shouldBank
    || (banked.mistakeId === expectedEvent.evaluationId && !isDeepStrictEqual(banked.evaluation, expectedEvent)))) {
    throw coded('PENDING_UNRESOLVED', 'bank consumer contains different learning evidence');
  }
  if (!legacy && pending.applied.bank && shouldBank && !banked) throw coded('PENDING_UNRESOLVED', 'bank completion flag has no matching evidence');
  let srsDone = pending.srsPatch === null;
  if (pending.srsPatch) {
    const captured = pending.srsPatch;
    const candidate = items.find((item) => item.mistakeId === captured.mistakeId);
    if (!candidate || !sameSource(candidate.sourceIdentity, source)
      || candidate.spotKey !== question.prompt.spotKey || candidate.handClass !== question.prompt.handClass
      || !object(captured.patch)) throw coded('PENDING_UNRESOLVED', 'SRS candidate does not match this question');
    if (!legacy || captured.before !== undefined) {
      if (session.studyRun && (Date.parse(captured.patch.lastReviewedAt) < Date.parse(session.studyRun.startedAt)
        || Date.parse(captured.patch.lastReviewedAt) > Date.parse(serverNow))) throw coded('PENDING_UNRESOLVED', 'SRS review time is outside its run');
      const expected = scheduleTarget(captured.before, expectedResult, captured.patch.lastReviewedAt);
      if (!isDeepStrictEqual(expected, captured.patch)) throw coded('PENDING_UNRESOLVED', 'SRS target is not the captured absolute transition');
      const target = { ...captured.before, ...expected };
      srsDone = isDeepStrictEqual(candidate.reviewState, target);
      if (!srsDone && !isDeepStrictEqual(candidate.reviewState, captured.before)) throw coded('PENDING_UNRESOLVED', 'SRS schedule changed since capture');
    } else {
      // The prior producer did not capture a pre-state. Only an already-applied
      // absolute target can be proven without inventing missing recovery evidence.
      const fields = ['lastReviewedAt', 'attempts', 'intervalDays', 'ease', 'lapses', 'nextReviewAt'];
      if (Object.keys(captured.patch).length !== fields.length || fields.some((key) => !Object.hasOwn(captured.patch, key))) throw coded('PENDING_UNRESOLVED', 'legacy SRS target is incomplete');
      srsDone = fields.length > 0
        && Object.entries(captured.patch).every(([key, value]) => candidate.reviewState[key] === value);
      if (!srsDone) throw coded('PENDING_UNRESOLVED', 'legacy SRS pre-state is unavailable');
    }
    if (pending.applied.srs && !srsDone) throw coded('PENDING_UNRESOLVED', 'SRS completion flag has no applied target');
  }
  return { profileDone: Boolean(prior), bankDone: !shouldBank || Boolean(banked), srsDone, legacy };
}

async function replayPending(storeDir, session, eventSnapshot) {
  const pending = session.pending;
  if (!pending) return session;
  try {
    const proof = await pendingProof(storeDir, session, eventSnapshot);
    if (!pending.applied.profile) {
      if (!proof.profileDone) await createProfileStore(storeDir).apply(pending.profileEvent);
      pending.applied.profile = true;
      persistSession(storeDir, session);
    }
    if (!proof.legacy && !pending.applied.bank) {
      if (!proof.bankDone) await createMistakeBank(storeDir).collect(pending.bankEvent);
      pending.applied.bank = true;
      persistSession(storeDir, session);
    }
    if (!pending.applied.srs) {
      if (!proof.srsDone) await applySrsTarget(storeDir, pending.srsPatch);
      pending.applied.srs = true;
      persistSession(storeDir, session);
    }
    commitPending(session);
    persistSession(storeDir, session);
    return session;
  } catch (error) {
    if (error.code === 'PENDING_UNRESOLVED') throw error;
    throw coded('PENDING_UNRESOLVED', error.message);
  }
}

async function loadLiveSession(storeDir) {
  const session = loadSession(storeDir);
  if (session) {
    const proof = await committedProof(storeDir, session);
    if (session.pending) await replayPending(storeDir, session, proof.events);
    assertSession(session);
  }
  return session;
}

function answerPayload(session) {
  return {
    ok: true,
    result: session.answers[session.index - 1],
    next: session.queue[session.index] ?? null,
  };
}

function sessionDto(session) {
  if (!session) return {
    done: true, question: null, count: 0, index: 0, mode: null,
    lastFeedback: null, sessionId: null, attemptNo: null,
  };
  const count = Array.isArray(session.queue) ? session.queue.length : 0;
  const index = Number.isInteger(session.index) ? session.index : 0;
  const done = index >= count;
  const last = index > 0 && Array.isArray(session.answers) ? session.answers[index - 1] : null;
  return {
    done,
    question: done ? null : session.queue[index],
    count,
    index,
    mode: session.mode,
    lastFeedback: typeof last?.feedback === 'string' ? last.feedback : null,
    lastResult: last ?? null,
    sessionId: session.sessionId,
    attemptNo: done ? null : index,
    sourceIdentity: session.sourceIdentity ? { ...session.sourceIdentity } : null,
    studyRun: session.studyRun ? { ...session.studyRun } : null,
    notices: Array.isArray(session.notices) ? session.notices.slice(0, 20) : [],
    ...(done ? { summary: Array.isArray(session.answers) ? session.answers.slice(0, 100) : [] } : {}),
  };
}

function storedAnswer(session, questionId, attemptNo) {
  const question = session.queue[attemptNo];
  if (!question || question.questionId !== questionId) {
    throw coded('STALE_QUESTION', '이미 처리된 문항과 요청이 일치하지 않습니다.');
  }
  const result = session.answers[attemptNo];
  if (!result) throw coded('STALE_QUESTION', '저장된 답이 없습니다.');
  return { ok: true, result, next: session.queue[attemptNo + 1] ?? null };
}

export async function startDrill(storeDir, {
  mode = 'free', seed = '0', idempotencyKey, spotKey, handClass,
  assessmentId, source: requestedSource,
} = {}) {
  return withDrillLock(storeDir, async () => {
    const existing = loadSession(storeDir);
    const serverNow = new Date().toISOString();
    let defaultSource = CANONICAL_REFERENCE_SOURCE;
    if (!requestedSource && !spotKey) {
      let events;
      try { events = (await loadProfileEvents(storeDir)).filter(e=>Date.parse(e.appliedAt)<=Date.parse(serverNow)); }
      catch(error) {
        if(existing) throw coded('PENDING_UNRESOLVED','Existing drill history is unavailable');
        throw error;
      }
      const activeId = rebuildFromEvents(events).activeSegmentId;
      defaultSource = KNOWN_REFERENCE_SOURCES.find(s=>`${s.id}@${s.version}`===activeId) ?? defaultSource;
    }
    const loadedDataset = loadReferenceDataset(requestedSource ?? (spotKey && !spotKey.endsWith('-v2') ? LEGACY_REFERENCE_SOURCE : defaultSource));
    let sourceIdentity = sourceIdentityOfDataset(loadedDataset);
    if (requestedSource !== undefined && !sameSource(requestedSource, sourceIdentity)) {
      throw coded('SOURCE_CHANGED', 'requested reference source is not available');
    }
    // Validate mode and explicit selection before any store reader can migrate
    // data and, most importantly, before replacing the current session.
    generateQueue({
      mode, source: sourceIdentity, spotKey, handClass, limit: 0,
      ...(mode === 'retest' ? { questionSet: [] } : {}),
    });
    let existingProof = null;
    if (existing) {
      try { existingProof = await committedProof(storeDir, existing, serverNow); }
      catch (error) {
        // A fresh run may replace an unanswered obsolete-source question, as
        // before. No committed feedback or pending consumer may be discarded.
        if (error.code !== 'SOURCE_CHANGED' || existing.index !== 0
          || existing.answers?.length !== 0 || existing.pending
          || (idempotencyKey && existing.idempotencyKey === idempotencyKey)) throw error;
      }
    }
    if (existing?.pending) throw coded('PENDING_UNRESOLVED', 'resume the captured answer with next or retry before starting another run');
    if (existing && idempotencyKey && existing.idempotencyKey === idempotencyKey) {
      assertSession(existing, serverNow);
      return existing;
    }
    const history = studyHistory(existingProof?.events ?? await loadProfileEvents(storeDir), serverNow);
    let assessment = null;
    let questionSet;
    if (mode === 'retest') {
      assessment = assessmentId !== undefined
        ? history.assessments.find((run) => run.id === assessmentId)
        : [...history.assessments].reverse().find((run) => run.complete);
      if (assessment?.sourceIdentity) {
        if (requestedSource && !sameSource(requestedSource,assessment.sourceIdentity)) throw coded('SOURCE_CHANGED','Requested source differs from assessment');
        sourceIdentity = sourceIdentityOfDataset(loadReferenceDataset(assessment.sourceIdentity));
      }
      if (!assessment?.complete) throw coded('INCOMPLETE_ASSESSMENT', 'completed assessment is required');
      const eligibility = retestEligibility(assessment, serverNow);
      if (!eligibility.eligible) {
        const error = coded('RETEST_NOT_DUE', 'retest is not available yet');
        error.nextAvailableAt = eligibility.nextAvailableAt;
        throw error;
      }
      questionSet = assessment.questions;
    }
    const bank = createMistakeBank(storeDir);
    const profile = await createProfileStore(storeDir).show();
    const mistakes = await bank.list();
    const bankStats = await bank.stats();
    const notices = bankStats.prunedUnlearnable > 0
      ? [`postflop 항목 ${bankStats.prunedUnlearnable}건은 드릴 대상이 아닙니다`]
      : [];
    const queue = generateQueue({
      mode, profile, mistakes, seed, now: serverNow, spotKey, handClass,
      history, questionSet, source: sourceIdentity,
    });
    const noticesForRun = [...notices];
    if (mode === 'assessment' && queue.length < 10) {
      noticesForRun.push(`추적된 미노출 문항은 ${queue.length}개입니다.`);
    }
    if (mode === 'assessment' && history.unknownPreTrackingExposure) {
      noticesForRun.push('추적 시작 이전의 노출 여부는 알 수 없습니다.');
    }
    const runId = randomUUID();
    const studyRun = queue.length ? {
      id: runId,
      mode,
      total: queue.length,
      startedAt: serverNow,
      ...(mode === 'retest' ? { assessmentId: assessment.id } : {}),
    } : null;
    const session = {
      schemaVersion: 2,
      sessionId: randomUUID(),
      idempotencyKey: idempotencyKey ?? randomUUID(),
      mode,
      seed,
      sourceIdentity,
      studyRun,
      index: 0,
      queue,
      answers: [],
      pending: null,
      notices: noticesForRun,
    };
    persistSession(storeDir, session);
    return session;
  });
}

export async function nextQuestion(storeDir) {
  return withDrillLock(storeDir, async () => {
    const session = await loadLiveSession(storeDir);
    return sessionDto(session);
  });
}

export async function readDrillSession(storeDir) {
  return withDrillLock(storeDir, async () => sessionDto(await loadLiveSession(storeDir)));
}

export async function readStudyHistory(storeDir) {
  return withDrillLock(storeDir, async () => {
    const serverNow = new Date().toISOString();
    const value = studyHistory(await loadProfileEvents(storeDir), serverNow);
    const assessments = value.assessments.slice(-100).map((run) => ({
      ...run,
      retests: run.retests.slice(-100),
      latestCompletedRetest: run.latestCompletedRetest ?? null,
    }));
    return {
      ...value,
      seenPairs: value.seenPairs.slice(0, 2_000),
      assessments,
      retests: value.retests.slice(-100),
    };
  });
}

export async function answerQuestion(storeDir, { action, sizeBb, sessionId, questionId, attemptNo } = {}) {
  return withDrillLock(storeDir, async () => {
    const session = loadSession(storeDir);
    if (!session) throw coded('NO_SESSION', 'drill session이 없습니다.');
    const answer = assertAnswer({ action, ...(sizeBb !== undefined ? { sizeBb } : {}) });
    const attempt = coerceAttemptNo(attemptNo);
    if (!isSessionId(session.sessionId) || !isSessionId(sessionId)
      || sessionId !== session.sessionId || attempt == null || typeof questionId !== 'string') {
      throw coded('STALE_QUESTION', '문항 요청이 현재 세션과 일치하지 않습니다.');
    }
    const committed = await committedProof(storeDir, session);
    if (session.pending) {
      if (attempt !== session.pending.attemptNo || questionId !== session.pending.questionId
        || !isDeepStrictEqual(answer, session.pending.answer)) throw coded('STALE_QUESTION', 'request differs from the captured pending answer');
      await replayPending(storeDir, session, committed.events);
    }
    const { legacy } = assertSession(session);
    if (attempt < session.index) return storedAnswer(session, questionId, attempt);
    if (legacy) throw coded('SOURCE_UNVERIFIED', 'legacy question has no source content identity; start a new run');
    if (attempt !== session.index) {
      throw coded('STALE_QUESTION', '문항 요청이 현재 세션과 일치하지 않습니다.');
    }
    const question = session.queue[session.index];
    if (!question) return { done: true };
    if (question.questionId !== questionId) {
      throw coded('STALE_QUESTION', '문항 요청이 현재 세션과 일치하지 않습니다.');
    }

    assertAnswer(answer, question);
    const strategy = lookupStrategy(question);
    const policySource = {
      id: question.answerPolicy?.providerId,
      version: question.answerPolicy?.providerVersion,
      contentSha256: question.answerPolicy?.contentSha256,
    };
    if (!sameSource(question.sourceIdentity, strategy.source)
      || !sameSource(policySource, strategy.source)) {
      throw coded('SOURCE_CHANGED', 'stored drill question source no longer matches the dataset');
    }
    const result = evaluateDrillAnswer(question, { action, sizeBb }, strategy);
    const srsPatch = await buildSrsPatch(storeDir, question, result);
    // 데이터셋이 스스로 밝히는 provider·version을 쓴다 — 상수를 따로 두면
    // 데이터셋을 갈아도 프로필 이벤트는 옛 버전을 주장하게 된다.
    const profileEvent = profileEventOf(session, question, attempt, result, strategy.source, answer);
    session.pending = {
      answer,
      result,
      srsPatch,
      profileEvent,
      bankEvent: profileEvent,
      applied: { srs: false, bank: false, profile: false },
      questionId,
      attemptNo: attempt,
    };
    await pendingProof(storeDir, session, committed.events);
    persistSession(storeDir, session);
    await replayPending(storeDir, session, committed.events);
    return answerPayload(session);
  });
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const storeDir = flags['store-dir'];
  if (!storeDir) fail('USAGE', '--store-dir가 필요합니다.');
  if (cmd === 'start') {
    const source = flags['source-version'] === undefined ? undefined : KNOWN_REFERENCE_SOURCES.find(s=>s.version===flags['source-version']);
    if(flags['source-version'] !== undefined && !source) fail('SOURCE_CHANGED','Unknown reference source version');
    const session = await startDrill(storeDir, {
      mode: flags.mode ?? 'free',
      seed: flags.seed ?? '0',
      idempotencyKey: flags['idempotency-key'],
      spotKey: flags['spot-key'],
      handClass: flags['hand-class'],
      assessmentId: flags['assessment-id'],
      ...(source ? {source} : {}),
    });
    fs.writeSync(1, `${JSON.stringify({
      ok: true,
      count: session.queue.length,
      sessionId: session.sessionId,
      notices: session.notices ?? [],
      session,
    })}\n`);
    return;
  }
  if (cmd === 'next') {
    fs.writeSync(1, `${JSON.stringify({ ok: true, ...(await nextQuestion(storeDir)) })}\n`);
    return;
  }
  if (cmd === 'answer') {
    const session = loadSession(storeDir);
    const question = session?.queue?.[session.index];
    const out = await answerQuestion(storeDir, {
      action: flags.action,
      sizeBb: flags['size-bb'] != null ? Number(flags['size-bb']) : undefined,
      sessionId: flags['session-id'] ?? session?.sessionId,
      questionId: flags['question-id'] ?? question?.questionId,
      attemptNo: flags['attempt-no'] != null ? Number(flags['attempt-no']) : session?.index,
    });
    fs.writeSync(1, `${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === 'summary') {
    const session = await withDrillLock(storeDir, async () => loadLiveSession(storeDir));
    const current = session ?? { answers: [], queue: [], index: 0 };
    fs.writeSync(1, `${JSON.stringify({
      ok: true,
      answers: current.answers,
      remaining: Math.max(0, (current.queue?.length ?? 0) - (current.index ?? 0)),
    })}\n`);
    return;
  }
  if (cmd === 'due') {
    const due = (await createMistakeBank(storeDir).list())
      .filter((item) => !item.nextReviewAt || item.nextReviewAt <= new Date().toISOString());
    fs.writeSync(1, `${JSON.stringify({ ok: true, due })}\n`);
    return;
  }
  if (cmd === 'history') {
    fs.writeSync(1, `${JSON.stringify({ ok: true, ...(await readStudyHistory(storeDir)) })}\n`);
    return;
  }
  fail('USAGE', 'start|next|answer|summary|due|history만 지원합니다.');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'ERROR', error.message, {
    ...(error.nextAvailableAt ? { nextAvailableAt: error.nextAvailableAt } : {}),
  }));
}
