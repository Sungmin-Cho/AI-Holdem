// Applies per-browser display preferences (theme, deck colours, motion) to
// <html> before first paint. Loaded as a classic render-blocking script at the
// top of <head>; inline scripts are not allowed by the app CSP. Storage can be
// unavailable (private mode, blocked site data): every access is guarded and
// the defaults (theme B, four-colour deck, system motion) apply.
(function applyDisplayPreferences() {
  if (typeof document === 'undefined') return;
  var root = document.documentElement;
  var read = function (key) {
    try { return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null; } catch (error) { return null; }
  };
  var set = function (name, value) {
    if (value) root.setAttribute(name, value); else root.removeAttribute(name);
  };
  var apply = function () {
    var theme = read('holdem.theme.v1');
    set('data-theme', theme === 'a' || theme === 'c' ? theme : null);
    set('data-deck', read('holdem.deck-colors.v1') === '2' ? '2' : null);
    set('data-motion', read('holdem.motion.v1') === 'reduce' ? 'reduce' : null);
  };
  apply();
  try {
    globalThis.addEventListener('storage', function (event) {
      if (!event.key || event.key.indexOf('holdem.') === 0) apply();
    });
  } catch (error) { /* no storage events: preferences apply on next load */ }
}());
