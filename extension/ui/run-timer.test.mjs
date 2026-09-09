import test from 'node:test';
import assert from 'node:assert/strict';
import { nextClock, clockElapsed, formatElapsed, timerView } from './run-timer.js';

const at = (ms) => ({ kind: 'working', at: ms });

test('ยังไม่สั่งงาน ก็ยังไม่มีนาฬิกา', () => {
  assert.equal(nextClock(null, { kind: 'ready', at: 1000 }), null);
  assert.equal(timerView(null, 5000).hidden, true);
});

test('เริ่มนับตั้งแต่สถานะแรกที่ไม่ใช่พร้อมเริ่ม', () => {
  const c = nextClock(null, at(1000));
  assert.deepEqual(c, { base: 0, since: 1000, running: true, done: false });
  assert.equal(clockElapsed(c, 61000), 60000);
  assert.equal(timerView(c, 61000).text, '01:00');
});

test('สถานะระหว่างทางไม่รีเซ็ตเวลา', () => {
  let c = nextClock(null, at(1000));
  for (const kind of ['working', 'waiting', 'input', 'working']) c = nextClock(c, { kind, at: 5000 });
  assert.equal(c.since, 1000);
  assert.equal(c.running, true);
});

test('งานหยุดแล้วเวลาหยุดนับ พอทำต่อจึงเดินต่อจากเลขเดิม', () => {
  let c = nextClock(null, at(0));
  c = nextClock(c, { kind: 'stopped', at: 30000 });
  assert.equal(c.running, false);
  assert.equal(clockElapsed(c, 999000), 30000); // รอไปนานแค่ไหนก็ไม่นับเพิ่ม
  assert.equal(timerView(c, 999000).state, 'paused');
  c = nextClock(c, { kind: 'working', at: 100000 });
  assert.equal(clockElapsed(c, 110000), 40000);
});

test('ส่งมอบแล้วเลขค้างไว้ ไม่เดินต่อ', () => {
  let c = nextClock(null, at(0));
  c = nextClock(c, { kind: 'done', at: 3723000 });
  const view = timerView(c, 9999999);
  assert.equal(view.state, 'done');
  assert.equal(view.text, '1:02:03');
});

test('เล่มใหม่หลังส่งมอบเริ่มนับใหม่จากศูนย์', () => {
  let c = nextClock(nextClock(null, at(0)), { kind: 'done', at: 60000 });
  c = nextClock(c, { kind: 'working', at: 70000 });
  assert.deepEqual(c, { base: 0, since: 70000, running: true, done: false });
});

test('รูปแบบเวลาอ่านออกทั้งสั้นและยาว', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(9500), '00:09');
  assert.equal(formatElapsed(3599000), '59:59');
  assert.equal(formatElapsed(3600000), '1:00:00');
  assert.equal(formatElapsed(-5), '00:00');
});
