import fs from 'node:fs';
import path from 'node:path';
import {openContained} from './training-store.js';
import {isHumanSeat} from '../shared/seat-roles.js';

const MAX_BYTES=256*1024,MAX_HANDS=1000,BATCH=25;
const integer=value=>Number.isSafeInteger(value);
function projectHand(record,handNo,playerIds) {
  if(record?.handNo!==handNo || !record.startStacks || !record.endStacks || !Array.isArray(record.pots))throw Error('BAD_HAND_SUMMARY');
  const net={};
  for(const playerId of playerIds) {
    if(!Object.hasOwn(record.startStacks,playerId))continue;
    const start=record.startStacks[playerId],end=record.endStacks[playerId];
    if(!integer(start)||!integer(end)||start<0||end<0)throw Error('BAD_HAND_SUMMARY');
    net[playerId]=end-start;
  }
  if(!Object.keys(net).length)throw Error('BAD_HAND_SUMMARY');
  let potTotal=0;const shares=new Map();
  for(const pot of record.pots) {
    if(!integer(pot.amount)||pot.amount<0||!Array.isArray(pot.winners))throw Error('BAD_HAND_SUMMARY');
    potTotal+=pot.amount;let paid=0;
    for(const winner of pot.winners) {
      if(!playerIds.has(winner.playerId)||!integer(winner.share)||winner.share<0)throw Error('BAD_HAND_SUMMARY');
      paid+=winner.share;shares.set(winner.playerId,(shares.get(winner.playerId)??0)+winner.share);
    }
    if(paid!==pot.amount)throw Error('BAD_HAND_SUMMARY');
  }
  if(!integer(potTotal))throw Error('BAD_HAND_SUMMARY');
  return {handNo,potTotal,winners:[...shares].map(([playerId,share])=>({playerId,share})),net};
}
function archiveIdentity(sessionDir,name) {
  for(const directory of [sessionDir,path.join(sessionDir,'hands')]) {
    const dir=fs.lstatSync(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error('UNSAFE_ARCHIVE');
  }
  const stat=fs.lstatSync(path.join(sessionDir,'hands',name));
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size>MAX_BYTES)throw Error('UNSAFE_ARCHIVE');
  return [stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
}

/** Cache only explicitly selected public fields; keep one game and one build. */
export function createSessionSummaryCache({openFile=openContained,yieldTurn=()=>new Promise(setImmediate)}={}) {
  let current=null;
  const get=({gameId,sessionDir,state})=>{
    const key=gameId+':'+path.resolve(sessionDir);
    if(current?.key!==key)current={key,gameId,records:new Map(),summary:null,flight:null};
    const entry=current;
    if(entry.flight)return entry.flight;
    entry.flight=(async()=>{
      const engine=state??JSON.parse(openFile(sessionDir,['state.json'],{maxBytes:2*1024*1024}));
      const seats=Array.isArray(engine.seats)?engine.seats:[];
      const playerIds=new Set(seats.map(seat=>seat.playerId));
      const completed=engine.lastHand?.handNo ?? (engine.result==='abort'?Math.max(0,engine.handNo-1):engine.handNo);
      const handCount=integer(completed)&&completed>=0?completed:0;
      let complete=integer(completed)&&completed>=0&&completed<=MAX_HANDS&&seats.length>=2;
      const hands=[];
      for(let handNo=1;handNo<=Math.min(handCount,MAX_HANDS);handNo++) {
        if(handNo>1&&(handNo-1)%BATCH===0)await yieldTurn();
        const name='hand-'+String(handNo).padStart(4,'0')+'.json';
        let projected;
        try {
          let identity;
          try {identity=archiveIdentity(sessionDir,name);}
          catch(error) {
            if(error.code!=='ENOENT' || engine.lastHand?.handNo!==handNo)throw error;
            projected=projectHand(engine.lastHand,handNo,playerIds);
          }
          if(identity) {
            const cached=entry.records.get(handNo);
            if(cached?.identity===identity)projected=cached.projected;
            else {
              projected=projectHand(JSON.parse(openFile(sessionDir,['hands',name],{maxBytes:MAX_BYTES})),handNo,playerIds);
              entry.records.set(handNo,{identity,projected});
            }
          }
          hands.push(projected);
        } catch {complete=false;entry.records.delete(handNo);}
      }
      if(hands.length!==handCount)complete=false;
      const players=seats.map(seat=>{
        let net=0;
        if(complete)for(const hand of hands)net+=hand.net[seat.playerId]??0;
        if(!integer(net))complete=false;
        return {playerId:seat.playerId,name:seat.name,kind:isHumanSeat(seat)?'human':'ai',net,
          finalStack:integer(seat.stack)?seat.stack:null,out:seat.out===true};
      });
      if(!complete)for(const player of players)player.net=null;
      const summary={schemaVersion:1,mode:engine.config?.mode??'tournament',handCount,
        startStack:integer(engine.config?.startStack)?engine.config.startStack:null,complete,players,hands};
      entry.summary=summary;
      return summary;
    })().catch(error=>{entry.summary=null;throw error;}).finally(()=>{entry.flight=null;});
    return entry.flight;
  };
  return {get,peek:gameId=>current?.gameId===gameId?current.summary:null,clear(){current=null;}};
}
