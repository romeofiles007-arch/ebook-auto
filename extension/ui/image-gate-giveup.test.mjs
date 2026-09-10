/**
 * ประตูภาพหยุดโหมดอัตโนมัติ "ทุกครั้ง" หลังเคยพลาดสองรอบ — และไม่มีวันหายเอง
 *
 * ตัวนับ autoRounds ถูกบันทึกลงเล่ม แต่มีทางลดลงทางเดียวคือรอบที่ไม่มีอะไรค้างเลย
 * ซึ่งเอื้อมไม่ถึงเมื่อยังมีภาพขาด เล่มที่เคยพลาดจึงเสียโหมดอัตโนมัติไปถาวร
 * อาการที่เห็น: กดอัตโนมัติแล้วมาจอดที่หน้า "เริ่มสร้างภาพ N รูป" ทุกครั้ง
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('./studio.js', import.meta.url), 'utf8');
const gate = src.slice(src.indexOf('async function openImagePhaseGate'), src.indexOf('async function startPhase2'));

test('รอบที่สร้างภาพได้เพิ่ม ต้องล้างตัวนับ ไม่ใช่นับเป็นรอบที่เสียเปล่า', () => {
  assert.match(gate, /const left = plannedImageJobs\(book\)/);
  assert.match(gate, /const leftBefore = Number\(book\.imagePhase\?\.autoRoundsLeft \?\? Infinity\)/);
  assert.match(gate, /const rounds = left < leftBefore \? 0 : Number\(book\.imagePhase\?\.autoRounds\) \|\| 0/);
  // ต้องจดจำนวนที่ขาดของรอบนี้ไว้ ไม่งั้นรอบหน้าเทียบกับอะไรไม่ได้
  assert.match(gate, /autoRoundsLeft: left/);
});

test('เพดานยังอยู่ — รอบที่ได้ผลเดิมซ้ำ ๆ ยังต้องหยุดให้คนมาดู', () => {
  assert.match(gate, /if \(stuck && rounds >= AUTO_PHASE2_ROUNDS\)/);
  assert.match(gate, /stopAutoPilot\(\);/);
});

test('คนกดปุ่มเอง = ล้างตัวนับ ทั้งปุ่มอัตโนมัติและปุ่มทำต่อ', () => {
  assert.match(src, /async function clearImageGiveUp\(\)/);
  const helper = src.slice(src.indexOf('async function clearImageGiveUp()'), src.indexOf('async function resumeGo()'));
  assert.match(helper, /autoRounds: 0, autoRoundsLeft: null/);

  const full = src.slice(src.indexOf('async function runFullAuto()'), src.indexOf('\n}', src.indexOf('async function runFullAuto()')));
  assert.match(full, /await clearImageGiveUp\(\);/);
  const resume = src.slice(src.indexOf('async function resumeGo()'), src.indexOf('\n}', src.indexOf('async function resumeGo()')));
  assert.match(resume, /await clearImageGiveUp\(\);/);
});

test('ไม่มีอะไรให้ล้าง ต้องไม่ไปเขียนฐานข้อมูลเปล่า ๆ', () => {
  const helper = src.slice(src.indexOf('async function clearImageGiveUp()'), src.indexOf('async function resumeGo()'));
  assert.match(helper, /if \(!book\?\.id \|\| !book\.imagePhase\) return;/);
  assert.match(helper, /autoRoundsLeft == null\) return;/);
});
