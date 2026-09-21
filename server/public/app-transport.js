// App credentials stay in sessionStorage; relay credentials never enter this page.
const params = new URLSearchParams(location.search);
export const appGameId = params.get("appGame");
export const appEpoch = params.get("epoch");
export const participantMode = params.get("participant") === "1";
const tokenKey = participantMode ? "holdem-participant-token" : "holdem-app-token";
const gamePrefix = participantMode ? "/api/p/game" : "/api/game";
export function authToken() {
  return sessionStorage.getItem(tokenKey) ?? "";
}
export function appFetch(endpoint, options = {}) {
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${authToken()}`);
  headers.set("x-game-epoch", appEpoch ?? "");
  return fetch(`${gamePrefix}/${appGameId}/${endpoint}`, { ...options, headers });
}
export const TERMINAL_CODES = new Set(['UNAUTHORIZED','STALE_GAME','SESSION_INACTIVE','NOT_SEATED']);

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new DOMException('Aborted','AbortError'));
  let abort;
  const interrupted=new Promise((_,reject)=>{
    abort=()=>reject(new DOMException('Aborted','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
  });
  return Promise.race([promise,interrupted]).finally(()=>signal.removeEventListener('abort',abort));
}
function delay(ms,signal,schedule,cancel) {
  let timer;
  return abortable(new Promise(resolve=>{timer=schedule(resolve,ms);}),signal).finally(()=>cancel(timer));
}
export async function recoverFinalSnapshot({getSnapshot,signal=new AbortController().signal,schedule=setTimeout,cancel=clearTimeout}) {
  for(let attempt=0;attempt<5&&!signal.aborted;attempt++) {
    const current=new AbortController();
    const abort=()=>current.abort();signal.addEventListener('abort',abort,{once:true});
    const timer=schedule(abort,8000);
    try {
      const snapshot=await abortable(Promise.resolve().then(()=>getSnapshot({signal:current.signal})),current.signal);
      if(snapshot && Object.hasOwn(snapshot,'view'))return snapshot;
    } catch {} finally {cancel(timer);signal.removeEventListener('abort',abort);current.abort();}
    if(attempt<4&&!signal.aborted)try{await delay(3000,signal,schedule,cancel);}catch{return null;}
  }
  return null;
}
export function eventStream(endpoint,{request=appFetch,schedule=setTimeout,cancel=clearTimeout,random=Math.random}={}) {
  const listeners=new Map(),lifetime=new AbortController();
  let lastId=0,failures=0,sequence=0;
  const stream={
    addEventListener(kind,fn){listeners.set(kind,fn);},
    close(){lifetime.abort();},
  };
  void (async()=>{
    while(!lifetime.signal.aborted) {
      const controller=new AbortController(),attempt=++sequence;
      const abort=()=>controller.abort();lifetime.signal.addEventListener('abort',abort,{once:true});
      let watchdog,reader,fatal=null,status=0;
      const heartbeat=()=>{cancel(watchdog);watchdog=schedule(abort,35000);};
      heartbeat();
      try {
        const query=new URLSearchParams(endpoint.split('?')[1]);query.set('after',String(lastId));
        const response=await abortable(Promise.resolve().then(()=>request(endpoint.split('?')[0]+'?'+query,{signal:controller.signal})),controller.signal);
        status=response.status;
        if(!response.ok) {
          const body=await abortable(Promise.resolve().then(()=>response.json()).catch(()=>({})),controller.signal);
          if(TERMINAL_CODES.has(body?.code))fatal=body.code;
        } else {
          await abortable(Promise.resolve().then(()=>stream.onopen?.({signal:controller.signal,attempt})),controller.signal);
          if(controller.signal.aborted || attempt!==sequence)throw new DOMException('Aborted','AbortError');
          reader=response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer='';
          for(;;) {
            const {value,done}=await abortable(reader.read(),controller.signal);
            if(done)break;
            heartbeat();failures=0;buffer+=value.replace(/\r\n/g,'\n');
            let boundary;
            while((boundary=buffer.indexOf('\n\n'))>=0) {
              const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
              let kind='message',id='';const data=[];
              for(const line of block.split('\n')) {
                if(line.startsWith('event:'))kind=line.slice(6).trim();
                else if(line.startsWith('data:'))data.push(line.slice(5).trimStart());
                else if(line.startsWith('id:'))id=line.slice(3).trim();
              }
              if(data.length && !controller.signal.aborted && attempt===sequence) {
                lastId=Math.max(lastId,Number(id)||0);
                const event={data:data.join('\n'),lastEventId:id};
                if(kind==='message')stream.onmessage?.(event);else listeners.get(kind)?.(event);
              }
            }
          }
        }
      } catch {} finally {
        controller.abort();cancel(watchdog);lifetime.signal.removeEventListener('abort',abort);
        if(reader){try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}}
      }
      if(lifetime.signal.aborted)return;
      if(fatal){try{await stream.onfatal?.(fatal,{signal:lifetime.signal});}catch{}return;}
      failures+=1;stream.onerror?.();stream.onretry?.(failures);
      const base=Math.min(15000,1500*2**Math.min(failures-1,4));
      const wait=Math.max(status===429?5000:0,Math.min(15000,base*(.8+.4*random())));
      try{await delay(wait,lifetime.signal,schedule,cancel);}catch{return;}
    }
  })();
  return stream;
}
