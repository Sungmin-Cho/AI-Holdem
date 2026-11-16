// Issue #347: a logout started from the remote host lobby lands on the plain login page. The server
// ends the session, and with it the session's event streams, before the logout answers, so the
// lobby's 1 s poll and its table iframe's requests can be refused while the logout is on its way, or
// after the logout navigated but before the page left. Those refusals are the logout, not an expired
// session. These tests run the pages' own code (remote-host.js, the lobby's api() and logout handler,
// the table's 401 wrapper) in one VM realm per page, with the two pages of a tab sharing its
// sessionStorage, and force each order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (name) => fs.readFileSync(new URL(`../server/public/${name}`, import.meta.url), 'utf8');
const between = (source, from, to) => {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `has ${from} … ${to}`);
  return source.slice(start, end);
};
const lobbySource = read('lobby.js'), appSource = read('app.js');
// remote-host.js as each page's own module instance (its defaults read that page's globals).
const remoteHostScript = read('remote-host.js').replace(/^export /gm, '');
const lobbyScript = between(lobbySource, 'async function api(url, options = {}) {', 'let interruptBusy')
  + between(lobbySource, 'if (remoteHost) {\n  $("study").hidden = true;', '$("study").onclick');
const tableScript = between(appSource, 'function remoteSessionLost() {', '// A remote table opened without a session');

const TOKEN = 'a'.repeat(64);
const ORIGIN = 'https://mini.tail1234.ts.net:8898';
const EXPIRED = '/login?expired=1';

function sessionStore(entries) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const response = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// The remote listener as these pages see it: a request is answered 401 once the session has ended or
// without its token. The logout request is held until the test answers it.
function hostServer() {
  const server = { live: true, logouts: [], held: null };
  server.answer = (authorization) => (server.live && authorization === `Bearer ${TOKEN}` ? response(200, { ok: true }) : response(401, { code: 'UNAUTHORIZED' }));
  return server;
}

function page({ win, sessionStorage, server, remoteHost = true, script, nodes }) {
  const context = {
    window: win, location: win.location, sessionStorage, remoteHost, remoteHostTable: remoteHost,
    AbortSignal: { timeout: () => undefined }, console,
    $: (id) => (nodes[id] ??= { id, hidden: true, textContent: '', onclick: null }),
    fetch: async (url, init = {}) => {
      const authorization = init.headers?.authorization;
      if (url !== '/api/host/logout') return server.answer(authorization);
      server.logouts.push({ method: init.method, authorization });
      server.held = deferred();
      return server.held.promise;
    },
    // app-transport's appFetch reads the tab's token when it sends.
    transportFetch: async () => server.answer(`Bearer ${sessionStorage.getItem('holdem-app-token') ?? ''}`),
  };
  vm.createContext(context);
  vm.runInContext(`${remoteHostScript}\n${script}\nglobalThis.exposed = { api: typeof api === 'function' ? api : null, appFetch: typeof appFetch === 'function' ? appFetch : null };`, context);
  return context.exposed;
}

// One browser tab on the remote host listener: the lobby as its top page and, inside it, the table
// iframe of the game in progress (same origin). `standalone` opens the table as the tab's top page.
function remoteTab({ remoteHost = true } = {}) {
  const navigations = [];
  const sessionStorage = sessionStore({ 'holdem-app-token': TOKEN });
  const server = hostServer();
  const location = (name, pathname) => ({ origin: ORIGIN, hostname: remoteHost ? 'mini.tail1234.ts.net' : '127.0.0.1', pathname, search: '',
    replace: (url) => navigations.push(name === 'top' ? url : `${name}:${url}`) });
  const top = { location: location('top', '/') };
  top.top = top;
  const frame = { top, location: location('frame', '/table') };
  const nodes = {};
  const lobby = page({ win: top, sessionStorage, server, remoteHost, script: lobbyScript, nodes });
  const table = page({ win: frame, sessionStorage, server, remoteHost, script: tableScript, nodes: {} });
  const standaloneWin = { location: location('top', '/table') };
  standaloneWin.top = standaloneWin;
  const standalone = () => page({ win: standaloneWin, sessionStorage, server, remoteHost, script: tableScript, nodes: {} });
  return {
    navigations, sessionStorage, server, nodes, table, standalone,
    token: () => sessionStorage.getItem('holdem-app-token'),
    // The lobby's poll (refresh → api) and its table's request; a refused poll rejects, as api() does.
    poll: () => lobby.api('/api/app').then(() => 'ok', (error) => error.status),
    tableRequest: () => table.appFetch('state').then((res) => res.status),
    clickLogout: () => nodes.logout.onclick(),
  };
}

test('a logout lands on the plain login page however refused requests interleave with it', async () => {
  // Refused while the logout is on its way: the server has ended the session, the answer is not back.
  const during = remoteTab();
  assert.equal(during.nodes.logout.hidden, false, 'the remote lobby offers the logout');
  const clicked = during.clickLogout();
  assert.deepEqual(during.server.logouts, [{ method: 'POST', authorization: `Bearer ${TOKEN}` }]);
  during.server.live = false;
  assert.equal(await during.poll(), 401);
  assert.equal(await during.tableRequest(), 401);
  during.server.held.resolve(response(200, { ok: true }));
  await clicked;
  assert.deepEqual(during.navigations, ['/login'], 'no request the logout refused turns it into an expired login');
  assert.equal(during.token(), null);

  // Refused after the logout navigated, before the page has left (a poll or a stream reconnect in flight).
  const after = remoteTab();
  const click = after.clickLogout();
  after.server.live = false;
  after.server.held.resolve(response(200, { ok: true }));
  await click;
  assert.equal(await after.tableRequest(), 401);
  assert.equal(await after.poll(), 401);
  assert.deepEqual(after.navigations, ['/login']);
  assert.equal(after.token(), null);

  // The logout request fails or times out: the tab still signs out to the plain login page.
  const failed = remoteTab();
  const attempt = failed.clickLogout();
  failed.server.live = false;
  failed.server.held.reject(new DOMException('The operation timed out.', 'TimeoutError'));
  await attempt;
  assert.equal(await failed.tableRequest(), 401);
  assert.equal(await failed.poll(), 401);
  assert.deepEqual(failed.navigations, ['/login']);
  assert.equal(failed.token(), null);
});

test('a session that ended without this tab logging out still returns to login as expired', async () => {
  // The lobby's own request (another device logged out, the session expired, a new password).
  const lobby = remoteTab();
  lobby.server.live = false;
  assert.equal(await lobby.poll(), 401);
  assert.deepEqual(lobby.navigations, [EXPIRED]);
  assert.equal(lobby.token(), null);

  // The table inside the lobby moves the whole tab.
  const framed = remoteTab();
  framed.server.live = false;
  assert.equal(await framed.tableRequest(), 401);
  assert.deepEqual(framed.navigations, [EXPIRED]);
  assert.equal(framed.token(), null);

  // A table opened on its own.
  const tab = remoteTab();
  const standalone = tab.standalone();
  tab.server.live = false;
  assert.equal(await standalone.appFetch('state').then((res) => res.status), 401);
  assert.deepEqual(tab.navigations, [EXPIRED]);
  assert.equal(tab.token(), null);
});

test('the local lobby keeps its service-token flow on a refused request', async () => {
  const local = remoteTab({ remoteHost: false });
  assert.equal(local.nodes.logout, undefined, 'no logout on the loopback lobby');
  local.server.live = false;
  assert.equal(await local.poll(), 401);
  assert.equal(await local.tableRequest(), 401);
  assert.deepEqual(local.navigations, []);
  assert.equal(local.token(), TOKEN);
});
