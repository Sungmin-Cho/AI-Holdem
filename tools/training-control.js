import fs from 'node:fs';
import path from 'node:path';
import { withNamedLock } from '../engine/state.js';
import { assertEvaluationId } from '../training/contracts.js';
import { toPublicSummary } from '../training/public-view.js';
import {
  SUPPORTED_TRAINING_AUTHORITY_SCHEMAS,
  detailRefOf,
  sha256Hex,
} from '../publish-contract.js';
import {
  appendJsonl,
  ensureDir,
  readJsonl,
  readJsonSecure,
  writeJsonSecure,
} from './training-store.js';

export const TRAINING_LOCK = 'training.lock.d';
export const SUPPORTED_SCHEMAS = SUPPORTED_TRAINING_AUTHORITY_SCHEMAS;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trainingDir(sessionDir) {
  return path.join(sessionDir, 'training');
}

function authPath(sessionDir) {
  return path.join(trainingDir(sessionDir), '.training-authority.json');
}

function evaluationsPath(sessionDir) {
  return path.join(trainingDir(sessionDir), 'evaluations.jsonl');
}

function detailsDir(sessionDir) {
  return path.join(trainingDir(sessionDir), 'details');
}

function emptyAuth({ gameEpoch, owner }) {
  return {
    schemaVersion: 1,
    gameEpoch,
    ownerSessionId: owner,
    items: {},
    publishQueue: {},
  };
}

function loadAuthorityUnlocked(sessionDir) {
  try {
    const auth = readJsonSecure(authPath(sessionDir));
    if (!SUPPORTED_TRAINING_AUTHORITY_SCHEMAS.includes(auth.schemaVersion)) {
      throw coded('UNSUPPORTED_TRAINING_AUTHORITY', `schema ${auth.schemaVersion}`);
    }
    if (!auth.items || typeof auth.items !== 'object' || Array.isArray(auth.items)) {
      throw coded('UNSUPPORTED_TRAINING_AUTHORITY', 'items');
    }
    return auth;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'UNSAFE_PATH') {
      if (error.code === 'UNSAFE_PATH' && fs.existsSync(authPath(sessionDir))) throw error;
    }
    if (error.code === 'ENOENT') return null;
    try {
      fs.accessSync(authPath(sessionDir));
    } catch (accessError) {
      if (accessError.code === 'ENOENT') return null;
    }
    if (error.code === 'UNSUPPORTED_TRAINING_AUTHORITY') throw error;
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function persistAuth(sessionDir, auth) {
  writeJsonSecure(authPath(sessionDir), auth);
}

function userDecisionsOf(record) {
  if (!record || !Array.isArray(record.decisions)) return [];
  return record.decisions.filter((snap) => snap.actorId === 'user');
}

function collectRecords({ lastHand, handsDir }) {
  const byHand = new Map();
  if (lastHand?.handNo) byHand.set(lastHand.handNo, lastHand);
  if (handsDir && fs.existsSync(handsDir)) {
    for (const name of fs.readdirSync(handsDir)) {
      const match = /^hand-(\d+)\.json$/.exec(name);
      if (!match) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(handsDir, name), 'utf8'));
        if (Number.isInteger(record?.handNo)) byHand.set(record.handNo, record);
      } catch {
        /* unreadable archive is ignored; lastHand may still cover it */
      }
    }
  }
  return [...byHand.values()].sort((a, b) => a.handNo - b.handNo);
}

export function createTrainingControl() {
  async function withLock(sessionDir, fn) {
    return withNamedLock(sessionDir, TRAINING_LOCK, fn);
  }

  function loadAuthority(sessionDir) {
    return loadAuthorityUnlocked(sessionDir);
  }

  async function acceptEvaluations(sessionDir, {
    gameEpoch, owner, handNo, evaluations, explanations = {},
  }) {
    return withLock(sessionDir, () => {
      let auth = loadAuthorityUnlocked(sessionDir);
      if (auth && auth.gameEpoch !== gameEpoch) {
        throw coded('TRAINING_EPOCH_MISMATCH', 'training authority gameEpoch가 일치하지 않습니다.');
      }
      if (!auth) auth = emptyAuth({ gameEpoch, owner });
      auth.ownerSessionId = owner;
      const accepted = [];
      for (const evaluation of evaluations ?? []) {
        const evaluationId = assertEvaluationId(evaluation.evaluationId);
        const detailRef = detailRefOf(evaluationId);
        ensureDir(detailsDir(sessionDir));
        const detailPath = path.join(detailsDir(sessionDir), `${detailRef}.json`);
        const detailRaw = JSON.stringify(evaluation);
        const detailSha256 = sha256Hex(detailRaw);
        const summary = toPublicSummary(evaluation, {
          handNo,
          detailSha256,
          detailRef,
          explanation: explanations[evaluationId] ?? null,
        });
        const existing = auth.items[evaluationId];
        if (existing) {
          if (existing.payloadSha256 !== summary.payloadSha256) {
            throw coded('EVALUATION_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
          }
          accepted.push(existing);
          continue;
        }
        writeJsonSecure(detailPath, evaluation);
        appendJsonl(evaluationsPath(sessionDir), summary);
        const item = {
          status: 'evaluated',
          handNo,
          decisionId: evaluation.decisionId,
          evaluationId,
          payloadSha256: summary.payloadSha256,
          detailRef,
          detailSha256,
        };
        auth.items[evaluationId] = item;
        auth.publishQueue[evaluationId] = {
          evaluationId,
          handNo,
          payloadSha256: summary.payloadSha256,
        };
        accepted.push(item);
      }
      persistAuth(sessionDir, auth);
      return { accepted };
    });
  }

  async function reconcile(sessionDir, {
    gameEpoch, owner, lastHand, handsDir, evaluate,
  }) {
    return withLock(sessionDir, async () => {
      let auth = loadAuthorityUnlocked(sessionDir) ?? emptyAuth({ gameEpoch, owner });
      if (auth.gameEpoch !== gameEpoch && Object.keys(auth.items).length) {
        throw coded('TRAINING_EPOCH_MISMATCH', 'training authority gameEpoch가 일치하지 않습니다.');
      }
      if (!Object.keys(auth.items).length) auth = emptyAuth({ gameEpoch, owner });
      auth.gameEpoch = gameEpoch;
      auth.ownerSessionId = owner;
      const recorded = new Set(readJsonl(evaluationsPath(sessionDir)).map((row) => row.decisionId));
      let created = 0;
      for (const record of collectRecords({ lastHand, handsDir })) {
        const missing = userDecisionsOf(record).filter((snap) => !recorded.has(snap.decisionId));
        if (missing.length === 0) continue;
        const evaluations = await evaluate({ handNo: record.handNo, record, missing });
        for (const evaluation of evaluations ?? []) {
          const evaluationId = assertEvaluationId(evaluation.evaluationId);
          if (auth.items[evaluationId]) continue;
          const detailRef = detailRefOf(evaluationId);
          ensureDir(detailsDir(sessionDir));
          const detailPath = path.join(detailsDir(sessionDir), `${detailRef}.json`);
          const detailRaw = JSON.stringify(evaluation);
          const detailSha256 = sha256Hex(detailRaw);
          const summary = toPublicSummary(evaluation, {
            handNo: record.handNo,
            detailSha256,
            detailRef,
          });
          writeJsonSecure(detailPath, evaluation);
          appendJsonl(evaluationsPath(sessionDir), summary);
          auth.items[evaluationId] = {
            status: 'evaluated',
            handNo: record.handNo,
            decisionId: evaluation.decisionId,
            evaluationId,
            payloadSha256: summary.payloadSha256,
            detailRef,
            detailSha256,
          };
          auth.publishQueue[evaluationId] = {
            evaluationId,
            handNo: record.handNo,
            payloadSha256: summary.payloadSha256,
          };
          recorded.add(evaluation.decisionId);
          created += 1;
        }
      }
      persistAuth(sessionDir, auth);
      return { created, authority: auth };
    });
  }

  function pendingItems(sessionDir) {
    const auth = loadAuthorityUnlocked(sessionDir);
    if (!auth) return [];
    return Object.values(auth.items).filter((item) => item.status !== 'published');
  }

  async function markPublished(sessionDir, evaluationId, payloadSha256) {
    return withLock(sessionDir, () => {
      const auth = loadAuthorityUnlocked(sessionDir);
      if (!auth) throw coded('NO_TRAINING_AUTHORITY', 'training authority가 없습니다.');
      const item = auth.items[evaluationId];
      if (!item) throw coded('NO_TRAINING_ITEM', evaluationId);
      if (item.payloadSha256 !== payloadSha256) {
        throw coded('EVALUATION_CONFLICT', '같은 evaluationId에 다른 digest가 있습니다.');
      }
      item.status = 'published';
      delete auth.publishQueue[evaluationId];
      persistAuth(sessionDir, auth);
      return item;
    });
  }

  return {
    acceptEvaluations,
    reconcile,
    loadAuthority,
    pendingItems,
    markPublished,
    withLock,
  };
}
