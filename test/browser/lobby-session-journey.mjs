import { finishJourney, selfTestJourney, cleanupJourney } from './journey-exit.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startAppService } from "../../tools/app-service.js";
import {
  inspectStudyService,
  stopStudyService,
} from "../../tools/study-service.js";
import {
  createBrowserWorkspace,
  runOwnedCommand,
  hashTree,
} from "../helpers/learning-browser-fixture.mjs";
export const requiredJourneyChecks = [
  "missing-module-visible-error",
  "bare-lobby-no-init",
  "mode-ai-selection",
  "deal-bias-selection-restart",
  "pause-resume",
  "host-iframe-survives-error-resume",
  "setup-back-no-resume",
  "menu-close-reopen",
  "restart-new-id",
  "abort-summary",
  "final-overlay-ended",
  "completed-review-reload",
  "command-reconnect",
  "study-paused-roundtrip",
  "keyboard-mobile",
  "real-user-store-unchanged",
  "owned-cleanup",
  "hand-result-hold-respected",
  "pause-during-ai-interval",
  "skip-advances",
];
export async function runLobbyJourney(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const workspace = createBrowserWorkspace(),
    root = workspace.root;
  const userStore = path.resolve("game"),
    before = hashTree(userStore),
    session = `lobby-${randomUUID()}`;
  let app, outdatedServer;
  const checks = [];
  let failure;
  const browser = async (args) => {
    const r = await runOwnedCommand(
      "npx",
      [
        "--yes",
        "--prefer-offline",
        "agent-browser@0.36.0",
        "--session",
        session,
        "--json",
        ...args,
      ],
      { timeoutMs: 45000 },
    );
    assert.equal(
      r.exitCode,
      0,
      `${args[0]} (timeout=${r.timedOut}, signal=${r.signal}, spawn=${r.spawnError}): ${r.stderr} ${r.stdout.replace(/token=[^\s"&]+/g, "token=[redacted]")}`,
    );
    const result = JSON.parse(r.stdout);
    assert.notEqual(result.success, false, JSON.stringify(result));
    return result.data;
  };
  const evaluate = async (expr) => {
    const data = await browser(["eval", expr]);
    return data?.result ?? data;
  };
  const check = (name) => checks.push(name);
  const wait = async (predicate, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("journey state timeout " + app.manager.snapshot().state);
  };
  const state = (expected, timeoutMs) =>
    wait(
      () =>
        app.manager.snapshot().state === expected &&
        !app.manager.snapshot().pendingRequestId,
      timeoutMs,
    );
  const click = async (selector) => {
    await browser(["snapshot", "-i"]);
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`,
    );
    await browser(["click", selector]);
  };
  const readEngine = () =>
    JSON.parse(
      fs.readFileSync(path.join(app.manager.current.sessionDir, "state.json")),
    );
  try {
    app = await startAppService(root, {
      resolver: async () => ({ player: null, upper: null, notices: [] }),
    });
    app.manager.setPrefill({pace:'instant'});
    // Reproduce an already-running server whose allowlist predates the UI update.
    outdatedServer = http.createServer(async (req, res) => {
      if (req.url === '/shared/game-setup.js') {
        res.writeHead(404, {'content-type':'application/json'});
        res.end('{"code":"NOT_FOUND"}');
        return;
      }
      const response = await fetch(app.origin + req.url);
      res.writeHead(response.status, {'content-type':response.headers.get('content-type')});
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise(resolve => outdatedServer.listen(0, '127.0.0.1', resolve));
    await browser(['open', `http://127.0.0.1:${outdatedServer.address().port}/`]);
    await wait(() => evaluate("document.querySelector('#status').textContent==='로비를 불러오지 못했습니다'"));
    assert.equal(await evaluate("document.querySelector('#start').disabled"), true);
    assert.match(await evaluate("document.querySelector('#error').textContent"), /로비 서버를 다시 실행/);
    check('missing-module-visible-error');
    await new Promise(resolve => outdatedServer.close(resolve));
    outdatedServer = null;
    await browser(["open", app.url]);
    await browser(["set", "viewport", "1280", "900"]);
    await browser(["snapshot", "-i"]);
    await wait(() =>
      evaluate("document.querySelector('#status').textContent==='로비'"),
    );
    assert.equal(app.manager.snapshot().gameId, null);
    assert.equal(await evaluate("location.hash"), "");
    check("bare-lobby-no-init");
    await browser(["screenshot", path.join(outDir, "lobby.png")]);
    assert.equal(await evaluate("document.querySelector('[name=dealBias]').value"), "off");
    await browser(["select", "[name=dealBias]", "strong"]);
    await click("#start");
    await state("playing");
    assert.equal(readEngine().config.dealBias, "strong");
    assert.equal(app.manager.snapshot().setup.dealBias, "strong");
    const players = JSON.parse(
      fs.readFileSync(
        path.join(app.manager.current.sessionDir, "players.json"),
      ),
    );
    assert.equal(players.length, 6);
    check("mode-ai-selection");
    await wait(() =>
      evaluate(
        "document.querySelector('#table').contentDocument.querySelector('#action-status')?.textContent.length>0",
      ),
    );
    // Keep authentication identity valid so the action reaches the real loop.
    // Damage only this owned fixture while an actual user action is pending.
    // The real loop fails and cleans up; restore the bytes before ordinary resume.
    await wait(()=>evaluate("document.querySelector('#table').contentDocument.querySelector('#btn-fold')?.disabled===false"));
    await evaluate("window.__recoveryDocument=document.querySelector('#table').contentDocument");
    const engineFile=path.join(app.manager.current.sessionDir,'state.json');
    const engineBeforeFault=fs.readFileSync(engineFile);
    const beforeFault=app.manager.snapshot();
    try {
      fs.writeFileSync(engineFile,JSON.stringify({...JSON.parse(engineBeforeFault),seats:null}));
      await evaluate("document.querySelector('#table').contentDocument.querySelector('#btn-fold').click()");
      await state('error');
      assert.equal(app.manager.session,null);
      const unavailable=await fetch(`${app.origin}/api/game/${beforeFault.gameId}/events`,{headers:{authorization:`Bearer ${app.token}`,'x-game-epoch':beforeFault.gameEpoch}});
      assert.equal(unavailable.status,503);assert.equal((await unavailable.json()).code,'SESSION_UNAVAILABLE');
    } finally {fs.writeFileSync(engineFile,engineBeforeFault);}
    // The manager reaches error before the browser's polling render does. Wait
    // for the actual recovery control to own its click point after layout.
    await wait(()=>evaluate(`(() => {
      const button=document.querySelector('#recover');
      if(!button || button.hidden || button.disabled || document.body.classList.contains('has-game'))return false;
      const r=button.getBoundingClientRect();
      return r.width>0 && r.height>0 && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
    })()`));
    await click('#recover');await state('playing');
    await wait(()=>evaluate("document.querySelector('#table').contentDocument.querySelector('#btn-fold')?.disabled===false"));
    assert.equal(app.manager.snapshot().gameId,beforeFault.gameId);
    assert.equal(await evaluate("document.querySelector('#table').contentDocument===window.__recoveryDocument && !document.querySelector('#game').hidden"),true);
    check('host-iframe-survives-error-resume');
    await click("#menu");
    await state("paused");
    const paused = hashTree(app.manager.current.sessionDir);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hashTree(app.manager.current.sessionDir), paused);
    await click("#modes");
    await click("#back");
    assert.equal(app.manager.snapshot().state, "paused");
    check("setup-back-no-resume");
    await click("#close-menu");
    assert.equal(app.manager.snapshot().state, "paused");
    await click("#menu");
    check("menu-close-reopen");
    await browser(["set", "viewport", "360", "800"]);
    await browser(["press", "Escape"]);
    assert.equal(app.manager.snapshot().state, "paused");
    assert.ok(await evaluate("document.documentElement.scrollWidth<=360"));
    await click("#menu");
    check("keyboard-mobile");
    await click("#resume");
    await state("playing");
    await click("#menu");
    await state("paused");
    check("pause-resume");
    await browser(["reload"]);
    await wait(() =>
      evaluate("document.querySelector('#status').textContent==='일시정지'"),
    );
    check("command-reconnect");
    await click("#study");
    await browser(["tab", "t1"]);
    assert.equal(app.manager.snapshot().state, "paused");
    check("study-paused-roundtrip");
    await click("#menu");
    const old = app.manager.snapshot().gameId;
    await click("#restart");
    await click("#confirm-yes");
    await state("playing");
    assert.notEqual(app.manager.snapshot().gameId, old);
    assert.equal(readEngine().config.dealBias, "strong");
    check("deal-bias-selection-restart");
    check("restart-new-id");
    await click("#menu");
    await state("paused");
    await click("#modes");
    await browser(["check", 'input[value="tournament"]']);
    await browser(["select", "#ai-count", "8"]);
    // Interrupt a receipt read after mode replacement was submitted. The UI
    // must reconcile its persisted command and leave the setup screen.
    await evaluate(`(() => {
      const original = window.fetch;
      window.__receiptDisconnected = false;
      window.fetch = async (url, options) => {
        if (!window.__receiptDisconnected && String(url).startsWith('/api/commands/')) {
          window.__receiptDisconnected = true;
          throw new TypeError('fetch failed');
        }
        return original(url, options);
      };
    })()`);
    await click("#start");
    await click("#confirm-yes");
    await state("playing");
    await wait(() => evaluate("window.__receiptDisconnected && document.querySelector('#setup').hidden && !sessionStorage.getItem('holdem.app.command.v1')"));
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(app.manager.current.sessionDir, "players.json"),
        ),
      ).length,
      9,
    );
    await click("#menu");
    await state("paused");
    await evaluate("window.__endingFrame=document.querySelector('#table').contentDocument");
    await click("#end");
    await click("#confirm-yes");
    await state("ended");
    assert.equal(readEngine().result, "abort");
    await wait(() =>
      evaluate(
        "document.querySelector('#result-message').textContent.includes('중도 종료')",
      ),
    );
    check("abort-summary");
    await wait(()=>evaluate("document.querySelector('#table').contentDocument.querySelector('#review-overlay')?.hidden===false"));
    assert.equal(await evaluate("!document.querySelector('#game').hidden && document.querySelector('#table').contentDocument===window.__endingFrame"),true);
    check("final-overlay-ended");
    await click("#result-modes");
    await browser(["check", 'input[value="cash-training"]']);
    await browser(["select", "#ai-count", "1"]);
    await click("summary");
    await browser(["fill", 'input[name="hands"]', "1"]);
    await evaluate(
      "window.lobbyDebug=[];document.querySelector('form').addEventListener('submit',()=>window.lobbyDebug.push('submit'));document.querySelector('#start').addEventListener('click',()=>window.lobbyDebug.push('click'));window.addEventListener('error',e=>window.lobbyDebug.push(e.message));",
    );
    await click("#start");
    await state("playing");
    for (
      let i = 0;
      i < 120 && app.manager.snapshot().state !== "completed";
      i++
    ) {
      await evaluate(
        "(()=>{const d=document.querySelector('#table').contentDocument;const b=d?.querySelector('#btn-fold');if(b&&!b.disabled)b.click();})()",
      );
      await new Promise((r) => setTimeout(r, 200));
    }
    await state("completed");
    await click("#review");
    await wait(() =>
      evaluate(
        "document.querySelector('#table').contentDocument.querySelector('#action-status')?.textContent==='종료된 게임 기록입니다.'",
      ),
    );
    await browser(["reload"]);
    await state("completed");
    await click("#review");
    await wait(()=>evaluate("document.querySelector('#table').contentDocument.querySelector('#review-close')!==null"));
    assert.equal(await evaluate("document.querySelector('#table').inert"),false);
    await browser(['frame','#table']);await browser(['snapshot','-i']);await browser(['click','#review-close']);await browser(['frame','main']);
    check("completed-review-reload");
    await browser(["screenshot", path.join(outDir, "completed.png")]);
    // Exercise real app -> loop pacing, not a mocked skip method.
    await click('#result-modes');
    await evaluate("document.querySelector('details').open=true");
    await browser(['fill','input[name="hands"]','4']);
    await browser(['select','[name="pace"]','fast']);
    await browser(['select','#ai-count','1']);
    await evaluate(`(() => {
      window.__pace={paused:false,skipClicked:false};
      window.__paceDriver=setInterval(()=>{
        const doc=document.querySelector('#table')?.contentDocument;if(!doc)return;
        if(document.querySelector('#status')?.textContent!=='게임 중')return;
        const thinking=doc.querySelector('#thinking'),menu=document.querySelector('#menu');
        if(!window.__pace.paused && thinking && !thinking.hidden && !menu.disabled){window.__pace.paused=true;menu.click();return;}
        const result=doc.querySelector('#hand-result'),skip=doc.querySelector('.hand-result-skip');
        if(result?.dataset.handNo==='2' && !result.hidden && skip && !skip.hidden && !skip.disabled){window.__pace.skipClicked=true;skip.click();}
        const button=['#btn-check','#btn-call','#btn-fold'].map(id=>doc.querySelector(id)).find(node=>node&&!node.disabled&&!node.hidden);
        if(button)button.click();
      },30);
    })()`);
    const holds=new Map(),advances=new Map();let lastHand=0;
    const paceWatch=setInterval(()=>{
      try {
        const snap=JSON.parse(fs.readFileSync(path.join(app.manager.current.sessionDir,'ui-snapshot.json')));
        if(snap.resultHold&&!holds.has(snap.resultHold.handNo))holds.set(snap.resultHold.handNo,snap.resultHold);
        const hand=readEngine().handNo;
        if(hand>lastHand){advances.set(hand,Date.now());lastHand=hand;}
      } catch {}
    },20);
    try {
      await click('#start');await state('paused');
      const pausedState=hashTree(app.manager.current.sessionDir);
      await new Promise(resolve=>setTimeout(resolve,500));assert.equal(hashTree(app.manager.current.sessionDir),pausedState);
      check('pause-during-ai-interval');
      // Four paced hands plus finalization can exceed the ordinary UI wait on CI.
      await click('#resume');await state('completed', 60000);
      assert.ok(holds.has(1)&&advances.has(2));
      assert.ok(advances.get(2)>=Date.parse(holds.get(1).until),'next hand preceded server hold deadline');
      check('hand-result-hold-respected');
      assert.equal(await evaluate('window.__pace.skipClicked'),true);
      assert.ok(holds.has(2)&&advances.has(3));
      assert.ok(advances.get(3)<Date.parse(holds.get(2).until),'skip did not shorten the active wait');
      check('skip-advances');
    } finally {clearInterval(paceWatch);await evaluate('clearInterval(window.__paceDriver)');}

  } catch (error) {
    failure = error;
    try {
      fs.writeFileSync(
        path.join(outDir, "failure-ui.json"),
        JSON.stringify(
          await evaluate(
            "({debug:window.lobbyDebug,button:document.querySelector('#start').outerHTML,dialogs:[...document.querySelectorAll('dialog')].map(d=>({id:d.id,open:d.open})),error:document.querySelector('#error').textContent,form:[...document.querySelector('form').elements].map(e=>({name:e.name,value:e.value,valid:e.validity?.valid})),status:document.querySelector('#status').textContent})",
          ),
          null,
          2,
        ),
      );
      await browser(["screenshot", path.join(outDir, "failure.png")]);
    } catch {}
  } finally {
    const cleanup = await cleanupJourney({ failure, steps: [
      () => browser(['close']),
      () => outdatedServer && new Promise(resolve => outdatedServer.close(resolve)),
      () => app?.close(),
      async () => { const study = await inspectStudyService(root);
        if (study.status === 'running') await stopStudyService(root, { expectedInstanceId: study.instanceId }); },
      () => { assert.equal(hashTree(userStore), before); checks.push('real-user-store-unchanged'); },
      () => workspace.close(),
    ] });
    failure = cleanup.failure;
    if (!cleanup.errors.length) checks.push('owned-cleanup');
    try { finishJourney({ required: requiredJourneyChecks, recorded: checks, failure }); }
    catch (error) { failure = error; }
    const result = {
      schemaVersion: 1,
      pass: !failure && requiredJourneyChecks.every((x) => checks.includes(x)),
      node: process.version,
      browser: "agent-browser@0.36.0",
      checks,
      pending: requiredJourneyChecks.filter((x) => !checks.includes(x)),
      error: failure?.message,
      cleanupErrors: cleanup.errors.map(error => error.message),
    };
    fs.writeFileSync(
      path.join(outDir, "result.json"),
      JSON.stringify(result, null, 2),
    );
  }
  finishJourney({ required: requiredJourneyChecks, recorded: checks, failure });
}
if (
  !process.env.NODE_TEST_CONTEXT &&
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (!selfTestJourney(requiredJourneyChecks)) {
    const i = process.argv.lastIndexOf("--out-dir");
    if (i < 0) throw new Error("--out-dir required");
    await runLobbyJourney(path.resolve(process.argv[i + 1]));
    console.log("Lobby browser journey PASS");
  }
}
