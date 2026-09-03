import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePreflopJson } from '../training/providers/preflop-json.js';
import { ERRORS, coded } from '../training/contracts.js';

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
