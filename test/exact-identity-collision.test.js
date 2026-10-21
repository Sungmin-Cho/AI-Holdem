import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createOwnedTempDir } from './helpers/owned-fixtures.mjs';
import { collideIdentity, FAR, NEAR } from './helpers/colliding-identity.mjs';
import { readPrivateJson } from '../tools/app-files.js';
import { openContained } from '../tools/training-store.js';
import { createRelayRootOwner } from '../server/action-receipts.js';
import { readRejectionRecords, REJECTION_LOG } from '../tools/rejection-audit.js';

// #308: each check that a path still names the file it inspected compares exact IDs. Here the
// path and the open descriptor (or a later look at the path) name two files whose IDs differ only
// past 2^53, where a Number-valued stat reads them as one. Each case also runs with the same ID on
// both sides, so a refusal is the ID comparison and not the stand-in stats.
function underCollision(target, ids, run) {
  const restore = collideIdentity(target, ids);
  try { return run(); } finally { restore(); }
}

test('#308 a private JSON read refuses a descriptor whose ID differs from its path only past 2^53', () => {
  const root = createOwnedTempDir('holdem-collide-app-files');
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, '{"ok":true}', { mode: 0o600 });
  assert.deepEqual(underCollision(file, { pathIno: () => FAR }, () => readPrivateJson(file)), { ok: true });
  assert.throws(() => underCollision(file, { pathIno: () => FAR, fdIno: () => NEAR }, () => readPrivateJson(file)),
    { code: 'APP_FILE_INVALID' });
});

test('#308 a contained read refuses a descriptor whose ID differs from its preinspection only past 2^53', () => {
  const root = createOwnedTempDir('holdem-collide-contained');
  fs.writeFileSync(path.join(root, 'record.json'), '{"ok":true}', { mode: 0o600 });
  const file = path.join(root, 'record.json');
  const read = () => openContained(root, ['record.json'], { maxBytes: 1024 }).toString('utf8');
  assert.equal(underCollision(file, { pathIno: () => FAR }, read), '{"ok":true}');
  assert.throws(() => underCollision(file, { pathIno: () => FAR, fdIno: () => NEAR }, read), { code: 'UNSAFE_PATH' });
});

test('#308 a relay root owner refuses a root whose ID changed only past 2^53', () => {
  const root = createOwnedTempDir('holdem-collide-relay-root');
  const same = collideIdentity(root, { pathIno: () => FAR });
  try {
    const owner = createRelayRootOwner(root);
    assert.doesNotThrow(() => owner.assert());
  } finally { same(); }
  const replaced = collideIdentity(root, { pathIno: (n) => (n === 0 ? FAR : NEAR) });
  try {
    const owner = createRelayRootOwner(root);
    assert.throws(() => owner.assert(), { code: 'RELAY_ROOT_CHANGED' });
  } finally { replaced(); }
});

test('#308 the rejection audit refuses a log whose descriptor ID differs from its path only past 2^53', () => {
  const root = createOwnedTempDir('holdem-collide-rejections');
  const file = path.join(root, REJECTION_LOG);
  fs.writeFileSync(file, '', { mode: 0o600 });
  assert.deepEqual(underCollision(file, { pathIno: () => FAR }, () => readRejectionRecords(root)), []);
  assert.throws(() => underCollision(file, { pathIno: () => FAR, fdIno: () => NEAR }, () => readRejectionRecords(root)),
    { code: 'REJECTION_AUDIT_UNSAFE' });
});
