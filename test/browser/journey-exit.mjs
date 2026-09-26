// Both browser execution and the no-browser control use this completion gate.
export function finishJourney({ required, recorded, failure }) {
  if (failure) throw failure;
  const pending = required.filter(name => !recorded.includes(name));
  if (pending.length) throw new Error(`MISSING_REQUIRED_CHECKS: ${pending.join(', ')}`);
}

export function selfTestJourney(required, argv = process.argv.slice(2)) {
  if (!argv.includes('--self-test')) return false;
  const index = argv.indexOf('--omit');
  const omitted = index < 0 ? null : argv[index + 1];
  if (index >= 0 && !required.includes(omitted)) throw new Error('UNKNOWN_REQUIRED_CHECK');
  finishJourney({ required, recorded: required.filter(name => name !== omitted) });
  console.log('JOURNEY_SELF_TEST_PASS');
  return true;
}

// Attempt all owned cleanup steps; never replace the failure being diagnosed.
export async function cleanupJourney({ steps, failure }) {
  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  return { failure: failure ?? errors[0], errors };
}

// Embedded table fit (design A5): the parent page never scrolls, the header sits
// above the iframe, the iframe ends inside the viewport, and inside it the table
// has no sideways scroll, no overlapping plates and a dock the viewer can reach.
export const EMBED_FIT_SCRIPT = "(()=>{ const frame=document.querySelector('#table'),doc=frame?.contentDocument,w=doc?.defaultView; if(!doc||!doc.body||doc.readyState==='loading')return null; const headerNode=document.querySelector('.app-header'),header=headerNode.getBoundingClientRect(),f=frame.getBoundingClientRect(); const parts=[...headerNode.querySelectorAll(':scope > *, .help-menu > button, .member-controls > *')].filter(n=>!n.classList.contains('help-menu')&&!n.classList.contains('member-controls')&&!n.classList.contains('header-spacer')&&n.getClientRects().length).map(n=>({id:n.id||n.className,r:n.getBoundingClientRect()})).filter(p=>p.r.width>1&&p.r.height>1); const headerClash=parts.flatMap((a,i)=>parts.slice(i+1).filter(b=>a.r.left<b.r.right-1&&a.r.right>b.r.left+1&&a.r.top<b.r.bottom-1&&a.r.bottom>b.r.top+1).map(b=>a.id+'|'+b.id)).concat(parts.filter(p=>p.r.right>innerWidth+1||p.r.left<-1).map(p=>p.id+'|edge')); const page={headerClash,scrollX:document.documentElement.scrollWidth-innerWidth,scrollY:document.documentElement.scrollHeight-innerHeight,headerBottom:header.bottom,frameTop:f.top,frameBottom:f.bottom,viewport:innerHeight}; const plates=[...doc.querySelectorAll('.plate')].filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect()); const overlap=plates.some((a,i)=>plates.slice(i+1).some(b=>a.left<b.right-1&&a.right>b.left+1&&a.top<b.bottom-1&&a.bottom>b.top+1)); const bar=doc.querySelector('#action-bar');let dock=null; if(bar&&!bar.hidden&&bar.getClientRects().length){bar.scrollIntoView({block:'end'});const r=bar.getBoundingClientRect();dock={top:r.top,bottom:r.bottom,height:w.innerHeight,position:w.getComputedStyle(bar).position};} return {page,innerScrollX:doc.documentElement.scrollWidth-w.innerWidth,plates:plates.length,overlap,dock}; })()";
export function assertEmbedFit(fit, label) {
  if (!fit) throw new Error(`embed fit ${label}: table document not ready`);
  const detail = JSON.stringify({ label, fit });
  if (!(fit.page.scrollX <= 1 && fit.page.scrollY <= 1)) throw new Error(`page scrolls: ${detail}`);
  if (fit.page.headerClash.length) throw new Error(`header controls overlap or leave the screen: ${detail}`);
  if (!(fit.page.frameTop >= fit.page.headerBottom - 1 && fit.page.frameBottom <= fit.page.viewport + 1)) throw new Error(`iframe outside the viewport: ${detail}`);
  if (!(fit.innerScrollX <= 1 && fit.plates > 0 && !fit.overlap)) throw new Error(`table layout: ${detail}`);
  if (fit.dock && !(fit.dock.top >= 0 && fit.dock.bottom <= fit.dock.height + 1)) throw new Error(`dock out of reach: ${detail}`);
}
