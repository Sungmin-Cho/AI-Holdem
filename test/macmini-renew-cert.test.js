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
    // With CLI_WAIT set, say "started" and hold until the test releases (no fixed sleeps).
    'if [ -n "${CLI_WAIT:-}" ]; then : > "$PAIR_DIR/started"; i=0; while [ ! -e "$PAIR_DIR/release" ] && [ "$i" -lt 600 ]; do sleep 0.05; i=$((i+1)); done; fi',
    'cat "$PAIR_DIR/cert.pem" "$PAIR_DIR/key.pem"',
    "",
  ].join("\n"), { mode: 0o755 });
  const serve = (certName, keyName) => {
    fs.copyFileSync(path.join(FIXTURES, certName), path.join(pair, "cert.pem"));
    fs.copyFileSync(path.join(FIXTURES, keyName), path.join(pair, "key.pem"));
  };
  const env = (extra = {}) => ({ ...process.env, TAILSCALE: fake, PAIR_DIR: pair, OPENSSL: openssl, HOLDEM_RENEW_TOKEN: "", ...extra });
  const run = (args = ["mini.tail1234.ts.net", out], extra = {}) => spawnSync("/bin/sh", [SCRIPT, ...args], { encoding: "utf8", env: env(extra) });
  const start = (extra = {}) => spawn("/bin/sh", [SCRIPT, "mini.tail1234.ts.net", out], { env: env(extra), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const waitFor = async (predicate, label) => {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  // Is the lock free right now? (a separate non-blocking flock on the same file)
  const lockFree = () => spawnSync("perl", ["-e", 'open(my $f, ">>", shift) or exit 2; exit(flock($f, 6) ? 0 : 1)', path.join(out, ".renew.lock")]).status === 0;
  const started = () => fs.existsSync(path.join(pair, "started"));
  const release = () => fs.writeFileSync(path.join(pair, "release"), "");
  const rearm = () => { for (const name of ["started", "release"]) fs.rmSync(path.join(pair, name), { force: true }); };
  return { dir, out, serve, run, start, pair, waitFor, lockFree, started, release, rearm };
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

test("one renewal at a time per directory, whatever the environment says", posixOnly, async (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, start, waitFor, started, release } = fixture(t);
  serve("a.crt", "a.key");
  const first = start({ CLI_WAIT: "1" });
  const firstOutput = collect(first);
  const firstDone = exited(first);
  t.after(() => { try { process.kill(-first.pid, "SIGKILL"); } catch { /* already gone */ } });
  await waitFor(started, "the first run reached its CLI call");
  for (const token of ["", "1", "0", "not-the-token"]) {
    const second = run(undefined, { HOLDEM_RENEW_TOKEN: token });
    assert.equal(second.status, 75, `token ${JSON.stringify(token)}: ${second.stderr}`);
    assert.match(second.stderr, /another renewal is running/);
  }
  assert.equal(fs.existsSync(path.join(out, ".renew-work")), true, "the first run's working directory survives the refused runs");
  release();
  assert.equal(await firstDone, 0, firstOutput());
  assert.match(firstOutput(), /updated: /);
});

test("the lock ends with the last process holding it; a killed run's leftovers are cleared", posixOnly, async (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { out, serve, run, start, waitFor, lockFree, started, release, rearm } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  serve("b.crt", "b.key");
  // Killing only the shell leaves the lock with its still-running child (the CLI call).
  let victim = start({ CLI_WAIT: "1" });
  let done = exited(victim);
  t.after(() => { try { process.kill(-victim.pid, "SIGKILL"); } catch { /* already gone */ } });
  await waitFor(started, "the CLI call started");
  process.kill(victim.pid, "SIGKILL");
  await done;
  assert.equal(lockFree(), false, "the CLI child still holds the inherited lock");
  release();
  await waitFor(lockFree, "the lock is released once the child exits");
  // Killing the whole run mid-way: the lock goes with it, and the working directory it left
  // (it may hold a key copy) is cleared by the next run.
  rearm();
  victim = start({ CLI_WAIT: "1" });
  done = exited(victim);
  await waitFor(started, "the CLI call started again");
  assert.equal(fs.existsSync(path.join(out, ".renew-work")), true);
  process.kill(-victim.pid, "SIGKILL");
  await done;
  await waitFor(lockFree, "the lock is released with the killed process group");
  const after = run();
  assert.equal(after.status, 0, after.stderr);
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "b.crt")).trim());
  assert.deepEqual(fs.readdirSync(out).sort(), [".renew.lock", "host.crt", "host.key"]);
  assert.equal(read(path.join(out, ".renew.lock")), "", "a finished run leaves no token behind");
});

test("cleanup removes only the script's own working directory", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { dir, serve, run } = fixture(t);
  // An output directory whose own name looks like a temporary one, next to an unrelated backup.
  const out = path.join(dir, ".renew.tls");
  fs.mkdirSync(path.join(out, ".renew.backup"), { recursive: true });
  fs.writeFileSync(path.join(out, ".renew.backup", "keep.txt"), "mine");
  fs.copyFileSync(path.join(FIXTURES, "a.crt"), path.join(out, "host.crt"));
  fs.copyFileSync(path.join(FIXTURES, "a.key"), path.join(out, "host.key"));
  serve("b.crt", "b.key");
  const result = run(["mini.tail1234.ts.net", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(path.join(out, ".renew.backup", "keep.txt")), "mine");
  assert.equal(read(path.join(out, "host.crt")).trim(), read(path.join(FIXTURES, "b.crt")).trim());
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

test("when even the previous key cannot be put back, it is kept beside the pair", posixOnly, (t) => {
  if (!openssl) return t.skip("openssl not installed");
  const { dir, out, serve, run } = fixture(t);
  serve("a.crt", "a.key");
  assert.equal(run().status, 0);
  const bin = path.join(dir, "bin2");
  fs.mkdirSync(bin);
  const realMv = ["/bin/mv", "/usr/bin/mv"].find((file) => fs.existsSync(file));
  fs.writeFileSync(path.join(bin, "mv"), `#!/bin/sh\ncase "$1:$2" in */previous.key:*|*:*/host.crt) echo "mv: refused" >&2; exit 1 ;; esac\nexec ${realMv} "$@"\n`, { mode: 0o755 });
  serve("b.crt", "b.key");
  const result = run(undefined, { PATH: `${bin}:${process.env.PATH}` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /mismatched pair; the previous key is kept at .*host\.key\.previous/);
  assert.equal(read(path.join(out, "host.key.previous")).trim(), read(path.join(FIXTURES, "a.key")).trim());
  assert.equal(fs.statSync(path.join(out, "host.key.previous")).mode & 0o777, 0o600);
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
