#!/usr/bin/env node
import { timingSafeEqual, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDrill, nextQuestion, answerQuestion } from '../tools/drill-cli.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'drill-public');
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
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
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

export async function startDrillServer({ storeDir, port = 0, token } = {}) {
  if (!storeDir || !token) throw new Error('storeDir and token required');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const provided = url.searchParams.get('token') ?? req.headers['x-drill-token'];
    if (url.pathname.startsWith('/api/')) {
      if (!tokensEqual(provided, token)) {
        sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        return;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      const body = JSON.parse(await readBody(req));
      const session = await startDrill(storeDir, { mode: body.mode ?? 'free', seed: body.seed ?? '0' });
      sendJson(res, 200, { ok: true, count: session.queue.length });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/next') {
      sendJson(res, 200, { ok: true, ...(await nextQuestion(storeDir)) });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const body = JSON.parse(await readBody(req));
      sendJson(res, 200, await answerQuestion(storeDir, body));
      return;
    }
    if (req.method === 'GET') {
      serveStatic(url.pathname, res);
      return;
    }
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND' });
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}'));
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
