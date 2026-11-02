import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { HOST_TOKEN_KEY, goToLogin, isRemoteHostPage, loginErrorText, loginPath, reloadWhenRestored } from "../server/public/remote-host.js";

const read = (name) => fs.readFileSync(new URL(`../server/public/${name}`, import.meta.url), "utf8");

test("only the 127.0.0.1 origin is the local lobby", () => {
  assert.equal(isRemoteHostPage({ hostname: "127.0.0.1" }), false);
  for (const hostname of ["mini.tail1234.ts.net", "localhost", "192.168.0.10", "[fd7a::1]", "::1"])
    assert.equal(isRemoteHostPage({ hostname }), true, hostname);
  assert.equal(isRemoteHostPage(undefined), false, "no location (Node) is not remote");
  assert.equal(HOST_TOKEN_KEY, "holdem-app-token", "the lobby, table transport and login share one key");
  assert.match(read("app-transport.js"), /"holdem-app-token"/);
  assert.equal(loginPath(), "/login");
  assert.equal(loginPath({ expired: true }), "/login?expired=1");
});

test("login errors explain every server refusal in Korean", () => {
  assert.equal(loginErrorText("LOGIN_FAILED"), "비밀번호가 맞지 않습니다.");
  assert.match(loginErrorText("LOGIN_RATE_LIMIT", 899), /15분 뒤/);
  assert.match(loginErrorText("LOGIN_RATE_LIMIT", 42), /42초 뒤/);
  assert.match(loginErrorText("LOGIN_RATE_LIMIT"), /1분 뒤/);
  for (const code of ["LOGIN_BUSY", "HOST_PASSWORD_NOT_SET", "HOST_AUTH_INVALID", "NOT_FOUND", "BAD_ORIGIN", undefined, "ANYTHING"]) {
    const text = loginErrorText(code);
    assert.ok(text && /[가-힣]/.test(text), String(code));
  }
  assert.match(loginErrorText("HOST_PASSWORD_NOT_SET"), /host-password/);
});

test("the login page is a CSP-clean form a password manager understands", async () => {
  const html = read("login.html");
  assert.match(html, /<form id="login-form" class="login-form" method="post"/, "never a GET that puts a password in the URL");
  assert.match(html, /id="password"[^>]*type="password"[^>]*autocomplete="current-password"[^>]*\bdisabled\b/);
  assert.match(html, /id="login-submit"[^>]*type="submit" disabled>/, "nothing is submittable until login.js runs over HTTPS");
  assert.match(html, /autocomplete="username"/);
  assert.match(html, /id="login-error"[^>]*role="alert"/);
  assert.match(html, /<script type="module" src="\/login\.js"><\/script>/);
  // CSP default-src 'self': no inline script bodies or handlers.
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\son[a-z]+=/i);
  for (const match of html.matchAll(/(?:src|href)="\/([^"]+)"/g))
    assert.ok(fs.existsSync(new URL(`../server/public/${match[1]}`, import.meta.url)), match[1]);
  // Inert in Node.
  await import("../server/public/login.js");
  const source = read("login.js");
  assert.match(source, /\/api\/host\/login/);
  assert.match(source, /sessionStorage\.setItem\(HOST_TOKEN_KEY/);
  assert.match(source, /location\.replace\('\/'\)/);
});

test("the lobby offers logout only on a remote host page and hides the loopback-only study", () => {
  const html = read("lobby.html");
  assert.match(html, /<button type="button" id="logout" class="ui-btn ui-btn--quiet" hidden>로그아웃<\/button>/);
  const lobby = read("lobby.js");
  assert.match(lobby, /if \(remoteHost && !sessionStorage\.getItem\(HOST_TOKEN_KEY\)\) \{\n  location\.replace\(loginPath\(\)\);/);
  assert.match(lobby, /response\.status === 401 && remoteHost/);
  assert.match(lobby, /\$\("study"\)\.hidden = true;\n  \$\("logout"\)\.hidden = false;/);
  const app = read("app.js");
  assert.match(app, /const remoteHostTable = Boolean\(appGameId\) && !participantMode && isRemoteHostPage\(\);/);
  assert.match(app, /participantMode \|\| remoteHostTable \? null : studyLink\(snap\.studyUrl\)/);
  // Every table request and the event stream go through the wrapper that signs a lost session in again.
  assert.match(app, /if \(response\.status === 401\) remoteSessionLost\(\);/);
  assert.match(app, /eventStream\('events\?after=0', \{ request: appFetch \}\)/);
  assert.match(app, /if \(remoteHostTable && !authToken\(\)\) goToLogin\(\);/);
  assert.doesNotMatch(app.replace(/^import[^\n]*$/gm, ""), /transportFetch\((?!endpoint, options\))/, "no call bypasses the wrapper");
});

test("login navigation moves the whole tab and a restored page reloads", () => {
  const replaced = [];
  const top = { location: { origin: "https://mini:8898", replace: (url) => replaced.push(["top", url]) } };
  const frame = { top, location: { origin: "https://mini:8898", replace: (url) => replaced.push(["frame", url]) } };
  goToLogin({ expired: true, win: frame });
  top.top = top;
  goToLogin({ win: top });
  const foreignTop = { get location() { throw new Error("cross-origin"); } };
  const foreignFrame = { top: foreignTop, location: { origin: "https://mini:8898", replace: (url) => replaced.push(["frame", url]) } };
  goToLogin({ win: foreignFrame });
  assert.deepEqual(replaced, [["top", "/login?expired=1"], ["top", "/login"], ["frame", "/login"]]);
  const listeners = {};
  let reloads = 0;
  reloadWhenRestored({ addEventListener: (type, fn) => { listeners[type] = fn; }, location: { reload: () => { reloads += 1; } } });
  listeners.pageshow({ persisted: false });
  listeners.pageshow({ persisted: true });
  assert.equal(reloads, 1);
});

test("the login script takes no password over plain HTTP", async () => {
  const elements = {};
  // The markup starts the password field and button disabled (see the login page test).
  const element = (id) => (elements[id] ??= { id, disabled: id === "password" || id === "login-submit", textContent: "", value: "", listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute() {}, removeAttribute() {}, select() {}, focus() {} });
  for (const [protocol, search] of [["http:", ""], ["https:", "?expired=1"]]) {
    for (const key of Object.keys(elements)) delete elements[key];
    globalThis.document = { getElementById: element };
    globalThis.location = { protocol, search };
    try {
      await import(`../server/public/login.js?case=${protocol}`);
    } finally {
      delete globalThis.document;
      delete globalThis.location;
    }
    if (protocol === "http:") {
      assert.equal(elements.password.disabled, true);
      assert.equal(elements["login-submit"].disabled, true);
      assert.match(elements["login-error"].textContent, /암호화되지 않은 주소/);
      assert.equal(elements["login-form"].listeners.submit, undefined, "no submit handler on HTTP");
    } else {
      assert.equal(typeof elements["login-form"].listeners.submit, "function");
      assert.equal(elements.password.disabled, false, "enabled only once the handler is installed over HTTPS");
      assert.equal(elements["login-submit"].disabled, false);
      assert.equal(elements["login-note"].textContent, "로그인이 만료됐습니다. 다시 로그인하세요.");
    }
  }
});
