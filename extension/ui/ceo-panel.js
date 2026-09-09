const ACTIVE_RUNS = new Set(['working', 'waiting']);

export function ceoView(state, now = Date.now(), run = null) {
  // เมื่อถูกเรียกจริง ให้ภาพทำงานต่อครบช่วงนำเสนอ แม้ API จะตอบเสร็จเร็วกว่านั้น
  if ((state?.called || state?.working) && state.until > now) return {
    mode: 'working', working: true, title: state.working ? 'CEO · กำลังตัดสินใจ' : 'CEO · ส่งคำตัดสินแล้ว',
    detail: state.detail || 'กำลังตรวจสถานะและกำกับขั้นตอนถัดไป',
  };
  // ระหว่างทีมผลิตกำลังเดินงาน CEO ไม่ต้องแสร้งว่ากำลังทำงาน ถ้าไม่มีเหตุให้ถูกเรียกก็นอนที่โต๊ะ
  if (ACTIVE_RUNS.has(run?.kind)) return {
    mode: 'sleeping', working: false, title: 'CEO · พักระหว่างทีมทำงาน',
    detail: 'ทีมกำลังสร้างหนังสือตามปกติ · จะตื่นเมื่อระบบกู้เองไม่ได้และเรียก CEO',
  };
  // ยังไม่มีงาน งานเสร็จ หรือส่งออกแล้ว: ตื่นอยู่เพื่อให้เห็นว่า CEO mode พร้อมรับงานครั้งใหม่
  return {
    mode: 'awake', working: false, title: 'CEO · ตื่นและพร้อมรับงาน',
    detail: run?.kind === 'done' ? 'หนังสือเสร็จและส่งออกแล้ว · พร้อมรับงานเล่มถัดไป' : 'ยังไม่มีงานที่ต้องกำกับ · พร้อมรับการเรียกครั้งถัดไป',
  };
}

export function mountCeoPanel(el) {
  if (!el) return () => {};
  let state = null;
  let run = null;
  const paint = () => {
    const view = ceoView(state, Date.now(), run);
    el.classList.toggle('working', view.working);
    el.classList.toggle('awake', view.mode === 'awake');
    el.classList.toggle('sleeping', view.mode === 'sleeping');
    el.querySelector('strong').textContent = view.title;
    el.querySelector('.ceo-detail').textContent = view.detail;
  };
  paint();
  setInterval(paint, 1000);
  return (next, nextRun) => {
    if (next && (!state || next.at >= state.at)) state = next;
    if (nextRun && (!run || nextRun.at >= run.at)) run = nextRun;
    paint();
  };
}
