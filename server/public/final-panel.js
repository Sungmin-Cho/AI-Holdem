import {rankPlayers,summarizeHands,graphPoints} from './final-summary.js';
import {formatAmount,formatSignedAmount} from './chip-format.js';
const node=(tag,text,className)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(className)el.className=className;return el;};
const SVG='http://www.w3.org/2000/svg';
const svgNode=(tag,attrs={})=>{const el=document.createElementNS(SVG,tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;};
/** Cash games read in the fixed big blind; tournaments (rising blinds) in chips. */
function amountFormat(view){
  const bb=view?.mode==='cash-training'&&Number.isSafeInteger(view?.blinds?.[1])?view.blinds[1]:null;
  return {plain:value=>formatAmount(value,bb,'bb').primary,signed:value=>formatSignedAmount(value,bb,'bb').primary};
}
// One series (the viewer's running total): no legend, a zero baseline, the end
// value labelled, and every hand a focusable point with its own name.
function paintChart(container,series,fmt){
  const width=320,height=120,padding=12,points=graphPoints(series,{width,height,padding});
  if(!points.length)return;
  const values=series.map(row=>row.value),lo=Math.min(0,...values),hi=Math.max(0,...values),span=hi-lo||1;
  const zeroY=height-padding-(0-lo)/span*(height-2*padding);
  const figure=node('figure',undefined,'final-chart-figure');
  const svg=svgNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-label':`완료 ${series.length}핸드 누적 증감 그래프 · 최종 ${fmt.signed(series.at(-1).value)}`});
  svg.classList.add('final-chart');
  svg.append(svgNode('line',{x1:padding,x2:width-padding,y1:zeroY,y2:zeroY,class:'final-chart-zero'}));
  svg.append(svgNode('polyline',{points:points.map(p=>`${p.x},${p.y}`).join(' '),class:'final-chart-line'}));
  const tip=node('p','', 'final-chart-tip');tip.hidden=true;tip.setAttribute('aria-hidden','true');
  const show=index=>{const row=series[index],point=points[index];tip.textContent=`핸드 ${row.handNo} · 누적 ${fmt.signed(row.value)}`;tip.hidden=false;tip.style.left=`${point.x/width*100}%`;tip.style.top=`${point.y/height*100}%`;};
  const hide=()=>{tip.hidden=true;};
  points.forEach((point,index)=>{
    const dot=svgNode('circle',{cx:point.x,cy:point.y,r:4,class:'final-chart-dot',tabindex:0,'aria-label':`핸드 ${series[index].handNo} 누적 ${fmt.signed(series[index].value)}`});
    dot.addEventListener('focus',()=>show(index));dot.addEventListener('blur',hide);
    svg.append(dot);
  });
  const last=points.at(-1);
  svg.append(Object.assign(svgNode('text',{x:Math.min(last.x,width-padding),y:Math.max(last.y-8,10),'text-anchor':'end',class:'final-chart-label'}),{textContent:fmt.signed(series.at(-1).value)}));
  // Pointer hover follows the nearest hand, so small dots are easy to read.
  svg.addEventListener('pointermove',event=>{
    const box=svg.getBoundingClientRect();if(!box.width)return;
    const x=(event.clientX-box.left)/box.width*width;
    let nearest=0;points.forEach((point,index)=>{if(Math.abs(point.x-x)<Math.abs(points[nearest].x-x))nearest=index;});show(nearest);
  });
  svg.addEventListener('pointerleave',hide);
  const axis=node('div',undefined,'final-chart-axis');axis.setAttribute('aria-hidden','true');
  axis.append(node('span',`핸드 ${series[0].handNo}`),node('span',`핸드 ${series.at(-1).handNo}`));
  figure.append(svg,tip,axis);
  container.append(figure);
}
/** Public fields only. Callers supply viewer authority and replay navigation. */
export function paintFinalPanel(container,{summary,view,viewer=null,onReplay=null,canReplay=()=>true,includeRanking=true}) {
  container.replaceChildren();
  const fmt=amountFormat(view),cash=view?.mode==='cash-training';
  const rows=rankPlayers({summary,view}),withNet=rows.some(row=>Object.hasOwn(row,'net'));
  // Cash stacks are restored every hand, so a final stack says nothing there.
  const withStack=!cash;
  if(includeRanking)container.append(node('h2','순위'));
  const table=node('table',undefined,'final-ranking');const head=node('tr');
  for(const label of ['순위','이름',...(withNet?['증감']:[]),...(withStack?['최종 스택']:[])])head.append(node('th',label));
  const thead=node('thead');thead.append(head);table.append(thead);const body=node('tbody');
  for(const row of rows){
    const tr=node('tr',undefined,row.playerId===viewer?'is-viewer':undefined);
    for(const value of [row.rank,row.name??row.playerId,...(withNet?[fmt.signed(row.net)]:[]),...(withStack?[Number.isSafeInteger(row.finalStack)?fmt.plain(row.finalStack):'—']:[])])tr.append(node('td',String(value)));
    body.append(tr);
  }
  table.append(body);if(includeRanking)container.append(table);
  const data=summarizeHands(summary,viewer);
  if(!data){if(summary?.complete===false)container.append(node('p','일부 핸드 기록을 읽지 못해 생략했습니다'));return;}
  const handLink=(hand,label)=>{
    const enabled=onReplay&&canReplay(hand.handNo);const el=node(enabled?'button':'span',label);if(enabled){el.type='button';el.className='btn btn-ghost';el.addEventListener('click',()=>onReplay(hand.handNo));}return el;
  };
  if(viewer) {
    container.append(node('h2','내 요약'));
    paintChart(container,data.series,fmt);
    const cards=node('div',undefined,'final-highlights');
    for(const [label,hand,tone] of [['최고 핸드',data.best,'is-pos'],['최악 핸드',data.worst,'is-neg']]){
      const card=node('div',undefined,`final-highlight ${hand?tone:''}`.trim());
      card.append(node('span',label,'final-highlight-label'));
      if(hand)card.append(node('strong',fmt.signed(hand.net[viewer]),'final-highlight-value'),handLink(hand,onReplay&&canReplay(hand.handNo)?`핸드 ${hand.handNo} 복기`:`핸드 ${hand.handNo}`));
      else card.append(node('strong','없음','final-highlight-value'));
      cards.append(card);
    }
    container.append(cards);
  }
  container.append(node('h2','가장 큰 팟'));
  const list=node('ol',undefined,'final-pots');for(const hand of data.topPots){const li=node('li');li.append(handLink(hand,`핸드 ${hand.handNo} · 팟 ${fmt.plain(hand.potTotal)}`));list.append(li);}container.append(list);
}
