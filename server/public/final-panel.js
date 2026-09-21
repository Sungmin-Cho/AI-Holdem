import {rankPlayers,summarizeHands,graphPoints} from './final-summary.js';
const node=(tag,text)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
const signed=value=>`${value>0?'+':''}${value}`;
/** Public fields only. Callers supply viewer authority and replay navigation. */
export function paintFinalPanel(container,{summary,view,viewer=null,onReplay=null,canReplay=()=>true,includeRanking=true}) {
  container.replaceChildren();
  const rows=rankPlayers({summary,view}),withNet=rows.some(row=>Object.hasOwn(row,'net'));
  if(includeRanking)container.append(node('h2','순위'));
  const table=node('table');table.className='final-ranking';const head=node('tr');
  for(const label of ['순위','이름',...(withNet?['증감']:[]),'최종 스택'])head.append(node('th',label));
  const thead=node('thead');thead.append(head);table.append(thead);const body=node('tbody');
  for(const row of rows){const tr=node('tr');for(const value of [row.rank,row.name??row.playerId,...(withNet?[signed(row.net)]:[]),row.finalStack??'—'])tr.append(node('td',String(value)));body.append(tr);}
  table.append(body);if(includeRanking)container.append(table);
  const data=summarizeHands(summary,viewer);
  if(!data){if(summary?.complete===false)container.append(node('p','일부 핸드 기록을 읽지 못해 생략했습니다'));return;}
  const handLink=(hand,label)=>{
    const enabled=onReplay&&canReplay(hand.handNo);const el=node(enabled?'button':'span',label);if(enabled){el.type='button';el.className='btn btn-ghost';el.addEventListener('click',()=>onReplay(hand.handNo));}return el;
  };
  if(viewer) {
    container.append(node('h2','내 요약'));
    const points=graphPoints(data.series);
    if(points.length){
      const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 320 100');svg.setAttribute('role','img');svg.setAttribute('aria-label',`완료 ${data.series.length}핸드 누적 증감 그래프 · 최종 ${signed(data.series.at(-1).value)}`);svg.classList.add('final-chart');
      const line=document.createElementNS(ns,'polyline');line.setAttribute('points',points.map(p=>`${p.x},${p.y}`).join(' '));line.setAttribute('fill','none');line.setAttribute('stroke','currentColor');line.setAttribute('stroke-width','2');svg.append(line);
      for(const p of points){const dot=document.createElementNS(ns,'circle');dot.setAttribute('cx',p.x);dot.setAttribute('cy',p.y);dot.setAttribute('r','3');svg.append(dot);}container.append(svg);
    }
    for(const [label,hand] of [['최고',data.best],['최악',data.worst]]){
      const p=node('p',`${label} 핸드: `);p.append(hand?handLink(hand,`${hand.handNo} · ${signed(hand.net[viewer])}`):node('span','없음'));container.append(p);
    }
  }
  container.append(node('h2','가장 큰 팟'));
  const list=node('ol');for(const hand of data.topPots){const li=node('li');li.append(handLink(hand,`핸드 ${hand.handNo} · 팟 ${hand.potTotal}`));list.append(li);}container.append(list);
}
