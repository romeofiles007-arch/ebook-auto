import './panel-activity.js';
const $ = (id) => document.getElementById(id);
async function openPage(buttonId, type, label) {
  const button = $(buttonId);
  button.disabled = true;
  $('live').textContent = `กำลังเปิด ${label}...`;
  try {
    const result = await chrome.runtime.sendMessage({ type });
    if (!result?.ok) throw new Error(result?.error || `เปิด ${label} ไม่สำเร็จ`);
    $('live').textContent = `เปิด ${label} แล้ว`;
  } catch (error) {
    $('live').textContent = `เปิด ${label} ไม่สำเร็จ: ${error.message}`;
  } finally { button.disabled = false; }
}
$('studio').onclick = () => openPage('studio', 'sw.openStudio', 'Studio');
$('chat').onclick = () => openPage('chat', 'sw.focusChat', 'ChatGPT');

/**
 * สั่งหยุด/ทำต่อจากแผงข้างได้โดยไม่ต้องสลับไปหน้า Studio
 *
 * งานเดินเป็นสิบนาทีและคนเฝ้าอยู่ที่แผงนี้ ไม่ใช่ที่ Studio การจะหยุดสักครั้ง
 * ไม่ควรต้องหาแท็บให้เจอก่อน — ยิ่งตอนที่อยากหยุด มักเป็นตอนที่เห็นอะไรผิดใน log พอดี
 *
 * คำสั่งวิ่งผ่าน service worker ไปหาหน้า Studio ถ้าไม่มีหน้าไหนรับ ต้องบอกตรง ๆ
 * ไม่ใช่ขึ้นว่าส่งแล้วทั้งที่ไม่มีใครฟัง
 */
async function command(buttonId, name, label) {
  const button = $(buttonId);
  button.disabled = true;
  $('live').textContent = `กำลังสั่ง${label}...`;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'ui.command', command: name });
    if (!result?.ok) throw new Error(result?.error || 'ไม่มีหน้า Studio รับคำสั่ง');
    $('live').textContent = `สั่ง${label}แล้ว — ดูผลในบันทึกด้านล่าง`;
  } catch (error) {
    $('live').textContent = `สั่ง${label}ไม่สำเร็จ: ${error.message} · เปิด Studio ค้างไว้แล้วลองใหม่`;
  } finally {
    button.disabled = false;
  }
}
$('jobStop').onclick = () => command('jobStop', 'stopJob', 'หยุดงาน');
$('jobResume').onclick = () => command('jobResume', 'resumeJob', 'ทำต่อ');
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'ui.status') $('live').textContent = m.message || 'กำลังทำงาน...';
});
