#!/usr/bin/env node
import { timingSafeEqual, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDrill, nextQuestion, answerQuestion } from '../tools/drill-cli.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drill-public');
const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function tokensEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function statusFor(code) {
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'BAD_JSON' || code === 'USAGE') return 400;
  if (code === 'NO_SESSION' || code === 'STALE_QUESTION' || code === 'PENDING_UNRESOLVED') return 409;
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  return 500;
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/drill.html' : pathname;
  const abs = path.normalize(path.join(PUBLIC_DIR, rel));
  const root = path.normalize(`${PUBLIC_DIR}${path.sep}`);
  if (!abs.startsWith(root) && abs !== path.normalize(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, code: 'FORBIDDEN' });
    return;
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readRawBody(req, res) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const rejectTooLarge = () => {
      sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' });
      req.resume();
      finish(null);
    };
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY) {
      rejectTooLarge();
      return;
    }
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        rejectTooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      finish(Buffer.concat(chunks).toString('utf8') || '{}');
    });
    req.on('error', () => finish(null));
  });
}

async function readJsonBody(req, res) {
  const raw = await readRawBody(req, res);
  if (raw == null) return null;
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

export async function startDrillServer({ storeDir, port = 0, token } = {}) {
  if (!storeDir || !token) throw new Error('storeDir and token required');
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const provided = url.searchParams.get('token') ?? req.headers['x-drill-token'];
      if (url.pathname.startsWith('/api/')) {
        if (!tokensEqual(provided, token)) {
          sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
          return;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/start') {
        const body = await readJsonBody(req, res);
        if (body == null) return;
        if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length === 0) {
          sendJson(res, 400, { ok: false, code: 'USAGE' });
          return;
        }
        const session = await startDrill(storeDir, {
          mode: body.mode ?? 'free',
          seed: body.seed ?? '0',
          idempotencyKey: body.idempotencyKey,
        });
        sendJson(res, 200, { ok: true, count: session.queue.length, sessionId: session.sessionId });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/next') {
        sendJson(res, 200, { ok: true, ...(await nextQuestion(storeDir)) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/answer') {
        const body = await readJsonBody(req, res);
        if (body == null) return;
        sendJson(res, 200, await answerQuestion(storeDir, {
          action: body.action,
          sizeBb: body.sizeBb,
          sessionId: body.sessionId,
          questionId: body.questionId,
          attemptNo: body.attemptNo,
        }));
        return;
      }
      if (req.method === 'GET') {
        serveStatic(url.pathname, res);
        return;
      }
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
    } catch (error) {
      const code = error.code ?? 'ERROR';
      sendJson(res, statusFor(code), { ok: false, code, message: error.message });
    }
  });
  const close = () => new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, token, close });
    });
  });
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const storeDir = process.argv.includes('--store-dir')
    ? process.argv[process.argv.indexOf('--store-dir') + 1]
    : 'game';
  const token = randomBytes(16).toString('hex');
  const { port } = await startDrillServer({ storeDir, port: 0, token });
  process.stdout.write(`drill listening 127.0.0.1:${port} token=${token}\n`);
}
