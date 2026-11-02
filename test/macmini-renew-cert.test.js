// scripts/macmini/renew-tailscale-cert.sh: one `tailscale cert` call, a checked pair, and only a
// changed pair replaces the files the remote host listener reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { createOwnedTempDir } from "./helpers/owned-fixtures.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/macmini/renew-tailscale-cert.sh", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/remote-host-tls/", import.meta.url));
const posixOnly = { skip: process.platform === "win32" && "a POSIX shell script for macOS" };
const openssl = ["/usr/bin/openssl", "/opt/homebrew/bin/openssl", "/usr/local/bin/openssl"].find((file) => fs.existsSync(file));

function fixture(t) {
  const dir = createOwnedTempDir("renew-cert");
  const out = path.join(dir, "tls");
  const pair = path.join(dir, "pair");
  fs.mkdirSync(pair);
  // A stand-in for the Tailscale CLI: it insists on the one-call form and prints cert then key.
  const fake = path.join(dir, "fake-tailscale");
  fs.writeFileSync(fake, [
    "#!/bin/sh",
    '[ "$1" = cert ] && [ "$2" = --cert-file ] && [ "$3" = - ] && [ "$4" = --key-file ] && [ "$5" = - ] && [ "$6" = mini.tail1234.ts.net ] || { echo "unexpected args: $*" >&2; exit 64; }',
    'echo "Wrote public cert to -" >&2',
    '[ -n "${CLI_SLEEP:-}" ] && sleep "$CLI_SLEEP"',
    'cat "$PAIR_DIR/cert.pem" "$PAIR_DIR/key.pem"',
    "",
  ].join("\n"), { mode: 0o755 });
  const serve = (certName, keyName) => {
    fs.copyFileSync(path.join(FIXTURES, certName), path.join(pair, "cert.pem"));
    fs.copyFileSync(path.join(FIXTURES, keyName), path.join(pair, "key.pem"));
  };
  const env = (extra = {}) => ({ ...process.env, TAILSCALE: fake, PAIR_DIR: pair, OPENSSL: openssl, HOLDEM_RENEW_LOCKED: "", ...extra });
  const run = (args = ["mini.tail1234.ts.net", out], extra = {}) => spawnSync("/bin/sh", [SCRIPT, ...args], { encoding: "utf8", env: env(extra) });
  const start = (extra = {}) => spawn("/bin/sh", [SCRIPT, "mini.tail1234.ts.net", out], { env: env(extra), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  return { dir, out, serve, run, start, pair };
}
const read = (file) => fs.readFileSync(file, "utf8");

test("the renewal script installs a matching pair, leaves an unchanged one alone and replaces a new one", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run } = fixture(t);
  serve("a.crt", "a.key");
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated: notAfter=/);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "a.crt")).trim());
  assert.equal(read(path.join(out, "host.key")).trim(), read(path.join(FIXTURES, "a.key")).trim());
  assert.equal(fs.statSync(path.join(out, "host.key")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(out, "host.crt")).mode & 0o777, 0o644);
  const before = fs.statSync(path.join(out, "host.crt")).ino;
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^unchanged: notAfter=/);
  assert.equal(fs.statSync(path.join(out, "host.crt")).ino, before, "an unchanged pair is not rewritten");
  serve("b.crt", "b.key");
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^updated: /);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "b.crt")).trim());
  assert.equal(read(path.join(out, "host.key")).trim(), read(path.join(FIXTURES, "b.key")).trim());
  assert.deepEqual(fs.readdirSync(out).sort(), [".renew.lock", "host.crt", "host.key"], "no temporary files are left");
});

test("the renewal script replaces nothing when the pair does not match or the CLI returns nothing", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, pair } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  serve("b.crt", "a.key");
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /do not match; nothing replaced/);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "a.crt")).trim());
  fs.writeFileSync(path.join(pair, "cert.pem"), "");
  fs.writeFileSync(path.join(pair, "key.pem"), "");
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no certificate or key/);
  assert.equal(read(path.join(out, "host.key")).trim(), read(path.join(FIXTURES, "a.key")).trim());
  assert.deepEqual(fs.readdirSync(out).sort(), [".renew.lock", "host.crt", "host.key"]);
  assert.equal(run(["only-one-arg"]).status, 2);
});

test("the renewal script refuses parts that do not parse, even when both fail alike", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, pair } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  // PEM markers around garbage: the files are not empty, but neither part parses. A pipeline that
  // reported only its last stage would hash two empty outputs and call them a match.
  fs.writeFileSync(path.join(pair, "cert.pem"), "-----BEGIN CERTIFICATE-----\nnot base64 at all\n-----END CERTIFICATE-----\n");
  fs.writeFileSync(path.join(pair, "key.pem"), "-----BEGIN PRIVATE KEY-----\nnot base64 either\n-----END PRIVATE KEY-----\n");
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not parse; nothing replaced/);
  assert.doesNotMatch(result.stdout, /updated/);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "a.crt")).trim());
  assert.equal(read(path.join(out, "host.key")).trim(), read(path.join(FIXTURES, "a.key")).trim());
});

const exited = (child) => new Promise((resolve) => child.once("exit", (code) => resolve(code)));
const collect = (child) => { let text = ""; child.stderr.on("data", (d) => { text += d; }); child.stdout.on("data", (d) => { text += d; }); return () => text; };

test("one renewal at a time per directory: a concurrent run gets 75, the lock ends with its holder", posixOnly, async (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, start } = fixture(t);
  serve("a.crt", "a.key");
  // Two real runs at once: the first holds the lock while its CLI call is slow.
  const first = start({ CLI_SLEEP: "2" });
  const firstOutput = collect(first);
  const firstDone = exited(first);
  t.after(() => { try { process.kill(-first.pid, "SIGKILL"); } catch { /* already gone */ } });
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(out, ".renew.lock")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 300));
  const second = run();
  assert.equal(second.status, 75, second.stderr);
  assert.match(second.stderr, /another renewal is running/);
  assert.equal(await firstDone, 0, firstOutput());
  assert.match(firstOutput(), /updated: /);
  // A run killed mid-way (its whole process group) releases the lock with it: nothing to take over.
  serve("b.crt", "b.key");
  const killed = start({ CLI_SLEEP: "5" });
  const killedDone = exited(killed);
  await new Promise((r) => setTimeout(r, 700));
  process.kill(-killed.pid, "SIGKILL");
  await killedDone;
  const after = run();
  assert.equal(after.status, 0, after.stderr);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "b.crt")).trim());
  assert.deepEqual(fs.readdirSync(out).sort(), [".renew.lock", "host.crt", "host.key"], "the next run clears what the killed run left (it may hold a key copy)");
});

test("a failing CLI leaves the files, no temporary directory and no lock", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, pair } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  fs.rmSync(path.join(pair, "cert.pem"));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tailscale cert failed; nothing replaced/);
  assert.deepEqual(fs.readdirSync(out).sort(), [".renew.lock", "host.crt", "host.key"]);
});

test("every certificate of the chain and the one key must parse", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, pair } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  const unchanged = () => {
    assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "a.crt")).trim());
    assert.equal(read(path.join(out, "host.key")).trim(), read(path.join(FIXTURES, "a.key")).trim());
  };
  // A good leaf and key, then a damaged second certificate: `openssl x509` alone reads only the leaf.
  fs.writeFileSync(path.join(pair, "cert.pem"), read(path.join(FIXTURES, "b.crt")) + "-----BEGIN CERTIFICATE-----\nbroken chain\n-----END CERTIFICATE-----\n");
  fs.copyFileSync(path.join(FIXTURES, "b.key"), path.join(pair, "key.pem"));
  let result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /a certificate in the chain does not parse; nothing replaced/);
  unchanged();
  // A good certificate and a damaged key.
  serve("b.crt", "b.key");
  fs.writeFileSync(path.join(pair, "key.pem"), "-----BEGIN PRIVATE KEY-----\nbroken key\n-----END PRIVATE KEY-----\n");
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /key does not parse; nothing replaced/);
  unchanged();
  // Two keys: which one a server would use is not ours to guess.
  fs.writeFileSync(path.join(pair, "key.pem"), read(path.join(FIXTURES, "b.key")) + read(path.join(FIXTURES, "a.key")));
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected exactly one private key; nothing replaced/);
  unchanged();
});

test("a replace that fails half way puts the previous key back", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { dir, out, serve, run } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  // A mv that refuses only the certificate: the key is replaced first, then the certificate fails.
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const realMv = ["/bin/mv", "/usr/bin/mv"].find((file) => fs.existsSync(file));
  fs.writeFileSync(path.join(bin, "mv"), `#!/bin/sh\ncase "$2" in */host.crt) echo "mv: refused" >&2; exit 1 ;; esac\nexec ${realMv} "$@"\n`, { mode: 0o755 });
  serve("b.crt", "b.key");
  const result = run(undefined, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not replace the certificate; the previous key was put back; nothing replaced/);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "a.crt")).trim());
  assert.equal(read(path.join(out, "host.key")).trim(), read(path.join(FIXTURES, "a.key")).trim(), "the pair on disk still matches");
});

test("an ECDSA key with a certificate chain installs whole", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, run, pair } = fixture(t);
  const ossl = (args) => spawnSync(openssl, args, { encoding: "utf8", cwd: pair });
  // Tailscale serves an ECDSA P-256 key and a leaf followed by its issuer.
  if (ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ec.key"]).status !== 0) return t.skip("openssl cannot make EC keys");
  assert.equal(ossl(["req", "-x509", "-new", "-key", "ec.key", "-out", "leaf.crt", "-days", "2", "-subj", "/CN=mini.tail1234.ts.net"]).status, 0);
  fs.writeFileSync(path.join(pair, "cert.pem"), read(path.join(pair, "leaf.crt")) + read(path.join(FIXTURES, "b.crt")));
  fs.copyFileSync(path.join(pair, "ec.key"), path.join(pair, "key.pem"));
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const installed = read(path.join(out, "host.crt"));
  assert.equal((installed.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length, 2, "the whole chain is kept");
  assert.match(read(path.join(out, "host.key")), /-----BEGIN EC PRIVATE KEY-----/);
  // And the installed pair is what a TLS server can actually load.
  tls.createSecureContext({ cert: fs.readFileSync(path.join(out, "host.crt")), key: fs.readFileSync(path.join(out, "host.key")) });
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
