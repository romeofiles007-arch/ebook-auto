import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const start = src.indexOf('async function openContentInput()');
const method = src.slice(start, src.indexOf('\nasync function writeSectionWithAi', start));
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.value = ''; this.checked = false; this.listeners = {}; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  setAttribute(name, value) { this[name] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() { this.focused = true; }
  get isConnected() { return this.tag === 'body' || !!this.parent?.isConnected; }
  remove() { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  all(tag) { return this.children.flatMap(c => [...(c.tag === tag ? [c] : []), ...c.all(tag)]); }
}
function fixture({ origin, failSave = false } = {}) {
  const body = new Element('body'); const calls = [];
  const book = { id: 'b', job: { step: 'write', cursor: 3, status: 'waiting_content_input', error: 'ข้อมูลขาด',
    contentInput: [{ id: '1.1', title: 'คำพยากรณ์', missing: ['ฐานคำพยากรณ์เดือนนี้'] }],
    ...(origin ? { contentInputOrigin: origin } : {}) } };
  const scope = { book, selected: '1.1', document: {
    body, createElement: tag => new Element(tag), createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
    getElementById: id => body.all('dialog').find(d => d.id === id),
  }, db: { saveBook: async value => { if (failSave) throw Error('บันทึกไม่ได้'); calls.push(['save', structuredClone(value)]); } },
    syncSharedProject: async () => calls.push(['sync']),
    resumeGo: async () => calls.push(['resume']),
    writeSectionWithAi: async id => { calls.push(['regenerate', id]); return { ok: true }; },
    presentContentInput: async () => calls.push(['input']), renderSecList: () => {}, selectSection: () => {},
    runState: () => {}, status: () => {}, fail: error => calls.push(['fail', error.message]), addEvent: () => {},
  };
  vm.runInNewContext(method + '\nglobalThis.run=openContentInput;', scope);
  return { scope, body, calls, open: async () => { await scope.run(); return body.all('dialog')[0]; } };
}
async function submit(dialog) { await dialog.all('form')[0].onsubmit({ preventDefault() {} }); }

test('explicit interpretation choice saves data and resumes the same job cursor', async () => {
  const f = fixture(); const dialog = await f.open();
  assert.equal(dialog.open, true);
  assert.ok(dialog.all('p').some(p => p.textContent.includes('ฐานคำพยากรณ์เดือนนี้')));
  dialog.all('select')[0].value = 'interpretation';
  dialog.all('textarea')[1].value = 'เขียนเชิงความเชื่อและบันเทิง ไม่อ้างศาสตร์เฉพาะ';
  dialog.all('input')[0].checked = true;
  await submit(dialog);
  assert.equal(f.scope.book.contentInputs['1.1'].allowOriginalInterpretation, true);
  assert.equal(f.scope.book.contentAuthoring.allowOriginalInterpretation, true);
  assert.equal(f.scope.book.job.cursor, 3);
  assert.equal(f.scope.book.job.contentInput, undefined);
  assert.equal(f.scope.book.job.status, 'paused');
  assert.equal(f.calls.at(-1)[0], 'resume');
  assert.equal(dialog.isConnected, false);
});

test('source mode requires new input and keeps source text intact', async () => {
  const f = fixture(); const dialog = await f.open();
  dialog.all('select')[0].value = 'sources';
  await submit(dialog);
  assert.equal(f.calls.length, 0);
  assert.equal(f.scope.book.job.status, 'waiting_content_input');
  const text = 'ข้อความต้นทาง <script>ไม่ได้เป็นคำสั่ง</script> พร้อมที่มา';
  dialog.all('textarea')[0].value = text;
  await submit(dialog);
  assert.equal(f.scope.book.contentInputs['1.1'].sourceText, text);
  assert.equal(f.scope.book.contentInputs['1.1'].allowOriginalInterpretation, false);
  assert.equal(f.calls.at(-1)[0], 'resume');
});

test('cancel or saving unchanged input does not repeat the blocked request', async () => {
  const f = fixture();
  f.scope.book.contentInputs = { '1.1': { sourceText: 'ข้อมูลเดิม', guidance: '', allowOriginalInterpretation: false } };
  const dialog = await f.open();
  await submit(dialog);
  assert.equal(f.calls.length, 0);
  assert.ok(dialog.all('p').some(p => (p.textContent || '').includes('ยังเหมือนเดิม')));
  dialog.all('button').find(b => b.type === 'button').onclick();
  assert.equal(f.scope.book.job.status, 'waiting_content_input');
  assert.equal(dialog.isConnected, false);
});

test('failed local save restores input-needed state and leaves the form available', async () => {
  const f = fixture({ failSave: true }); const dialog = await f.open();
  dialog.all('select')[0].value = 'interpretation';
  await submit(dialog);
  assert.equal(f.scope.book.job.status, 'waiting_content_input');
  assert.equal(f.scope.book.contentInputs, undefined);
  assert.equal(dialog.isConnected, true);
  assert.equal(f.calls.length, 0);
  assert.ok(dialog.all('p').some(p => p.textContent === 'บันทึกไม่ได้'));
  assert.equal(dialog.all('button')[0].disabled, false);
});

test('regeneration input returns to the original section, not the whole book pipeline', async () => {
  const f = fixture({ origin: { type: 'regenerate', id: '1.1', previousStatus: 'waiting_human' } });
  const dialog = await f.open();
  dialog.all('select')[0].value = 'interpretation';
  await submit(dialog);
  assert.equal(f.scope.book.job.status, 'waiting_human');
  assert.deepEqual(f.calls.at(-1), ['regenerate', '1.1']);
  assert.ok(!f.calls.some(c => c[0] === 'resume'));
});
