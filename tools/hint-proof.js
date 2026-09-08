import fs from 'node:fs';
import path from 'node:path';
import { readSessionReference } from './reference-source.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { buildPreActionHint, recommendationHash } from '../training/pre-action-hint.js';
import { observationHash, canonicalJson } from '../shared/decision-observation.js';
import { projectHint } from '../shared/hint-contract.js';
import { sameReferenceSource } from '../shared/reference.js';
import { gameEpochOf } from '../publish-contract.js';

async function readBounded(root, name, maxBytes) {
  let timer;
  try {
    return await Promise.race([
      readEvidence(root,name,maxBytes),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('hint evidence deadline')),1000);timer.unref?.();}),
    ]);
  } finally { clearTimeout(timer); }
}
async function readEvidence(root, name, maxBytes) {
  const file = path.join(root,name);
  const before = await fs.promises.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('unsafe hint evidence');
  const handle = await fs.promises.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error('changed hint evidence');
    const bytes = Buffer.alloc(stat.size+1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const after = await fs.promises.lstat(file);
    if (bytesRead !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw new Error('changed hint evidence');
    return { raw:bytes.subarray(0,bytesRead).toString('utf8'), dev:stat.dev, ino:stat.ino };
  } finally { await handle.close(); }
}

/** The sole relay façade: bounded read-only I/O, pure reference computation.
 * `context` belongs to one relay lifetime; a changed source stays unavailable. */
export async function verifyHintPublication({ sessionDir, token, context, initialize = false, hint, view }) {
  if (initialize) {
    context.ready = false; context.cache = new Map(); context.queryCount = 0; context.probe = null;
    try {
      context.root = await fs.promises.realpath(sessionDir);
      const state = JSON.parse((await readBounded(context.root,'state.json',2*1024*1024)).raw);
      if (state.sessionToken !== token || state.config?.hintContractVersion !== 1 || state.config.hints !== 'on') return {ready:false};
      const before = await readBounded(context.root,'reference-source.json',4096);
      context.source = readSessionReference(context.root,{expectedDescriptor:before.raw});
      if (context.source.version !== '2.0.0') return {ready:false};
      context.dataset = loadReferenceDataset(context.source);
      context.descriptor = await readBounded(context.root,'reference-source.json',4096);
      if (before.raw !== context.descriptor.raw || before.dev !== context.descriptor.dev || before.ino !== context.descriptor.ino) throw new Error('source changed during initialization');
      context.ready = true;
    } catch { context.ready = false; }
    return {ready:context.ready};
  }
  if (hint == null) return { hint:null, disposition:null };
  let value;
  try { value=projectHint(hint); } catch { return {hint:null,disposition:'mismatch'}; }
  if (!context.ready) return {hint:null,disposition:'unverifiable'};
  try {
    // Share only concurrent reads, never a past decision's identity.
    if (!context.probe) {
      context.probe = Promise.all([readBounded(context.root,'state.json',2*1024*1024),readBounded(context.root,'reference-source.json',4096)]);
      context.probe.finally(() => {context.probe=null;}).catch(()=>{});
    }
    const [observed,descriptor] = await context.probe;
    if (descriptor.raw!==context.descriptor.raw || descriptor.dev!==context.descriptor.dev || descriptor.ino!==context.descriptor.ino) {
      context.ready=false;return {hint:null,disposition:'unverifiable'};
    }
    const state=JSON.parse(observed.raw);
    const decisionId=state.hand?`d-${state.handNo}-${state.hand.street}-${state.hand.actionIndex}`:null;
    if (state.sessionToken!==token || state.config?.hintContractVersion!==1 || state.config.hints!=='on') return {hint:null,disposition:'unverifiable'};
    if (value.gameEpoch!==gameEpochOf(token) || value.decisionId!==decisionId || value.stateVersion!==state.stateVersion
      || value.handNo!==state.handNo || view?.legal?.decisionId!==decisionId || view?.legal?.toAct!=='user') return {hint:null,disposition:'stale-stripped'};
    if (value.status!=='supported') return {hint:value,disposition:null};
    const marker=state.hand.hintExposures?.[decisionId];
    if (!marker || marker.exposureId!==value.exposureId || !sameReferenceSource(marker.source,context.source)
      || observationHash(marker.observationSnapshot)!==marker.observationSha256
      || Buffer.byteLength(JSON.stringify(marker.observationSnapshot))>16384) return {hint:null,disposition:'mismatch'};
    const key=canonicalJson([decisionId,marker.source,marker.observationSha256,marker.recommendationSha256]);
    let expected=context.cache.get(key);
    if (!expected) {
      expected=buildPreActionHint(marker.observationSnapshot,context.dataset,{gameEpoch:value.gameEpoch,stateVersion:value.stateVersion});
      context.queryCount++;
      context.cache.clear();context.cache.set(key,expected);
    }
    expected={...expected,stateVersion:value.stateVersion};
    if (expected.status!=='supported' || recommendationHash(expected)!==marker.recommendationSha256 || canonicalJson(value)!==canonicalJson(expected)) return {hint:null,disposition:'mismatch'};
    const latest=JSON.parse((await readBounded(context.root,'state.json',2*1024*1024)).raw);
    if (latest.stateVersion!==state.stateVersion || latest.sessionToken!==token) return {hint:null,disposition:'stale-stripped'};
    return {hint:value,disposition:null};
  } catch { return {hint:null,disposition:'unverifiable'}; }
}
