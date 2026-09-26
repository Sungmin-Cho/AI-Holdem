/** Parent side of the lobby <-> table iframe bridge (design §4 D4.1).
 *
 * The table document owns hand, blinds and connection state; the parent header
 * shows them. Messages flow one way (table -> parent) and carry public context
 * only. The parent announces itself with `holdem:shell-ready` on every iframe
 * load so the table can hide its own top bar; a table that never hears it keeps
 * that bar (legacy relay, parents without a receiver).
 *
 * A context is accepted only when it comes from this origin, from the current
 * iframe window, matches the allowlisted schema and names the game the parent
 * has selected. Changing the iframe source clears the header immediately so a
 * late message from the previous document cannot leak into the next game. */

const ID = /^[0-9a-f-]{1,64}$/;
const EPOCH = /^[0-9a-f]{1,128}$/;
const CONN = new Set(['on', 'retry', 'ended']);
const MODES = new Set(['cash-training', 'tournament']);
const int = (value, min) => (Number.isSafeInteger(value) && value >= min ? value : null);

/** Returns a clean copy of a `holdem:context` message, or null. Unknown fields
 * are dropped; malformed optional fields become null. */
export function sanitizeContext(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.type !== 'holdem:context' || data.v !== 1) return null;
  if (typeof data.gameId !== 'string' || !ID.test(data.gameId)) return null;
  if (typeof data.gameEpoch !== 'string' || !EPOCH.test(data.gameEpoch)) return null;
  if (!CONN.has(data.conn)) return null;
  const blinds = Array.isArray(data.blinds) && data.blinds.length === 2
    && data.blinds.every((value) => int(value, 0) !== null) ? [data.blinds[0], data.blinds[1]] : null;
  return {
    gameId: data.gameId,
    gameEpoch: data.gameEpoch,
    handNo: int(data.handNo, 0),
    handLimit: int(data.handLimit, 1),
    level: int(data.level, 1),
    blinds,
    levelLeft: int(data.levelLeft, 0),
    sessionNet: Number.isSafeInteger(data.sessionNet) ? data.sessionNet : null,
    conn: data.conn,
    retryCount: int(data.retryCount, 0) ?? 0,
    gameOver: data.gameOver === true,
    handInProgress: data.handInProgress === true,
    mode: MODES.has(data.mode) ? data.mode : null,
  };
}

export function createShellBridge({ win = globalThis.window, frame, identity, onContext = () => {} }) {
  let context = null;
  const reset = () => {
    if (context === null) return;
    context = null;
    onContext(null);
  };
  const announce = () => {
    const id = identity();
    const target = frame.contentWindow;
    if (!id?.gameId || !id.gameEpoch || !target) return false;
    try {
      target.postMessage({ type: 'holdem:shell-ready', v: 1, gameId: id.gameId, gameEpoch: id.gameEpoch }, win.location.origin);
      return true;
    } catch {
      return false;
    }
  };
  const onMessage = (event) => {
    if (event.origin !== win.location.origin) return;
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    // A table that started before the parent listened asks again, naming its own
    // game: a document of the previous game must never learn the next one.
    if (event.data?.type === 'holdem:shell-hello' && event.data.v === 1) {
      const id = identity();
      if (id && event.data.gameId === id.gameId && event.data.gameEpoch === id.gameEpoch) announce();
      return;
    }
    const clean = sanitizeContext(event.data);
    if (!clean) return;
    const id = identity();
    if (!id || clean.gameId !== id.gameId || clean.gameEpoch !== id.gameEpoch) return;
    context = clean;
    onContext(clean);
  };
  const onLoad = () => { reset(); announce(); };
  win.addEventListener('message', onMessage);
  frame.addEventListener('load', onLoad);
  let observer = null;
  if (typeof win.MutationObserver === 'function') {
    observer = new win.MutationObserver(reset);
    observer.observe(frame, { attributes: true, attributeFilter: ['src'] });
  }
  return {
    reset,
    announce,
    get context() { return context; },
    dispose() {
      win.removeEventListener('message', onMessage);
      frame.removeEventListener('load', onLoad);
      observer?.disconnect();
    },
  };
}
