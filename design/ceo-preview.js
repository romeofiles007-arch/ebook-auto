// Isolated visual fixture. No real extension connection or model requests.
const params = new URLSearchParams(location.search);
const working = params.has('working');
const active = params.has('active');
const done = params.has('done');
globalThis.chrome = {runtime:{onMessage:{addListener(){}},sendMessage:async()=>({
  at:Date.now(), events:[], run:{kind:done?'done':active?'working':'ready',at:Date.now()},
  ceo:working ? {working:true,called:true,at:Date.now(),until:Date.now()+300000,
    detail:'กำลังตรวจปัญหา · บรรณาธิการตรวจบทที่ 3'} : null,
})}};
await import('/extension/ui/panel-activity.js');
