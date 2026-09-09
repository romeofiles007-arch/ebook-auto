export const STATE_LABELS = {
  ready: 'พร้อมเริ่ม', working: 'กำลังทำงาน', waiting: 'รอระบบ',
  input: 'รอคุณเลือกใน Studio', stopped: 'หยุด / มีปัญหา', done: 'เสร็จสมบูรณ์',
};

// Only explicit transitions change the lamp. Silence changes the age, never the outcome.
let statusSerial = 0;
export function mountRunStatus(parent, act) {
  const box = document.createElement('section');
  box.className = 'run-status';
  box.setAttribute('aria-label', 'สถานะการทำงาน');
  const heading = document.createElement('strong');
  heading.setAttribute('role', 'status');
  const reason = document.createElement('div');
  reason.className = 'run-status-reason';
  reason.tabIndex = 0;
  reason.id = `run-status-detail-${++statusSerial}`;
  const header = document.createElement('div');
  header.className = 'run-status-header';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'run-status-toggle';
  toggle.setAttribute('aria-controls', reason.id);
  let expanded = false;
  const expand = (on) => {
    expanded = on;
    box.classList.toggle('details-expanded', on);
    toggle.setAttribute('aria-expanded', String(on));
    toggle.textContent = on ? 'ย่อรายละเอียด' : 'ขยายรายละเอียด';
  };
  toggle.onclick = () => expand(!expanded);
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && expanded) {
      expand(false);
      toggle.focus();
      event.stopPropagation();
    }
  });
  expand(false);
  header.append(heading, toggle);
  const age = document.createElement('small');
  const button = document.createElement('button');
  button.type = 'button';
  box.append(header, reason, age, button);
  parent.prepend(box);
  let state;
  const tick = () => {
    if (!state) return;
    age.textContent = state.at ? `ขั้น: ${state.step || 'เตรียมเล่ม'} · อัปเดต ${new Date(state.at).toLocaleTimeString('th-TH')} · ${Math.max(0, Math.floor((Date.now()-state.at)/1000))} วินาทีที่แล้ว` : 'ยังไม่มีข้อมูลจากงาน';
  };
  button.onclick = async () => {
    button.disabled = true;
    try { await act(state); } catch(e) { reason.textContent = e.message; }
    finally { button.disabled = false; }
  };
  const paint = (next) => {
    if (!next || !STATE_LABELS[next.kind] || (state && next.at < state.at)) return;
    state = next;
    box.dataset.state = next.kind;
    heading.textContent = `● ${STATE_LABELS[next.kind]}`;
    reason.textContent = next.reason || '';
    button.hidden = !next.action;
    button.textContent = next.actionLabel || 'ดูใน Studio';
    tick();
  };
  paint({kind:'ready', at:0, reason:'เลือกเริ่มงานใน Studio'});
  setInterval(tick, 1000);
  return paint;
}
