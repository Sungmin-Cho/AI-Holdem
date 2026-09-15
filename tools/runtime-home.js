// 스토어별 grok 격리 홈. 프로비저닝·재검증은 동기 fs만 쓴다(oneshotStart 즉시 반환 계약).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const IDENTITY_NAME = '.ai-holdem-home.json';
const CONFIG_REL = path.join('.grok', 'config.toml');
export const GROK_CONFIG_BODY = '[features]\nbackend_tools = false\n';
const FORBIDDEN_TABLES = new Set(['hooks', 'permission', 'plugins', 'mcp_servers', 'mcp']);
const SOCK_REL = path.join('.grok', 'leader.sock');
const SOCK_MAX_BYTES = 100;

function coded(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function lstatDirStrict(target, uid) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 홈 구성요소를 읽지 못했습니다.');
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 홈 구성요소가 디렉터리가 아닙니다.');
  }
  if (uid != null && st.uid !== uid) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 홈 구성요소 소유자가 현재 uid가 아닙니다.');
  }
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 홈 구성요소 권한이 0700이 아닙니다.');
  }
  return st;
}

function lstatFile0600(target, uid) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 정체성·설정 파일을 읽지 못했습니다.');
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 정체성·설정 파일이 일반 파일이 아닙니다.');
  }
  if (uid != null && st.uid !== uid) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 파일 소유자가 현재 uid가 아닙니다.');
  }
  if (process.platform !== 'win32' && (st.mode & 0o777) !== 0o600) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 파일 권한이 0600이 아닙니다.');
  }
  return st;
}

function mkdirComponent(target, uid) {
  if (!fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
  lstatDirStrict(target, uid);
}

function parseSimpleToml(text) {
  const tables = { '': {} };
  let current = '';
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      current = table[1].trim();
      if (!tables[current]) tables[current] = {};
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error('TOML_PARSE');
    let value = kv[2].trim();
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    tables[current][kv[1]] = value;
  }
  return tables;
}

function verifyConfigFile(configPath, uid) {
  lstatFile0600(configPath, uid);
  let tables;
  try {
    tables = parseSimpleToml(fs.readFileSync(configPath, 'utf8'));
  } catch {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 격리 홈 config.toml을 파싱하지 못했습니다.');
  }
  for (const name of FORBIDDEN_TABLES) {
    if (Object.prototype.hasOwnProperty.call(tables, name)) {
      throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 격리 홈 config.toml에 금지된 테이블이 있습니다.');
    }
  }
  if (!tables.features || tables.features.backend_tools !== false) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: backend_tools = false 가 아닙니다.');
  }
}

function readIdentity(identityPath, uid, expectedLockRoot) {
  lstatFile0600(identityPath, uid);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
  } catch {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 정체성 파일이 손상됐습니다.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 정체성 파일이 객체가 아닙니다.');
  }
  if (parsed.version !== 1 || parsed.kind !== 'grok' || typeof parsed.homeId !== 'string' || !parsed.homeId) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 정체성 파일 필드가 올바르지 않습니다.');
  }
  if (typeof parsed.lockRoot !== 'string' || parsed.lockRoot !== expectedLockRoot) {
    throw coded('RUNTIME_HOME_MISMATCH', 'RUNTIME_HOME_MISMATCH: 정체성 파일의 lockRoot가 일치하지 않습니다.');
  }
  return parsed;
}

export function runtimeHomeKey(lockRoot) {
  const realLock = fs.realpathSync(lockRoot);
  return crypto.createHash('sha256').update(realLock).digest('hex').slice(0, 16);
}

export function provisionRuntimeHome({ anchorRoot, lockRoot, kind }) {
  if (kind !== 'grok') {
    throw coded('RUNTIME_HOME_INVALID', `RUNTIME_HOME_INVALID: 지원하지 않는 kind ${kind}`);
  }
  if (typeof anchorRoot !== 'string' || !anchorRoot || typeof lockRoot !== 'string' || !lockRoot) {
    throw coded('RUNTIME_HOME_REQUIRED', 'RUNTIME_HOME_REQUIRED: lockRoot가 필요합니다.');
  }
  const uid = currentUid();
  const realLock = fs.realpathSync(lockRoot);
  const key = runtimeHomeKey(realLock);
  const keyDir = path.join(anchorRoot, key);
  const home = path.join(keyDir, kind);

  mkdirComponent(anchorRoot, uid);
  mkdirComponent(keyDir, uid);
  mkdirComponent(home, uid);

  const sockPath = path.join(home, SOCK_REL);
  if (Buffer.byteLength(sockPath) > SOCK_MAX_BYTES) {
    throw coded('RUNTIME_HOME_PATH_TOO_LONG', 'RUNTIME_HOME_PATH_TOO_LONG: 격리 홈 소켓 경로가 너무 깁니다.');
  }

  const grokDir = path.join(home, '.grok');
  mkdirComponent(grokDir, uid);

  const identityPath = path.join(home, IDENTITY_NAME);
  if (!fs.existsSync(identityPath)) {
    const identity = {
      version: 1,
      kind,
      lockRoot: realLock,
      homeId: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const fd = fs.openSync(identityPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(identity)}\n`);
    } finally {
      fs.closeSync(fd);
    }
  }
  const identity = readIdentity(identityPath, uid, realLock);

  const configPath = path.join(home, CONFIG_REL);
  if (!fs.existsSync(configPath)) {
    const fd = fs.openSync(configPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, GROK_CONFIG_BODY);
    } finally {
      fs.closeSync(fd);
    }
  }
  verifyConfigFile(configPath, uid);

  return { home, homeId: identity.homeId, lockRoot: realLock, key };
}

export function verifyRuntimeHome({ home, lockRoot, kind, homeId }) {
  if (kind !== 'grok') {
    throw coded('RUNTIME_HOME_INVALID', `RUNTIME_HOME_INVALID: 지원하지 않는 kind ${kind}`);
  }
  const uid = currentUid();
  const realLock = fs.realpathSync(lockRoot);
  lstatDirStrict(home, uid);
  const grokDir = path.join(home, '.grok');
  lstatDirStrict(grokDir, uid);
  const identity = readIdentity(path.join(home, IDENTITY_NAME), uid, realLock);
  if (homeId != null && identity.homeId !== homeId) {
    throw coded('RUNTIME_HOME_INVALID', 'RUNTIME_HOME_INVALID: 정체성 파일의 homeId가 일치하지 않습니다.');
  }
  verifyConfigFile(path.join(home, CONFIG_REL), uid);
  const sockPath = path.join(home, SOCK_REL);
  if (Buffer.byteLength(sockPath) > SOCK_MAX_BYTES) {
    throw coded('RUNTIME_HOME_PATH_TOO_LONG', 'RUNTIME_HOME_PATH_TOO_LONG: 격리 홈 소켓 경로가 너무 깁니다.');
  }
  return identity;
}

export function grokSessionDir(home, cwd, sessionId) {
  const encoded = encodeURIComponent(fs.realpathSync(cwd));
  return path.join(home, '.grok', 'sessions', encoded, sessionId);
}
