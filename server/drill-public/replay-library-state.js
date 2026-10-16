/** Selection generations own cancellation, including errors from older requests.
 * Hand numbers are scoped to the game; each selection discards its old player. */
export function createReplaySelection({ api, onState = () => {}, disposePlayer = () => {} }) {
  let generation = 0, pending = null, disposed = false;
  let state = { kind: 'idle' };
  const emit = value => { state = value; onState(value); return value; };
  async function load(path, context) {
    if (disposed) return;
    const ticket = ++generation;
    pending?.abort(); pending = new AbortController();
    disposePlayer(); emit({ kind: 'loading', ...context });
    try {
      const value = await api(path, { signal: pending.signal });
      if (disposed || ticket !== generation) return;
      if (value?.ok !== true) return emit({ kind: 'error', ...context, code: value?.code ?? 'CONNECTION' });
      return emit({ kind: 'ready', ...context, value });
    } catch (error) {
      if (disposed || ticket !== generation) return;
      return emit({ kind: 'error', ...context, code: error.name === 'AbortError' ? 'CONNECTION' : error.code ?? 'CONNECTION' });
    }
  }
  return {
    state: () => state,
    games: (offset = 0, limit = 25) => load(`/api/replays/games?offset=${offset}&limit=${limit}`, { page: 'games', offset, limit }),
    hands: (gameId, offset = 0, limit = 50) => load(`/api/replays/games/${encodeURIComponent(gameId)}/hands?offset=${offset}&limit=${limit}`, { page: 'hands', gameId, offset, limit }),
    hand: (gameId, handNo, offset = 0, limit = 50) => load(`/api/replays/games/${encodeURIComponent(gameId)}/hands/${handNo}`, { page: 'hand', gameId, handNo, offset, limit }),
    dispose() { disposed = true; generation++; pending?.abort(); disposePlayer(); },
  };
}
export function readReplayEntry(location) {
  const url = new URL(location.href);
  const token = new URLSearchParams(url.hash.slice(1)).get('token') ?? url.searchParams.get('token') ?? '';
  url.searchParams.delete('token');
  url.hash = token ? new URLSearchParams({ token }).toString() : '';
  return { token, cleanUrl: url.href, studyUrl: `/drill.html#${new URLSearchParams({ token })}` };
}
export function startReplayHeartbeat({ api, visible, setInterval: every = globalThis.setInterval, clearInterval: stop = globalThis.clearInterval, onError = () => {} }) {
  let disposed = false, busy = false;
  const id = every(async () => {
    if (disposed || busy || !visible()) return;
    busy = true;
    try { const result = await api('/api/heartbeat', { method: 'POST', body: {} }); if (!disposed && result?.ok !== true) onError(result?.code ?? 'CONNECTION'); }
    catch { if (!disposed) onError('CONNECTION'); }
    finally { busy = false; }
  }, 30000);
  return () => { disposed = true; stop(id); };
}

/** Portable equivalent of AbortSignal.any, with listeners released on success. */
export function createAbortScope(signals) {
  const controller = new AbortController(), listeners = [];
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, {once:true});
    listeners.push([signal,abort]);
  }
  return {signal:controller.signal, dispose(){for(const [signal,abort] of listeners) signal.removeEventListener('abort',abort);}};
}
