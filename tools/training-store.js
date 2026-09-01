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
      const tailSize = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(tailSize);
      fs.readSync(fd, buf, 0, tailSize, size - tailSize);
      if (buf[buf.length - 1] !== 0x0a) {
        const nl = lastNewlineOffset(buf);
        size = nl === -1 ? size - tailSize : size - tailSize + nl + 1;
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
  const st = lstatOrNull(filePath);
  if (!st) return [];
  if (st.isSymbolicLink() || !st.isFile()) {
    throw coded('UNSAFE_PATH', `${filePath}는 안전한 일반 파일이 아닙니다.`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
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
