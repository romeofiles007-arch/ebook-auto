/**
 * "อ้าวทำไมหยุด" — งานหยุดกลางทางพร้อมข้อความ "The user aborted a request."
 * ทั้งที่ผู้ใช้ไม่ได้แตะอะไรเลย
 *
 * ต้นเหตุสองชั้นซ้อนกัน:
 *   1. ตัวค้นแหล่งตั้งเพดานเวลาไว้ 25 วินาที พอครบก็สั่ง abort เอง
 *      แล้วเบราว์เซอร์โยน AbortError ที่เขียนว่า "The user aborted a request."
 *      ข้อความของเบราว์เซอร์ไหลขึ้นไปโผล่บนหน้าจอตรง ๆ จนอ่านเหมือนผู้ใช้เป็นคนกดยกเลิก
 *   2. ข้อผิดพลาดของการค้นรอบเดียว ไม่เคยถูกจับ จึงหยุดการสร้างหนังสือทั้งเล่ม
 *      ทั้งที่บรรณานุกรมเป็นของเสริม และแหล่งที่คัดได้ก่อนหน้ายังอยู่ครบ
 *
 * หลักฐานเวลาจากบันทึกจริง: ได้คำตอบ 19:51:28 → หยุด 19:51:54 = 26 วินาที
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchReferences } from './references.js';
import { collectReferences } from './auto-references.js';

test('หมดเวลารอ Crossref ต้องรายงานว่าเป็นที่บริการค้น ไม่ใช่ว่าผู้ใช้กดยกเลิก', async () => {
  const abort = () => {
    const e = new Error('The user aborted a request.');
    e.name = 'AbortError';
    return Promise.reject(e);
  };
  await assert.rejects(() => searchReferences('beer packaging', abort), (e) => {
    assert.match(e.message, /Crossref ไม่ตอบภายใน 25 วินาที/);
    assert.ok(!/aborted/i.test(e.message), 'ห้ามให้ข้อความของเบราว์เซอร์หลุดถึงผู้ใช้');
    return true;
  });
});

test('ค้นล้มรอบเดียว ต้องข้ามไปคำค้นถัดไป ไม่ใช่ล้มทั้งงาน', async () => {
  const good = [{ doi: '10.1/a', abstract: 'x'.repeat(150) }, { doi: '10.1/b', abstract: 'y'.repeat(150) }];
  let calls = 0;
  const search = async (q) => {
    calls++;
    if (q === 'คำค้นที่ล้ม') throw new Error('Crossref ไม่ตอบภายใน 25 วินาที');
    return good;
  };
  const choose = async (found) => ({ dois: found.map((s) => s.doi), queries: calls === 1 ? ['คำค้นที่ล้ม', 'คำค้นที่รอด'] : [] });

  const notes = [];
  const r = await collectReferences({
    query: 'คำค้นแรก', minimum: 4, search, choose, onProgress: (_, note) => notes.push(note),
  });
  assert.ok(calls >= 3, `ต้องค้นต่อหลังรอบที่ล้ม (ค้นไป ${calls} รอบ)`);
  assert.equal(r.sources.length, 2, 'แหล่งที่คัดได้ก่อนหน้าต้องไม่หาย');
  assert.ok(notes.some((n) => /ค้นรอบ \d+ ไม่สำเร็จ/.test(n)), 'ต้องบอกบนหน้าจอว่ารอบไหนล้มเพราะอะไร');
});

test('ขั้นคัดแหล่งมีด่านสุดท้ายกันไม่ให้พาเล่มล้มตาม', async () => {
  const ui = await readFile(new URL('../ui/references-ui.js', import.meta.url), 'utf8');
  const fn = ui.slice(ui.indexOf('export async function selectReferencesAutomatically'));
  assert.match(fn, /\} catch \(e\) \{/);
  assert.match(fn, /return \{ found: selected\.length, searches: 0, error:/);

  // และผู้เรียกต้องรายงานว่าล้มเพราะอะไร ไม่ใช่เดินต่อเงียบ ๆ
  const studio = await readFile(new URL('../ui/studio.js', import.meta.url), 'utf8');
  assert.match(studio, /const refRun = await selectReferencesAutomatically/);
  assert.match(studio, /ขั้นคัดแหล่งไม่สำเร็จ แต่ไม่หยุดเล่ม/);
});
