import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('./chatgpt.js',import.meta.url),'utf8');
function fn(name,async=false){const start=source.indexOf(`${async?'async ':''}function ${name}(`);return source.slice(start,source.indexOf('\n  }',start)+4);}
// turnIndexOf เป็น const arrow ไม่ใช่ function declaration จึงต้องตัดคนละแบบ — แต่ต้องเป็นตัวจริง
const constFn=(name)=>{const start=source.indexOf('const '+name+' = ');return source.slice(start,source.indexOf('\n  };',start)+5);};
const node=(key,text)=>({innerText:text,getAttribute:()=>key,closest:()=>null});
test('receipt matches prompt and new identity even when a long chat keeps the same DOM count',()=>{
 let rows=[node('old','prompt')];
 const ctx={$$:()=>rows,normalizeMessage:s=>String(s).replace(/\s+/g,' ').trim()};
 vm.createContext(ctx);vm.runInContext([constFn('turnIndexOf'),...['userMessageKey','snapshotUserMessages','findUserReceipt'].map(n=>fn(n))].join('\n'),ctx);
 const before=ctx.snapshotUserMessages();
 rows=[node('old','prompt')];assert.equal(ctx.findUserReceipt('prompt',before),null,'rerender is not a submission');
 rows=[node('new','unrelated')];assert.equal(ctx.findUserReceipt('prompt',before),null);
 rows=[node('new','prompt')];assert.equal(ctx.findUserReceipt('prompt',before),rows[0]);
});
test('button discovery never falls through to another form or global submit button',()=>{
 const target={};const form={querySelectorAll:()=>[target]};
 const run=vm.runInNewContext('('+fn('sendCandidates')+')',{document:{querySelectorAll:()=>{throw Error('global search')}}});
 assert.equal(run({isConnected:true,closest:()=>form})[0],target);
 assert.equal(run({isConnected:true,closest:()=>null}).length,0);
});
test('one DOM click without acknowledgement cannot loop over click and synthetic Enter',async()=>{
 let clicks=0,waits=0;
 const button={click:()=>clicks++};const box={isConnected:true};
 const run=vm.runInNewContext('('+fn('clickSend',true)+')',{
  stopButtonVisible:()=>false,snapshotUserMessages:()=>[],findUserReceipt:()=>null,
  waitForDom:async()=>++waits===1?button:null,$:()=>box,S:{},composerMatches:()=>true,
 });
 assert.equal(await run(box,12000,'prompt'),null);assert.equal(clicks,1);assert.equal(waits,2);
});
test('adapter serializes turns and replays duplicate IDs without resubmitting',async()=>{
 let listener,release,calls=0;const results=[];
 const start=source.indexOf('  async function runTurn('),end=source.indexOf('  // ---------- ตรวจสุขภาพ',start);
 const code=source.slice(0,start)+'  async function runTurn(...args) { return testRun(...args); }\n'+source.slice(end);
 const context={window:{},document:{},chrome:{storage:{local:{get:async()=>({})}},runtime:{onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>results.push(msg)}},
  testRun:(id)=>{calls++;return new Promise(r=>release=()=>r({turnId:id,status:'ok',text:'answer'}))}};
 vm.runInNewContext(code,context);await Promise.resolve();
 const send=id=>{let ack;listener({type:'gpt.run',turnId:id,prompt:'p'},{},r=>ack=r);return ack;};
 assert.equal(send('a').ok,true);assert.equal(send('a').ok,true);
 assert.equal(send('b').error,'previous_turn_running');assert.equal(calls,1);
 release();await new Promise(r=>setImmediate(r));
 assert.equal(send('a').ok,true);assert.equal(calls,1);assert.equal(results.length,2);
});

test('native fallback refuses a changed draft or an active response before touching input',async()=>{
 const sw=await readFile(new URL('../sw.js',import.meta.url),'utf8');
 const start=sw.indexOf('func: (expected, requireDraft) => {');
 const code=sw.slice(start+6,sw.indexOf('\n            },',start)+14);
 let draft='prompt',busy=false;
 const document={activeElement:null,querySelector:()=>box,querySelectorAll:()=>busy?[{getBoundingClientRect:()=>({width:10,height:10})}]:[]};
 const box={get innerText(){return draft},focus:()=>document.activeElement=box};
 const check=vm.runInNewContext('('+code+')',{document});
 assert.equal(check('prompt',true),true);
 draft='different';assert.equal(check('prompt',true),false);
 draft='prompt';busy=true;assert.equal(check('prompt',true),false);
});

/**
 * ChatGPT พับข้อความผู้ใช้ที่ยาวมากให้เหลือบางส่วน ซึ่ง Prompt ของระบบนี้ยาวหลายพันตัวอักษร
 * ถ้าเทียบแบบ "เท่ากันเป๊ะ" จะหาใบเสร็จของตัวเองไม่เจอ ทั้งที่ส่งไปแล้วจริง
 * แล้วจบเป็น outcome_unknown → หยุดทั้งงานโดยไม่มีเหตุ (เห็นจริง: ค้าง 40 นาทีที่ขั้นคิดชื่อ)
 */
test('ข้อความยาวที่หน้าเว็บพับท้ายทิ้ง ยังนับเป็นใบเสร็จของเราได้', () => {
  const long = 'คุณคือบรรณาธิการตั้งชื่อหนังสือมืออาชีพ ' + 'ก'.repeat(4000);
  let rows = [];
  const ctx = { $$: () => rows, normalizeMessage: (s) => String(s).replace(/\s+/g, ' ').trim() };
  vm.createContext(ctx);
  vm.runInContext(['userMessageKey', 'snapshotUserMessages', 'findUserReceipt'].map((n) => fn(n)).join('\n'), ctx);
  const before = ctx.snapshotUserMessages();
  // หน้าเว็บแสดงแค่ 300 ตัวแรกแล้วมีปุ่มขยาย — หัวข้อความยังตรง
  rows = [node('new', long.slice(0, 300))];
  assert.equal(ctx.findUserReceipt(long, before), rows[0], 'ส่งไปแล้วจริง ต้องเจอใบเสร็จ');
});

test('ข้อความอื่นที่ขึ้นต้นคนละแบบ ยังไม่ถูกนับเป็นใบเสร็จของเรา', () => {
  let rows = [];
  const ctx = { $$: () => rows, normalizeMessage: (s) => String(s).replace(/\s+/g, ' ').trim() };
  vm.createContext(ctx);
  vm.runInContext(['userMessageKey', 'snapshotUserMessages', 'findUserReceipt'].map((n) => fn(n)).join('\n'), ctx);
  const before = ctx.snapshotUserMessages();
  rows = [node('new', 'คำสั่งอื่นที่ไม่เกี่ยวกันเลย')];
  assert.equal(ctx.findUserReceipt('คุณคือบรรณาธิการ ' + 'ก'.repeat(300), before), null);
});
