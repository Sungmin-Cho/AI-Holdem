import { openContained } from './training-store.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePreflopJson } from '../training/providers/preflop-json.js';
import { ERRORS, coded } from '../training/contracts.js';
import { KNOWN_REFERENCE_SOURCES, sameReferenceSource } from '../shared/reference.js';

export const DEFAULT_DATASET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../training/data/preflop-baseline-v1.json',
);

function withCause(error, cause) {
  error.cause = cause;
  return error;
}

export function datasetDigestPath(datasetPath) {
  return datasetPath.replace(/\.json$/, '.sha256');
}

/**
 * Reads the dataset and its pinned digest from disk, then hands the bytes to
 * the pure parser. This is the only place the preflop dataset touches the
 * filesystem, so the digest pin (R5) cannot be bypassed by a second reader.
 */
export function loadPreflopDataset(datasetPath = DEFAULT_DATASET, { expectedSha256 } = {}) {
  let pinned = expectedSha256;
  if (pinned == null) {
    try {
      pinned = fs.readFileSync(datasetDigestPath(datasetPath), 'utf8').trim();
    } catch (error) {
      // 코드는 하나로 모으되 원인은 버리지 않는다 — 이전에는 ENOENT가 그대로
      // 올라와 어느 파일이 없는지 보였다.
      throw withCause(coded(ERRORS.DATASET_INVALID, `dataset digest 파일을 읽을 수 없습니다: ${error.message}`), error);
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(datasetPath, 'utf8');
  } catch (error) {
    throw withCause(coded(ERRORS.DATASET_INVALID, `dataset 파일을 읽을 수 없습니다: ${error.message}`), error);
  }
  return parsePreflopJson(raw, { expectedSha256: pinned });
}

const bundled = new Map();
export function loadReferenceDataset(source) {
  const known = KNOWN_REFERENCE_SOURCES.find(s => sameReferenceSource(s, source));
  if (!known) throw coded('SOURCE_UNAVAILABLE', 'Unknown reference source');
  const key = `${known.id}@${known.version}:${known.contentSha256}`;
  if (!bundled.has(key)) {
    const file = new URL(`../training/data/preflop-baseline-v${known.version.split('.')[0]}.json`, import.meta.url);
    const filename = fileURLToPath(file);
    const parsed = parsePreflopJson(openContained(path.dirname(filename),[path.basename(filename)],{maxBytes:8*1024*1024}).toString('utf8'), { expectedSha256: known.contentSha256 });
    if (!sameReferenceSource({...parsed.data, contentSha256:parsed.contentSha256}, known)) {
      throw coded('SOURCE_UNAVAILABLE', 'Reference identity mismatch');
    }
    bundled.set(key, Object.freeze(parsed));
  }
  return bundled.get(key);
}
