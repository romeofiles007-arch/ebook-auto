/**
 * ชั้น transport — ส่วนอื่นของระบบรู้จักแค่ send() ตัวเดียว
 *
 * ประโยชน์สามข้อ
 *  1) ทดสอบลูปนับหน้าได้โดยไม่ต้องยิง ChatGPT เลย (ใช้ fake)
 *  2) ย้ายไปใช้ API หรือโมเดลโลคัลได้วันไหนก็ได้ โดยไม่ต้องรื้อระบบ
 *  3) จังหวะการยิงและการลองใหม่อยู่ที่เดียว ไม่กระจายทั่วโค้ด
 */

import { ChatGptTabTransport } from './chatgpt-tab.js';

export { hasPendingTurn } from './chatgpt-tab.js';
import { FakeTransport } from './fake.js';

export function makeTransport(kind, opts = {}) {
  switch (kind) {
    case 'fake':
      return new FakeTransport(opts);
    case 'chatgpt_tab':
    default:
      return new ChatGptTabTransport(opts);
  }
}

/** หน่วงแบบสุ่ม ไม่ใช่ค่าคงที่ */
export function jitter([lo, hi]) {
  return lo + Math.random() * Math.max(0, hi - lo);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
