// One contender: take withNamedLock once on a dead publish.lock.d and record
// the lock directory inode and pid-file contents across the critical section.
// `node --test` also walks test/helpers/*.mjs, so stay inert under the runner.
import fs from 'node:fs';
import path from 'node:path';
import { withNamedLock } from '../../engine/state.js';

if (process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-'))) {
  /* collected as a test file; the parent lock-race test spawns this as a child */
} else {

const [dir, out] = process.argv.slice(2);
const lockDir = path.join(dir, 'publish.lock.d');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readPid = () => {
  try { return fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'); }
  catch (error) { return `ERR:${error.code}`; }
};
const inode = () => {
  try { return String(fs.statSync(lockDir, { bigint: true }).ino); }
  catch (error) { return `ERR:${error.code}`; }
};

let rec;
try {
  rec = await withNamedLock(dir, 'publish.lock.d', async () => {
    const enter = process.hrtime.bigint();
    const inoEnter = inode();
    const pidEnter = readPid();
    await sleep(15);
    const pidExit = readPid();
    const inoExit = inode();
    const exit = process.hrtime.bigint();
    return {
      pid: process.pid,
      enter: String(enter),
      exit: String(exit),
      inoEnter,
      inoExit,
      pidEnter,
      pidExit,
    };
  }, { timeoutMs: 30_000 });
} catch (error) {
  rec = {
    pid: process.pid,
    error: error.code || error.message,
    syscall: error.syscall,
    path: error.path,
    dest: error.dest,
  };
}
fs.writeFileSync(out, JSON.stringify(rec));
}
