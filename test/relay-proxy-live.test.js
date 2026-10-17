import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createRelayAccess } from '../tools/relay-access.js';
import { createGameLoop } from '../tools/game-loop.js';
import { createListenerOwnedBy } from '../tools/listener-ownership.js';
import { serverProcessStartTime } from '../engine/state.js';
import { createOwnedTempDir, registerOwnedProcess } from './helpers/owned-fixtures.mjs';
import { fakeRelay, makeSession, startProxyApp, SESSION_TOKEN } from './helpers/relay-proxy-fixture.js';

const TIMEOUT = process.platform === 'win32' ? 300000 : 30000;

// Production adapters: the real listener-ownership reader and the real owned start-time
// reader, with this test process as the relay (it owns the listener it serves).
const lsofAvailable = process.platform === 'win32' || ['/usr/sbin/lsof', '/usr/bin/lsof'].some((file) => fs.existsSync(file));
test('#270 live OS seams: the real listener and process identity readers authorize only the true owner',
  { timeout: TIMEOUT, skip: !lsofAvailable && 'lsof is not available' }, async (t) => {
    const relay = await fakeRelay();
    t.after(() => relay.close());
    const startTime = serverProcessStartTime(process.pid);
    assert.match(startTime ?? '', /^(utc-v1|win32-v1):/);
    const session = makeSession(createOwnedTempDir('relay-proxy-live'), relay.port, { lock: { serverStartTime: startTime } });
    const state = { binding: { pid: process.pid, startTime, port: relay.port, sessionToken: SESSION_TOKEN } };
    const access = createRelayAccess({
      lockPath: session.lockPath, statePath: session.statePath, managed: true,
      binding: () => state.binding, isStopping: () => false,
      startTimeOf: serverProcessStartTime, listenerOwnedBy: createListenerOwnedBy({ timeoutMs: 5000 }), probeMs: 3000,
    });
    const loop = { serverPid: process.pid, captureRelayAccess: () => access.capture() };
    const h = await startProxyApp(t, { loop, relay, session });
    const ok = await h.hostGet('snapshot');
    assert.equal(ok.status, 200);
    assert.equal(relay.seen.requests.length, 1);
    // Another live process that does not own the listener must not be authorized for the port.
    const foreign = registerOwnedProcess(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }), 'relay-foreign-process');
    await once(foreign, 'spawn');
    const foreignStart = serverProcessStartTime(foreign.pid);
    assert.match(foreignStart ?? '', /^(utc-v1|win32-v1):/, 'the negative ownership check must not silently disappear');
    state.binding = { pid: foreign.pid, startTime: foreignStart, port: relay.port, sessionToken: SESSION_TOKEN };
    session.rewriteLock({ serverPid: foreign.pid, serverStartTime: foreignStart });
    const denied = await h.hostGet('snapshot');
    assert.equal(denied.status, 503);
    assert.equal(relay.seen.requests.length, 1, 'a live process that does not own the listener got the token');
    assert.equal(relay.seen.connections, 1, 'the denied ownership request opened no connection');
  });

test('#270 live OS cost: every request observes a separate relay process without caching',
  { timeout: TIMEOUT, skip: !lsofAvailable && 'lsof is not available' }, async t => {
    const child = registerOwnedProcess(spawn(process.execPath, ['--input-type=module', '-e', `
      import http from 'node:http';
      const server = http.createServer((req, res) => {
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({ok:true}));
      });
      server.listen(0, '127.0.0.1', () => process.send({port:server.address().port}));
      process.on('disconnect', () => server.close(() => process.exit(0)));
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }), 'relay-cost-process');
    const [{ port }] = await once(child, 'message');
    const startTime = serverProcessStartTime(child.pid);
    assert.match(startTime ?? '', /^(utc-v1|win32-v1):/);
    const session = makeSession(createOwnedTempDir('relay-proxy-cost'), port, { lock: { serverPid: child.pid, serverStartTime: startTime } });
    const binding = { pid: child.pid, port, startTime, sessionToken: SESSION_TOKEN };
    const listener = createListenerOwnedBy({ timeoutMs: 5000 });
    const identityMs = [], listenerMs = [], roundTripMs = [];
    const access = createRelayAccess({
      lockPath: session.lockPath, statePath: session.statePath, managed: true,
      binding: () => binding, isStopping: () => false, probeMs: 3000,
      startTimeOf(pid) {
        const begin = performance.now();
        try { return serverProcessStartTime(pid); } finally { identityMs.push(performance.now() - begin); }
      },
      async listenerOwnedBy(pid, targetPort, call) {
        const begin = performance.now();
        try { return await listener(pid, targetPort, call); } finally { listenerMs.push(performance.now() - begin); }
      },
    });
    const loop = { serverPid: child.pid, captureRelayAccess: () => access.capture() };
    const h = await startProxyApp(t, { loop, session });
    for (let i = 0; i < 3; i++) {
      const begin = performance.now();
      const response = await h.hostGet('snapshot');
      assert.equal(response.status, 200);
      await response.arrayBuffer();
      roundTripMs.push(performance.now() - begin);
    }
    assert.equal(identityMs.length, 3, 'child identity is freshly read for every request, including Windows');
    assert.equal(listenerMs.length, 3);
    t.diagnostic(JSON.stringify({ kind: 'relay_proxy_os_cost', platform: process.platform, node: process.version,
      samples: 3, identityMs, listenerMs, roundTripMs, listenerBudgetMs: 3000 }));
  });

test('#270 the production loop exposes the capability and refuses without a verified binding', { timeout: TIMEOUT }, async () => {
  const gameDir = createOwnedTempDir('relay-proxy-loop');
  const loop = createGameLoop({ gameDir, resolver: async () => ({ player: null, upper: null, notices: [] }), opts: { port: 0, waitMs: 0 } });
  assert.equal(typeof loop.captureRelayAccess, 'function');
  let sent = false;
  const error = await loop.captureRelayAccess().use({ gameEpoch: 'x', revalidate() {} }, () => { sent = true; }).then(() => null, (e) => e);
  assert.equal(error?.code, 'RELAY_UNAVAILABLE');
  assert.equal(error.reason, 'NO_BINDING');
  assert.equal(sent, false);
});
