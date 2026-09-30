import { JEV_CONFIG } from '../shared/opponent-runtime.js';
import { jevError, jevCriteria, JEV_INSTRUCTIONS, validateJevAnswer } from './jev-player.js';

export async function preflightJev({ env = process.env, loadSdk = () => import('@typesafe-ai/sdk') } = {}) {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw jevError('JEV_API_KEY_MISSING', true);
  let sdk;
  try { sdk = await loadSdk(); } catch { throw jevError('JEV_SDK_UNAVAILABLE', true); }
  if (typeof sdk.TypeSafeClient !== 'function' || typeof sdk.choice !== 'function') throw jevError('JEV_SDK_UNAVAILABLE', true);
  return { sdk, apiKey };
}
export function safeJevError(error) {
  const statuses = { 401: 'JEV_AUTH_FAILED', 403: 'JEV_AUTH_FAILED', 422: 'JEV_REQUEST_REJECTED',
    429: 'JEV_RATE_LIMITED', 529: 'JEV_SERVICE_UNAVAILABLE' };
  const code = statuses[error?.status] ?? (error?.status >= 500 ? 'JEV_SERVICE_UNAVAILABLE'
    : error?.name === 'APITimeoutError' ? 'JEV_TIMEOUT' : 'JEV_NETWORK_ERROR');
  return jevError(code, true);
}

export function createJevRuntime({ env = process.env, loadSdk, fetch: fetchImpl = globalThis.fetch,
  client: injectedClient, graceMs = 2000, onLateSettlement = () => {} } = {}) {
  let phase = 'idle', active = null, disposing = false;
  async function decide({ state, candidates, signal, timeoutMs }) {
    if (phase !== 'idle') throw jevError('JEV_RUNTIME_UNAVAILABLE');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw jevError('JEV_INPUT_INVALID');
    phase = 'active';
    const controller = new AbortController();
    let revoked = false, timedOut = false, graceTimer, deadline, abortListener;
    let rejectAbort;
    const abortFailure = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = () => {
      if (revoked) return;
      revoked = true;
      controller.abort();
      graceTimer = setTimeout(() => {
        phase = 'closure_unconfirmed';
        rejectAbort(Object.assign(jevError('JEV_REQUEST_CLOSE_UNCONFIRMED'), { closeConfirmed: false }));
      }, graceMs);
    };
    const record = { abort, settled: null };
    active = record;
    const operation = (async () => {
      const { sdk, apiKey } = injectedClient ? { sdk: null } : await preflightJev({ env, ...(loadSdk ? { loadSdk } : {}) });
      if (revoked || signal?.aborted) throw jevError('INTERRUPTED', true);
      const guardedFetch = (url, options) => {
        if (new URL(typeof url === 'string' || url instanceof URL ? url : url.url).origin !== 'https://api.typesafe.ai') {
          throw jevError('JEV_REQUEST_REJECTED', true);
        }
        return fetchImpl(url, { ...options, redirect: 'error' });
      };
      const client = injectedClient ?? new sdk.TypeSafeClient({ apiKey, baseURL: 'https://api.typesafe.ai',
        defaultModel: JEV_CONFIG.model, logLevel: 'off',
        logger: { debug() {}, info() {}, warn() {}, error() {} }, fetch: guardedFetch,
        timeout: timeoutMs, retry: { maxRetries: 0 } });
      const question = sdk ? sdk.choice(JEV_INSTRUCTIONS, jevCriteria(candidates))
        : { type: 'choice', instructions: JEV_INSTRUCTIONS, criteria: jevCriteria(candidates) };
      let response;
      try {
        response = await client.systemOne({ model: JEV_CONFIG.model, state, questions: { action: question } },
          { signal: controller.signal, timeout: timeoutMs, retry: { maxRetries: 0 } });
      } catch (error) { throw safeJevError(error); }
      if (revoked) throw jevError(timedOut ? 'JEV_TIMEOUT' : 'INTERRUPTED', true);
      return validateJevAnswer(response, candidates);
    })();
    // Settlement is observed separately from the revoked response continuation.
    record.settled = operation.then(() => {}, () => {}).then(() => {
      clearTimeout(graceTimer);
      const late = phase === 'closure_unconfirmed';
      if (active === record) { active = null; phase = disposing ? 'disposed' : 'idle'; }
      if (late) Promise.resolve().then(onLateSettlement).catch(() => {});
    });
    abortListener = abort;
    signal?.addEventListener('abort', abortListener, { once: true });
    if (signal?.aborted) abort();
    deadline = setTimeout(() => { timedOut = true; abort(); }, timeoutMs);
    try {
      const result = await Promise.race([operation, abortFailure]);
      if (revoked) throw jevError(timedOut ? 'JEV_TIMEOUT' : 'INTERRUPTED', true);
      return result;
    } catch (error) {
      if (phase === 'closure_unconfirmed') throw error;
      await record.settled;
      if (revoked) throw Object.assign(jevError(timedOut ? 'JEV_TIMEOUT' : 'INTERRUPTED', true), { closeConfirmed: true });
      throw error;
    } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abortListener); }
  }
  async function dispose() {
    disposing = true;
    if (!active) { phase = 'disposed'; return { closeConfirmed: true }; }
    const record = active;
    if (phase !== 'closure_unconfirmed') phase = 'disposing';
    record.abort();
    let timer;
    try {
      await Promise.race([record.settled, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(jevError('JEV_REQUEST_CLOSE_UNCONFIRMED'), { closeConfirmed: false })), graceMs);
      })]);
    } finally { clearTimeout(timer); }
    return { closeConfirmed: true };
  }
  return { decide, dispose, get phase() { return phase; } };
}
