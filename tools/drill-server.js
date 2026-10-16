#!/usr/bin/env node
import { timingSafeEqual, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDrill, nextQuestion, answerQuestion, readDrillSession, readSpotChart } from './drill-cli.js';
import { readStudySummary } from './study-summary.js';
import { KNOWN_REFERENCE_SOURCES } from '../shared/reference.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY = 64 * 1024;
const STATIC = new Map([
  ['/', ['server/drill-public/drill.html', 'text/html; charset=utf-8']],
  ['/drill.html', ['server/drill-public/drill.html', 'text/html; charset=utf-8']],
  ['/drill.js', ['server/drill-public/drill.js', 'text/javascript; charset=utf-8']],
  ['/drill.css', ['server/drill-public/drill.css', 'text/css; charset=utf-8']],
  ['/design-tokens.css', ['server/public/design-tokens.css', 'text/css; charset=utf-8']],
  ['/ui-base.css', ['server/public/ui-base.css', 'text/css; charset=utf-8']],
  ['/theme-boot.js', ['server/public/theme-boot.js', 'text/javascript; charset=utf-8']],
  // Shared page modules keep their on-disk relative imports: drill.js and
  // study-format.js import '../public/x.js', which the browser resolves to /public/x.js.
  ['/public/card-render.js', ['server/public/card-render.js', 'text/javascript; charset=utf-8']],
  ['/public/help-panel.js', ['server/public/help-panel.js', 'text/javascript; charset=utf-8']],
  ['/public/display-settings.js', ['server/public/display-settings.js', 'text/javascript; charset=utf-8']],
  ['/public/chip-format.js', ['server/public/chip-format.js', 'text/javascript; charset=utf-8']],
  ['/font-pretendard-400.woff2', ['server/public/font-pretendard-400.woff2', 'font/woff2']],
  ['/font-pretendard-600.woff2', ['server/public/font-pretendard-600.woff2', 'font/woff2']],
  ['/font-pretendard-700.woff2', ['server/public/font-pretendard-700.woff2', 'font/woff2']],
  ['/font-space-grotesk.woff2', ['server/public/font-space-grotesk.woff2', 'font/woff2']],
  ['/study-format.js', ['server/drill-public/study-format.js', 'text/javascript; charset=utf-8']],
  ['/shared/preflop-key.js', ['shared/preflop-key.js', 'text/javascript; charset=utf-8']],
  ['/shared/reference.js', ['shared/reference.js', 'text/javascript; charset=utf-8']],
  ['/pot-odds-drill.js', ['server/drill-public/pot-odds-drill.js', 'text/javascript; charset=utf-8']],
  ['/spot-chart.js', ['server/drill-public/spot-chart.js', 'text/javascript; charset=utf-8']],
]);
// Only the study listener exposes the replay library; these resources include
// the complete browser import closure, with paths preserved for ES modules.
const REPLAY_STATIC = new Map([
  ['/replay.html', ['server/drill-public/replay.html', 'text/html; charset=utf-8']],
  ['/replay.js', ['server/drill-public/replay.js', 'text/javascript; charset=utf-8']],
  ['/replay.css', ['server/drill-public/replay.css', 'text/css; charset=utf-8']],
  ['/replay-library-state.js', ['server/drill-public/replay-library-state.js', 'text/javascript; charset=utf-8']],
  ...['replay-player', 'replay-controller', 'replay-perspective', 'replay-model', 'replay-format', 'replay-facts', 'replayer', 'seat-format'].map(name => [`/public/${name}.js`, [`server/public/${name}.js`, 'text/javascript; charset=utf-8']]),
  ['/public/replay.css', ['server/public/replay.css', 'text/css; charset=utf-8']],
  ...['decision-facts', 'poker-eval'].map(name => [`/shared/${name}.js`, [`shared/${name}.js`, 'text/javascript; charset=utf-8']]),
]);
const CLIENT_ERRORS = new Map([
  ['REPLAY_BAD_REQUEST', 400], ['REPLAY_NOT_FOUND', 404], ['REPLAY_NOT_COMPLETED', 409],
  ['REPLAY_UNAVAILABLE', 422], ['REPLAY_UNSUPPORTED', 422], ['REPLAY_LIMIT_EXCEEDED', 413], ['REPLAY_BUSY', 429],
  ['PAYLOAD_TOO_LARGE', 413], ['BAD_JSON', 400], ['USAGE', 400],
  ['INVALID_DRILL_ANSWER', 400], ['INVALID_DRILL_MODE', 400], ['INVALID_DRILL_LIMIT', 400], ['INVALID_DRILL_SELECTION', 400],
  ['UNSUPPORTED_SPOT', 400], ['UNSUPPORTED_HAND', 400],
  ['NO_SESSION', 409], ['STALE_QUESTION', 409], ['PENDING_UNRESOLVED', 409],
  ['RETEST_NOT_DUE', 409], ['UNFINISHED_RUN', 409], ['GRID_LOCKED', 409], ['INCOMPLETE_ASSESSMENT', 409], ['SOURCE_UNAVAILABLE', 409], ['SOURCE_CHANGED', 409], ['SOURCE_UNVERIFIED', 409],
  ['PARENT_IDENTITY_MISMATCH', 409], ['STUDY_IDENTITY_MISMATCH', 409], ['LOCKED', 409],
  ['UNAUTHORIZED', 401], ['FORBIDDEN', 403], ['NOT_FOUND', 404],
  ['UNSUPPORTED_PROFILE', 500], ['UNSUPPORTED_MISTAKES', 500], ['PROFILE_EVENT_INVALID', 500],
  ['PROFILE_EVENT_CONFLICT', 500], ['STUDY_DESCRIPTOR_CORRUPT', 500], ['STUDY_HISTORY_TOO_LARGE', 500],
]);

function tokensEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}
function sendJson(res, status, obj, onSent) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(body, onSent);
}
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  if (!req.headers.origin) return true;
  // Derive the origin from the actual listener, never the caller's Host header.
  return req.headers.origin === `http://127.0.0.1:${req.socket.localPort}`;
}
function readRawBody(req, res) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0, done = false;
    const finish = (value) => { if (!done) { done = true; resolve(value); } };
    const tooLarge = () => {
      sendJson(res, 413, { ok: false, code: 'PAYLOAD_TOO_LARGE' }, () => req.destroy());
      finish(null);
    };
    const len = Number(req.headers['content-length']);
    if (Number.isFinite(len) && len > MAX_BODY) { tooLarge(); return; }
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) { tooLarge(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8') || '{}'));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}
async function readJsonBody(req, res) {
  const raw = await readRawBody(req, res);
  if (raw === null) return null;
  let body;
  try { body = JSON.parse(raw); } catch { fail('BAD_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('BAD_JSON');
  return body;
}
function typedBody(body, fields, required = []) {
  if (Object.keys(body).some((key) => !Object.hasOwn(fields, key))) fail('USAGE');
  if (required.some((key) => !Object.hasOwn(body, key))) fail('USAGE');
  for (const [key, value] of Object.entries(body)) if (!fields[key](value)) fail('USAGE');
  return body;
}
const string = (max) => (value) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const START_FIELDS = {
  mode: string(40), seed: string(256), idempotencyKey: string(256), spotKey: string(128),
  handClass: string(8), assessmentId: string(128),
  // Protected start (next step): never replace a run that is not finished.
  protectUnfinished: (value) => typeof value === 'boolean',
  source: value => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'contentSha256,id,version'
    && string(64)(value.id) && string(32)(value.version) && /^[0-9a-f]{64}$/.test(value.contentSha256),
};
const ANSWER_FIELDS = {
  action: string(16), sizeBb: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9,
  sessionId: string(128), questionId: string(256),
  attemptNo: (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100,
};

/** Shared HTTP adapter. Store and hooks are trusted startup configuration only. */
export function createDrillHandler({ storeDir, token, onActivity = () => {}, beforeRequest = () => {},
  health = {}, parentRegistry, replayLibrary, replayEnabled = true, staticAssets } = {}) {
  if (typeof storeDir !== 'string' || !storeDir || typeof token !== 'string' || !token) {
    throw new TypeError('storeDir and token required');
  }
  // Privileged constructor options support mixed-version fixtures; HTTP callers
  // cannot change this closure or the library capability.
  const assets = staticAssets ?? new Map([...STATIC, ...(replayEnabled ? REPLAY_STATIC : [])]);
  let libraryPromise;
  const library = () => replayLibrary ?? (libraryPromise ??= import('./replay-library.js').then(({ createReplayLibrary }) => createReplayLibrary(storeDir)).catch(error => { libraryPromise = undefined; throw error; }));
  return async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
      const internal = url.pathname === '/internal' || url.pathname.startsWith('/internal/');
      if (api || internal) {
        const expected = internal ? parentRegistry?.controlToken : token;
        const provided = req.headers[internal ? 'x-study-control' : 'x-drill-token'];
        // No body parsing, filesystem access, or hook runs before authorization.
        if (!tokensEqual(provided, expected)) {
          sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED' }); return;
        }
        if (!sameOrigin(req)) { sendJson(res, 403, { ok: false, code: 'FORBIDDEN' }); return; }
        await beforeRequest();
        if (api) await onActivity();
      }
      if (internal) {
        if (req.method !== 'POST' || !['/internal/parent-attach', '/internal/shutdown'].includes(url.pathname)) {
          fail('NOT_FOUND');
        }
        const body = await readJsonBody(req, res); if (body === null) return;
        if (url.pathname === '/internal/parent-attach') {
          typedBody(body, { pid: (value) => Number.isSafeInteger(value) && value > 0, startTime: string(128) }, ['pid', 'startTime']);
          await parentRegistry.attach(body);
          sendJson(res, 200, { ok: true });
        } else {
          typedBody(body, { expectedInstanceId: string(128) }, ['expectedInstanceId']);
          const shutdown = await parentRegistry.shutdown(body);
          sendJson(res, 200, { ok: true }, shutdown);
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, protocolVersion: 1, ...health, capabilities: { ...health.capabilities, study: true, ...(replayEnabled ? { replayLibrary: 1 } : {}) } }); return;
      }
      if (url.pathname === '/api/replays' || url.pathname.startsWith('/api/replays/')) {
        if (!replayEnabled || req.method !== 'GET') fail('NOT_FOUND');
        const match = /^\/api\/replays\/games(?:\/([^/]+)\/hands(?:\/([^/]+))?)?$/.exec(url.pathname);
        if (!match) fail('REPLAY_BAD_REQUEST');
        const [, gameId, rawHand] = match;
        if (gameId && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(gameId)) fail('REPLAY_BAD_REQUEST');
        if (rawHand && (!/^[1-9][0-9]*$/.test(rawHand) || !Number.isSafeInteger(Number(rawHand)))) fail('REPLAY_BAD_REQUEST');
        const allowed = rawHand ? [] : ['offset', 'limit'];
        for (const key of url.searchParams.keys()) {
          if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail('REPLAY_BAD_REQUEST');
        }
        const integer = (key, fallback, min, max) => {
          const raw = url.searchParams.get(key);
          if (raw === null) return fallback;
          if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail('REPLAY_BAD_REQUEST');
          const value = Number(raw);
          if (!Number.isSafeInteger(value) || value < min || value > max) fail('REPLAY_BAD_REQUEST');
          return value;
        };
        const page = rawHand ? null : { offset: integer('offset', 0, 0, Number.MAX_SAFE_INTEGER), limit: integer('limit', gameId ? 50 : 25, 1, gameId ? 100 : 50) };
        const reader = await library();
        const value = rawHand ? await reader.readHand(gameId, Number(rawHand))
          : gameId ? await reader.listHands(gameId, page) : await reader.listGames(page);
        sendJson(res, 200, value); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/summary') {
        sendJson(res, 200, { ok: true, summary: await readStudySummary(storeDir) }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/spot') {
        await beforeRequest();
        const version = url.searchParams.get('version');
        if (version && !['1.0.0', '2.0.0', '3.0.0'].includes(version)) fail('USAGE');
        const known = version ? KNOWN_REFERENCE_SOURCES.find((row) => row.version === version) : undefined;
        sendJson(res, 200, await readSpotChart(storeDir, { spotKey: url.searchParams.get('spotKey'), source: known })); return;
      }
      if (req.method === 'GET' && ['/api/current', '/api/next'].includes(url.pathname)) {
        const read = url.pathname === '/api/current' ? readDrillSession : nextQuestion;
        sendJson(res, 200, { ok: true, ...await read(storeDir) }); return;
      }
      if (req.method === 'POST' && ['/api/start', '/api/answer', '/api/heartbeat'].includes(url.pathname)) {
        const body = await readJsonBody(req, res); if (body === null) return;
        await beforeRequest();
        if (url.pathname === '/api/start') {
          typedBody(body, START_FIELDS, ['idempotencyKey']);
          const session = await startDrill(storeDir, body);
          sendJson(res, 200, { ok: true, count: session.queue.length, sessionId: session.sessionId });
        } else if (url.pathname === '/api/answer') {
          typedBody(body, ANSWER_FIELDS);
          sendJson(res, 200, await answerQuestion(storeDir, body));
        } else { typedBody(body, {}); sendJson(res, 200, { ok: true }); }
        return;
      }
      if (api || req.method !== 'GET' || !assets.has(url.pathname)) fail('NOT_FOUND');
      const [file, mime] = assets.get(url.pathname);
      fs.readFile(path.join(ROOT, file), (error, bytes) => {
        if (error) { sendJson(res, 404, { ok: false, code: 'NOT_FOUND' }); return; }
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length,
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' });
        res.end(bytes);
      });
    } catch (error) {
      const code = CLIENT_ERRORS.has(error.code) ? error.code : 'ERROR';
      const nextAvailableAt = code === 'RETEST_NOT_DUE' && typeof error.nextAvailableAt === 'string'
        && Number.isFinite(Date.parse(error.nextAvailableAt)) ? error.nextAvailableAt : null;
      sendJson(res, CLIENT_ERRORS.get(code) ?? 500, { ok: false, code,
        ...(nextAvailableAt ? { nextAvailableAt } : {}) });
    }
  };
}

export async function startDrillServer({ port = 0, ...options } = {}) {
  const server = http.createServer(createDrillHandler(options));
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const close = () => new Promise((resolve, reject) => {
    if (!server.listening) { resolve(); return; }
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, token: options.token, close }));
  });
}
const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const storeDir = process.argv.includes('--store-dir') ? process.argv[process.argv.indexOf('--store-dir') + 1] : 'game';
  const token = randomBytes(32).toString('hex');
  const { port } = await startDrillServer({ storeDir, port: 0, token });
  process.stdout.write(`drill listening 127.0.0.1:${port} token=${token}\n`);
}
