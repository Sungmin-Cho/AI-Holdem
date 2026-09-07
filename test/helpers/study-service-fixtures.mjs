import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { startDrillServer } from '../../tools/drill-server.js';
import { createOwnedTempDir, registerOwnedServer, registerOwnedProcess } from './owned-fixtures.mjs';
import { startDrill, answerQuestion } from '../../tools/drill-cli.js';
import { createProfileStore } from '../../tools/training-stores.js';
import { CANONICAL_REFERENCE_SOURCE } from '../../shared/reference.js';

// On Windows the service re-proves its boundaries before answering, and each
// proof is a PowerShell child, so a request costs seconds and the owned state
// converges in tens of seconds. These budgets follow the product's own ceiling.
export const WIN32 = process.platform === 'win32';
export const REQUEST_MS = WIN32 ? 30_000 : 2000;
export const CONVERGE_MS = WIN32 ? 90_000 : 3500;

export const descriptorPath = (storeDir) => path.join(storeDir, '.training', 'study-service.json');
export const lockPath = (storeDir) => path.join(storeDir, '.training', 'study.lock.d');
export const service = () => import('../../tools/study-service.js');
export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const source = CANONICAL_REFERENCE_SOURCE;

export async function request(port, token, route, { body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { ...(token ? { 'x-drill-token': token } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(REQUEST_MS),
  });
  return { status: response.status, body: await response.json() };
}

export async function standalone(t) {
  const storeDir = createOwnedTempDir('holdem-study-http');
  const server = await startDrillServer({ storeDir, token: 'study-http' });
  registerOwnedServer(server.server);
  t.after(() => server.close());
  return { storeDir, ...server };
}

export async function launch(t, options = {}, storeDir = createOwnedTempDir('holdem-study-child')) {
  const api = await service();
  const children = [];
  const handle = await api.ensureStudyService(storeDir, {
    ...options, onChild(child) { child.ref(); children.push(registerOwnedProcess(child, 'study service')); },
  });
  t.after(async () => {
    try { await api.stopStudyService(storeDir, { expectedInstanceId: handle.instanceId }); }
    catch (error) {
      if (error.code === 'STUDY_IDENTITY_MISMATCH') {
        assert.notEqual((await api.inspectStudyService(storeDir)).instanceId, handle.instanceId);
      } else if (error.code !== 'STUDY_DESCRIPTOR_CORRUPT') throw error;
    }
  });
  return { storeDir, handle, children, api, token: new URL(handle.studyUrl).hash.slice(7) };
}

export async function until(predicate, timeout = CONVERGE_MS) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() >= deadline) assert.fail('owned state did not converge before deadline');
    await wait(25);
  }
}

export function readDescriptor(storeDir) { return JSON.parse(fs.readFileSync(descriptorPath(storeDir), 'utf8')); }

// An unauthenticated body remains deliberately unfinished: authorization must
// produce a response without waiting for JSON, touching files, or draining it.
export function unfinishedRequest(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: route,
      headers: { 'content-length': '99999999', ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, body: JSON.parse(text) }); });
    });
    req.setTimeout(1500, () => req.destroy(new Error('authorization waited for request body')));
    req.on('error', reject);
    req.flushHeaders();
  });
}

export async function assessmentEvent(storeDir) {
  const run = await startDrill(storeDir, { mode: 'assessment', idempotencyKey: randomUUID(),
    spotKey: '6max-100bb-btn-rfi-unopened', handClass: 'AJo' });
  await answerQuestion(storeDir, { action: 'fold', sessionId: run.sessionId, questionId: run.queue[0].questionId, attemptNo: 0 });
  return (await createProfileStore(storeDir).readEventSnapshot())[0];
}

export function replaceEvents(storeDir, events) {
  fs.writeFileSync(path.join(storeDir, '.training', 'profile-events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}
