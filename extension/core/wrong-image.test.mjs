/**
 * "พอดึงภาพมาก็ดึงผิดภาพ" — fig-2.1-1.png กลายเป็นรูปหน้าผู้เขียน แหล่งที่มาเขียนว่า ChatGPT
 *
 * รูปที่เราแนบไปกับคำสั่งถูกนับเป็นภาพที่โมเดลวาด แล้วบันทึกลงช่องภาพจริงในเล่ม
 * ด่านเดิมกันด้วย closest('[data-message-author-role="user"]') ซึ่งไม่พอ เพราะหน้าเว็บ
 * วางภาพย่อของไฟล์แนบไว้คนละคอนเทนเนอร์กับก้อนข้อความ
 * และตัวกันภาพซ้ำก็ช่วยไม่ได้ เพราะหน้าเว็บบีบอัดไฟล์แนบใหม่ ไบต์จึงไม่ตรงต้นฉบับ
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const adapter = await readFile(new URL('../adapter/chatgpt.js', import.meta.url), 'utf8');
const machine = await readFile(new URL('./machine.js', import.meta.url), 'utf8');

/**
 * ตัวสแกน DOM ต้องกันเฉพาะสิ่งที่ "แน่นอน" เท่านั้น
 *
 * เคยเผลอกันทั้งเทิร์นที่มีข้อความผู้ใช้ แล้วภาพที่ ChatGPT วาดก็ถูกตัดทิ้งไปด้วย
 * (หน้าเว็บครอบข้อความเรากับคำตอบไว้ในกล่องเดียวกันได้) — เห็นกับตา: ภาพขึ้นเต็มจอแล้ว
 * แต่บันทึกฟ้อง "ภาพในคำตอบ 0 รูป" งานวนรอจนหมดเวลา
 */
test('ตัวสแกนกันเฉพาะสิ่งที่แน่นอน ไม่เดาจากตำแหน่งในหน้าเว็บ', () => {
  const scan = adapter.slice(adapter.indexOf('function scanImages('), adapter.indexOf('function readImages('));
  // อยู่ในก้อนข้อความของผู้ใช้ = แน่นอน
  assert.match(scan, /i\.closest\('\[data-message-author-role="user"\]'\)\) continue;/);
  // อยู่ในช่องพิมพ์ = ยังไม่ได้ส่งด้วยซ้ำ แน่นอนเช่นกัน
  assert.match(scan, /i\.closest\('form'\)\?\.contains\(\$\(S\.composer\)\)\) continue;/);
  // ห้ามกันทั้งเทิร์น — กว้างเกินไปและตัดภาพที่เรารออยู่ทิ้ง
  // ดูที่โค้ดที่รันจริง ไม่ใช่คำอธิบาย — คอมเมนต์ที่เล่าว่าเคยพลาดยังไงต้องอยู่ต่อได้
  assert.ok(!scan.includes('[data-testid^="conversation-turn"]'), 'ห้ามตัดสินจากกล่องเทิร์นทั้งก้อน');
});

/**
 * งานแยก "รูปผู้เขียน" ออกจาก "ภาพที่โมเดลวาด" ย้ายไปอยู่ที่ลายนิ้วมือของภาพแทน
 * ซึ่งรู้แน่และไม่ขึ้นกับว่าหน้าเว็บจัดวางยังไง
 */
test('การกันรูปผู้เขียนย้ายไปอยู่ที่ลายนิ้วมือ ไม่ใช่ตำแหน่ง DOM', () => {
  assert.match(machine, /if \(this\.refHash\)/);
  assert.match(machine, /hashDistance\(got, this\.refHash\) < 6/);
});

test('ลายนิ้วมือที่ทนการบีบอัดใหม่ — เทียบ "ภาพเดียวกัน" ไม่ใช่ "ไฟล์เดียวกัน"', () => {
  const fn = machine.slice(machine.indexOf('async function imageAHash('), machine.indexOf('function imageFingerprint('));
  assert.match(fn, /new OffscreenCanvas\(8, 8\)/);
  assert.match(fn, /0\.299 \* d\[i\]/);          // ระดับเทาตามการรับรู้ของตา
  assert.match(fn, /g >= avg \? '1' : '0'/);      // เทียบกับค่าเฉลี่ยของภาพเอง
  assert.match(machine, /function hashDistance\(a, b\)/);
});

test('คว้าได้รูปผู้เขียน = ปฏิเสธก่อนบันทึก ไม่ใช่ปล่อยไปโผล่ในเล่ม', () => {
  const dl = machine.slice(machine.indexOf("if (!rawBlob?.size) throw new Error"), machine.indexOf('made++;'));
  assert.match(dl, /if \(this\.refHash\)/);
  assert.match(dl, /hashDistance\(got, this\.refHash\) < 6/);
  // ต้องปฏิเสธก่อนตรวจอย่างอื่น จะได้ไม่เสียเวลาปรับขนาดไฟล์ที่ยังไงก็ไม่รับ
  assert.ok(dl.indexOf('this.refHash') < dl.indexOf('validateGeneratedSource'));
});

test('จำหน้าตาของรูปผู้เขียนไว้ตั้งแต่ตอนแนบ', () => {
  assert.match(machine, /this\.refHash = await imageAHash\(await db\.dataUrlToBlob\(ref\.dataUrl\)\)/);
  // ตัวเทียบไบต์เดิมยังอยู่ ใช้จับไฟล์ที่ซ้ำกันเป๊ะ ๆ ซึ่งเร็วกว่า
  assert.match(machine, /this\.usedImageKeys\.add\(imageFingerprint\(ref\.dataUrl\)\)/);
});
