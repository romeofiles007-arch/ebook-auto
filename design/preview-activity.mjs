import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { crewMarkup } from '../extension/ui/crew-sprites.js';
const panel = await readFile(new URL('../extension/ui/panel.html', import.meta.url), 'utf8');
await writeFile(new URL('./panel-preview.html', import.meta.url), panel.replace('<head>', '<head><base href="/extension/ui/"><style>body{max-width:355px;margin:auto!important}</style>').replace('src="panel.js"', 'src="/design/panel-preview.js?v=2"'));
const studio = await readFile(new URL('../extension/ui/studio.js', import.meta.url), 'utf8');
const start = studio.indexOf('const DEPARTMENTS =');
const end = studio.indexOf('const MACRO_STAGES =', start);
const dom = { steps: { innerHTML: '' }, detail: { textContent: 'กำลังเขียนตอน 2.1' } };
vm.runInNewContext(`${studio.slice(start, end)}; activeDept = 2; completedDepts.add(0); completedDepts.add(1); deptNotes.set(2, {text:'กำลังเขียนตอน 2.1 · รอคำตอบจาก ChatGPT',level:'ok'}); renderSteps();`, {
  $: (id) => dom[id], crewWorking: true, publishActivity() {}, crewMarkup,
  esc: (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;'),
});
await writeFile(new URL('./crew-preview.html', import.meta.url), `<!doctype html><html lang="th"><meta charset="utf-8"><link rel="stylesheet" href="/extension/ui/studio.css"><link rel="stylesheet" href="/extension/ui/crew.css"><base href="/extension/ui/"><main class="app"><h1>ตัวอย่างทีมงาน · ข้อมูลจำลอง</h1><div id="steps">${dom.steps.innerHTML}</div></main></html>`);

