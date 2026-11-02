// scripts/macmini/renew-tailscale-cert.sh: one `tailscale cert` call, every part checked, and one
// combined host.pem (chain + key) replaced in a single rename.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/macmini/renew-tailscale-cert.sh", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/remote-host-tls/", import.meta.url));
const posixOnly = { skip: process.platform === "win32" && "a POSIX shell script for macOS" };
const openssl = ["/usr/bin/openssl", "/opt/homebrew/bin/openssl", "/usr/local/bin/openssl"].find((file) => fs.existsSync(file));
const read = (file) => fs.readFileSync(file, "utf8");
const fixtureText = (name) => read(path.join(FIXTURES, name));

function fixture(t) {
  const dir = createOwnedTempDir("renew-cert");
  const out = path.join(dir, "tls");
  // A stand-in for the Tailscale CLI: it insists on the one-call form and prints what PAIR_DIR holds.
  // With CLI_WAIT it says "started" and holds until "release" exists (no fixed sleeps).
  const fake = path.join(dir, "fake-tailscale");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    '[ "$1" = cert ] && [ "$2" = --cert-file ] && [ "$3" = - ] && [ "$4" = --key-file ] && [ "$5" = - ] && [ "$6" = mini.tail1234.ts.net ] || { echo "unexpected args: $*" >&2; exit 64; }',
    'echo "Wrote public cert to -" >&2',
    'if [ -n "${CLI_WAIT:-}" ]; then : > "$PAIR_DIR/started"; i=0; while [ ! -e "$PAIR_DIR/release" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i+1)); done; fi',
    '[ -e "$PAIR_DIR/fail" ] && exit 1',
    'cat "$PAIR_DIR/cert.pem" "$PAIR_DIR/key.pem"',
    "",
  ].join("\n"), { mode: 0o755 });
  const pairDir = (name) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };
  const pair = pairDir("pair");
  const serve = (certText, keyText, into = pair) => {
    fs.writeFileSync(path.join(into, "cert.pem"), certText);
    fs.writeFileSync(path.join(into, "key.pem"), keyText);
  };
  const env = (extra = {}) => ({ ...process.env, TAILSCALE: fake, PAIR_DIR: pair, OPENSSL: openssl, ...extra });
  const run = (args = ["mini.tail1234.ts.net", out], extra = {}) => spawnSync("/bin/sh", [SCRIPT, ...args], { encoding: "utf8", env: env(extra) });
  const start = (extra = {}) => spawn("/bin/sh", [SCRIPT, "mini.tail1234.ts.net", out], { env: env(extra), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const pem = () => path.join(out, "host.pem");
  return { dir, out, pair, pairDir, serve, run, start, pem };
}
const exited = (child) => new Promise((resolve) => child.once("exit", (code) => resolve(code)));
const collect = (child) => { let text = ""; child.stderr.on("data", (d) => { text += d; }); child.stdout.on("data", (d) => { text += d; }); return () => text; };
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
// The combined file is what the listeners load as both certificate and key.
const loads = (file) => { const bytes = fs.readFileSync(file); tls.createSecureContext({ cert: bytes, key: bytes }); return true; };

test("the renewal script installs one combined file, leaves it alone when unchanged and replaces a new pair", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, pem } = fixture(t);
  serve(fixtureText("a.crt"), fixtureText("a.key"));
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated: notAfter=/);
  assert.equal(read(pem()), fixtureText("a.crt") + fixtureText("a.key"));
  assert.equal(fs.statSync(pem()).mode & 0o777, 0o600, "it holds the key");
  assert.equal(loads(pem()), true);
  const before = fs.statSync(pem()).ino;
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^unchanged: notAfter=/);
  assert.equal(fs.statSync(pem()).ino, before, "an unchanged file is not rewritten");
  serve(fixtureText("b.crt"), fixtureText("b.key"));
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated: /);
  assert.equal(read(pem()), fixtureText("b.crt") + fixtureText("b.key"));
  assert.deepEqual(fs.readdirSync(out), ["host.pem"], "no temporary file is left");
  assert.equal(run(["only-one-arg"]).status, 2);
});

test("nothing is replaced unless every certificate, the one key and the pair check out", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, pair, serve, run, pem } = fixture(t);
  serve(fixtureText("a.crt"), fixtureText("a.key"));
  assert.equal(run().status, 0);
  const good = read(pem());
  const broken = (kind) => `-----BEGIN ${kind}-----\nnot base64 at all\n-----END ${kind}-----\n`;
  const cases = [
    ["a key for another certificate", fixtureText("b.crt"), fixtureText("a.key"), /certificate and key do not match/],
    // Markers around garbage: a pipeline whose status came from a later stage would let these pass.
    ["a broken certificate and key", broken("CERTIFICATE"), broken("PRIVATE KEY"), /does not parse/],
    // `openssl x509` alone reads only the first certificate of a chain.
    ["a broken certificate after a good leaf", fixtureText("b.crt") + broken("CERTIFICATE"), fixtureText("b.key"), /a certificate in the chain does not parse/],
    ["a broken key with a good certificate", fixtureText("b.crt"), broken("PRIVATE KEY"), /key does not parse/],
    ["two keys", fixtureText("b.crt"), fixtureText("b.key") + fixtureText("a.key"), /expected exactly one private key/],
    ["nothing", "", "", /no certificate or key/],
  ];
  for (const [label, cert, key, message] of cases) {
    serve(cert, key);
    const result = run();
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, message, label);
    assert.match(result.stderr, /nothing replaced/, label);
    assert.doesNotMatch(result.stdout, /updated/, label);
    assert.equal(read(pem()), good, `${label}: the installed file is untouched`);
    assert.deepEqual(fs.readdirSync(out), ["host.pem"], `${label}: no temporary file is left`);
  }
  serve(fixtureText("b.crt"), fixtureText("b.key"));
  fs.writeFileSync(path.join(pair, "fail"), "");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tailscale cert failed; nothing replaced/);
  assert.equal(read(pem()), good);
});

test("only the checked blocks are installed: other PEM labels are refused, stray text is dropped, the key goes last", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, pem } = fixture(t);
  serve(fixtureText("a.crt"), fixtureText("a.key"));
  assert.equal(run().status, 0);
  const good = read(pem());
  // OpenSSL also loads these labels as a certificate, so one of them could become the served leaf.
  const relabel = (label) => fixtureText("b.crt").replaceAll("CERTIFICATE-----", `${label}-----`);
  for (const label of ["X509 CERTIFICATE", "TRUSTED CERTIFICATE"]) {
    serve(relabel(label) + fixtureText("b.crt"), fixtureText("b.key"));
    const result = run();
    assert.equal(result.status, 1, label);
    assert.match(result.stderr, /unexpected PEM block; nothing replaced/, label);
    assert.equal(read(pem()), good, `${label}: the installed file is untouched`);
    assert.deepEqual(fs.readdirSync(out), ["host.pem"], `${label}: no temporary file is left`);
  }
  // Text around the blocks is not copied, and a key printed first still ends up after the chain.
  serve(`note before\n${fixtureText("b.key")}between\n`, `${fixtureText("b.crt")}trailing words\n`);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(pem()), fixtureText("b.crt") + fixtureText("b.key"));
  assert.equal(loads(pem()), true);
});

test("a directory in host.pem's place is refused, not filled", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { dir, out, serve, run, pem } = fixture(t);
  serve(fixtureText("a.crt"), fixtureText("a.key"));
  // `mv` into a directory would move the new file inside it and report success.
  fs.mkdirSync(pem(), { recursive: true });
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /host\.pem is a directory; nothing replaced/);
  assert.deepEqual(fs.readdirSync(pem()), []);
  assert.deepEqual(fs.readdirSync(out), ["host.pem"], "no temporary file is left");
  // The same through a symlink to a directory.
  fs.rmdirSync(pem());
  const elsewhere = path.join(dir, "elsewhere");
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, pem());
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is a directory; nothing replaced/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.equal(fs.lstatSync(pem()).isSymbolicLink(), true);
});

test("two runs at once each install a complete pair; the file never holds a mix", posixOnly, async (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, pairDir, serve, run, start, pem } = fixture(t);
  const slow = pairDir("slow");
  serve(fixtureText("a.crt"), fixtureText("a.key"), slow);
  serve(fixtureText("b.crt"), fixtureText("b.key"));
  // The slow run fetches pair A and waits; meanwhile another run installs pair B; then A finishes.
  const first = start({ PAIR_DIR: slow, CLI_WAIT: "1" });
  const output = collect(first);
  const done = exited(first);
  t.after(() => { try { process.kill(-first.pid, "SIGKILL"); } catch { /* already gone */ } });
  await waitFor(() => fs.existsSync(path.join(slow, "started")), "the slow run reached its CLI call");
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(read(pem()), fixtureText("b.crt") + fixtureText("b.key"));
  fs.writeFileSync(path.join(slow, "release"), "");
  assert.equal(await done, 0, output());
  assert.equal(read(pem()), fixtureText("a.crt") + fixtureText("a.key"), "the later run's complete pair stays");
  assert.equal(loads(pem()), true);
  assert.deepEqual(fs.readdirSync(out), ["host.pem"]);
});

test("a killed run leaves the installed file intact", posixOnly, async (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, pair, serve, run, start, pem } = fixture(t);
  serve(fixtureText("a.crt"), fixtureText("a.key"));
  assert.equal(run().status, 0);
  serve(fixtureText("b.crt"), fixtureText("b.key"));
  const victim = start({ CLI_WAIT: "1" });
  const done = exited(victim);
  await waitFor(() => fs.existsSync(path.join(pair, "started")), "the CLI call started");
  process.kill(-victim.pid, "SIGKILL");
  await done;
  assert.equal(read(pem()), fixtureText("a.crt") + fixtureText("a.key"), "the old pair is still whole");
  // What it may leave is only its own temporary file, which is safe to delete.
  for (const name of fs.readdirSync(out)) assert.ok(name === "host.pem" || /^\.host\.pem\.[A-Za-z0-9]{6}$/.test(name), name);
  fs.rmSync(path.join(pair, "started"));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(pem()), fixtureText("b.crt") + fixtureText("b.key"));
});

test("an ECDSA key with a certificate chain installs whole and loads", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { dir, serve, run, pem } = fixture(t);
  const ossl = (args) => spawnSync(openssl, args, { encoding: "utf8", cwd: dir });
  // Tailscale serves an ECDSA P-256 key and a leaf followed by its issuer.
  if (ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ec.key"]).status !== 0) return t.skip("openssl cannot make EC keys");
  assert.equal(ossl(["req", "-x509", "-new", "-key", "ec.key", "-out", "leaf.crt", "-days", "2", "-subj", "/CN=mini.tail1234.ts.net"]).status, 0);
  serve(read(path.join(dir, "leaf.crt")) + fixtureText("b.crt"), read(path.join(dir, "ec.key")));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const installed = read(pem());
  assert.equal((installed.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length, 2, "the whole chain is kept");
  assert.match(installed, /-----BEGIN EC PRIVATE KEY-----/);
  assert.equal(loads(pem()), true);
});

test("the deployment guide's serve commands use only flags serve reads", async () => {
  const { parseServeArgs } = await import("../tools/app-service.js");
  const guide = fs.readFileSync(new URL("../docs/deploy-mac-mini.ko.md", import.meta.url), "utf8");
  // §6 (terminal) and §7.1 (launchd ProgramArguments) — both spell the same serve.
  const terminal = /node tools\/app-service\.js serve ([^\n]*\\\n[^\n]*\\\n[^\n]*)/.exec(guide)[1]
    .replace(/\\\n/g, " ").match(/"[^"]*"|\S+/g).map((arg) => arg.replace(/^"|"$/g, ""));
  const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(guide)[1];
  const strings = [...program.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  const launchd = strings.slice(strings.indexOf("serve") + 1);
  for (const args of [terminal, launchd]) {
    const flags = args.filter((arg) => arg.startsWith("--"));
    assert.ok(flags.length >= 6, String(args));
    const known = ["--player-runtime", "--public-port", "--public-host", "--tls-cert", "--tls-key", "--remote-host-port", "--remote-host-listen", "--remote-host-name", "--remote-tls-cert", "--remote-tls-key"];
    for (const flag of flags) assert.ok(known.includes(flag), `unknown serve flag in the guide: ${flag}`);
    const parsed = parseServeArgs(args.slice(1));
    assert.equal(parsed.remoteHost.port, 8898);
    for (const key of ["listen", "tlsCert", "tlsKey"]) assert.ok(parsed.remoteHost[key], key);
    assert.equal(parsed.remoteHost.names.length, 1);
  }
});
