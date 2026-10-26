/** Phone layouts (mobile table design §1). The table page switches to an app
 * shell on a phone held upright (P) or sideways (L); wide desktops and the
 * scrolling tablet layout keep their own rules. table-mobile.css uses the same
 * two queries (test/layout-mode.test.js compares the strings). */
export const PHONE_LANDSCAPE_QUERY = '(orientation: landscape) and (max-height: 500px) and (max-width: 1023px)';
export const PHONE_PORTRAIT_QUERY = '(max-width: 600px) and (orientation: portrait), (max-width: 600px) and (min-height: 501px)';
export const COMPACT_QUERY = `${PHONE_PORTRAIT_QUERY}, ${PHONE_LANDSCAPE_QUERY}`;

function media(query, win) {
  try { return win?.matchMedia?.(query) ?? null; } catch { return null; }
}

/** True on either phone layout; false where matchMedia is unavailable. */
export function compactLayout(win = globalThis) {
  return media(COMPACT_QUERY, win)?.matches === true;
}

/** Calls `listener(compact)` whenever the phone/desktop boundary is crossed. */
export function onCompactChange(listener, win = globalThis) {
  const list = media(COMPACT_QUERY, win);
  if (!list) return () => {};
  const handler = () => listener(list.matches);
  list.addEventListener?.('change', handler);
  return () => list.removeEventListener?.('change', handler);
}
