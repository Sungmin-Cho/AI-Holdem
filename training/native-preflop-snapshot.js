import {parsePreflopKey,PREFLOP_ORDERS} from '../shared/preflop-key.js';
import {allHandClasses} from './cards.js';
/** Explicit synthetic native practice context, never a reconstruction of the
 * user's projected game. No hidden cards or game runtime state is consumed. */
export function nativePreflopSnapshot(spotKey,handClass,answer) {
 const spot=parsePreflopKey(spotKey);
 if(spot?.version!==2||!allHandClasses().includes(handClass))throw new Error('Invalid native practice context');
 const order=PREFLOP_ORDERS[spot.seated],heroIndex=order.indexOf(spot.position);
 const seats=order.map((position,i)=>({playerId:position===spot.position?'user':`p${i}`,position,
  stack:5000,bet:position==='SB'?25:position==='BB'?50:0,contribution:position==='SB'?25:position==='BB'?50:0,
  folded:i<heroIndex&&position!==spot.openerPosition,allIn:false,out:false}));
 const opener=seats.find(p=>p.position===spot.openerPosition);
 if(opener)opener.bet=opener.contribution=125;
 seats.forEach(p=>p.stack-=p.contribution);
 const hero=seats[heroIndex],currentBet=opener?125:50,minRaiseTo=opener?200:100;
 const decisionId=`d-1-preflop-${heroIndex}`;
 const holeCards=[`${handClass[0]}s`,`${handClass[1]}${handClass.endsWith('s')?'s':'h'}`];
 return {schemaVersion:2,decisionId,gameMode:'cash-training',handNo:1,actorId:'user',street:'preflop',
  position:spot.position,holeCards,board:[],blinds:[25,50],potBefore:seats.reduce((n,p)=>n+p.contribution,0),
  currentBet,actorBet:hero.bet,toCall:currentBet-hero.bet,minRaiseTo,maxRaiseTo:5000,effectiveStack:5000,forced:false,
  publicSeats:seats,priorActions:seats.slice(0,heroIndex).map((p,i)=>({playerId:p.playerId,
    decisionId:`d-1-preflop-${i}`,street:'preflop',action:p===opener?'raise':'fold',amount:p===opener?125:0})),
  legal:{decisionId,canCheck:false,canRaise:true,callAmount:currentBet-hero.bet,minRaiseTo,maxRaiseTo:5000},
  ...(answer?{chosenAction:{action:answer.action,amount:answer.action==='raise'?Math.round(answer.sizeBb*50):0}}:{})};
}
