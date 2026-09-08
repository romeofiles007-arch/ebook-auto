import { searchReferences, formatReference, referenceLines, referenceProblem, REFERENCE_STYLES, REFERENCE_EXAMPLES } from '../core/references.js';
import { BOOK_EXAMPLES } from './reference-book-examples.js';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let candidates = [];
let selected = [];
let busy = false;
let styleTouched = false;
function message(text) { $('referencesState').textContent = text; }
export function renderReferenceExample() {
  const style = $('referenceStyle').value;
  const [hint] = REFERENCE_EXAMPLES[style] || REFERENCE_EXAMPLES.apa;
  const [pattern, thai, english, inline] = BOOK_EXAMPLES[style] || BOOK_EXAMPLES.apa;
  $('referenceStyleHint').textContent = hint;
  $('referenceInlineExample').textContent = inline;
  const markup = (text) => esc(text).replace(/\*([^*]+)\*/g, '<em>$1</em>');
  $('referenceBibliographyExample').innerHTML = `<p><b>รูปแบบ:</b> ${markup(pattern)}</p><p><b>ตัวอย่างภาษาไทย:</b> ${markup(thai)}</p><p><b>ตัวอย่างภาษาอังกฤษ:</b> ${markup(english)}</p>`;
}
function renderSelected() {
  const settings = readReferenceSettings();
  const lines = referenceLines(settings);
  $('references').value = selected.length && lines.length === selected.length ? lines.join('\n\n') : selected.map((s, i) => `${i + 1}. ${s.title} (${s.year}) · ${s.doi}`).join('\n');
}
function show() {
  $('referenceResults').innerHTML = candidates.map((s, i) => `<div class="reference-result">
    <label><input type="checkbox" data-reference-index="${i}" ${selected.some((x) => x.doi === s.doi) ? 'checked' : ''}> อ่านต้นทางแล้วและเกี่ยวข้องกับเล่มนี้</label>
    <b>${esc(s.title)}</b><div>${esc(s.authors.join(', '))} · ${s.year}</div>
    <div>${esc(s.container || s.publisher)} · ${esc(s.publisher)}</div>
    <a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">เปิดต้นทาง · ${esc(s.doi)}</a>
    ${s.abstract ? `<details><summary>บทคัดย่อจากทะเบียน</summary><p>${esc(s.abstract)}</p></details>` : '<div class="muted">ทะเบียนไม่มีบทคัดย่อ ต้องอ่านต้นทางก่อนเลือก</div>'}
  </div>`).join('');
}
$('referenceResults').addEventListener('change', (event) => {
  const i = event.target.dataset.referenceIndex;
  if (i == null) return;
  const source = candidates[Number(i)];
  selected = selected.filter((s) => s.doi !== source.doi);
  if (event.target.checked) selected.push({ ...source, reviewed: true });
  renderSelected();
  message(`เลือก ${selected.length} รายการแล้ว · ระบบจัดรูปแบบให้เมื่อเริ่มสร้าง ไม่ต้องกดยืนยันซ้ำ`);
});
function lock(value) {
  busy = value;
  for (const id of ['referenceSearch','referenceStyle','referenceQuery']) $(id).disabled = value;
  $('referenceResults').querySelectorAll('input').forEach((el) => el.disabled = value);
}
export function readReferenceSettings() {
  return { referenceStyle: $('referenceStyle').value, referenceSources: structuredClone(selected) };
}
export function resetReferenceSources() {
  candidates = []; selected = []; show(); renderSelected();
  $('referenceQuery').value = '';
  message('เล่มใหม่ · รูปแบบเดิมถูกจำไว้ ค้นและเลือกแหล่งที่เกี่ยวข้องกับเล่มนี้');
}
export async function findReferences() {
  if (busy) return;
  lock(true); message('กำลังค้นฐานข้อมูล Crossref…');
  try {
    const query = $('referenceQuery').value.trim() || $('title').value.trim();
    $('referenceQuery').value = query;
    const results = await searchReferences(query);
    candidates = [...selected, ...results.filter((s) => !selected.some((x) => x.doi === s.doi))];
    show();
    message(results.length ? `พบ ${results.length} รายการ · เปิดต้นทางและติ๊กเฉพาะที่เกี่ยวข้อง แล้วเริ่มสร้างเล่มได้เลย` : 'ไม่พบงานที่มีข้อมูลครบ ลองคำค้นภาษาอังกฤษหรือ DOI');
  } catch (e) { message(`ค้นไม่สำเร็จ: ${e.message} · รายการเดิมยังอยู่`); }
  finally { lock(false); }
}
$('referenceSearch').onclick = findReferences;
$('referenceStyle').addEventListener('change', () => {
  styleTouched = true;
  renderReferenceExample(); renderSelected();
  chrome.storage.local.set({ preferredReferenceStyle: $('referenceStyle').value }).catch(() => {});
});
/**
 * บอกเงื่อนไขตั้งแต่ตอนติ๊ก ไม่ใช่ตอนกดเริ่มสร้าง
 *
 * ช่อง "บรรณานุกรม" หน้าตาเหมือนช่องอื่นในแถวเดียวกัน (สารบัญ · คำนำ · อภิธานศัพท์)
 * ซึ่งติ๊กแล้วระบบสร้างให้เองทั้งหมด คนจึงคาดว่าอันนี้ก็เหมือนกัน
 * แต่รายการอ้างอิงเป็นสิ่งเดียวในกลุ่มนี้ที่ระบบสร้างเองไม่ได้ ต้องมีแหล่งจริงที่คนเลือก
 * ถ้าไม่บอกตรงนี้ ผู้ใช้จะไปรู้ตอนกดเริ่มสร้างแล้วโดนดีดกลับมาหน้านี้โดยไม่รู้ว่าทำไม
 */
$('bm_references').addEventListener('change', () => {
  renderReferenceExample();
  if ($('bm_references').checked && !selected.length) {
    $('referenceOptions').open = true; // ข้อความข้างล่างอยู่ในกล่องนี้ ถ้าไม่กางก็เท่ากับไม่ได้บอก
    message('ติ๊กบรรณานุกรมไว้แล้ว — ขั้นต่อไปคือค้นแล้วติ๊กเลือกแหล่งอย่างน้อย 1 รายการ ระบบไม่แต่งรายการอ้างอิงขึ้นเอง ถ้าไม่เลือก หน้านี้จะไม่ถูกใส่ในเล่ม');
  }
});
renderReferenceExample();
chrome.storage.local.get('preferredReferenceStyle').then((saved) => {
  if (!styleTouched && REFERENCE_STYLES[saved.preferredReferenceStyle]) {
    $('referenceStyle').value = saved.preferredReferenceStyle; renderReferenceExample();
  }
}).catch(() => {});
export async function validateBackMatterSetup() {
  if ($('bm_about').checked && $('aboutAuthor').value.trim().length < 40)
    return 'เลือกเกี่ยวกับผู้เขียนไว้ กรุณากรอกข้อมูลจริงอย่างน้อย 40 ตัวอักษรก่อนเริ่ม';
  if (!$('bm_references').checked) return '';
  if (busy) return 'กำลังค้นหรือจัดรูปแบบบรรณานุกรม กรุณารอให้เสร็จ';
  if (!selected.length) {
    $('referenceOptions').open = true; await findReferences();
    return 'กรุณาอ่านต้นทางแล้วติ๊กเลือกแหล่งอ้างอิง จากนั้นเริ่มสร้างได้เลย รูปแบบที่เลือกยังอยู่';
  }
  lock(true);
  try {
    const style = $('referenceStyle').value;
    for (const s of selected) {
      if (!s.citations?.[style]) {
        message(`กำลังจัดรูปแบบ ${REFERENCE_STYLES[style]} · ${s.title}`);
        s.citations = { ...s.citations, [style]: await formatReference(s, style) };
      }
    }
    renderSelected(); message(`พร้อมใช้ ${selected.length} รายการ · ${REFERENCE_STYLES[style]}`);
    return referenceProblem({ backMatter: ['references'], ...readReferenceSettings() });
  } catch (e) { return `จัดรูปแบบอ้างอิงไม่สำเร็จ: ${e.message} · เก็บรายการและรูปแบบไว้แล้ว ลองเริ่มอีกครั้งได้`; }
  finally { lock(false); }
}
