/** Owns only presentation/focus, never game pause or action authority. */
export function createDialogController(doc, onClose=()=>{}) {
  let active=null,trigger=null,dismiss=null;
  const previousInert=new Map();
  const focusables=()=>[...active.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(n=>!n.hidden && n.getClientRects().length);
  const controller={
    get active(){return active;},
    open(overlay,close){
      if(active===overlay)return;
      if(active)this.dismiss();
      trigger=doc.activeElement;active=overlay;dismiss=close;overlay.hidden=false;
      for(const node of doc.body.children)if(node!==overlay && !['script','svg'].includes(node.localName)){previousInert.set(node,node.inert);node.inert=true;}
      const target=focusables()[0]??overlay.querySelector('[role="dialog"]')??overlay;
      if(!target.hasAttribute('tabindex') && !target.matches('button,input,a,select,summary'))target.tabIndex=-1;
      target.focus();
    },
    close(){
      if(!active)return;
      active.hidden=true;active=null;dismiss=null;
      for(const [node,value] of previousInert)node.inert=value;
      previousInert.clear();
      if(trigger?.isConnected && !trigger.closest('[inert]'))trigger.focus();
      trigger=null;onClose();
    },
    dismiss(){if(dismiss)dismiss();if(active)this.close();},
  };
  doc.addEventListener('keydown',ev=>{
    if(!active)return;
    if(ev.key==='Escape'){ev.preventDefault();controller.dismiss();return;}
    if(ev.key!=='Tab')return;
    const nodes=focusables();if(!nodes.length){ev.preventDefault();return;}
    const index=nodes.indexOf(doc.activeElement);
    if(ev.shiftKey && index<=0){ev.preventDefault();nodes.at(-1).focus();}
    else if(!ev.shiftKey && (index===nodes.length-1 || index<0)){ev.preventDefault();nodes[0].focus();}
  });
  return controller;
}
