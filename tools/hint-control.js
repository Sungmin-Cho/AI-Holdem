import fs from 'node:fs';
import path from 'node:path';
import { openContained, writeContained } from './training-store.js';
import { readSessionReference } from './reference-source.js';
import { loadReferenceDataset } from './preflop-dataset.js';
import { buildPreActionHint, recommendationHash } from '../training/pre-action-hint.js';
import { observationHash, hintError } from '../shared/decision-observation.js';
import { gameEpochOf } from '../publish-contract.js';

export function checkHintResume(config, requested) {
  if (requested !== undefined && !['on','off'].includes(requested)) throw hintError('USAGE');
  if (config?.hintContractVersion !== 1) {
    if (requested === 'on') throw hintError('HINT_SESSION_UPGRADE_REQUIRED');
    return 'off';
  }
  if (!['on','off'].includes(config.hints)) throw hintError('HINT_CAPABILITY_UNAVAILABLE');
  if (requested !== undefined && requested !== config.hints) throw hintError('HINT_MODE_CONFLICT');
  return config.hints;
}
export function createHintControl({sessionDir,runCli,ready,enabled=()=>true,assertActive=()=>{},isFatal=()=>false,log=()=>{}}) {
  let source, dataset, descriptor, blockedDecision;
  return { async prepare(envelope) {
    if (!enabled()) return envelope;
    let state;
    try { state=JSON.parse(openContained(sessionDir,['state.json'],{maxBytes:2*1024*1024})); }
    catch(error) { log('hint-unavailable',{code:'HINT_STATE_UNAVAILABLE'});return {...envelope,hint:null}; }
    if (state.config?.hints!=='on' || state.config.hintContractVersion!==1) return envelope;
    if (!envelope.view || envelope.next?.toAct!=='user') return {...envelope,hint:null};
    const identity={schemaVersion:1,gameEpoch:gameEpochOf(state.sessionToken),decisionId:envelope.next.decisionId,
      handNo:envelope.view.handNo,stateVersion:envelope.stateVersion};
    const unavailable=code=>({...envelope,hint:{...identity,status:'unavailable',source:source??null,code}});
    if (blockedDecision===identity.decisionId) return unavailable('HINT_EXPOSURE_CONFLICT');
    const started=performance.now();
    try {
      assertActive();
      if (!await ready()) return unavailable('HINT_RELAY_UNAVAILABLE');
      assertActive();
      if (!source) {
        source=readSessionReference(sessionDir);dataset=loadReferenceDataset(source);
        const stat=fs.lstatSync(path.join(sessionDir,'reference-source.json'));
        descriptor={raw:openContained(sessionDir,['reference-source.json'],{maxBytes:4096}).toString('utf8'),ino:stat.ino,dev:stat.dev};
      } else {
        const stat=fs.lstatSync(path.join(sessionDir,'reference-source.json'));
        if (stat.ino!==descriptor.ino || stat.dev!==descriptor.dev || openContained(sessionDir,['reference-source.json'],{maxBytes:4096}).toString('utf8')!==descriptor.raw) return unavailable('HINT_SOURCE_UNAVAILABLE');
      }
      const peek=await runCli(['decision-peek','--for','user','--expect-version',String(envelope.stateVersion)]);
      assertActive();
      if (Buffer.byteLength(JSON.stringify(peek.snapshot))>16384) throw hintError('HINT_SNAPSHOT_INVALID');
      const hint=buildPreActionHint(peek.snapshot,dataset,identity);
      if (hint.status!=='supported') return {...envelope,hint};
      const marker=state.hand?.hintExposures?.[identity.decisionId];
      if (marker?.exposureId===hint.exposureId && marker.observationSha256===observationHash(peek.snapshot)) return {...envelope,hint};
      const meta={schemaVersion:1,gameEpoch:identity.gameEpoch,decisionId:identity.decisionId,source,
        observationSha256:observationHash(peek.snapshot),recommendationSha256:recommendationHash(hint)};
      const name='.hint-meta.json';
      writeContained(sessionDir,[name],JSON.stringify(meta),{mode:'replace'});
      assertActive();
      const marked=await runCli(['hint-expose','--for','user','--decision-id',identity.decisionId,
        '--expect-version',String(peek.stateVersion),'--hint-meta-file',path.join(sessionDir,name)]);
      // Preserve the original action acknowledgement and public transition events.
      return {...envelope,...marked,events:envelope.events,actionAck:envelope.actionAck,handReplay:envelope.handReplay,
        hint:{...hint,stateVersion:marked.stateVersion}};
    } catch(error) {
      if (isFatal(error) || error.code === 'STOPPING' || error.code === 'FINALIZATION_RESULT_WAIT_CUTOFF') throw error;
      log('hint-unavailable',{code:error.code??'HINT_QUERY_UNAVAILABLE'});
      if (['HINT_EXPOSURE_CONFLICT','HINT_PROOF_MISMATCH'].includes(error.code)) blockedDecision=identity.decisionId;
      // A commit may have succeeded before stdout loss: always re-sync identity.
      assertActive();
      const synchronized=await runCli(['step']);
      const code=['HINT_EXPOSURE_CONFLICT','HINT_PROOF_MISMATCH','HINT_SNAPSHOT_INVALID'].includes(error.code)?error.code
        :error.code==='SNAPSHOT_INVALID'?'HINT_SNAPSHOT_INVALID':error.code==='VERSION_MISMATCH'?'HINT_STALE_DECISION'
        :error.code?.includes('TIMEOUT')?'HINT_PREPARE_TIMEOUT':error.code?.includes('SOURCE')?'HINT_SOURCE_UNAVAILABLE':'HINT_QUERY_UNAVAILABLE';
      return {...envelope,...synchronized,events:envelope.events,actionAck:envelope.actionAck,handReplay:envelope.handReplay,
        hint:synchronized.next?.toAct==='user'?{...identity,decisionId:synchronized.next.decisionId,
          handNo:synchronized.view.handNo,stateVersion:synchronized.stateVersion,status:'unavailable',source:source??null,code}:null};
    } finally { log('hint-timing',{prepareMs:performance.now()-started}); }
  }};
}
