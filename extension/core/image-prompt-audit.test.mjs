import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { compactImagePrompt } from './prompts.js';

/**
 * ด่านตรวจคำสั่งภาพต้องล้มโดยไม่พาทั้งเล่มล้มตาม
 *
 * แผนกนี้ไม่ได้ผลิตอะไรลงในเล่มสักบรรทัด หน้าที่มันคือทำให้คำสั่งที่มีอยู่แล้วดีขึ้น
 * แต่มันเป็นด่านที่ล้มง่ายที่สุด เพราะคำสั่งของมันคือคำสั่งภาพทุกฉบับต่อกันเป็นก้อนเดียว
 * ซึ่งเป็นข้อความยาวที่สุดที่ระบบเคยพิมพ์ลงช่องของ ChatGPT — พิมพ์ไม่ติดแล้วจบด้วย
 * previous_turn_running ได้จริง (เห็นบนจอ: ค้างที่ขั้น "พิมพ์ Prompt ลงช่อง" เกือบห้านาที)
 *
 * เดิม Halt ถูกส่งต่อขึ้นไป = งานทั้งเล่มหยุดที่ด่านนี้ ทั้งที่ภาพทุกใบมีคำสั่งพร้อมวาดอยู่แล้ว
 * มีเรื่องเดียวที่ยังต้องหยุดจริงคือโควตาหมด เพราะนั่นเป็นเรื่องของทั้งระบบ ไม่ใช่ของแผนกนี้
 */
const src = await readFile(new URL('./machine.js', import.meta.url), 'utf8');
const start = src.indexOf('  async auditImagePrompts(jobs) {');
assert.ok(start > 0, 'หา auditImagePrompts ใน machine.js ไม่เจอ');
const body = src.slice(start, src.indexOf('\n  }\n', start) + 4);

class Halt extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
class RateLimited extends Error {}

/**
 * ตัวช่วยระดับโมดูลที่เมท็อดนี้เรียกใช้ — ดึงของจริงจาก machine.js มาใช้
 * (นำเข้าตรง ๆ ไม่ได้ เพราะไฟล์นั้นผูกกับ API ของเบราว์เซอร์ตั้งแต่บรรทัดแรก)
 */
const grab = (re) => {
  const m = src.match(re);
  assert.ok(m, `หาโค้ดที่ต้องใช้ไม่เจอ: ${re}`);
  return m[0];
};
const AUDIT_BATCH_CHARS = Number(grab(/const AUDIT_BATCH_CHARS = (\d+)/).replace(/\D/g, ''));
const helpers = vm.createContext({});
vm.runInContext(
  `${grab(/const promptKey = \(text\) => \{[\s\S]*?\n\};/)}
${grab(/export function batchByBudget[\s\S]*?\n\}/).replace('export ', '')}
globalThis.out = { promptKey, batchByBudget };`,
  helpers,
);
const { promptKey, batchByBudget } = helpers.out;

function makeMachine(turnWithRetry, jobs, { book = {}, sent = [] } = {}) {
  const logs = [];
  const scope = {
    Halt,
    RateLimited,
    AUDIT_BATCH_CHARS,
    promptKey,
    batchByBudget,
    // หัวคำสั่งจริงมีค่าคงที่ราวสองพันห้า บวกเนื้อของแต่ละฉบับ — จำลองให้ใกล้ของจริง
    P: {
      compactImagePrompt: compactImagePrompt,
      imagePromptAuditPrompt: (b, group) =>
        'หัวข้อและกติกา'.repeat(180) + group.map((j) => `[[${j.name}]]${j.prompt}`).join('\n'),
    },
    X: { parseJson: (t) => JSON.parse(t) },
    wantsAuthorRef: () => false,
    enforceAuthorRefPrompt: (p) => p,
    machine: null,
    /**
     * นับเฉพาะก้อนที่ "ส่งจริง"
     *
     * ตัวซอยก้อนต้องวัดขนาดของก้อนที่ยังไม่ได้ส่งเพื่อตัดสินใจว่าตัดตรงไหน
     * ถ้าไปนับตอนสร้างข้อความ จะได้ก้อนทดลองที่ถูกปฏิเสธไปแล้วปนมาด้วย
     */
    turnWithRetry: async (prompt, opts) => {
      sent.push({
        size: prompt.length,
        names: [...String(prompt).matchAll(/\[\[(.+?)\]\]/g)].map((m) => m[1]),
      });
      return turnWithRetry(prompt, opts);
    },
    book,
    logs,
  };
  vm.createContext(scope);
  vm.runInContext(
    `machine = {
${body.trimEnd()},
      book,
      job: {},
      log: (level, msg) => logs.push([level, msg]),
      save: async () => {},
      wantNewThread: () => true,
      turnWithRetry,
    };`,
    scope,
  );
  return { machine: scope.machine, logs, jobs };
}

const sampleJobs = () => [
  { name: 'cover.png', what: 'ปกหน้า', prompt: 'ก'.repeat(1200) },
  { name: 'fig-1.png', what: 'ภาพตอน 1.1', prompt: 'ข'.repeat(1200) },
];

test('หน้าเว็บยังทำเทิร์นก่อนหน้าอยู่ = ข้ามด่านตรวจ ไม่หยุดทั้งเล่ม', async () => {
  const jobs = sampleJobs();
  const before = jobs.map((j) => j.prompt);
  const { machine, logs } = makeMachine(async () => {
    throw new Halt('ChatGPT ยังทำเทิร์นก่อนหน้าอยู่', 'previous_turn_running');
  }, jobs);

  await machine.auditImagePrompts(jobs);

  assert.deepEqual(jobs.map((j) => j.prompt), before, 'คำสั่งเดิมต้องอยู่ครบ พร้อมเอาไปวาดต่อ');
  assert.ok(
    logs.some(([level, msg]) => level === 'warn' && /ข้ามก้อนนี้/.test(msg)),
    'ต้องบอกผู้ใช้ว่าข้ามก้อนนี้ ไม่ใช่เงียบหายไปเฉย ๆ',
  );
});

test('พิมพ์ลงช่องไม่สำเร็จ หรืออ่านคำตอบไม่ออก ก็ยังเดินต่อ', async () => {
  for (const boom of [
    new Halt('เขียนลงช่องพิมพ์ไม่สำเร็จ', 'not_sent'),
    new Error('composer_text_mismatch'),
  ]) {
    const jobs = sampleJobs();
    const { machine } = makeMachine(async () => {
      throw boom;
    }, jobs);
    await assert.doesNotReject(() => machine.auditImagePrompts(jobs));
  }
});

test('โควตาหมดยังต้องหยุด เพราะเป็นเรื่องของทั้งระบบ ไม่ใช่ของแผนกนี้', async () => {
  const jobs = sampleJobs();
  const { machine } = makeMachine(async () => {
    throw new RateLimited('โควตาหมด');
  }, jobs);
  await assert.rejects(() => machine.auditImagePrompts(jobs), RateLimited);
});

test('ตรวจผ่านปกติ = คำสั่งที่แก้แล้วถูกนำไปใช้จริง', async () => {
  const jobs = sampleJobs();
  const fixed = 'ค'.repeat(1200);
  const { machine } = makeMachine(async () => ({
    text: JSON.stringify({
      checks: [{ name: 'cover.png', verdict: 'fixed', issues: ['ขัดกันเอง'], fixed_prompt: fixed }],
      notes: '',
    }),
  }), jobs);

  await machine.auditImagePrompts(jobs);

  assert.equal(jobs[0].prompt, fixed, 'ฉบับที่แก้แล้วต้องถูกใช้แทนของเดิม');
  assert.equal(jobs[1].prompt, 'ข'.repeat(1200), 'ฉบับที่ไม่ได้ทักต้องไม่ถูกแตะ');
});

test('คำสั่งที่แก้แล้วสั้นผิดปกติ = ไม่รับ ใช้ของเดิม', async () => {
  const jobs = sampleJobs();
  const { machine } = makeMachine(async () => ({
    text: JSON.stringify({
      checks: [{ name: 'cover.png', verdict: 'fixed', issues: [], fixed_prompt: 'ควรตัดท่อนที่ขัดกันออก' }],
    }),
  }), jobs);

  await machine.auditImagePrompts(jobs);

  assert.equal(jobs[0].prompt, 'ก'.repeat(1200), 'คำแนะนำสั้น ๆ ใช้แทนบรีฟทั้งฉบับไม่ได้');
});

/**
 * ก้อนที่ส่งต้องเล็กพอที่จะพิมพ์ลงช่องของ ChatGPT ได้จริง
 *
 * นี่คือต้นเหตุของอาการค้าง ไม่ใช่ผลข้างเคียง: คำสั่งภาพทุกฉบับต่อกันได้สองหมื่นกว่าตัวอักษร
 * ซึ่งเกินขนาดที่เคยพังจริงไปเกือบสามเท่า แล้วจบที่วนพิมพ์ใหม่จนหมดเวลาโดยไม่เคยส่งออกไปเลย
 */
test('คำสั่งเจ็ดฉบับถูกซอยเป็นก้อนย่อย ไม่ส่งเป็นก้อนเดียว', async () => {
  const jobs = Array.from({ length: 7 }, (_, i) => ({
    name: `fig-${i}.png`,
    what: `ภาพที่ ${i}`,
    prompt: `ภาพประกอบหมายเลข ${i} `.repeat(120),
  }));
  const sent = [];
  const { machine } = makeMachine(async () => ({ text: JSON.stringify({ checks: [] }) }), jobs, { sent });

  await machine.auditImagePrompts(jobs);

  const turns = sent.filter((s) => s.names.length);
  assert.ok(turns.length > 1, 'ต้องซอย ไม่ใช่ยัดทั้งเจ็ดฉบับในเทิร์นเดียว');
  for (const t of turns) {
    assert.ok(
      t.size <= AUDIT_BATCH_CHARS || t.names.length === 1,
      `ก้อนละ ${t.size} ตัวอักษร เกินเพดาน ${AUDIT_BATCH_CHARS} ทั้งที่มี ${t.names.length} ฉบับ`,
    );
  }
  assert.deepEqual(
    turns.flatMap((t) => t.names).sort(),
    jobs.map((j) => j.name).sort(),
    'ซอยแล้วต้องยังอ่านครบทุกฉบับ ไม่ใช่ตรวจน้อยลง',
  );
});

test('ชิ้นเดียวที่ใหญ่เกินงบยังต้องได้ไป ไม่ใช่เงียบหาย', () => {
  const items = [{ n: 'ใหญ่', len: 20000 }, { n: 'เล็ก', len: 100 }];
  const batches = batchByBudget(items, (g) => g.reduce((a, c) => a + c.len, 0), 7000);
  // batchByBudget ถูกสร้างในบริบท vm ผลลัพธ์จึงเป็นอาร์เรย์คนละ realm — เทียบเป็นข้อความแทน
  assert.equal(JSON.stringify(batches.map((b) => b.map((x) => x.n))), JSON.stringify([['ใหญ่'], ['เล็ก']]));
});

/**
 * รอบสองของเล่มเดียวกันแทบไม่ต้องส่งอะไรเลย
 *
 * เดิมจำด้วยลายเซ็นรวมของทุกฉบับ แก้ใบเดียวก็ตรวจใหม่ทั้งชุด ทั้งที่อีกหกใบเป็นข้อความเดิมเป๊ะ
 */
test('คำสั่งที่เคยตรวจแล้วไม่ถูกส่งซ้ำ', async () => {
  const jobs = sampleJobs();
  const book = {};
  const sent = [];
  let calls = 0;
  const reply = async () => {
    calls++;
    return { text: JSON.stringify({ checks: [] }) };
  };

  await makeMachine(reply, jobs, { book, sent }).machine.auditImagePrompts(jobs);
  assert.equal(calls, 1, 'รอบแรกต้องส่งจริง');

  await makeMachine(reply, jobs, { book, sent }).machine.auditImagePrompts(jobs);
  assert.equal(calls, 1, 'รอบสองของคำสั่งชุดเดิมต้องไม่ส่งอะไรเลย');
});

test('แก้คำสั่งใบเดียว = ตรวจเฉพาะใบนั้น ไม่ลากทั้งชุดไปตรวจใหม่', async () => {
  const jobs = sampleJobs();
  const book = {};
  const asked = [];
  const reply = async () => ({ text: JSON.stringify({ checks: [] }) });

  await makeMachine(reply, jobs, { book, sent: asked }).machine.auditImagePrompts(jobs);
  asked.length = 0;

  jobs[1].prompt = 'ง'.repeat(1500);
  await makeMachine(reply, jobs, { book, sent: asked }).machine.auditImagePrompts(jobs);

  assert.deepEqual(asked.flatMap((a) => a.names), ['fig-1.png'], 'ต้องส่งเฉพาะฉบับที่เปลี่ยน');
});

test('ก้อนหนึ่งล้ม ก้อนที่เหลือยังตรวจต่อ', async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => ({
    name: `fig-${i}.png`,
    what: `ภาพที่ ${i}`,
    prompt: `ภาพประกอบหมายเลข ${i} `.repeat(120),
  }));
  const sent = [];
  let calls = 0;
  const { machine, logs } = makeMachine(async () => {
    calls++;
    if (calls === 1) throw new Halt('ChatGPT ยังทำเทิร์นก่อนหน้าอยู่', 'previous_turn_running');
    return { text: JSON.stringify({ checks: [] }) };
  }, jobs, { sent });

  await machine.auditImagePrompts(jobs);

  assert.ok(calls > 1, 'ก้อนแรกล้มแล้วต้องไปต่อ ไม่ใช่จบทั้งด่าน');
  assert.ok(logs.some(([l, m]) => l === 'warn' && /ก้อนที่ 1/.test(m)), 'ต้องบอกว่าก้อนไหนล้ม');
});

/**
 * แผนกนี้ถูกปิดที่จุดเรียก ไม่ใช่ถอดโค้ดทิ้ง
 *
 * เหตุผลที่ปิด: มันอ่านคำสั่งภาพทุกฉบับแล้วเขียนฉบับเต็มที่แก้แล้วกลับมาทั้งฉบับ
 * เล่มหนึ่งจึงกินเวลาเป็นชั่วโมงก่อนได้เริ่มวาดภาพใบแรก ทั้งที่ไม่ได้ผลิตอะไรลงในเล่ม
 * เหตุผลที่ไม่ถอดทิ้ง: ของที่มันจับได้เป็นของจริง วันหนึ่งอาจคุ้มที่จะจ่ายเวลานั้น
 */
test('เส้นทางสร้างภาพต้องไม่เรียกแผนกนี้ นอกจากจะเปิดไว้ชัด ๆ', () => {
  const call = src.indexOf('await this.auditImagePrompts(jobs);');
  assert.ok(call > 0, 'ยังต้องมีจุดเรียกอยู่ เพื่อให้เปิดกลับมาได้');
  const before = src.slice(call - 400, call);
  assert.match(before, /if \(this\.book\.auditImagePrompts === true\) \{/);
  // ต้องเปิดด้วยการตั้งค่าชัดเจนเท่านั้น ค่าว่าง/ไม่เคยตั้ง = ปิด
  assert.ok(!/this\.book\.auditImagePrompts \)/.test(src), 'ห้ามใช้เงื่อนไขหลวม ๆ ที่ค่าเก่าในไฟล์โครงการเปิดมันกลับมาเองได้');
});
