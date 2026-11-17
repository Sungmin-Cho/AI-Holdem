import fs from 'node:fs';
import path from 'node:path';
import { readSessionReference } from './reference-source.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { buildPreActionHint, recommendationHash } from '../training/pre-action-hint.js';
import { observationHash, canonicalJson } from '../shared/decision-observation.js';
import { projectHint } from '../shared/hint-contract.js';
import { isCoverageReferenceSource, sameReferenceSource } from '../shared/reference.js';
import { gameEpochOf } from '../publish-contract.js';
import { lstatExactAsync, handleStatExact } from '../shared/exact-stat.js';

// #347 C: an initialization that ended without a verdict is tried again from a later hint
// publication — at most this many more times, each at least this long after the previous try ended.
export const HINT_INIT_RETRY_LIMIT = 3;
export const HINT_INIT_RETRY_INTERVAL_MS = 5000;
const DESCRIPTOR = 'reference-source.json';
// An open refused for what the path is, not for what the file system could do: the same set the
// synchronous reader turns into UNSAFE_PATH (tools/training-store.js mapOpenError), and ENOTDIR.
const PATH_REFUSALS = new Set(['ELOOP', 'EMLINK', 'EISDIR', 'ENOTDIR']);
const coded = (code, message) => Object.assign(new Error(message), { code });

// One asynchronous step of hint I/O, bounded: the bound decides only how long the caller waits. The
// step itself is not cancelled; `lease.active` tells it whether its caller is still waiting.
async function bounded(start) {
  const lease = { active: true };
  let timer;
  try {
    return await Promise.race([
      start(lease),
      new Promise((_,reject)=>{timer=setTimeout(()=>{lease.active=false;reject(coded('HINT_EVIDENCE_DEADLINE','hint evidence deadline'));},1000);timer.unref?.();}),
    ]);
  } finally { clearTimeout(timer); lease.active = false; }
}
const readBounded = (root, name, maxBytes, observer) => bounded(lease => readEvidence(root,name,maxBytes,observer,lease));

// An observer judges what this read finds where the read finds it, whether or not its caller is still
// waiting: `identity({dev, ino, size})` for every regular file it sees (the first lstat, the handle's
// fstat, the lstat after reading), `anomaly()` when the file is replaced, gone or not a small
// regular file, and `content(evidence)` with the validated content before the file is closed (a slow
// or failing close cannot hide it). `missingIsAnomaly()`, asked when the file is found missing: the
// file was seen before, so its absence is a change too. `singleLink`: a file with a second name is not
// the file (the descriptor; the synchronous reader it replaces refused that too, training-store.js).
async function readEvidence(root, name, maxBytes, observer = {}, lease = { active: true }) {
  const file = path.join(root,name);
  const anomaly = (code, message) => { observer.anomaly?.(); return coded(code, message); };
  const unsafe = () => anomaly('HINT_EVIDENCE_UNSAFE', 'unsafe hint evidence');
  const changed = () => anomaly('HINT_EVIDENCE_CHANGED', 'changed hint evidence');
  const seen = stat => observer.identity?.({ dev:stat.dev, ino:stat.ino, size:stat.size }, lease);
  // Exact identities (#308): a Number-valued ino past 2^53 (Windows) can match a replacement.
  let before;
  try { before = await lstatExactAsync(file); }
  catch (error) { if (error?.code === 'ENOENT' && observer.missingIsAnomaly?.()) throw changed(); throw error; }
  const extraLink = stat => observer.singleLink === true && stat.nlink !== 1;
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes || extraLink(before)) throw unsafe();
  seen(before);
  let handle;
  try { handle = await fs.promises.open(file,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (error?.code === 'ENOENT') throw changed(); // there a moment ago
    if (PATH_REFUSALS.has(error?.code)) throw unsafe();
    throw error;
  }
  try {
    const stat = await handleStatExact(handle);
    if (stat.isFile()) seen(stat);
    if (!stat.isFile() || stat.size > maxBytes || stat.size !== before.size || stat.dev !== before.dev || stat.ino !== before.ino) throw changed();
    if (extraLink(stat)) throw unsafe();
    const bytes = Buffer.alloc(stat.size+1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const result = await handle.read(bytes,bytesRead,bytes.length-bytesRead,bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== stat.size) throw changed(); // shorter or longer than its stat
    const evidence = { raw:bytes.subarray(0,bytesRead).toString('utf8'), dev:stat.dev, ino:stat.ino };
    // Judged now: what was read is a fact before the stat after it, whose own failure must not hide it.
    observer.content?.(evidence, lease);
    let after;
    try { after = await lstatExactAsync(file); }
    catch (error) { if (error?.code === 'ENOENT') throw changed(); throw error; }
    if (after.isFile() && !after.isSymbolicLink()) seen(after);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size) throw changed();
    if (extraLink(after)) throw unsafe();
    return evidence;
  } finally { await handle.close().catch(() => {}); } // a failed close never replaces what the read found
}

const sameEvidence = (a, b) => a.raw === b.raw && a.dev === b.dev && a.ino === b.ino;
const unverifiable = () => ({ hint:null, disposition:'unverifiable' });
const disable = context => { context.ready = false; context.disabled = true; };

// #347 C: the descriptor is written once, by link, when its session is created, and never replaced
// (tools/reference-source.js). The first identity (dev, ino and size) the relay sees at its path and
// the first content it reads whole are its pins — even when the read that saw them was no longer awaited: an observation is
// a fact, and turning hints on is a separate step. Any later identity or content that differs, the
// file found replaced, gone after it was seen, or not one small regular file is evidence that the
// session's source changed: hints stay off for this relay's life, from the moment it is seen.
function descriptorObserver(context) {
  return {
    singleLink: true,
    anomaly: () => disable(context),
    missingIsAnomaly: () => Boolean(context.pinnedIdentity),
    identity: id => {
      if (!context.pinnedIdentity) context.pinnedIdentity = id;
      else if (id.dev !== context.pinnedIdentity.dev || id.ino !== context.pinnedIdentity.ino || id.size !== context.pinnedIdentity.size) disable(context);
    },
    content: evidence => {
      if (context.pinnedRaw === undefined) context.pinnedRaw = evidence.raw;
      else if (evidence.raw !== context.pinnedRaw) disable(context);
    },
  };
}
async function readDescriptor(context, root) {
  try { return await readBounded(root,DESCRIPTOR,4096,descriptorObserver(context)); }
  catch (error) {
    if (error?.code === 'HINT_EVIDENCE_UNSAFE' || error?.code === 'HINT_EVIDENCE_CHANGED') throw coded('HINT_SOURCE_CHANGED', 'hint source changed');
    throw error;
  }
}

// #347 C: whether a failure turns hints off for this relay's life — a verdict on content the relay
// read, or evidence that the source descriptor changed. Anything else is transient: a missed deadline,
// an errno, a state.json caught mid-replacement, a training history file that was being written.
function permanentFailure(error) {
  if (typeof error?.evidence === 'string' && error.evidence.startsWith('training/')) return false;
  return ['HINT_SOURCE_CHANGED','REFERENCE_SOURCE_INVALID','REFERENCE_SOURCE_CONFLICT','REFERENCE_CONTEXT_UNAVAILABLE'].includes(error?.code);
}

// One initialization: false on a verdict, a throw on anything else. Nothing reaches `context` unless
// every step succeeded — except the pins, which bind every later try (descriptorObserver).
async function initializeOnce(context, sessionDir, token) {
  const root = await bounded(() => fs.promises.realpath(sessionDir));
  const state = JSON.parse((await readBounded(root,'state.json',2*1024*1024)).raw);
  if (state.sessionToken !== token || state.config?.hintContractVersion !== 1 || state.config.hints !== 'on') return false;
  const before = await readDescriptor(context, root);
  if (context.disabled) return false;
  // The text just read and observed is what is validated; the descriptor is not read again here, so
  // every identity of it the relay relies on went through the observer.
  const source = readSessionReference(root,{capturedDescriptor:before.raw});
  if (!isCoverageReferenceSource(source)) return false;
  const dataset = loadReferenceDataset(source);
  const after = await readDescriptor(context, root);
  if (context.disabled || !sameEvidence(before, after)) return false;
  Object.assign(context, { root, source, dataset, descriptor:after, cache:new Map(), queryCount:0, probe:null, ready:true });
  return true;
}
function attempt(context, sessionDir, token) {
  context.attempts += 1;
  return (async () => {
    try { if (!await initializeOnce(context, sessionDir, token)) disable(context); }
    catch (error) { if (permanentFailure(error)) disable(context); }
    finally { context.lastAttemptEnd = context.now(); }
  })();
}
const retryDue = context => !context.ready && !context.disabled && context.attempts >= 1
  && context.attempts <= HINT_INIT_RETRY_LIMIT && context.now() - context.lastAttemptEnd >= HINT_INIT_RETRY_INTERVAL_MS;

/** The sole relay façade: bounded read-only I/O, pure reference computation.
 * `context` belongs to one relay lifetime. Hints stay off for that lifetime only on a verdict or on
 * evidence that the source changed (#347 C); a passing failure drops only that publication's hint, and
 * a publication (`retry`) may try a failed initialization again, a bounded number of times. */
export async function verifyHintPublication({ sessionDir, token, context, initialize = false, retry = false, now, hint, view }) {
  if (initialize) {
    Object.assign(context, { ready:false, disabled:false, attempts:0, lastAttemptEnd:-Infinity,
      now: typeof now === 'function' ? now : () => performance.now() });
    await attempt(context, sessionDir, token);
    return {ready:context.ready};
  }
  if (hint == null) return { hint:null, disposition:null };
  let value;
  try { value=projectHint(hint); } catch { return {hint:null,disposition:'mismatch'}; }
  if (retry && retryDue(context)) {
    context.retrying ??= attempt(context, sessionDir, token).finally(() => { context.retrying = null; });
    await context.retrying;
  }
  if (!context.ready) return {hint:null,disposition:'unverifiable'};
  try {
    // Share only concurrent reads, never a past decision's identity. Settled, so the descriptor's
    // evidence is judged even when the state read failed beside it.
    if (!context.probe) {
      context.probe = Promise.allSettled([readBounded(context.root,'state.json',2*1024*1024),readDescriptor(context,context.root)]);
      context.probe.finally(() => {context.probe=null;});
    }
    const [observed,descriptor] = await context.probe;
    if (descriptor.status === 'rejected') {
      if (permanentFailure(descriptor.reason)) disable(context);
      return unverifiable();
    }
    if (!sameEvidence(descriptor.value, context.descriptor)) { disable(context); return unverifiable(); }
    if (observed.status === 'rejected') return unverifiable();
    const state=JSON.parse(observed.value.raw);
    const decisionId=state.hand?`d-${state.handNo}-${state.hand.street}-${state.hand.actionIndex}`:null;
    if (state.sessionToken!==token || state.config?.hintContractVersion!==1 || state.config.hints!=='on') { disable(context); return unverifiable(); }
    if (value.gameEpoch!==gameEpochOf(token) || value.decisionId!==decisionId || value.stateVersion!==state.stateVersion
      || value.handNo!==state.handNo || view?.legal?.decisionId!==decisionId || view?.legal?.toAct!=='user') return {hint:null,disposition:'stale-stripped'};
    // A proof that another one turned off meanwhile never returns its hint; its other verdicts stand.
    const proved = () => (context.ready ? {hint:value,disposition:null} : unverifiable());
    if (value.status!=='supported') return proved();
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
    return proved();
  } catch (error) {
    if (permanentFailure(error)) disable(context);
    return unverifiable();
  }
}
