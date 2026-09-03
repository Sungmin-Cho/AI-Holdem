import fs from 'node:fs';
import path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function ensureDir(dirPath) {
  const st = lstatOrNull(dirPath);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw coded('UNSAFE_PATH', `${dirPath}는 안전한 디렉터리가 아닙니다.`);
    }
    fs.chmodSync(dirPath, DIR_MODE);
    return;
  }
  fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  const created = fs.lstatSync(dirPath);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw coded('UNSAFE_PATH', `${dirPath}는 안전한 디렉터리가 아닙니다.`);
  }
  fs.chmodSync(dirPath, DIR_MODE);
}

function assertRegularFileOrAbsent(filePath) {
  const st = lstatOrNull(filePath);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
  }
}

function openNoFollow(filePath, flags, mode) {
  return fs.openSync(filePath, flags | NOFOLLOW, mode);
}

export function writeTextSecure(filePath, text) {
  ensureDir(path.dirname(filePath));
  assertRegularFileOrAbsent(filePath);
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let fd;
  try {
    fd = openNoFollow(
      tmpPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      FILE_MODE,
    );
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmpPath, FILE_MODE);
    fs.renameSync(tmpPath, filePath);
    fs.chmodSync(filePath, FILE_MODE);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* close best-effort */ }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* leftover tmp is harmless */ }
    throw error;
  }
}

export function writeJsonSecure(filePath, obj) {
  writeTextSecure(filePath, JSON.stringify(obj));
}

export function readJsonSecure(filePath) {
  assertRegularFileOrAbsent(filePath);
  const fd = openNoFollow(filePath, fs.constants.O_RDONLY);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function lastNewlineOffset(buffer) {
  for (let i = buffer.length - 1; i >= 0; i -= 1) {
    if (buffer[i] === 0x0a) return i;
  }
  return -1;
}

export function appendJsonl(filePath, record) {
  ensureDir(path.dirname(filePath));
  assertRegularFileOrAbsent(filePath);
  const line = `${JSON.stringify(record)}\n`;
  let fd;
  try {
    try {
      fd = openNoFollow(filePath, fs.constants.O_RDWR);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fd = openNoFollow(
        filePath,
        fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
        FILE_MODE,
      );
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
    let size = st.size;
    if (size > 0) {
      // Walk back a window at a time until a newline turns up. Scanning one
      // 64KiB window and giving up truncated a longer torn line to a point that
      // was still mid-line, which left the file corrupt instead of repairing it.
      const window = 64 * 1024;
      let end = size;
      let recovered = null;
      let complete = false;
      while (end > 0) {
        const chunk = Math.min(window, end);
        const buf = Buffer.alloc(chunk);
        fs.readSync(fd, buf, 0, chunk, end - chunk);
        if (end === size && buf[buf.length - 1] === 0x0a) {
          complete = true;
          break;
        }
        const nl = lastNewlineOffset(buf);
        if (nl !== -1) {
          recovered = end - chunk + nl + 1;
          break;
        }
        end -= chunk;
      }
      if (!complete) {
        // No newline anywhere means the whole file is one torn line.
        size = recovered ?? 0;
        fs.ftruncateSync(fd, size);
      }
    }
    fs.writeSync(fd, line, size, 'utf8');
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, FILE_MODE);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function readJsonl(filePath) {
  // O_NOFOLLOW instead of lstat-then-read: the check and the read are the same
  // syscall, so the path cannot become a symlink in between.
  let fd;
  let raw;
  try {
    fd = openNoFollow(filePath, fs.constants.O_RDONLY);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    if (error.code === 'ELOOP' || error.code === 'EMLINK' || error.code === 'EISDIR') {
      throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
    }
    throw error;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
    raw = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  const rows = [];
  const parts = raw.split('\n');
  const last = parts[parts.length - 1];
  const complete = last === '' ? parts.slice(0, -1) : parts.slice(0, -1);
  for (const part of complete) {
    if (part.length === 0) continue;
    rows.push(JSON.parse(part));
  }
  return rows;
}

function assertSafeSegment(segment) {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw coded('BAD_SEGMENT', '경로 세그먼트가 비어 있습니다.');
  }
  if (segment === '.' || segment === '..') {
    throw coded('BAD_SEGMENT', `경로 세그먼트가 허용되지 않습니다: ${segment}`);
  }
  if (path.isAbsolute(segment)) {
    throw coded('BAD_SEGMENT', `절대 경로 세그먼트는 허용되지 않습니다: ${segment}`);
  }
  if (segment.includes('\0') || segment.includes('/') || segment.includes('\\')) {
    throw coded('BAD_SEGMENT', `경로 세그먼트에 구분자가 있습니다: ${segment}`);
  }
}

function inspectDirectory(dirPath) {
  const st = fs.lstatSync(dirPath);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw coded('UNSAFE_PATH', `${dirPath}는 안전한 디렉터리가 아닙니다.`);
  }
  return { path: dirPath, dev: st.dev, ino: st.ino };
}

function walkAncestors(root, dirSegments) {
  const ancestors = [inspectDirectory(root)];
  let current = root;
  for (const segment of dirSegments) {
    current = path.join(current, segment);
    ancestors.push(inspectDirectory(current));
  }
  return ancestors;
}

function reinspectAncestors(ancestors) {
  for (const ancestor of ancestors) {
    const st = fs.lstatSync(ancestor.path);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw coded('UNSAFE_PATH', `${ancestor.path}는 안전한 디렉터리가 아닙니다.`);
    }
    if (st.dev !== ancestor.dev || st.ino !== ancestor.ino) {
      throw coded('UNSAFE_PATH', `${ancestor.path}가 열기 이후 교체되었습니다.`);
    }
  }
}

function mapOpenError(error, filePath) {
  if (error?.code === 'ELOOP' || error?.code === 'EMLINK' || error?.code === 'EISDIR') {
    return coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
  }
  return error;
}

function uniqueTmpPath(dir, destName) {
  return path.join(dir, `.${destName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

function unlinkTmpIfOurs(tmpPath, tmpId, ancestors) {
  try {
    reinspectAncestors(ancestors);
    const st = fs.lstatSync(tmpPath);
    if (st.isSymbolicLink() || !st.isFile()) return;
    if (st.dev !== tmpId.dev || st.ino !== tmpId.ino) return;
    fs.unlinkSync(tmpPath);
  } catch {
    /* best-effort: never unlink through a replaced ancestor */
  }
}

/**
 * Read a file under `root` by single-component segments.
 * Inspect-open-reinspect is not complete containment (Node has no openat).
 */
export function openContained(root, segments, { maxBytes } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw coded('BAD_SEGMENT', '경로 세그먼트가 비어 있습니다.');
  }
  for (const segment of segments) assertSafeSegment(segment);
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw coded('TOO_LARGE', 'maxBytes가 올바르지 않습니다.');
  }

  const dirSegments = segments.slice(0, -1);
  const ancestors = walkAncestors(root, dirSegments);
  const filePath = path.join(root, ...segments);

  let fd;
  try {
    try {
      fd = openNoFollow(filePath, fs.constants.O_RDONLY);
    } catch (error) {
      throw mapOpenError(error, filePath);
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
    if (st.size > maxBytes) throw coded('TOO_LARGE', `${filePath}가 maxBytes를 초과합니다.`);
    reinspectAncestors(ancestors);
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = fs.readSync(fd, buf, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buf.subarray(0, offset);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Write `bytes` under `root` by single-component segments.
 * `create` uses link(tmp, dest) (EEXIST → EXISTS); `replace` uses rename.
 */
export function writeContained(root, segments, bytes, { mode } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw coded('BAD_SEGMENT', '경로 세그먼트가 비어 있습니다.');
  }
  for (const segment of segments) assertSafeSegment(segment);
  if (mode !== 'create' && mode !== 'replace') {
    throw coded('BAD_MODE', `writeContained mode가 올바르지 않습니다: ${mode}`);
  }

  const dirSegments = segments.slice(0, -1);
  const ancestors = walkAncestors(root, dirSegments);
  const destPath = path.join(root, ...segments);
  const destDir = dirSegments.length === 0 ? root : path.join(root, ...dirSegments);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  const tmpPath = uniqueTmpPath(destDir, segments[segments.length - 1]);

  let fd;
  let tmpId;
  let published = false;
  const closeFd = () => {
    if (fd === undefined) return;
    try { fs.closeSync(fd); } catch { /* close best-effort */ }
    fd = undefined;
  };
  const wipeOpenTmp = () => {
    if (fd === undefined) return;
    try { fs.ftruncateSync(fd, 0); } catch { /* best-effort neutralize */ }
    try { fs.fsyncSync(fd); } catch { /* fsync may be the injected failure */ }
    closeFd();
  };
  try {
    try {
      fd = openNoFollow(
        tmpPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        FILE_MODE,
      );
    } catch (error) {
      throw mapOpenError(error, tmpPath);
    }
    const opened = fs.fstatSync(fd);
    tmpId = { dev: opened.dev, ino: opened.ino };
    fs.writeFileSync(fd, buf);
    fs.fchmodSync(fd, FILE_MODE);
    fs.fsyncSync(fd);
    reinspectAncestors(ancestors);
    if (mode === 'replace') {
      fs.renameSync(tmpPath, destPath);
      published = true;
      tmpId = undefined;
    } else {
      try {
        fs.linkSync(tmpPath, destPath);
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw coded('EXISTS', `${destPath}가 이미 있습니다.`);
        }
        throw error;
      }
      published = true;
      unlinkTmpIfOurs(tmpPath, tmpId, ancestors);
      tmpId = undefined;
    }
    closeFd();
  } catch (error) {
    if (published) closeFd();
    else wipeOpenTmp();
    if (!published && tmpId) unlinkTmpIfOurs(tmpPath, tmpId, ancestors);
    throw error;
  }
}
