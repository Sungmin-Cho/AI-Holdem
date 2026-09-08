import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {openContained} from './training-store.js';
import {CANONICAL_REFERENCE_SOURCE,LEGACY_REFERENCE_SOURCE,KNOWN_REFERENCE_SOURCES,sameReferenceSource} from '../shared/reference.js';
import {loadReferenceDataset} from './preflop-dataset.js';
const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
function read(root,parts,maxBytes=4*1024*1024){
 try{return JSON.parse(openContained(root,parts,{maxBytes}).toString('utf8'));}
 catch(e){if(e.code==='ENOENT')return null;fail('REFERENCE_SOURCE_INVALID',`Invalid reference evidence: ${e.code??'JSON'}`);}
}
function validateDescriptor(value){
 if(!value||value.schemaVersion!==1||Object.keys(value).sort().join(',')!=='schemaVersion,source'
  ||!value.source||Object.keys(value.source).sort().join(',')!=='contentSha256,id,version')fail('REFERENCE_SOURCE_INVALID','Invalid descriptor');
 const known=KNOWN_REFERENCE_SOURCES.find(s=>sameReferenceSource(s,value.source));
 if(!known)fail('REFERENCE_SOURCE_INVALID','Unknown source');return known;
}
function assertHistory(root,source){
 const auth=read(root,['training','.training-authority.json']);
 for(const item of Object.values(auth?.items??{})) {
  const s=item.summary?.source;
  if(s?.id!==LEGACY_REFERENCE_SOURCE.id)continue;
  if(s.version!==source.version)fail('REFERENCE_SOURCE_CONFLICT','Session baseline version conflict');
  if(item.detailRef){
   if(!/^[a-f0-9]{64}$/.test(item.detailRef))fail('REFERENCE_SOURCE_INVALID','Invalid detail reference');
   const d=read(root,['training','details',`${item.detailRef}.json`]);
   if(!d || d.source?.id!==source.id || d.source?.version!==source.version
     || (d.source.contentSha256!==undefined ? d.source.contentSha256!==source.contentSha256 : source.version!=='1.0.0'))fail('REFERENCE_SOURCE_CONFLICT','Session baseline detail conflict');
  }else if(s.version!=='1.0.0')fail('REFERENCE_SOURCE_CONFLICT','Missing versioned detail');
 }
 // Detect a deleted descriptor even before authority recovery from the journal.
 let raw;try{raw=openContained(root,['training','evaluations.jsonl'],{maxBytes:64*1024*1024}).toString('utf8');}
 catch(e){if(e.code!=='ENOENT')fail('REFERENCE_SOURCE_INVALID','Unreadable evaluation history');}
 if(raw)for(const line of raw.split('\n').filter(Boolean)){
  let row;try{row=JSON.parse(line);}catch{fail('REFERENCE_SOURCE_INVALID','Invalid evaluation history');}
  if(row.source?.id===source.id && (row.source.version!==source.version
    ||(row.source.contentSha256!==undefined&&row.source.contentSha256!==source.contentSha256)))fail('REFERENCE_SOURCE_CONFLICT','Journal baseline conflict');
 }
}
/** Validation-only lookup: never creates or repairs lifecycle state. */
export function readSessionReference(root,{allowLegacyMissing=false}={}) {
 const descriptor=read(root,['reference-source.json'],4096);
 if(!descriptor&&!allowLegacyMissing)fail('REFERENCE_CONTEXT_UNAVAILABLE','Session reference descriptor missing');
 const source=descriptor?validateDescriptor(descriptor):LEGACY_REFERENCE_SOURCE;
 assertHistory(root,source);loadReferenceDataset(source);
 return source;
}
/** New source binding is created while the caller holds the session lifecycle
 * lock, before catalog commit. Missing legacy descriptors can only bind v1. */
export function resolveSessionReference(root,{createNew=false,source=CANONICAL_REFERENCE_SOURCE}={}) {
 const descriptor=read(root,['reference-source.json'],4096);
 let selected=descriptor?validateDescriptor(descriptor):createNew?source:LEGACY_REFERENCE_SOURCE;
 if(!KNOWN_REFERENCE_SOURCES.some(s=>sameReferenceSource(s,selected)))fail('REFERENCE_SOURCE_INVALID','Unknown requested source');
 if(createNew&&descriptor&&!sameReferenceSource(selected,source))fail('REFERENCE_SOURCE_CONFLICT','Existing session cannot be rebound');
 assertHistory(root,selected);loadReferenceDataset(selected);
 if(!descriptor){
  const target=path.join(root,'reference-source.json'),tmp=path.join(root,`.reference-source-${randomUUID()}.tmp`);
  try{
   const fd=fs.openSync(tmp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL,0o600);
   try{fs.writeFileSync(fd,JSON.stringify({schemaVersion:1,source:selected}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   try{fs.linkSync(tmp,target);}catch(e){if(e.code!=='EEXIST')throw e;
    const winner=validateDescriptor(read(root,['reference-source.json'],4096));
    if(!sameReferenceSource(winner,selected))fail('REFERENCE_SOURCE_CONFLICT','Concurrent source binding conflict');selected=winner;}
  }finally{try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 return selected;
}
