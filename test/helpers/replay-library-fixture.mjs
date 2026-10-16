import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createGame, startHand, legalFor, applyAction } from '../../engine/hand.js';
import { saveState, writeHandArchive } from '../../engine/state.js';
import { prepareSession, commitSession } from '../../engine/session-catalog.js';
import { fixedDeck } from './fixtures.js';
import { newDeck } from '../../engine/cards.js';

/** Real engine records and catalog publication, never hand-written replay DTOs. */
export function createReplayGame(storeDir, { aiCount = 1, hands = 2, ongoing = false, mode = 'cash-training', participants, hostAbsent = false, participantAbsent = false, foldFirst = false, showdownPolicy = 'open' } = {}) {
  const prepared = prepareSession(storeDir);
  let state = createGame({ aiCount, mode, ...(participants ? {participants} : {}), ...(mode === 'cash-training' ? {levelEvery:null, handLimit:ongoing ? hands+2 : hands} : {}), replayReveal:'all', showdownPolicy, button:0 });
  if (hostAbsent || participantAbsent) {
    // Real tournament settlement busts the host while h1 remains. The following
    // hand is therefore dealt without user, without manufacturing an out flag.
    if(mode!=='tournament' || !participants?.length || aiCount!==1) throw Error('elimination fixture requires h1 and one AI');
    const busted=participantAbsent?'h1':'user';
    state.seats.find(seat=>seat.playerId===busted).stack=25;
    const prefix=participantAbsent?['Kd','As','2c','Kh','Ah','7d','3s','8h','9d','Jc','Qs']:['Kd','2c','As','Kh','7d','Ah','3s','8h','9d','Jc','Qs'];
    state=startHand(state,{deck:[...prefix,...newDeck().filter(card=>!prefix.includes(card))]}).state;
    while(!legalFor(state).handOver) {
      const legal=legalFor(state);
      state=applyAction(state,legal.toAct,legal.canCheck?'check':'call').state;
    }
    if(!state.seats.find(seat=>seat.playerId===busted).out || state.gameOver) throw Error('host must bust with another human still playing');
    writeHandArchive(prepared.stagingDir,state.lastHand);
  }
  for (let number=1; number<=hands; number++) {
    state=startHand(state,{deck:fixedDeck()}).state;
    let turns=0;
    while (!legalFor(state).handOver) {
      if (++turns>150) throw Error('fixture did not finish');
      const legal=legalFor(state);
      state=applyAction(state,legal.toAct,foldFirst && turns===1 ? 'fold' : legal.canCheck?'check':'call').state;
    }
    writeHandArchive(prepared.stagingDir,state.lastHand);
  }
  if (ongoing) state=startHand(state,{deck:fixedDeck()}).state;
  saveState(prepared.stagingDir,state);
  const session=commitSession(storeDir,prepared);
  return {...session,state,handPath:number=>path.join(session.sessionDir,'hands',`hand-${String(number).padStart(4,'0')}.json`)};
}
export function sourceSnapshot(storeDir) {
  const result={};
  for (const directory of ['.session-store','.training']) {
    const root=path.join(storeDir,directory);
    const visit=(file,rel)=>{if(rel==='.training/study-service.json' || rel==='.training/study.lock.d')return;const stat=fs.lstatSync(file);if(stat.isDirectory())for(const name of fs.readdirSync(file).sort())visit(path.join(file,name),`${rel}/${name}`);else result[rel]=createHash('sha256').update(fs.readFileSync(file)).digest('hex');};
    if(fs.existsSync(root))visit(root,directory);
  }
  return result;
}
