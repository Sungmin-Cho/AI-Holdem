// scripts/macmini/renew-tailscale-cert.sh: one `tailscale cert` call, a checked pair, and only a
// changed pair replaces the files the remote host listener reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
    'cat "$PAIR_DIR/cert.pem" "$PAIR_DIR/key.pem"',
    "",
  ].join("\n"), { mode: 0o755 });
  const serve = (certName, keyName) => {
    fs.copyFileSync(path.join(FIXTURES, certName), path.join(pair, "cert.pem"));
    fs.copyFileSync(path.join(FIXTURES, keyName), path.join(pair, "key.pem"));
  };
  const run = (args = ["mini.tail1234.ts.net", out]) => spawnSync("/bin/sh", [SCRIPT, ...args], {
    encoding: "utf8", env: { ...process.env, TAILSCALE: fake, PAIR_DIR: pair, OPENSSL: openssl },
  });
  return { out, serve, run, pair };
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
  assert.deepEqual(fs.readdirSync(out).sort(), ["host.crt", "host.key"], "no temporary files are left");
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
  assert.deepEqual(fs.readdirSync(out).sort(), ["host.crt", "host.key"]);
  assert.equal(run(["only-one-arg"]).status, 2);
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
