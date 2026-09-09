import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
function worker(session = {}) {
  let listener;
  const event = { addListener() {} };
  const chrome = {
    runtime: { id: 'test', getURL: (p) => p, onInstalled: event, onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { onActivated: event, onUpdated: event, onRemoved: event },
    storage: { session: {
      get: async (key) => structuredClone(key in session ? { [key]: session[key] } : {}),
      set: async (value) => Object.assign(session, structuredClone(value)),
    } },
    alarms: { create() {}, onAlarm: event },
  };
  vm.runInNewContext(source, { chrome });
  return (msg) => new Promise((resolve) => listener(msg, { id: 'test' }, resolve));
}
test('concurrent activity keeps ordered bounded history and restores crew after worker restart', async () => {
  const session = {};
  const send = worker(session);
  await Promise.all(Array.from({ length: 220 }, (_, i) => send({ type: 'ui.activity', event: { id: String(i), at: i, message: `event ${i}` } })));
  await send({ type: 'ui.activity', event: { id: 'crew', at: 221, message: '', crew: { id: 'art', ids: ['art', 'proof'], working: true } } });
  const snapshot = await worker(session)({ type: 'ui.activitySnapshot' });
  assert.equal(snapshot.events.length, 200);
  assert.equal(snapshot.events[0].id, '20');
  assert.equal(snapshot.events.at(-1).id, '219');
  assert.equal(snapshot.crew.id, 'art');
  assert.deepEqual(snapshot.crew.ids, ['art', 'proof']);
  const run={kind:'stopped',reason:'connection lost',at:222,action:'resume'};
  await send({type:'ui.activity',event:{id:'run',at:222,run}});
  const restored=await worker(session)({type:'ui.activitySnapshot'});
  assert.deepEqual(restored.run,run);
  const ceo={working:true,at:223,until:75223,requestId:'decision-1'};
  await send({type:'ui.activity',event:{id:'ceo',at:223,ceo}});
  assert.deepEqual((await worker(session)({type:'ui.activitySnapshot'})).ceo,ceo);
});
test('Studio routes image generation to art instead of proof', async () => {
  const studio = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
  const start = studio.indexOf('const DEPARTMENTS =');
  const end = studio.indexOf('// ผลงานล่าสุด', start);
  const result = vm.runInNewContext(`${studio.slice(start, end)}; DEPARTMENTS[DEPT_OF_STEP.get('images')].id`);
  assert.equal(result, 'art');
});
test('Studio declares only real same-phase department collaboration', async () => {
  const studio = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
  const start = studio.indexOf('const DEPARTMENTS =');
  const end = studio.indexOf('// ผลงานล่าสุด', start);
  const result = vm.runInNewContext(
    `${studio.slice(start, end)}; ({outline: COLLABORATORS_OF_STEP.get('outline'), fit: COLLABORATORS_OF_STEP.get('fit'), write: COLLABORATORS_OF_STEP.get('write')})`,
  );
  assert.deepEqual([...result.outline], ['planner', 'layout']);
  assert.deepEqual([...result.fit], ['layout', 'writer']);
  assert.equal(result.write, undefined);
});
test('image status moves from proofing to artwork and final layout accurately', async () => {
  const studio = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
  const start = studio.indexOf('const DEPARTMENTS =');
  const end = studio.indexOf('// ผลงานล่าสุด', start);
  const result = vm.runInNewContext(
    `${studio.slice(start, end)}; ['check','generate','verify_all','compile'].map((stage) => IMAGE_DEPT_OF_STAGE.get(stage) || 'art')`,
  );
  assert.deepEqual([...result], ['proof', 'art', 'proof', 'layout']);
});
test('completed step clears only a transient send warning, retaining unresolved findings and partial images', async () => {
  const studio = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
  const begin = studio.indexOf("  if (e.type === 'step_done') {");
  const end = studio.indexOf("  if (e.type === 'state')", begin);
  const run = (step, text, imageStatus = 'complete') => {
    const notes = new Map([[0, { level: 'warn', text }]]);
    const completed = new Set();
    const env = {
      e: { type: 'step_done', step }, book: { imagePhase: { status: imageStatus } },
      DEPT_OF_STEP: new Map([[step, 0]]), deptNotes: notes, completedDepts: completed,
      setNote: (i, text, level) => notes.set(i, { text, level }),
      noteDept() {}, renderSteps() {}, addEvent() {}, STEP_NAMES: {},
    };
    vm.runInNewContext(`(function(){${studio.slice(begin, end)}})()`, env);
    return { note: notes.get(0), done: completed.has(0) };
  };
  assert.equal(run('consistency', 'ส่งงานไม่ออก ลองส่งใหม่ 1/4').note.level, 'ok');
  assert.equal(run('consistency', 'พบ 3 ประเด็นที่ควรดู').note.level, 'warn');
  const partial = run('images', 'ลองส่งใหม่', 'partial');
  assert.equal(partial.note.level, 'warn');
  assert.equal(partial.done, false);
});
