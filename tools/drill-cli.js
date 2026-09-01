#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMistakeBank } from '../training/mistake-bank.js';
import { generateQueue } from '../training/drill-generator.js';
import { evaluateDrillAnswer } from '../training/drill-evaluator.js';
import { nextSchedule } from '../training/spaced-repetition.js';
import { createProfileStore } from '../training/profile-store.js';
import { loadPreflopJson, lookup } from '../training/providers/preflop-json.js';
import { writeJsonSecure, readJsonSecure, ensureDir } from './training-store.js';
import { createHash } from 'node:crypto';
import { evaluationIdOf } from '../training/contracts.js';

const DATASET = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../training/data/preflop-baseline-v1.json');

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

function sessionPath(storeDir) {
  return path.join(storeDir, '.training', 'drill-session.json');
}

function loadSession(storeDir) {
  try { return readJsonSecure(sessionPath(storeDir)); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function lookupStrategy(question) {
  const { data, contentSha256 } = loadPreflopJson(DATASET);
  return lookup({ data, contentSha256 }, {
    spotKey: question.prompt.spotKey,
    handClass: question.prompt.handClass,
  });
}

export async function startDrill(storeDir, { mode = 'free', seed = '0' } = {}) {
  const bank = createMistakeBank(storeDir);
  const profile = await createProfileStore(storeDir).show();
  const mistakes = await bank.list();
  const queue = generateQueue({ mode, profile, mistakes, seed, now: new Date().toISOString() });
  const session = {
    schemaVersion: 1,
    mode,
    seed,
    index: 0,
    queue,
    answers: [],
  };
  ensureDir(path.join(storeDir, '.training'));
  writeJsonSecure(sessionPath(storeDir), session);
  return session;
}

export async function nextQuestion(storeDir) {
  const session = loadSession(storeDir);
  if (!session) return { done: true, question: null };
  if (session.index >= session.queue.length) return { done: true, question: null, summary: session.answers };
  return { done: false, question: session.queue[session.index] };
}

export async function answerQuestion(storeDir, { action, sizeBb } = {}) {
  const session = loadSession(storeDir);
  if (!session) fail('NO_SESSION', 'drill session이 없습니다.');
  const question = session.queue[session.index];
  if (!question) return { done: true };
  const strategy = lookupStrategy(question);
  const result = evaluateDrillAnswer(question, { action, sizeBb }, strategy);
  session.answers.push(result);
  session.index += 1;
  writeJsonSecure(sessionPath(storeDir), session);

  const bank = createMistakeBank(storeDir);
  const items = await bank.list();
  const match = items.find((item) => item.spotSignature === `${question.prompt.spotKey}:${question.prompt.handClass}`);
  if (match) {
    const schedule = nextSchedule({
      grade: result.grade,
      intervalDays: match.intervalDays,
      ease: match.ease,
      lapses: match.lapses,
    });
    await bank.update(match.mistakeId, {
      lastReviewedAt: new Date().toISOString(),
      attempts: (match.attempts ?? 0) + 1,
      ...schedule,
    });
  }

  const attemptKey = `drill:${question.questionId}:${session.answers.length}`;
  const digest = createHash('sha256').update(attemptKey).digest('hex');
  await createProfileStore(storeDir).apply({
    evaluationId: evaluationIdOf({
      gameEpoch: digest,
      decisionId: `d-${session.answers.length}-preflop-0`,
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
  }).catch(() => {});

  return { ok: true, result, next: session.queue[session.index] ?? null };
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  const storeDir = flags['store-dir'];
  if (!storeDir) fail('USAGE', '--store-dir가 필요합니다.');
  if (cmd === 'start') {
    const session = await startDrill(storeDir, { mode: flags.mode ?? 'free', seed: flags.seed ?? '0' });
    fs.writeSync(1, `${JSON.stringify({ ok: true, count: session.queue.length, session })}\n`);
    return;
  }
  if (cmd === 'next') {
    fs.writeSync(1, `${JSON.stringify({ ok: true, ...(await nextQuestion(storeDir)) })}\n`);
    return;
  }
  if (cmd === 'answer') {
    const out = await answerQuestion(storeDir, {
      action: flags.action,
      sizeBb: flags['size-bb'] != null ? Number(flags['size-bb']) : undefined,
    });
    fs.writeSync(1, `${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === 'summary') {
    const session = loadSession(storeDir) ?? { answers: [] };
    fs.writeSync(1, `${JSON.stringify({ ok: true, answers: session.answers, remaining: Math.max(0, (session.queue?.length ?? 0) - (session.index ?? 0)) })}\n`);
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
