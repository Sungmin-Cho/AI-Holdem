import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePreflopJson } from '../training/providers/preflop-json.js';
import { ERRORS, coded } from '../training/contracts.js';

export const DEFAULT_DATASET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../training/data/preflop-baseline-v1.json',
);

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
    } catch {
      throw coded(ERRORS.DATASET_INVALID, 'dataset digest 파일을 읽을 수 없습니다.');
    }
  }
  let raw;
  try {
    raw = fs.readFileSync(datasetPath, 'utf8');
  } catch {
    throw coded(ERRORS.DATASET_INVALID, 'dataset 파일을 읽을 수 없습니다.');
  }
  return parsePreflopJson(raw, { expectedSha256: pinned });
}
