#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createMistakeBank } from './training-stores.js';
import { dueForReview, generateQueue, legalActionsFor } from '../training/drill-generator.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { nextSchedule, SRS_VERSION } from '../training/spaced-repetition.js';
import { createProfileStore, trainingStoreIo } from './training-stores.js';
import { createMistakeBank as createReadOnlyBank } from '../training/mistake-bank.js';
import { NO_HINT_ASSISTANCE } from '../shared/assistance.js';
import { eventFromEvaluation, eventForPrior } from '../training/profile-store.js';
import { learningEventKey } from '../training/study-history.js';
import { validateStudyRun } from '../shared/study-contract.js';
import { lookup } from '../training/providers/preflop-json.js';
import { parsePreflopKeyV3 } from '../shared/preflop-key.js';
import { CANONICAL_REFERENCE_SOURCE, LEGACY_REFERENCE_SOURCE, KNOWN_REFERENCE_SOURCES, V2_REFERENCE_SOURCE, V3_REFERENCE_SOURCE, referenceSchemaOf } from '../shared/reference.js';
import { rebuildFromEvents } from '../training/profile-aggregator.js';
import { nativePreflopSnapshot } from '../training/native-preflop-snapshot.js';
import { evaluatePreflopReference } from '../training/preflop-reference.js';
import { evaluatePreflopReferenceV3 } from '../training/preflop-reference-v3.js';
import { nativePreflopSnapshotV3 } from '../training/native-preflop-snapshot-v3.js';
import { strataForSpot } from '../training/drill-strata.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { ensureDir, openContained, writeContained } from './training-store.js';
import { assertEvaluationId, evaluationIdOf, coded } from '../training/contracts.js';
import { withNamedLock } from '../engine/state.js';
import { studyHistory, retestEligibility } from '../training/study-history.js';
import { appendLedgerRow, appendLedgerRows, MEASUREMENT_MODES, readRecentViewSeed } from './learning-ledgers.js';

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

export async function withDrillLock(storeDir, fn) {
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
  if (!object(session) || ![1, 2, 3].includes(session.schemaVersion) || !isSessionId(session.sessionId)
    || !['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest', 'transfer'].includes(session.mode)
    || !Array.isArray(session.queue) || session.queue.length > 100
    || !Number.isSafeInteger(session.index) || session.index < 0 || session.index > session.queue.length
    || !Array.isArray(session.answers) || session.answers.length !== session.index) {
    throw coded('PENDING_UNRESOLVED', 'stored drill session is invalid');
  }
  if (session.schemaVersion === 3 ? session.assistanceContractVersion !== 1 : session.assistanceContractVersion !== undefined) throw coded('PENDING_UNRESOLVED', 'study assistance contract differs from capture schema');
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
    const [canonical] = generateQueue({ mode: 'free', source, spotKey, handClass, limit: 1, admits: admitsFor(source) });
    if (question.questionId !== `drill:${source.version}:${spotKey}:${handClass}:${index + 1}`
      || question.mode !== session.mode || !isDeepStrictEqual(question.prompt, canonical.prompt)
      || (['free', 'leak', 'assessment', 'retest', 'transfer'].includes(session.mode) && pairs.has(`${spotKey}:${handClass}`))) throw coded('PENDING_UNRESOLVED', 'stored question identity or context is inconsistent');
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
    if ([2,3].includes(session?.schemaVersion)) events = await loadProfileEvents(storeDir);
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
      if (session.schemaVersion === 3 && prior?.schemaVersion !== 6) throw coded('PENDING_UNRESOLVED','new study contract lost assistance event');
      if (!prior) throw coded('PENDING_UNRESOLVED', 'committed answer has no learning evidence');
      const answer = assertAnswer(prior.mixObservation?.chosenAction, question);
      const result = evaluateDrillAnswer(question, answer, lookupStrategy(question));
      const expected = profileEventOf(session, question, index, result, contract.source, answer);
      if (byId.get(expected.evaluationId) !== prior
        || typeof prior.appliedAt !== 'string' || !Number.isFinite(Date.parse(prior.appliedAt))
        || new Date(prior.appliedAt).toISOString() !== prior.appliedAt
        || Date.parse(prior.appliedAt) > Date.parse(now)
        || Date.parse(prior.appliedAt) < Date.parse(session.studyRun.startedAt)
        || learningEventKey(prior) !== learningEventKey(eventForPrior(expected, prior))
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

// v3 grades against the rows its evaluator materializes on the practice table,
// so the drill, the game and the eligibility check see the same row set.
function lookupStrategy(question) {
  const dataset = loadReferenceDataset(question.sourceIdentity ?? LEGACY_REFERENCE_SOURCE);
  if (dataset.data.schemaVersion === 3) {
    const evaluation = evaluatePreflopReferenceV3(nativePreflopSnapshotV3(question.prompt.spotKey, question.prompt.handClass, null),
      dataset, { gameEpoch: '00'.repeat(32) });
    if (evaluation.status !== 'supported') return { status: 'unsupported', code: evaluation.code, reason: evaluation.code, source: evaluation.source };
    return { status: 'supported', actions: evaluation.recommended, source: lookup(dataset, { spotKey: '', handClass: '' }).source };
  }
  return lookup(dataset, {
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
  });
}

// Stratum weights of a v3 spot (assessment), from the dataset's frequencies.
function weightsFor(source) {
  if (referenceSchemaOf(source) !== 3) return undefined;
  const dataset = loadReferenceDataset(source);
  const cache = new Map();
  return (spotKey, handClass) => {
    if (!cache.has(spotKey)) {
      cache.set(spotKey, strataForSpot((cls) => {
        const found = lookup(dataset, { spotKey, handClass: cls });
        const f = { fold: 1, call: 0, raise: 0 };
        if (found.status === 'supported') {
          f.fold = 0;
          for (const row of found.actions) f[row.action] = (f[row.action] ?? 0) + row.frequency;
        }
        return f;
      }));
    }
    return cache.get(spotKey).get(handClass)?.weight ?? 1;
  };
}

// Pairs a v3 spot can be asked with: the hand reaches it (a 3-bet spot only
// with a hand the hero opens). Other sources ask every pair.
function admitsFor(source) {
  if (referenceSchemaOf(source) !== 3) return undefined;
  const dataset = loadReferenceDataset(source);
  return (spotKey, handClass) => lookup(dataset, { spotKey, handClass }).status === 'supported';
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
    ...(source.version === '3.0.0' ? {coverage:evaluatePreflopReferenceV3(nativePreflopSnapshotV3(question.prompt.spotKey,question.prompt.handClass,answer),loadReferenceDataset(source)).coverage} : {}),
    recommended: result.recommended,
    chosen: {
      action: answer.action,
      ...(answer.sizeBb !== undefined ? { sizeBb: answer.sizeBb } : {}),
    },
    origin: session.mode === 'retest' ? 'retest' : 'drill',
    ...(session.schemaVersion === 3 ? { assistance: {...NO_HINT_ASSISTANCE} } : {}),
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

// New reviews use SR v2; a pending patch is re-derived with the version it was
// captured under (a patch without srsVersion is a v1 transition).
function scheduleTarget(before, result, at, srsVersion = SRS_VERSION) {
  if (!object(before) || !Number.isSafeInteger(before.attempts) || before.attempts < 0
    || !Number.isSafeInteger(before.intervalDays) || before.intervalDays < 0
    || !Number.isSafeInteger(before.lapses) || before.lapses < 0
    || typeof before.ease !== 'number' || !Number.isFinite(before.ease) || before.ease <= 0
    || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || new Date(at).toISOString() !== at) {
    throw coded('PENDING_UNRESOLVED', 'SRS pre-state or review time is invalid');
  }
  const target = {
    lastReviewedAt: at, attempts: before.attempts + 1,
    ...(srsVersion === SRS_VERSION
      ? nextSchedule({ grade: result.grade, intervalDays: before.intervalDays, ease: before.ease, lapses: before.lapses, now: Date.parse(at),
        srsVersion, correctStreak: before.correctStreak, graduatedAt: before.graduatedAt ?? null })
      : nextSchedule({ grade: result.grade, intervalDays: before.intervalDays, ease: before.ease, lapses: before.lapses, now: Date.parse(at) })),
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
  if (session.schemaVersion === 3 && prior && prior.schemaVersion !== 6) throw coded('PENDING_UNRESOLVED','new study contract lost assistance event');
  if (prior && (typeof prior.appliedAt !== 'string' || !Number.isFinite(Date.parse(prior.appliedAt))
    || Date.parse(prior.appliedAt) > Date.parse(serverNow)
    || learningEventKey(prior) !== learningEventKey(eventForPrior(expectedEvent, prior))
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
      const expected = scheduleTarget(captured.before, expectedResult, captured.patch.lastReviewedAt, captured.patch.srsVersion === SRS_VERSION ? SRS_VERSION : 1);
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

// Chart view (design D12): the full 13×13 frequencies of one spot. A chart
// shows every answer of that spot, so it is refused while an assessment, a
// retest or a transfer run is open, and each view is recorded; assessment and
// transfer then treat that spot's hands as seen for seven days.
// One row per source and spot (its latest view); rows past the window expire.
const EXPOSURE_SEGMENTS = ['grid-exposures.json'];
const EXPOSURE_MAX_BYTES = 1024 * 1024;
const EXPOSURE_WINDOW_MS = 7 * 86_400_000;
const LOCKED_RUN_MODES = new Set(['assessment', 'retest', 'transfer']);
function loadExposures(storeDir) {
  try {
    const rows = JSON.parse(openContained(trainingRoot(storeDir), EXPOSURE_SEGMENTS, { maxBytes: EXPOSURE_MAX_BYTES }).toString('utf8'));
    return Array.isArray(rows) ? rows.filter((row) => row && typeof row.spotKey === 'string' && typeof row.at === 'string'
      && Number.isFinite(Date.parse(row.at)) && row.sourceIdentity) : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
/** Pairs of spots whose chart was shown within the window, for this source. */
function exposedPairsFor(storeDir, source, now) {
  const recent = loadExposures(storeDir).filter((row) => sameSource(row.sourceIdentity, source)
    && Date.parse(now) - Date.parse(row.at) <= EXPOSURE_WINDOW_MS);
  const hands = allHandClassesOrder();
  return [...new Set(recent.map((row) => row.spotKey))].flatMap((spotKey) => hands.map((hand) => `${spotKey}:${hand}`));
}
const RANKS = 'AKQJT98765432';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function allHandClassesOrder() {
  const out = [];
  for (let row = 0; row < 13; row += 1) {
    for (let col = 0; col < 13; col += 1) out.push(row === col ? `${RANKS[row]}${RANKS[col]}` : row < col ? `${RANKS[row]}${RANKS[col]}s` : `${RANKS[col]}${RANKS[row]}o`);
  }
  return out;
}
// The chart of one spot (no I/O beyond the bundled dataset): its source and every hand's cell.
function spotChart(spotKey, requested) {
  const known = requested ? KNOWN_REFERENCE_SOURCES.find((row) => sameSource(row, requested))
    : spotKey.endsWith('-v3') ? V3_REFERENCE_SOURCE : spotKey.endsWith('-v2') ? KNOWN_REFERENCE_SOURCES.find((row) => row.version === '2.0.0') : LEGACY_REFERENCE_SOURCE;
  if (!known) throw coded('SOURCE_UNAVAILABLE', 'requested reference source is not available');
  const dataset = loadReferenceDataset(known);
  const source = sourceIdentityOfDataset(dataset);
  const cells = {};
  let any = false;
  for (const hand of allHandClassesOrder()) {
    const found = lookup(dataset, { spotKey, handClass: hand });
    if (found.status !== 'supported') { cells[hand] = null; continue; }
    any = true;
    const f = { fold: 0, call: 0, raise: 0 };
    for (const row of found.actions) f[row.action] = Math.round((f[row.action] + row.frequency) * 10000) / 10000;
    cells[hand] = f;
  }
  if (!any) throw coded('UNSUPPORTED_SPOT', 'spot is not in the reference dataset');
  return { source, cells };
}

// Records one chart view (caller holds the drill lock): the append-only exposure ledger first,
// then the recent-view file the question generators read.
function recordChartView(storeDir, source, spotKey, fault = () => {}) {
  const at = new Date().toISOString();
  const latest = new Map();
  for (const row of [...loadExposures(storeDir), { sourceIdentity: source, spotKey, at }]) {
    if (Date.parse(at) - Date.parse(row.at) > EXPOSURE_WINDOW_MS) continue;
    const key = JSON.stringify([row.sourceIdentity.id, row.sourceIdentity.version, row.sourceIdentity.contentSha256 ?? null, row.spotKey]);
    const prior = latest.get(key);
    if (!prior || Date.parse(row.at) >= Date.parse(prior.at)) latest.set(key, row);
  }
  const rows = [...latest.values()].sort((left, right) => left.at.localeCompare(right.at));
  // #298: 덧붙이기 전용 노출 원장을 먼저 쓴다. 실패하면 차트를 돌려주지 않는다(노출 없음). 원장만 쓰고 아래 쓰기가
  // 실패하면 원장이 열람을 과대 기록한다 — 평가 쪽에는 보수적인 방향이다.
  appendLedgerRow(trainingRoot(storeDir), 'exposure', { at, sourceIdentity: { ...source }, spotKey }, {
    at, seedRows: () => readRecentViewSeed(trainingRoot(storeDir)),
  });
  fault('recent-view');
  writeContained(trainingRoot(storeDir), EXPOSURE_SEGMENTS, JSON.stringify(rows), { mode: 'replace' });
}

export async function readSpotChart(storeDir, { spotKey, source: requested } = {}) {
  if (typeof spotKey !== 'string' || !/^[a-z0-9-]{1,100}$/.test(spotKey)) throw coded('UNSUPPORTED_SPOT', 'spot key is invalid');
  return withDrillLock(storeDir, async () => {
    const session = loadSession(storeDir);
    if (session && LOCKED_RUN_MODES.has(session.mode) && session.index < (session.queue?.length ?? 0)) {
      throw coded('GRID_LOCKED', 'charts are hidden while an assessment, retest or transfer run is open');
    }
    const { source, cells } = spotChart(spotKey, requested);
    recordChartView(storeDir, source, spotKey);
    return { ok: true, source, spotKey, cells };
  });
}

// A run is provably finished only when its whole shape says so. Anything else
// (a foreign shape, a non-list queue, a bad index, a pending answer) is treated as
// unfinished by a protected start.
function runProvenFinished(session) {
  return object(session) && Array.isArray(session.queue) && Number.isSafeInteger(session.index)
    && session.index === session.queue.length && !session.pending;
}

/** protectUnfinished: the next-step start never discards a run that is not
 * finished. It is decided here, under the drill lock, because a client's cached
 * state can be stale (another tab may have started a run). The same request
 * replayed (same idempotencyKey) is still answered with its own run; an
 * ordinary start, without the condition, replaces as before. */
export async function startDrill(storeDir, {
  mode = 'free', seed = '0', idempotencyKey, spotKey, handClass,
  assessmentId, source: requestedSource, protectUnfinished,
} = {}) {
  if (protectUnfinished !== undefined && typeof protectUnfinished !== 'boolean') {
    throw coded('USAGE', 'protectUnfinished must be a boolean');
  }
  const unfinished = () => coded('UNFINISHED_RUN', 'an unfinished practice run exists; replace it with the ordinary start');
  return withDrillLock(storeDir, async () => {
    let existing;
    try { existing = loadSession(storeDir); }
    catch (error) {
      // An unreadable session cannot be proven finished.
      if (protectUnfinished === true) throw unfinished();
      throw error;
    }
    if (protectUnfinished === true && existing !== null && !object(existing)) throw unfinished();
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
    // A named spot carries its own source (v1 keys have no suffix); only a run
    // without one follows the active record or the default.
    const spotSource = !spotKey ? null : spotKey.endsWith('-v3') ? V3_REFERENCE_SOURCE
      : spotKey.endsWith('-v2') ? V2_REFERENCE_SOURCE : LEGACY_REFERENCE_SOURCE;
    const loadedDataset = loadReferenceDataset(requestedSource ?? spotSource ?? defaultSource);
    let sourceIdentity = sourceIdentityOfDataset(loadedDataset);
    if (requestedSource !== undefined && !sameSource(requestedSource, sourceIdentity)) {
      throw coded('SOURCE_CHANGED', 'requested reference source is not available');
    }
    // Validate mode and explicit selection before any store reader can migrate
    // data and, most importantly, before replacing the current session.
    generateQueue({
      mode, source: sourceIdentity, spotKey, handClass, limit: 0, admits: admitsFor(sourceIdentity),
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
    if (protectUnfinished === true && existing && !runProvenFinished(existing)) throw unfinished();
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
      history, questionSet, source: sourceIdentity, admits: admitsFor(sourceIdentity),
      weightOf: mode === 'assessment' ? weightsFor(sourceIdentity) : undefined,
      exposedPairs: ['assessment', 'transfer'].includes(mode) ? exposedPairsFor(storeDir, sourceIdentity, serverNow) : undefined,
    });
    const noticesForRun = [...notices];
    if (mode === 'assessment' && queue.length < 10) {
      noticesForRun.push(`추적된 미응답 문항은 ${queue.length}개입니다.`);
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
      schemaVersion: 3,
      assistanceContractVersion: 1,
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
    // #298: 측정 실행(assessment·retest)의 시작 의도와, 이 시작이 미완료 측정 실행을 교체한다는 사실을 세션보다 먼저
    // 덧붙이기 전용 원장에 한 번에 남긴다. 응답이 0건이거나 교체돼도 분모에서 사라지지 않게 하려는 것이다. idempotent
    // 재생과 모든 거부는 여기 오기 전에 끝났다. 원장 쓰기가 실패하면 시작도 실패한다(세션은 그대로다).
    const startId = randomUUID();
    const replaced = existing && MEASUREMENT_MODES.has(existing.mode) && UUID_RE.test(existing.studyRun?.id ?? '')
      && !runProvenFinished(existing) ? existing.studyRun.id : null;
    const ledgerRows = [
      ...(replaced ? [{ type: 'replace', startId, at: serverNow, mode, replacedRunId: replaced }] : []),
      ...(MEASUREMENT_MODES.has(mode) ? [{
        type: 'start', startId, runId: studyRun?.id ?? null, mode, total: queue.length, startedAt: serverNow,
        ...(mode === 'retest' && studyRun ? { assessmentId: studyRun.assessmentId } : {}),
        sourceIdentity: { ...sourceIdentity },
      }] : []),
    ];
    if (ledgerRows.length) appendLedgerRows(trainingRoot(storeDir), 'run', ledgerRows, { at: serverNow });
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

// ── End-of-game review quiz (#349) ────────────────────────────────────────────
// The app server's host-only quiz routes. Opening serves the asked pairs with their choices and no
// reference. An answer records the chart view first; then, for a v3 spot whose due mistake-bank item
// it finds, one spaced-repetition review through the drill's own grading and transition. No profile
// or practice event is written. The review log `quiz-reviews.json` makes one game's answer to one
// pair count once and lets the next answer finish a write that was interrupted.
const QUIZ_DRILL_MODES = new Set(['free', 'leak', 'daily', 'mistake-review', 'assessment', 'retest', 'transfer']);
const QUIZ_LOG_SEGMENTS = ['quiz-reviews.json'];
const QUIZ_LOG_MAX_BYTES = 1024 * 1024;
const QUIZ_LOG_MAX_ROWS = 500;
const QUIZ_ACTIONS = ['fold', 'call', 'raise'];
const QUIZ_ROW_KEYS = ['action', 'at', 'before', 'gameId', 'grade', 'handClass', 'mistakeId', 'patch', 'spotKey', 'state'].join();
const QUIZ_STATES = new Set(['pending', 'applied', 'unconfirmed']);
const QUIZ_SPOT_RE = /^[a-z0-9-]{1,100}$/;
const QUIZ_HAND_RE = /^[2-9TJQKA]{2}[so]?$/;

// Read only, never replayed: the quiz goes ahead only when no measurement run can be open and no
// drill answer is unresolved. A drill pending captures the bank item's schedule; changing it first
// would leave that pending unprovable.
function quizGate(storeDir) {
  // An absent session file is no session; a file whose content is `null` (or anything else that is
  // not a session) is an unknown state.
  let session;
  try {
    session = JSON.parse(openContained(trainingRoot(storeDir), SESSION_SEGMENTS, { maxBytes: SESSION_MAX_BYTES }).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw coded('STUDY_BUSY', 'the drill session cannot be read');
  }
  const shaped = object(session) && QUIZ_DRILL_MODES.has(session.mode) && Array.isArray(session.queue)
    && Number.isSafeInteger(session.index) && session.index >= 0 && session.index <= session.queue.length;
  if (object(session) && LOCKED_RUN_MODES.has(session.mode) && !(shaped && runProvenFinished(session))) {
    throw coded('GRID_LOCKED', 'charts are hidden while an assessment, retest or transfer run is open');
  }
  if (!shaped) throw coded('STUDY_BUSY', 'the drill session state cannot be proven');
  if (session.pending !== null && session.pending !== undefined) throw coded('STUDY_BUSY', 'an unresolved drill answer must be resumed first');
}

// The action classes a question on this spot offers: the drill prompt's actions without sizes.
function quizChoices(spotKey) {
  const legal = legalActionsFor(spotKey);
  return legal ? [...new Set(legal.map((entry) => entry.split(':')[0]))] : null;
}

// The drill's grading of one answer, on a question-shaped object (the drill's practice list is not
// consulted: a game asks spots the drill does not practise). v3 compares action classes only.
function quizGrade(source, spotKey, handClass, action) {
  try {
    const question = { questionId: 'quiz', sourceIdentity: { ...source }, prompt: { spotKey, handClass },
      answerPolicy: { providerId: source.id, providerVersion: source.version, contentSha256: source.contentSha256 } };
    const strategy = lookupStrategy(question);
    if (strategy.status !== 'supported') return null;
    const result = evaluateDrillAnswer(question, { action }, strategy);
    return result.status === 'reference-adherence' ? result : null;
  } catch {
    return null;
  }
}

function readQuizLog(storeDir) {
  let text;
  try { text = openContained(trainingRoot(storeDir), QUIZ_LOG_SEGMENTS, { maxBytes: QUIZ_LOG_MAX_BYTES }).toString('utf8'); }
  catch (error) { return error.code === 'ENOENT' ? { rows: [] } : null; }
  try {
    const data = JSON.parse(text);
    return object(data) && data.schemaVersion === 1 && Array.isArray(data.rows) && data.rows.length <= QUIZ_LOG_MAX_ROWS ? { rows: data.rows } : null;
  } catch {
    return null;
  }
}

function writeQuizLog(storeDir, rows) {
  writeContained(trainingRoot(storeDir), QUIZ_LOG_SEGMENTS, JSON.stringify({ schemaVersion: 1, rows }), { mode: 'replace' });
}

// Every row must be one this code could have written: its shape, a unique (game, spot, hand), an
// offered action, the grade that answer gets now and the exact transition from its captured
// schedule. A pending row must still name a bank item of the same source and pair. A row's time is
// not compared with the clock (a clock moved back does not make the log invalid).
function validQuizLog(rows, items, v3) {
  const keys = new Set();
  const grades = new Map();
  for (const row of rows) {
    if (!object(row) || Object.keys(row).sort().join() !== QUIZ_ROW_KEYS) return false;
    if (!isSessionId(row.gameId) || typeof row.spotKey !== 'string' || !QUIZ_SPOT_RE.test(row.spotKey) || !parsePreflopKeyV3(row.spotKey)
      || typeof row.handClass !== 'string' || !QUIZ_HAND_RE.test(row.handClass) || !QUIZ_ACTIONS.includes(row.action)
      || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at
      || !QUIZ_STATES.has(row.state) || !object(row.before) || !object(row.patch)) return false;
    try { assertEvaluationId(row.mistakeId); } catch { return false; }
    const key = JSON.stringify([row.gameId, row.spotKey, row.handClass]);
    if (keys.has(key)) return false;
    keys.add(key);
    if (!quizChoices(row.spotKey)?.includes(row.action)) return false;
    const gradeKey = JSON.stringify([row.spotKey, row.handClass, row.action]);
    if (!grades.has(gradeKey)) grades.set(gradeKey, quizGrade(v3, row.spotKey, row.handClass, row.action));
    const result = grades.get(gradeKey);
    if (!result || result.grade !== row.grade) return false;
    let expected;
    // Re-derived with the SR version the row was captured under, as the drill's pending proof does.
    try { expected = scheduleTarget(row.before, result, row.at, row.patch.srsVersion === SRS_VERSION ? SRS_VERSION : 1); } catch { return false; }
    if (!isDeepStrictEqual(expected, row.patch)) return false;
    if (row.state === 'pending') {
      const item = items.find((candidate) => candidate.mistakeId === row.mistakeId);
      if (!item || !sameSource(item.sourceIdentity, v3) || item.spotKey !== row.spotKey || item.handClass !== row.handClass) return false;
    }
  }
  return true;
}

const quizUnconfirmed = { recorded: false, reason: 'REVIEW_UNCONFIRMED' };
function quizRecorded(before, patch, already) {
  return { recorded: true, already, nextReviewAt: patch.nextReviewAt, intervalDays: patch.intervalDays,
    graduated: Boolean(patch.graduatedAt) && !before.graduatedAt };
}

const quizFault = (faults) => (step) => { if (faults?.failAt === step) throw coded('FAULT_INJECTED', `injected failure at ${step}`); };

async function recordQuizReview(storeDir, { gameId, spotKey, handClass, action, at, source, faults }) {
  const fault = quizFault(faults);
  const v3 = sourceIdentityOfDataset(loadReferenceDataset(V3_REFERENCE_SOURCE));
  const log = readQuizLog(storeDir);
  if (!log) return { recorded: false, reason: 'REVIEW_LOG_INVALID' };
  let items = await readOnlyBank(storeDir).list();
  if (!validQuizLog(log.rows, items, v3)) return { recorded: false, reason: 'REVIEW_LOG_INVALID' };
  // Finish what an interrupted answer left. A schedule that is neither the captured one nor its
  // target was changed by a drill review since: the row ends unconfirmed and nothing is written.
  let recovered = false;
  for (const row of log.rows) {
    if (row.state !== 'pending') continue;
    const current = items.find((item) => item.mistakeId === row.mistakeId).reviewState;
    if (isDeepStrictEqual(current, { ...row.before, ...row.patch })) row.state = 'applied';
    else if (isDeepStrictEqual(current, row.before)) {
      fault('recover');
      await applySrsTarget(storeDir, { mistakeId: row.mistakeId, before: row.before, patch: row.patch });
      row.state = 'applied';
    } else row.state = 'unconfirmed';
    recovered = true;
  }
  if (recovered) {
    writeQuizLog(storeDir, log.rows);
    // The recovered reviews moved schedules: choose and capture from the bank as it is now.
    items = await readOnlyBank(storeDir).list();
  }
  if (!sameSource(source, v3)) return { recorded: false, reason: 'SOURCE_NOT_TRACKED' };
  const prior = log.rows.find((row) => row.gameId === gameId && row.spotKey === spotKey && row.handClass === handClass);
  if (prior) return prior.state === 'applied' ? quizRecorded(prior.before, prior.patch, true) : quizUnconfirmed;
  // The study room's due rule; the first due item in bank order, as the daily queue would ask it.
  const same = items.filter((item) => sameSource(item.sourceIdentity, v3) && item.spotKey === spotKey && item.handClass === handClass);
  if (!same.length) return { recorded: false, reason: 'NOT_IN_BANK' };
  const target = same.find((item) => dueForReview(item, at));
  if (!target) return { recorded: false, reason: 'NOT_DUE' };
  const result = quizGrade(v3, spotKey, handClass, action);
  if (!result) return quizUnconfirmed;
  const before = { ...target.reviewState };
  const patch = scheduleTarget(before, result, at);
  // Room for the new row first, by insertion order; this game's rows and pending rows stay.
  const rows = [...log.rows];
  while (rows.length + 1 > QUIZ_LOG_MAX_ROWS) {
    const index = rows.findIndex((row) => row.gameId !== gameId && row.state !== 'pending');
    if (index < 0) return quizUnconfirmed;
    rows.splice(index, 1);
  }
  const row = { gameId, spotKey, handClass, action, grade: result.grade, at, mistakeId: target.mistakeId, before, patch, state: 'pending' };
  rows.push(row);
  fault('journal-pending');
  writeQuizLog(storeDir, rows);
  fault('bank');
  await applySrsTarget(storeDir, { mistakeId: target.mistakeId, before, patch });
  fault('journal-applied');
  row.state = 'applied';
  writeQuizLog(storeDir, rows);
  return quizRecorded(before, patch, false);
}

/** Opening the quiz: the asked pairs that have a chart cell, with the actions each offers. No
 * reference and no chart view (the reference is disclosed only by an answer). */
export async function readQuizSpots(storeDir, pairs) {
  return withDrillLock(storeDir, async () => {
    quizGate(storeDir);
    const charts = new Map();
    const items = [];
    for (const { spotKey, handClass } of Array.isArray(pairs) ? pairs : []) {
      if (typeof spotKey !== 'string' || !QUIZ_SPOT_RE.test(spotKey) || typeof handClass !== 'string' || !QUIZ_HAND_RE.test(handClass)) continue;
      if (!charts.has(spotKey)) {
        try { charts.set(spotKey, spotChart(spotKey).cells); } catch { charts.set(spotKey, null); }
      }
      const choices = quizChoices(spotKey);
      if (charts.get(spotKey)?.[handClass] && choices) items.push({ spotKey, handClass, choices });
    }
    return { items };
  });
}

/** One quiz answer: the chart view is recorded first (refused while a measurement run is open or a
 * drill answer is unresolved), then the review step. The reference goes out only after the view is
 * on record. `faults` is a test-only seam that cuts the review writes at a boundary. */
export async function answerQuizQuestion(storeDir, { gameId, spotKey, handClass, action, now, faults } = {}) {
  if (!isSessionId(gameId) || typeof spotKey !== 'string' || !QUIZ_SPOT_RE.test(spotKey)
    || typeof handClass !== 'string' || !QUIZ_HAND_RE.test(handClass) || !QUIZ_ACTIONS.includes(action)) {
    throw coded('BAD_COMMAND', 'quiz answer is invalid');
  }
  return withDrillLock(storeDir, async () => {
    quizGate(storeDir);
    let chart;
    try { chart = spotChart(spotKey); } catch { throw coded('QUIZ_NOT_ISSUED', 'the spot has no chart'); }
    const cell = chart.cells[handClass];
    const choices = quizChoices(spotKey);
    if (!cell || !choices) throw coded('QUIZ_NOT_ISSUED', 'the hand has no chart cell');
    if (!choices.includes(action)) throw coded('BAD_COMMAND', 'the question does not offer this action');
    try { recordChartView(storeDir, chart.source, spotKey, quizFault(faults)); }
    catch { throw coded('STUDY_BUSY', 'the chart view could not be recorded'); }
    let review;
    try {
      review = await recordQuizReview(storeDir, { gameId, spotKey, handClass, action, at: now ?? new Date().toISOString(), source: chart.source, faults });
    } catch {
      review = quizUnconfirmed;
    }
    return { ok: true, spotKey, handClass, reference: { fold: cell.fold, call: cell.call, raise: cell.raise }, review: { ...review } };
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
