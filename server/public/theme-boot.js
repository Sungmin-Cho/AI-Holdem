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
  // display-settings.js lists here the choices this page could not save.
  var local = function (name) {
    return (' ' + (root.getAttribute('data-display-local') || '') + ' ').indexOf(' ' + name + ' ') >= 0;
  };
  var unmark = function (name) {
    var rest = (root.getAttribute('data-display-local') || '').split(' ').filter(function (item) { return item && item !== name; });
    set('data-display-local', rest.length ? rest.join(' ') : null);
  };
  var applyOne = function (name) {
    if (local(name)) return;
    if (name === 'theme') { var theme = read('holdem.theme.v1'); set('data-theme', theme === 'a' || theme === 'c' ? theme : null); }
    if (name === 'deck') set('data-deck', read('holdem.deck-colors.v1') === '2' ? '2' : null);
    if (name === 'motion') set('data-motion', read('holdem.motion.v1') === 'reduce' ? 'reduce' : null);
  };
  var KEYS = { 'holdem.theme.v1': 'theme', 'holdem.deck-colors.v1': 'deck', 'holdem.motion.v1': 'motion' };
  var apply = function () { applyOne('theme'); applyOne('deck'); applyOne('motion'); };
  apply();
  try {
    globalThis.addEventListener('storage', function (event) {
      // A choice saved in another document replaces this page's unsaved one;
      // unrelated keys never touch what this page shows.
      if (event.key && KEYS[event.key]) { unmark(KEYS[event.key]); applyOne(KEYS[event.key]); }
      else if (!event.key) apply();
    });
  } catch (error) { /* no storage events: preferences apply on next load */ }
}());
