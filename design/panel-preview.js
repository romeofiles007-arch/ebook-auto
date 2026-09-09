// Visual fixture only: no extension APIs, storage, messages, or real book data.
globalThis.chrome = { runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({
  at: Date.now(), crew: { id: 'art', name: 'นักออกแบบภาพ', working: !new URLSearchParams(location.search).has('idle'), detail: 'ภาพ 3/7 · ภาพตอน 2.1 · fig-2.1-1.png' },
  events: [
    { id: '1', at: Date.now() - 20000, message: 'เริ่มสร้างภาพ 3/7 · ภาพตอน 2.1', level: 'info' },
    { id: '2', at: Date.now() - 12000, message: 'ChatGPT · ส่งคำสั่งแล้ว · รอภาพจากคำตอบของเทิร์นนี้', level: 'progress' },
    { id: '3', at: Date.now() - 4000, message: 'ดึง fig-2.1-1.png · ตรวจขนาด 1222×815 px · บันทึกสำเร็จ', level: 'info' },
  ],
}) } };
document.querySelector('.brand').textContent = 'Ebook Auto · ตัวอย่างหน้าจอ';
await import('/extension/ui/panel-activity.js');
