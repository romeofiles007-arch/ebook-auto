import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { ceoView } from './ceo-panel.js';
import { addCeoUsage, ceoUsageLabel } from '../core/ceo-usage.js';
import { parseSupervisorDecision } from '../core/supervisor.js';
const src = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('async function sendTurn('), src.indexOf('/** ยิงหนึ่งครั้งด้วยสายส่งปัจจุบัน'));
// เกณฑ์จำนวนขั้นต่ำถูกประกาศไว้ก่อนตัว parser ต้องตัดมาตั้งแต่ตรงนั้น ไม่งั้น parser จะอ้างถึงของที่ไม่มี
const parsers = src.slice(src.indexOf('const MIN_TITLE_CHOICES'), src.indexOf('async function generateTrendIdeas('));
function setup(responses, decision, book = {}) {
  let asks = 0;
  const sends = [];
  const transport = { send: async (prompt, opts) => { sends.push(opts); return responses.shift(); } };
  const scope = { book, RETRYABLE_TURN_STATUS: new Set(['error','timeout','empty']),
    turnErrorMessage: r => r.meta?.error || r.status,
    makeSupervisor: () => async () => { asks++; return decision; },
    addEvent() {}, recentLogLines: () => [], answerEvidence: () => '',
    parseJson: s => { try { return JSON.parse(s); } catch { return null; } },
    setTimeout: fn => fn() };
  vm.runInNewContext(`${parsers}\n${block}\nglobalThis.run = sendTurn;`, scope);
  return { sends, asks: () => asks, run: (parse = scope.parseTitleAnswer, opts = {}) =>
    scope.run(transport, 'prompt', opts, { attempts: 1, parse }) };
}
for (const code of ['outcome_unknown','previous_turn_running']) test(`${code}: no CEO or duplicate send`, async () => {
  const f = setup([{status:'timeout', meta:{error:code}}], {action:'retry'});
  await f.run(); assert.equal(f.asks(),0); assert.equal(f.sends.length,1);
});
test('quota and parser fatal never reach CEO', async () => {
  const f = setup([{status:'rate_limited'}], {action:'retry'});
  await f.run(); assert.equal(f.asks(),0);
  const p = setup([{status:'ok',text:'cannot'}], {action:'retry'});
  await p.run(() => ({error:'unavailable',fatal:true})); assert.equal(p.asks(),0);
});
test('repaired titles use original parser and produce UI array', async () => {
  const f = setup([{status:'ok',text:'broken'}], {action:'repair_json',repaired:{titles:['Example','สอง','สาม','สี่']}});
  const r = await f.run(); assert.equal(r.data[0].title,'Example'); assert.equal(f.sends.length,1);
});
test('repaired trends retain UI field mapping', async () => {
  const f = setup([{status:'ok',text:'broken'}], {action:'repair_json',repaired:{topics:[{topic:'AI',why:'now'}]}});
  const parse = r => { const x = JSON.parse(r.text).topics; return {data:x.map(v=>({trend:v.topic,why_now:v.why}))}; };
  const r = await f.run(parse); assert.equal(r.data[0].trend,'AI');
});
test('retry uses same transport and validates new response', async () => {
  const f = setup([{status:'error'},{status:'ok',text:'{"titles":["Ready","สอง","สาม","สี่"]}'}], {action:'retry'});
  const r = await f.run(); assert.equal(r.data[0].title,'Ready'); assert.equal(f.sends.length,2);
});
test('wrong repaired shape never enters UI', async () => {
  const f = setup([{status:'ok',text:'broken'}], {action:'repair_json',repaired:{titles:{bad:true}}});
  const r = await f.run(); assert.equal(r.data,undefined); assert.ok(r.error);
});
test('recovery preserves unknown outcome from its final attempt', async () => {
  const f = setup([{status:'error'},{status:'timeout',meta:{error:'outcome_unknown'}}], {action:'retry'});
  assert.equal((await f.run()).meta.error,'outcome_unknown'); assert.equal(f.sends.length,2);
});
for (const [book,opts] of [[{threadMode:'reuse'},{}],[{},{wantImages:true}]]) test('CEO cannot abandon protected conversation', async () => {
  const f = setup([{status:'error'}], {action:'new_thread'},book);
  await f.run(undefined,opts); assert.equal(f.sends.length,1);
});
test('CEO is awake without work, sleeps during production, and works for the full display window', () => {
  assert.equal(ceoView(null, 50, null).mode, 'awake');
  assert.equal(ceoView(null, 50, {kind:'done'}).mode, 'awake');
  assert.equal(ceoView(null, 50, {kind:'working'}).mode, 'sleeping');
  assert.equal(ceoView({working:true,called:true,until:100},50,{kind:'working'}).mode,'working');
  const finished = ceoView({working:false,called:true,until:100,detail:'done'},50,{kind:'working'});
  assert.equal(finished.mode,'working');
  assert.match(finished.title,/ส่งคำตัดสินแล้ว/);
  assert.equal(ceoView({working:false,called:true,until:100},101,{kind:'working'}).mode,'sleeping');
});
test('CEO tokens counted separately, including failure metadata and repair turn', () => {
  const a = addCeoUsage({}, {meta:{promptTokens:20,completionTokens:5}});
  const b = addCeoUsage(a, {status:'error',meta:{promptTokens:10,completionTokens:2}});
  assert.deepEqual(b,{turns:2,promptTokens:30,completionTokens:7});
  assert.equal(a.turns,1); assert.equal(addCeoUsage(b,{}),b);
});
test('actual CEO wrapper publishes start/finish and persists both decision and repair usage',async()=>{
  const states=[],saved=new Map(),owner={id:'test'};
  const responses=[{status:'ok',text:'{"action":"repair_json"}',meta:{promptTokens:3,completionTokens:2}},
    {status:'ok',text:'{"titles":["Ready"]}',meta:{promptTokens:5,completionTokens:4}}];
  const scope={book:owner,ceoModeOn:()=>true,apiKeyValue:'fake',SUPERVISOR_MODEL:'test',
    chrome:{runtime:{sendMessage:async m=>states.push(m.event.ceo)}},
    db:{setting:async(k,v)=>v===undefined?saved.get(k):saved.set(k,v),saveBook:async()=>{}},
    addCeoUsage,ceoUsageLabel,showRunningCost(){},addEvent(){},
    makeTransport:()=>({send:async()=>responses.shift()}),supervisorPrompt:()=>'',repairPrompt:()=>'',
    parseSupervisorDecision,parseJson:JSON.parse,turnErrorMessage:()=> 'failed'};
  const fn=src.slice(src.indexOf('function makeSupervisor()'),src.indexOf('\nfunction makeMachine()'));
  vm.runInNewContext(`${fn}\nglobalThis.supervise=makeSupervisor();`,scope);
  const r=await scope.supervise({step:'setup',raw:'bad'});
  assert.equal(r.repaired.titles[0],'Ready');
  assert.deepEqual(states.map(x=>x.working),[true,true,false]);
  assert.ok(states.every(x=>x.called && x.until === states[0].until));
  assert.ok(states[0].until - states[0].at > 299000);
  assert.equal(owner.ceoUsage.turns,2); assert.equal(owner.ceoUsage.promptTokens,8);
  scope.makeTransport=()=>({send:async()=>{throw Error('offline');}});
  await assert.rejects(scope.supervise({step:'setup'}));
  assert.equal(states.at(-1).working,false); assert.match(states.at(-1).detail,/offline/);
});
