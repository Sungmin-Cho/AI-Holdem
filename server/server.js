#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PUBLISH_BODY_BYTES, MAX_PUBLISH_ID, payloadSha256 } from '../publish-contract.js';
import { openContained } from '../tools/training-store.js';

const MAX_BODY = MAX_PUBLISH_BODY_BYTES;
const HEARTBEAT_MS = 15_000;
const KEEP_ALIVE_MS = 120_000;
const HEADERS_MS = 125_000;
const DEFAULT_WAIT_MS = 25_000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function writeJsonAtomic(filePath, obj) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(tmpPath); } catch { /* leftover tmp is harmless */ }
    throw error;
  }
}

function sendJson(res, status, obj) {
  if (res.writableEnded || res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function tokensEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function emptyState() {
  return {
    revision: 0,
    view: null,
    log: [],
    coach: [],
    training: [],
    review: undefined,
    publishId: undefined,
    history: [],
  };
}

function loadUiState(gameDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(gameDir, 'ui-snapshot.json'), 'utf8'));
    return {
      revision: Number(raw.revision) || 0,
      view: raw.view ?? null,
      log: Array.isArray(raw.log) ? raw.log : [],
      coach: Array.isArray(raw.coach) ? mergeCoach([], raw.coach) : [],
      training: Array.isArray(raw.training) ? raw.training : [],
      review: raw.review,
      publishId: raw.publishId,
      history: Array.isArray(raw.history) ? raw.history : [],
    };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
}

function v2ProofRequired(gameDir) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(gameDir, '.coach-authority.json'), 'utf8'));
    return auth.schemaVersion === 2;
  } catch {
    return false;
  }
}

function hasCoachProof(note) {
  const proof = note?.coachProof;
  return Boolean(
    proof
    && typeof proof.id === 'string'
    && typeof proof.payloadSha256 === 'string'
    && /^[0-9a-f]{64}$/.test(proof.id)
    && /^[0-9a-f]{64}$/.test(proof.payloadSha256),
  );
}

function validateIncomingCoach(existing, incoming, gameDir) {
  const required = v2ProofRequired(gameDir);
  for (const note of incoming) {
    if (required && !hasCoachProof(note)) return 'COACH_PROOF_REQUIRED';
    if (!hasCoachProof(note)) continue;
    if (!Number.isInteger(note.handNo) || typeof note.text !== 'string' || !note.text.trim()) {
      return 'COACH_PROOF_MISMATCH';
    }
    if (note.overfold !== undefined && note.overfold !== true) return 'COACH_PROOF_MISMATCH';
    if (note.unavailable !== undefined && note.unavailable !== true) return 'COACH_PROOF_MISMATCH';
    const digest = payloadSha256({
      handNo: note.handNo,
      text: note.text,
      overfold: note.overfold === true,
      unavailable: note.unavailable === true,
    });
    if (digest !== note.coachProof.payloadSha256) return 'COACH_PROOF_MISMATCH';
    const prev = existing.find((entry) => entry.handNo === note.handNo);
    if (prev) {
      const incomingOverfold = note.overfold === true;
      const sticky = Boolean(prev.overfold) || incomingOverfold;
      if (sticky !== incomingOverfold) return 'COACH_SEMANTIC_CONFLICT';
    }
  }
  return null;
}

// Coaching runs in the background, so notes arrive out of order and sometimes twice.
// Keyed by handNo and sorted, the array reads the same however they arrive — including
// when an older snapshot written before this rule is loaded back.
function mergeTraining(existing, incoming) {
  const merged = [...existing];
  for (const item of incoming) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.evaluationId !== 'string'
      || typeof item.payloadSha256 !== 'string') {
      return { error: 'TRAINING_PROOF_REQUIRED' };
    }
    const at = merged.findIndex((row) => row.evaluationId === item.evaluationId);
    if (at === -1) {
      merged.push(item);
      continue;
    }
    if (merged[at].payloadSha256 !== item.payloadSha256) {
      return { error: 'TRAINING_CONFLICT' };
    }
  }
  merged.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0)
    || String(a.evaluationId).localeCompare(String(b.evaluationId)));
  return { merged };
}

function mergeCoach(existing, incoming) {
  const merged = [...existing];
  for (const note of incoming) {
    const at = merged.findIndex((entry) => entry.handNo === note.handNo);
    if (hasCoachProof(note)) {
      if (at === -1) merged.push(note);
      else merged[at] = note;
      continue;
    }
    if (at === -1) { merged.push(note); continue; }
    // The once-per-game overfold comment is recorded here; a later edit of the same
    // note must not erase the fact that it was spent.
    const overfold = merged[at].overfold || note.overfold;
    merged[at] = overfold ? { ...note, overfold: true } : note;
  }
  return merged.sort((a, b) => (a.handNo ?? 0) - (b.handNo ?? 0));
}

function publicSnapshot(state) {
  const snap = {
    revision: state.revision,
    view: state.view,
    log: state.log,
    coach: state.coach,
    training: state.training ?? [],
  };
  if (state.review !== undefined) snap.review = state.review;
  return snap;
}

function persistUiState(gameDir, state) {
  const file = {
    revision: state.revision,
    view: state.view,
    log: state.log,
    coach: state.coach,
    training: state.training ?? [],
    publishId: state.publishId,
    history: state.history,
  };
  if (state.review !== undefined) file.review = state.review;
  writeJsonAtomic(path.join(gameDir, 'ui-snapshot.json'), file);
}

function writeSse(res, revision, payload) {
  res.write(`id: ${revision}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function parseArgs(argv) {
  const out = { gameDir: 'game', port: 8877, token: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--game-dir' && next != null) { out.gameDir = next; i += 1; }
    else if (arg === '--port' && next != null) { out.port = Number(next); i += 1; }
    else if (arg === '--token' && next != null) { out.token = next; i += 1; }
  }
  return out;
}

function readRawBody(req, res) {
  return new Promise((resolve) => {
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY) {
      sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
      req.resume();
      req.destroy();
      resolve(null);
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      finish(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => finish(null));
  });
}

async function readJsonBody(req, res) {
  const raw = await readRawBody(req, res);
  if (raw == null) return null;
  if (raw === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, code: 'BAD_JSON' });
      return null;
    }
    return parsed;
  } catch {
    sendJson(res, 400, { ok: false, code: 'BAD_JSON' });
    return null;
  }
}

function readTrainingDetail(root, ref, expectedSha) {
  const buf = openContained(root, ['training', 'details', `${ref}.json`], { maxBytes: 1_000_000 });
  const digest = createHash('sha256').update(buf).digest('hex');
  if (digest !== expectedSha) throw new Error('digest');
  return JSON.parse(buf.toString('utf8'));
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  const root = path.normalize(`${PUBLIC_DIR}${path.sep}`);
  if (abs !== path.normalize(PUBLIC_DIR) && !abs.startsWith(root)) {
    sendJson(res, 403, { ok: false, code: 'FORBIDDEN' });
    return;
  }
  fs.stat(abs, (statErr, st) => {
    if (statErr || !st.isFile()) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      return;
    }
    fs.readFile(abs, (readErr, data) => {
      if (readErr) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      res.end(data);
    });
  });
}

export function startServer({ gameDir, port = 8877, token }) {
  if (!gameDir) throw new Error('gameDir required');
  if (typeof token !== 'string' || token.length === 0) throw new Error('token required');
  const root = path.resolve(gameDir);
  fs.mkdirSync(root, { recursive: true });

  const state = loadUiState(root);
  const sseClients = new Set();
  const waiters = new Set();
  let slot = null;
  let delivered = null;

  const checkToken = (provided, res) => {
    if (tokensEqual(provided, token)) return true;
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
    return false;
  };

  const currentDecisionId = () => state.view?.legal?.decisionId ?? null;

  const deliverSlot = () => {
    if (!slot) return;
    for (const waiter of waiters) {
      if (waiter.expectDecisionId && waiter.expectDecisionId !== slot.decisionId) continue;
      const taken = slot;
      slot = null;
      // Delivery is not proof of receipt: an HTTP response can be lost, and the user's
      // action bar is already disabled, so a consumed-and-forgotten action stalls the
      // hand with nobody able to resend it. Kept until the next decision is published.
      delivered = taken;
      waiters.delete(waiter);
      clearTimeout(waiter.timer);
      waiter.finish(taken);
      return;
    }
  };

  const handlePublish = (body, res) => {
    if (!Number.isInteger(body.publishId) || body.publishId < 1 || body.publishId > MAX_PUBLISH_ID) {
      sendJson(res, 400, { ok: false, code: 'BAD_PUBLISH_ID' });
      return;
    }
    // publishIds only ever move forward, so anything at or below the last one is a
    // resend of something already applied — not just the immediately previous id.
    // Answering it as already-done is what makes a publisher's retry safe.
    const alreadyApplied = Number.isInteger(state.publishId)
      ? body.publishId <= state.publishId
      : false;
    if (alreadyApplied) {
      sendJson(res, 200, { ok: true, revision: state.revision });
      return;
    }

    // Build the whole next state to the side, persist it, and only then commit.
    // Mutating first would leave memory ahead of disk after a write failure, and the
    // publisher's same-id retry would then hit the duplicate fast-path above — reported
    // as published, present nowhere.
    const next = {
      revision: state.revision + 1,
      publishId: body.publishId,
      view: state.view,
      log: state.log,
      coach: state.coach,
      training: state.training ?? [],
      review: state.review,
      history: state.history,
    };

    const payload = {};
    if (body.view !== undefined) {
      next.view = body.view;
      payload.view = body.view;
    }
    if (Array.isArray(body.events) && body.events.length) {
      next.log = [...next.log, ...body.events];
      payload.events = body.events;
    }
    if (Array.isArray(body.messages) && body.messages.length) {
      next.log = [...next.log, ...body.messages];
      payload.messages = body.messages;
    }
    if (Array.isArray(body.coach) && body.coach.length) {
      const coachError = validateIncomingCoach(next.coach, body.coach, root);
      if (coachError) {
        sendJson(res, 400, { ok: false, code: coachError });
        return;
      }
      next.coach = mergeCoach(next.coach, body.coach);
      payload.coach = body.coach;
    }
    if (body.review !== undefined) {
      next.review = body.review;
      payload.review = body.review;
    }
    if (Array.isArray(body.training) && body.training.length) {
      const merged = mergeTraining(next.training, body.training);
      if (merged.error) {
        sendJson(res, 400, { ok: false, code: merged.error });
        return;
      }
      next.training = merged.merged;
      payload.training = body.training;
    }

    // Stamped for turn-latency measurement; kept off the payload so clients see no change.
    next.history = [...next.history, { revision: next.revision, at: new Date().toISOString(), payload }];

    try {
      persistUiState(root, next);
    } catch {
      sendJson(res, 500, { ok: false, code: 'PERSIST_FAILED' });
      return;
    }

    Object.assign(state, next);
    // Any published view means the dealer got the action and moved on — either it was
    // applied, or it was refused and re-asked. Re-delivering past this point would feed
    // a refused action straight back into the wait it just re-entered, forever.
    // A view-only republish is the exception: it re-shows a state rather than
    // acknowledging anything, so a resuming dealer must still be able to collect an
    // action whose response was lost.
    if (body.view !== undefined && body.viewOnly !== true) delivered = null;
    for (const client of sseClients) {
      try { writeSse(client.res, state.revision, payload); } catch { /* disconnected */ }
    }
    sendJson(res, 200, { ok: true, revision: state.revision });
  };

  const handleAction = (body, res) => {
    const current = currentDecisionId();
    if (current == null || body.decisionId !== current) {
      sendJson(res, 409, { ok: false, code: 'STALE_DECISION' });
      return;
    }
    const next = { decisionId: body.decisionId, action: body.action };
    if (body.amount !== undefined) next.amount = body.amount;
    slot = next;
    deliverSlot();
    sendJson(res, 200, { ok: true });
  };

  const attachSse = (req, res, url) => {
    const afterRaw = Number(url.searchParams.get('after'));
    const after = Number.isFinite(afterRaw) ? afterRaw : 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    res.socket?.setNoDelay(true);

    const client = {
      res,
      heartbeat: setInterval(() => {
        try { res.write(':heartbeat\n\n'); } catch { /* gone */ }
      }, HEARTBEAT_MS),
    };
    sseClients.add(client);
    for (const entry of state.history) {
      if (entry.revision > after) writeSse(res, entry.revision, entry.payload);
    }

    const cleanup = () => {
      clearInterval(client.heartbeat);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  };

  const attachWait = (req, res, url) => {
    const expectDecisionId = url.searchParams.get('expectDecisionId') ?? '';
    let timeoutMs = Number(url.searchParams.get('timeoutMs'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) timeoutMs = DEFAULT_WAIT_MS;

    const finish = (payload) => {
      sendJson(res, 200, payload);
    };

    if (slot && (!expectDecisionId || slot.decisionId === expectDecisionId)) {
      const taken = slot;
      slot = null;
      delivered = taken;
      finish(taken);
      return;
    }

    // The same decision asked twice means the first answer never arrived.
    if (delivered && expectDecisionId && delivered.decisionId === expectDecisionId) {
      finish(delivered);
      return;
    }

    const waiter = { expectDecisionId, finish, timer: null };
    waiter.timer = setTimeout(() => {
      waiters.delete(waiter);
      finish({ timeout: true });
    }, timeoutMs);
    waiters.add(waiter);
    req.on('close', () => {
      if (waiters.has(waiter)) {
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
      }
    });
  };

  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      attachSse(req, res, url);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/snapshot') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      sendJson(res, 200, publicSnapshot(state));
      return;
    }

    if (req.method === 'GET' && pathname === '/api/training-detail') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      const ref = url.searchParams.get('ref') ?? '';
      if (!/^[0-9a-f]{64}$/.test(ref)) {
        sendJson(res, 400, { ok: false, code: 'BAD_DETAIL_REF' });
        return;
      }
      const item = (state.training ?? []).find((row) => row.detailRef === ref);
      if (!item?.detailSha256) {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
        return;
      }
      try {
        const detail = readTrainingDetail(root, ref, item.detailSha256);
        sendJson(res, 200, { ok: true, detail });
      } catch {
        sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      }
      return;
    }

    if (req.method === 'GET' && pathname === '/api/wait-action') {
      if (!checkToken(url.searchParams.get('token'), res)) return;
      attachWait(req, res, url);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/publish') {
      const body = await readJsonBody(req, res);
      if (body == null) return;
      if (!checkToken(url.searchParams.get('token') ?? body.token, res)) return;
      handlePublish(body, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readJsonBody(req, res);
      if (body == null) return;
      if (!checkToken(url.searchParams.get('token') ?? body.token, res)) return;
      handleAction(body, res);
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      return;
    }

    if (req.method === 'GET') {
      serveStatic(pathname, res);
      return;
    }

    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, code: 'INTERNAL' });
      else res.destroy();
    });
  });

  // Node's default requestTimeout (300s) would kill SSE and long-poll.
  server.timeout = 0;
  server.requestTimeout = 0;
  server.keepAliveTimeout = KEEP_ALIVE_MS;
  server.headersTimeout = HEADERS_MS;

  const close = () => new Promise((resolve, reject) => {
    for (const client of sseClients) {
      clearInterval(client.heartbeat);
      try { client.res.end(); } catch { /* already closed */ }
    }
    sseClients.clear();
    for (const waiter of waiters) clearTimeout(waiter.timer);
    waiters.clear();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close((err) => (err ? reject(err) : resolve()));
  });

  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', onError);
      const actualPort = server.address().port;
      writeJsonAtomic(path.join(root, 'lock.json'), {
        serverPid: process.pid,
        port: actualPort,
        sessionToken: token,
        startedAt: new Date().toISOString(),
      });
      resolve({ server, port: actualPort, close });
    });
  });
}

const isDirectRun = process.argv[1] != null
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.token) {
    console.error('usage: node server/server.js --game-dir game --port 8877 --token <t>');
    process.exit(2);
  }
  const { port } = await startServer(opts);
  process.stdout.write(`listening 127.0.0.1:${port}\n`);
}
