import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './owned-fixtures.mjs';

// #339, #343: a fetch that never settles, whatever its signal does — the worst case on every
// Node version, where the real one (a listener that drops the connection before it reads the
// request) is a race at connection setup. Load the preload into a one-shot process with
// `node --require <preload>`, or with NODE_OPTIONS=--require=<preload> through npm, and set
// stallEnv(): only the named route stalls; every other request is real.
//
// Stage `request` (the default) is a fetch that never settles; stage `body` answers 200 at once
// with a body that never ends; stage `redirect` sends the request, for real, to the same path on
// another origin (a listener whose answer misbehaves on a real socket). `after` lets that many
// calls to the route through untouched first. The process writes down its own moments,
// synchronously, with the system monotonic clock — a parent that registers its child (a
// synchronous identity probe, up to 15s on Windows) observes the exit late:
//   calls  one line per intercepted call: the moment it was called
//   report one JSON line per intercepted call whose signal aborted: { calledAt, abortedAt }
//   exit   the moment the process exited, written only by a process that intercepted a call
//          (npm, which loads the preload too through NODE_OPTIONS, never does)
export function writeStallingFetch() {
  const dir = createOwnedTempDir('holdem-stall');
  const preload = path.join(dir, 'stall-fetch.cjs');
  fs.writeFileSync(preload, [
    "const fs = require('node:fs');",
    'const route = process.env.HOLDEM_TEST_STALL_ROUTE;',
    "const stage = process.env.HOLDEM_TEST_STALL_STAGE ?? 'request';",
    'const after = Number(process.env.HOLDEM_TEST_STALL_AFTER ?? 0);',
    'const target = process.env.HOLDEM_TEST_STALL_TARGET;',
    'let passed = 0;',
    'const calls = process.env.HOLDEM_TEST_STALL_CALLS;',
    'const report = process.env.HOLDEM_TEST_STALL_REPORT;',
    'const exitReport = process.env.HOLDEM_TEST_STALL_EXIT_REPORT;',
    'let stalled = false;',
    "if (exitReport) process.on('exit', () => { if (stalled) fs.writeFileSync(exitReport, String(process.hrtime.bigint())); });",
    'const realFetch = globalThis.fetch;',
    'globalThis.fetch = (url, init = {}) => {',
    '  const requested = new URL(String(url));',
    '  if (requested.pathname !== route || passed++ < after) return realFetch(url, init);',
    '  stalled = true;',
    '  const calledAt = String(process.hrtime.bigint());',
    "  if (calls) fs.appendFileSync(calls, calledAt + '\\n');",
    "  init.signal?.addEventListener('abort', () => {",
    "    fs.appendFileSync(report, JSON.stringify({ calledAt, abortedAt: String(process.hrtime.bigint()) }) + '\\n');",
    '  }, { once: true });',
    "  if (stage === 'redirect') return realFetch(new URL(requested.pathname + requested.search, target), init);",
    "  if (stage === 'body') {",
    '    const endless = new ReadableStream({ pull: () => new Promise(() => {}) });',
    "    return Promise.resolve(new Response(endless, { status: 200, headers: { 'content-type': 'application/json' } }));",
    '  }',
    '  return new Promise(() => {});',
    '};',
    '',
  ].join('\n'));
  return {
    preload,
    calls: path.join(dir, 'calls.txt'),
    report: path.join(dir, 'abort.json'),
    exitReport: path.join(dir, 'exit.txt'),
  };
}

export function stallEnv(stall, route, stage = 'request', { after = 0, target } = {}) {
  return {
    HOLDEM_TEST_STALL_ROUTE: route,
    HOLDEM_TEST_STALL_STAGE: stage,
    HOLDEM_TEST_STALL_AFTER: String(after),
    ...(target ? { HOLDEM_TEST_STALL_TARGET: target } : {}),
    HOLDEM_TEST_STALL_CALLS: stall.calls,
    HOLDEM_TEST_STALL_REPORT: stall.report,
    HOLDEM_TEST_STALL_EXIT_REPORT: stall.exitReport,
  };
}

// NODE_OPTIONS splits on spaces outside double quotes, and inside them a backslash escapes the next
// character: a Windows path is quoted with its backslashes (and any quote) escaped.
export const nodeOptionsRequire = (preload) => `--require="${preload.replace(/[\\"]/g, (c) => `\\${c}`)}"`;

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

/** The moments the stalled calls were made, in order: bigint nanoseconds. */
export const stalledCalls = (stall) => lines(stall.calls).map((line) => BigInt(line));
/** Every stalled call whose signal aborted: { calledAt, abortedAt } in bigint nanoseconds. */
export const stalledAborts = (stall) => lines(stall.report).map((line) => {
  const { calledAt, abortedAt } = JSON.parse(line);
  return { calledAt: BigInt(calledAt), abortedAt: BigInt(abortedAt) };
});
/** The moment the stalling process exited, or null when it recorded none. */
export const stalledExit = (stall) => (fs.existsSync(stall.exitReport) ? BigInt(fs.readFileSync(stall.exitReport, 'utf8')) : null);
export const msBetween = (from, to) => Number(to - from) / 1e6;
