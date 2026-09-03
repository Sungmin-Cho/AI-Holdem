#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createMistakeBank } from './training-stores.js';
import { generateQueue } from '../training/drill-generator.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { nextSchedule } from '../training/spaced-repetition.js';
import { createProfileStore } from './training-stores.js';
import { lookup } from '../training/providers/preflop-json.js';
import { loadPreflopDataset } from './preflop-dataset.js';
import { ensureDir, openContained, writeContained } from './training-store.js';
import { evaluationIdOf, coded } from '../training/contracts.js';
import { withNamedLock } from '../engine/state.js';

const DATASET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/data/preflop-baseline-v1.json');
const DRILL_LOCK = 'drill.lock.d';
const SESSION_SEGMENTS = ['drill-session.json'];
const SESSION_MAX_BYTES = 1_048_576;
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value);
}

function fail(code, message) {
  fs.writeSync(1, `${JSON.stringify({ ok: false, code, message })}\n`);
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

function lookupStrategy(question) {
  const { data, contentSha256 } = loadPreflopDataset(DATASET);
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

function profileEventOf(session, question, attemptNo, result) {
  const digest = createHash('sha256')
    .update(attemptKeyOf(session.sessionId, question.questionId, attemptNo))
    .digest('hex');
  return {
    evaluationId: evaluationIdOf({
      gameEpoch: digest,
      decisionId: `d-${attemptNo + 1}-preflop-0`,
      providerId: 'local-preflop-baseline',
      providerVersion: '1.0.0',
    }),
    payloadSha256: digest,
    status: 'supported',
    street: 'preflop',
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
    grade: result.grade,
    forced: false,
    evLossBb: null,
    source: { id: 'local-preflop-baseline', version: '1.0.0' },
    origin: 'drill',
  };
}

async function buildSrsPatch(storeDir, question, result) {
  const items = await createMistakeBank(storeDir).list();
  const match = items.find((item) => item.spotSignature === `${question.prompt.spotKey}:${question.prompt.handClass}`);
  if (!match) return null;
  const schedule = nextSchedule({
    grade: result.grade,
    intervalDays: match.intervalDays,
    ease: match.ease,
    lapses: match.lapses,
  });
  return {
    mistakeId: match.mistakeId,
    patch: {
      lastReviewedAt: new Date().toISOString(),
      attempts: (match.attempts ?? 0) + 1,
      ...schedule,
    },
  };
}

async function applySrs(storeDir, srsPatch) {
  if (!srsPatch) return;
  await createMistakeBank(storeDir).update(srsPatch.mistakeId, srsPatch.patch);
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

function assertPending(pending) {
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
}

async function replayPending(storeDir, session) {
  const pending = session.pending;
  if (!pending) return session;
  try {
    assertPending(pending);
    if (!pending.applied) pending.applied = { srs: false, profile: false };
    if (!pending.applied.srs) {
      await applySrs(storeDir, pending.srsPatch ?? null);
      pending.applied.srs = true;
      persistSession(storeDir, session);
    }
    if (!pending.applied.profile) {
      if (!pending.profileEvent) throw coded('PENDING_UNRESOLVED', 'pending profileEvent가 없습니다.');
      await createProfileStore(storeDir).apply(pending.profileEvent);
      pending.applied.profile = true;
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
  if (session?.pending) await replayPending(storeDir, session);
  return session;
}

function answerPayload(session) {
  return {
    ok: true,
    result: session.answers[session.index - 1],
    next: session.queue[session.index] ?? null,
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

export async function startDrill(storeDir, { mode = 'free', seed = '0', idempotencyKey } = {}) {
  return withDrillLock(storeDir, async () => {
    const existing = loadSession(storeDir);
    if (existing?.pending) await replayPending(storeDir, existing);
    if (existing && idempotencyKey && existing.idempotencyKey === idempotencyKey) {
      return existing;
    }
    const bank = createMistakeBank(storeDir);
    const profile = await createProfileStore(storeDir).show();
    const mistakes = await bank.list();
    const queue = generateQueue({ mode, profile, mistakes, seed, now: new Date().toISOString() });
    const session = {
      schemaVersion: 1,
      sessionId: randomUUID(),
      idempotencyKey: idempotencyKey ?? randomUUID(),
      mode,
      seed,
      index: 0,
      queue,
      answers: [],
      pending: null,
    };
    persistSession(storeDir, session);
    return session;
  });
}

export async function nextQuestion(storeDir) {
  return withDrillLock(storeDir, async () => {
    const session = await loadLiveSession(storeDir);
    if (!session) return { done: true, question: null };
    if (session.index >= session.queue.length) {
      return { done: true, question: null, summary: session.answers, sessionId: session.sessionId };
    }
    return {
      done: false,
      question: session.queue[session.index],
      sessionId: session.sessionId,
      attemptNo: session.index,
    };
  });
}

export async function answerQuestion(storeDir, { action, sizeBb, sessionId, questionId, attemptNo } = {}) {
  return withDrillLock(storeDir, async () => {
    const session = await loadLiveSession(storeDir);
    if (!session) throw coded('NO_SESSION', 'drill session이 없습니다.');
    const attempt = coerceAttemptNo(attemptNo);
    if (!isSessionId(session.sessionId) || !isSessionId(sessionId)
      || sessionId !== session.sessionId || attempt == null || typeof questionId !== 'string') {
      throw coded('STALE_QUESTION', '문항 요청이 현재 세션과 일치하지 않습니다.');
    }
    if (attempt < session.index) return storedAnswer(session, questionId, attempt);
    if (attempt !== session.index) {
      throw coded('STALE_QUESTION', '문항 요청이 현재 세션과 일치하지 않습니다.');
    }
    const question = session.queue[session.index];
    if (!question) return { done: true };
    if (question.questionId !== questionId) {
      throw coded('STALE_QUESTION', '문항 요청이 현재 세션과 일치하지 않습니다.');
    }

    const strategy = lookupStrategy(question);
    const result = evaluateDrillAnswer(question, { action, sizeBb }, strategy);
    const srsPatch = await buildSrsPatch(storeDir, question, result);
    const profileEvent = profileEventOf(session, question, attempt, result);
    session.pending = {
      answer: { action, sizeBb },
      result,
      srsPatch,
      profileEvent,
      applied: { srs: false, profile: false },
      questionId,
      attemptNo: attempt,
    };
    persistSession(storeDir, session);
    await replayPending(storeDir, session);
    return answerPayload(session);
  });
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const storeDir = flags['store-dir'];
  if (!storeDir) fail('USAGE', '--store-dir가 필요합니다.');
  if (cmd === 'start') {
    const session = await startDrill(storeDir, {
      mode: flags.mode ?? 'free',
      seed: flags.seed ?? '0',
      idempotencyKey: flags['idempotency-key'],
    });
    fs.writeSync(1, `${JSON.stringify({ ok: true, count: session.queue.length, sessionId: session.sessionId, session })}\n`);
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
  fail('USAGE', 'start|next|answer|summary|due만 지원합니다.');
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((error) => fail(error.code ?? 'ERROR', error.message));
}
