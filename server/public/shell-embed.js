/** Table (child) side of the lobby shell bridge (design §4 D4.1).
 *
 * An embedded table asks its parent with `holdem:shell-hello` and waits for
 * `holdem:shell-ready` naming its own game. Only then does it hide its own top
 * bar (`onReady`) and start sending public context. A parent that never answers
 * (legacy relay, the join page before its redesign) leaves the table exactly as
 * it was. Messages go to this origin only and carry no cards, decisions or
 * tokens; the parent validates them again. */

const FIELDS = ['handNo', 'handLimit', 'level', 'blinds', 'levelLeft', 'sessionNet', 'conn', 'retryCount', 'gameOver', 'handInProgress', 'mode'];

export function createShellEmbed({
  win = globalThis.window,
  gameId,
  gameEpoch,
  onReady = () => {},
  throttleMs = 250,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  const parent = win?.parent;
  const embedded = Boolean(gameId && gameEpoch && parent && parent !== win);
  let ready = false;
  let pending = null;
  let lastSent = null;
  let timer = null;
  let lastFlushAt = -Infinity;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  const flush = () => {
    timer = null;
    if (!ready || !pending) return;
    const message = { type: 'holdem:context', v: 1, gameId, gameEpoch };
    for (const key of FIELDS) if (pending[key] !== undefined) message[key] = pending[key];
    const key = JSON.stringify(message);
    if (key === lastSent) return;
    lastSent = key;
    lastFlushAt = now();
    try { parent.postMessage(message, win.location.origin); } catch { /* parent gone */ }
  };
  const queue = () => {
    if (!ready || timer !== null) return;
    const wait = Math.max(0, throttleMs - (now() - lastFlushAt));
    timer = schedule(flush, wait);
  };
  const onMessage = (event) => {
    if (event.origin !== win.location.origin || event.source !== parent) return;
    const data = event.data;
    if (!data || data.type !== 'holdem:shell-ready' || data.v !== 1) return;
    if (data.gameId !== gameId || data.gameEpoch !== gameEpoch) return;
    if (ready) return;
    ready = true;
    onReady();
    flush();
  };

  if (embedded) {
    win.addEventListener('message', onMessage);
    try { parent.postMessage({ type: 'holdem:shell-hello', v: 1, gameId, gameEpoch }, win.location.origin); } catch { /* parent gone */ }
  }
  return {
    get embedded() { return embedded; },
    get ready() { return ready; },
    /** Latest public context; sent at most every `throttleMs`, only when changed. */
    send(context) {
      if (!embedded || !context || typeof context !== 'object') return;
      pending = context;
      queue();
    },
    dispose() {
      if (timer !== null) cancel(timer);
      timer = null;
      if (embedded) win.removeEventListener('message', onMessage);
    },
  };
}
