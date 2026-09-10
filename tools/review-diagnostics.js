import fs from 'node:fs';
import path from 'node:path';
import { createPrivateDirectory, arePrivatePaths } from '../shared/platform-files.js';

export const REVIEW_DIAGNOSTIC_MAX_BYTES = 16 * 1024;
const INPUT_MAX_CHARS = 1024 * 1024;

function bounded(text, bytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= bytes) return text;
  // Decode only complete UTF-8 characters at the cut.
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function sanitizeReviewDiagnostic(value, secrets = [], maxBytes = REVIEW_DIAGNOSTIC_MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Invalid diagnostic byte cap');
  if (typeof value !== 'string') return '';
  if (value.length > INPUT_MAX_CHARS) return bounded('[oversized diagnostic omitted]', maxBytes);
  // Normalize separators before redaction; removing them afterwards can restore
  // a secret that did not match its split representation.
  let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/g, '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[REDACTED]');
  }
  text = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED KEY]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, '[REDACTED AUTH]')
    .replace(/(["']?(?:[\w-]*(?:token|password|secret|api[_-]?key))["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&<>]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, '[REDACTED KEY]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[REDACTED URL]');
  const marker = '\n[truncated]';
  if (maxBytes < Buffer.byteLength(marker)) return bounded(text, maxBytes);
  return Buffer.byteLength(text) > maxBytes
    ? bounded(text, maxBytes - Buffer.byteLength(marker)) + marker
    : text;
}

// Four fixed slots bound retention across resumes. Rejected output is never a
// review input or a publishable artifact. Privacy failure omits diagnostics only.
export function preserveReviewFailure(root, { stage, attempt, raw, secrets = [] }) {
  if (!['evaluator', 'synthesizer'].includes(stage) || ![1, 2].includes(attempt)) {
    throw new Error('Invalid review diagnostic slot');
  }
  if (typeof raw !== 'string') return { outputStatus: 'unavailable' };
  let temporary;
  try {
    const parent = fs.lstatSync(root);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('unsafe root');
    const directory = path.join(root, '.review-diagnostics');
    try { fs.lstatSync(directory); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { createPrivateDirectory(directory); } catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
    }
    const directoryStat = fs.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('unsafe directory');
    const proofs = [{ file: directory }];
    const name = `${stage}-${attempt}.txt`;
    const target = path.join(directory, name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('unsafe slot');
      proofs.push({ file: target });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The loop owns the session exclusively. One fixed scratch slot also bounds
    // retained output after crashes; verify a leftover before removing it.
    const scratch = path.join(directory, '.pending.tmp');
    try {
      const stat = fs.lstatSync(scratch);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
        || !arePrivatePaths([...proofs, { file: scratch }])) throw new Error('unsafe scratch');
      fs.unlinkSync(scratch);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    // Verify inherited Windows ACL before writing rejected content.
    fs.writeFileSync(scratch, '', { flag: 'wx', mode: 0o600 });
    temporary = scratch;
    if (!arePrivatePaths([...proofs, { file: temporary }])) throw new Error('unsafe temporary');
    const text = sanitizeReviewDiagnostic(raw, secrets);
    fs.writeFileSync(temporary, text, { encoding: 'utf8', flag: 'r+' });
    fs.renameSync(temporary, target);
    temporary = null;
    return { outputStatus: 'saved', outputPath: `.review-diagnostics/${name}`, outputBytes: Buffer.byteLength(text) };
  } catch {
    return { outputStatus: 'not_saved' };
  } finally {
    if (temporary) try { fs.unlinkSync(temporary); } catch { /* best effort */ }
  }
}
