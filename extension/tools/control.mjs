/**
 * ท่อคุม Studio จากบรรทัดคำสั่ง
 *
 * ฝั่งเบราว์เซอร์กดปุ่มเองไม่ได้จากข้างนอก และหน้า chrome://extensions ก็ไม่มีใครแตะได้เลย
 * ตัวนี้จึงเป็นจุดนัดพบ: Studio คอยถามเข้ามาว่ามีคำสั่งอะไร ส่วนคนสั่งก็หย่อนคำสั่งไว้ที่นี่
 *
 * ฟังเฉพาะ 127.0.0.1 — เครื่องอื่นในวงแลนต่อไม่ถึง แต่ต้องรู้ไว้ว่าอะไรก็ตามที่รันอยู่บน
 * เครื่องนี้ยิงเข้ามาได้ ท่อนี้จึงควรเปิดตอนใช้งานและปิดเมื่อเสร็จ ไม่ใช่เปิดค้างไว้ตลอด
 *
 *   node extension/tools/control.mjs serve            เปิดท่อ (ค้างไว้ในหน้าต่างนี้)
 *   node extension/tools/control.mjs state            ดูว่า Studio กำลังทำอะไรอยู่
 *   node extension/tools/control.mjs continue         กด "ทำต่อ"
 *   node extension/tools/control.mjs images           กดทำต่อขั้นสร้างภาพ
 *   node extension/tools/control.mjs focus            เปิดแท็บ ChatGPT ให้พร้อม
 *   node extension/tools/control.mjs reload           รีโหลดส่วนขยาย แล้วเปิด Studio คืนให้
 *
 * ตั้งพอร์ตอื่นได้ด้วย EBOOK_CONTROL_PORT (ต้องตั้งให้ตรงกับฝั่ง Studio ด้วย)
 */

import http from 'node:http';

const PORT = Number(process.env.EBOOK_CONTROL_PORT || 8787);
const HOST = '127.0.0.1';
const COMMANDS = ['continue', 'images', 'focus', 'reload'];

function serve() {
  /** คิวคำสั่ง — ตั้งใจให้ตื้น เพราะคำสั่งพวกนี้กินเวลาเป็นนาที การกองไว้เป็นสิบไม่มีความหมาย */
  const queue = [];
  let state = null;
  let stateAt = 0;
  let lastResult = null;

  const send = (res, code, body) => {
    const text = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      // หน้า Studio เป็น chrome-extension:// ซึ่งเป็นคนละต้นทาง ต้องเปิดให้ชัด ๆ
      // ปลอดภัยเท่าที่ควรเพราะฟังแค่ 127.0.0.1 อยู่แล้ว
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
    });
    res.end(text);
  };

  const body = (req) =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
        if (raw.length > 1e6) req.destroy();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'));
        } catch {
          resolve({});
        }
      });
    });

  http
    .createServer(async (req, res) => {
      const url = new URL(req.url, `http://${HOST}`);
      if (req.method === 'OPTIONS') return send(res, 204, {});

      // Studio ถามเข้ามา: ส่งสถานะล่าสุดกับผลของคำสั่งก่อนหน้ามาให้ แล้วรับคำสั่งถัดไปกลับไป
      if (url.pathname === '/poll' && req.method === 'POST') {
        const b = await body(req);
        state = b.state || state;
        stateAt = Date.now();
        if (b.result) {
          lastResult = { ...b.result, at: Date.now() };
          const mark = b.result.ok ? 'ok ' : 'พลาด';
          console.log(`[${new Date().toLocaleTimeString()}] ${mark} ${b.result.cmd} · ${b.result.detail || ''}`);
        }
        return send(res, 200, queue.shift() || {});
      }

      // คนสั่งหย่อนคำสั่งไว้
      if (url.pathname === '/cmd' && req.method === 'POST') {
        const b = await body(req);
        if (!COMMANDS.includes(b.cmd)) return send(res, 400, { error: `คำสั่งที่รับได้: ${COMMANDS.join(', ')}` });
        const job = { id: `c${Date.now().toString(36)}`, cmd: b.cmd, args: b.args || {} };
        queue.push(job);
        console.log(`[${new Date().toLocaleTimeString()}] เข้าคิว ${job.cmd}`);
        return send(res, 200, { queued: job, waiting: queue.length });
      }

      if (url.pathname === '/state') {
        // Studio ถามทุกสามวินาทีตอนท่อเปิดอยู่ ถ้าเงียบเกินนั้นมาก แปลว่าหน้ามันไม่ได้เปิดอยู่
        const quietMs = stateAt ? Date.now() - stateAt : null;
        return send(res, 200, { state, quietMs, connected: quietMs != null && quietMs < 20000, waiting: queue.length, lastResult });
      }

      send(res, 404, { error: 'ไม่มีเส้นทางนี้' });
    })
    .listen(PORT, HOST, () => {
      console.log(`ท่อคุมเปิดที่ http://${HOST}:${PORT} — เปิดหน้า Studio ค้างไว้ แล้วสั่งจากอีกหน้าต่างได้เลย`);
      console.log(`(ปิดท่อด้วย Ctrl+C · หน้า Studio จะกลับไปถามนาน ๆ ครั้งเอง ไม่ต้องแก้อะไร)`);
    });
}

async function ask(path, init) {
  try {
    const res = await fetch(`http://${HOST}:${PORT}${path}`, init);
    return await res.json();
  } catch (e) {
    console.error(`ต่อท่อไม่ได้ที่ ${HOST}:${PORT} — เปิดท่อก่อนด้วย "node extension/tools/control.mjs serve"`);
    process.exit(1);
  }
}

const arg = process.argv[2];
if (arg === 'serve') {
  serve();
} else if (arg === 'state') {
  const r = await ask('/state');
  console.log(JSON.stringify(r, null, 2));
} else if (COMMANDS.includes(arg)) {
  const r = await ask('/cmd', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: arg }) });
  console.log(JSON.stringify(r, null, 2));
} else {
  console.log(`ใช้: node extension/tools/control.mjs <serve|state|${COMMANDS.join('|')}>`);
  process.exit(arg ? 1 : 0);
}
