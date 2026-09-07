/** All amounts are total committed chips on this street (raise-to). */
export function clampRaiseTo(value, legal) {
  const max = Math.max(0, Number(legal.maxRaiseTo) || 0);
  const min = Math.min(max, Math.max(0, Number(legal.minRaiseTo) || 0));
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

export function potRaiseTo(legal, actorBet, fraction) {
  return clampRaiseTo(actorBet + legal.callAmount + fraction * (legal.potTotal + legal.callAmount), legal);
}

export function bbRaiseTo(legal, bb, multiple) {
  const amount = Number(bb) * multiple;
  return legal.canRaise && legal.minRaiseTo <= amount && amount <= legal.maxRaiseTo
    && Number.isSafeInteger(amount) ? amount : null;
}

export function reviewDismissalAfterUpdate(dismissed) {
  return dismissed === true;
}

export function studyLink(value, selectors = {}) {
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535
      || url.username || url.password || url.pathname !== '/' || url.search
      || [...fragment.keys()].length !== 1 || !/^[0-9a-f]{64}$/.test(fragment.get('token') ?? '')) return null;
    for (const key of ['mode', 'spotKey', 'handClass']) {
      if (selectors[key] != null && /^[a-zA-Z0-9-]{1,100}$/.test(selectors[key])) url.searchParams.set(key, selectors[key]);
    }
    return url.href;
  } catch { return null; }
}
