// Remote host journey: a browser on another device signs in over HTTPS with the host password,
// plays from the remote lobby through the shared relay proxy, loses its session and signs in
// again, and logs out. The participant listener never offers the login page.
import { finishJourney, selfTestJourney, cleanupJourney } from './journey-exit.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setHostPassword, startAppService } from '../../tools/app-service.js';
import { createBrowserWorkspace, runOwnedCommand, hashTree } from '../helpers/learning-browser-fixture.mjs';

export const requiredJourneyChecks = [
  'login-redirect', 'wrong-password', 'login-lobby', 'remote-play', 'study-link-hidden',
  'expired-relogin', 'standalone-table-relogin', 'logout', 'participant-no-login', 'real-user-store-unchanged', 'owned-cleanup',
];
const FIXTURES = fileURLToPath(new URL('../fixtures/remote-host-tls/', import.meta.url));
const CERT = path.join(FIXTURES, 'a.crt'), KEY = path.join(FIXTURES, 'a.key');
const PASSWORD = '원격 호스트 저니 비밀번호';

export async function runRemoteHostJourney(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const workspace = createBrowserWorkspace(), root = workspace.root;
  const userStore = path.resolve('game'), before = hashTree(userStore), session = `remote-host-${randomUUID()}`;
  const checks = [];
  let app, failure;
  const browser = async (args) => {
    const r = await runOwnedCommand('npx', ['--yes', '--prefer-offline', 'agent-browser@0.36.0', '--session', session, '--ignore-https-errors', '--json', ...args], { timeoutMs: 45000 });
    assert.equal(r.exitCode, 0, `${args[0]} (timeout=${r.timedOut}, signal=${r.signal}): ${r.stderr} ${r.stdout.replace(/[0-9a-f]{64}/g, '[redacted]')}`);
    const result = JSON.parse(r.stdout);
    assert.notEqual(result.success, false, JSON.stringify(result));
    return result.data;
  };
  const evaluate = async (expr) => { const data = await browser(['eval', expr]); return data?.result ?? data; };
  const wait = async (predicate, label, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error(`remote host journey timeout: ${label} (state ${app?.manager.snapshot().state})`);
  };
  const atLogin = (search = '') => evaluate(`location.pathname==='/login' && location.search===${JSON.stringify(search)} && !!document.querySelector('#login-form')`);
  const signIn = async (password) => {
    await browser(['fill', '#password', password]);
    await browser(['click', '#login-submit']);
  };
  const inLobby = () => evaluate("location.pathname==='/' && document.querySelector('#status')?.textContent.length>0 && !document.querySelector('#logout').hidden");
  const hostRequest = (target, { method = 'GET', token, body } = {}) => new Promise((resolve, reject) => {
    const port = app.remoteHostPort;
    const req = https.request({ host: '127.0.0.1', port, method, path: target, servername: 'localhost', ca: fs.readFileSync(CERT), agent: false,
      headers: { host: `localhost:${port}`, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  try {
    await setHostPassword(root, PASSWORD);
    app = await startAppService(root, {
      resolver: async () => ({ player: null, upper: null, notices: [] }),
      publicPort: 0,
      remoteHost: { port: 0, listen: '127.0.0.1', names: ['localhost'], tlsCert: CERT, tlsKey: KEY },
    });
    app.manager.setPrefill({ pace: 'instant' });
    const origin = app.remoteHostOrigins[0];
    await browser(['open', `${origin}/`]);
    await wait(() => atLogin(), 'redirect to login');
    await browser(['set', 'viewport', '390', '844']);
    await browser(['screenshot', path.join(outDir, 'login-phone.png')]);
    checks.push('login-redirect');

    await signIn('틀린 비밀번호입니다');
    await wait(() => evaluate("document.querySelector('#login-error').textContent==='비밀번호가 맞지 않습니다.'"), 'wrong password message');
    checks.push('wrong-password');

    await signIn(PASSWORD);
    await wait(inLobby, 'lobby after login');
    assert.equal(await evaluate("document.querySelector('#study').hidden"), true);
    assert.equal(await evaluate("/^[0-9a-f]{64}$/.test(sessionStorage.getItem('holdem-app-token')||'')"), true);
    await browser(['screenshot', path.join(outDir, 'lobby-phone.png')]);
    checks.push('login-lobby');

    // Play from the remote lobby: the table iframe acts through the remote listener's relay proxy.
    await browser(['set', 'viewport', '1280', '900']);
    await wait(() => evaluate("!document.querySelector('#start').disabled"), 'start enabled');
    await browser(['click', '#start']);
    await wait(() => app.manager.snapshot().state === 'playing', 'game playing', 60000);
    // The engine records a decision only for the host's own actions (AI-only hands record none).
    const hostDecided = () => {
      const dir = app.manager.current.sessionDir;
      const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
      const engine = read(path.join(dir, 'state.json'));
      const records = [engine?.hand, engine?.lastHand];
      try { for (const name of fs.readdirSync(path.join(dir, 'hands'))) records.push(read(path.join(dir, 'hands', name))); } catch { /* none yet */ }
      return records.some((record) => Array.isArray(record?.decisions) && record.decisions.length > 0);
    };
    assert.equal(hostDecided(), false);
    await wait(async () => {
      if (hostDecided()) return true;
      // With a check available the first fold press only arms it (#320): press again.
      await evaluate("(()=>{const d=document.querySelector('#table')?.contentDocument;const b=['#btn-check','#btn-call','#btn-fold'].map(id=>d?.querySelector(id)).find(n=>n&&!n.disabled&&!n.hidden);if(b){b.click();if(b.classList.contains('is-armed'))b.click();}})()");
      return false;
    }, 'a remote host action reaches the engine', 60000);
    await browser(['screenshot', path.join(outDir, 'remote-table.png')]);
    checks.push('remote-play');
    assert.equal(await evaluate("document.querySelector('#table').contentDocument.querySelector('#study-open')?.hidden!==false"), true);
    checks.push('study-link-hidden');

    // The server ends this session (as a logout elsewhere, expiry or a new password would): the
    // lobby's next request is refused and the whole tab returns to the login page.
    const token = await evaluate("sessionStorage.getItem('holdem-app-token')");
    assert.equal(await hostRequest('/api/host/logout', { method: 'POST', token }), 200);
    await wait(() => atLogin('?expired=1'), 'expired session returns to login');
    assert.equal(await evaluate("document.querySelector('#login-note').textContent"), '로그인이 만료됐습니다. 다시 로그인하세요.');
    await signIn(PASSWORD);
    await wait(inLobby, 'lobby after signing in again');
    checks.push('expired-relogin');

    // A table opened on its own (no lobby around it) also returns to login when its session ends.
    const { gameId, gameEpoch } = app.manager.snapshot();
    await browser(['open', `${origin}/table?${new URLSearchParams({ appGame: gameId, epoch: gameEpoch })}`]);
    await wait(() => evaluate("document.querySelector('#conn')?.classList.contains('on') || document.querySelector('#action-status')?.textContent.length>0"), 'standalone table connected');
    const tableToken = await evaluate("sessionStorage.getItem('holdem-app-token')");
    assert.equal(await hostRequest('/api/host/logout', { method: 'POST', token: tableToken }), 200);
    await wait(() => atLogin('?expired=1'), 'standalone table returns to login');
    await signIn(PASSWORD);
    await wait(inLobby, 'lobby after the standalone table');
    checks.push('standalone-table-relogin');

    await browser(['click', '#help-menu']);
    await browser(['click', '#logout']);
    await wait(() => atLogin(), 'logout returns to login');
    assert.equal(await evaluate("sessionStorage.getItem('holdem-app-token')===null"), true);
    checks.push('logout');

    for (const target of ['/login.html', '/login.js', '/lobby.html'])
      assert.equal((await fetch(`${app.publicOrigin}${target}`)).status, 404, target);
    checks.push('participant-no-login');
  } catch (error) {
    failure = error;
    try { await browser(['screenshot', path.join(outDir, 'failure.png')]); } catch { /* keep the failure */ }
  } finally {
    const cleanup = await cleanupJourney({ failure, steps: [
      () => browser(['close']),
      () => app?.close(),
      () => { assert.equal(hashTree(userStore), before); checks.push('real-user-store-unchanged'); },
      () => workspace.close(),
    ] });
    failure = cleanup.failure;
    if (!cleanup.errors.length) checks.push('owned-cleanup');
    try { finishJourney({ required: requiredJourneyChecks, recorded: checks, failure }); }
    catch (error) { failure = error; }
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify({ pass: !failure, checks, cleanupErrors: cleanup.errors.map((error) => error.message), error: failure?.message }, null, 2));
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!selfTestJourney(requiredJourneyChecks)) {
    const i = process.argv.lastIndexOf('--out-dir');
    if (i < 0) throw new Error('--out-dir required');
    await runRemoteHostJourney(path.resolve(process.argv[i + 1]));
    console.log('Remote host browser journey PASS');
  }
}
