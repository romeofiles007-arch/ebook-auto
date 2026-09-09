import { readFile, writeFile } from 'node:fs/promises';
const html=await readFile('extension/ui/studio.html','utf8');
const formats=''; // The format preview now lives inside referenceOptions.
const options=html.slice(html.indexOf('  <details class="more" data-step="book" id="referenceOptions"'),html.indexOf('  <details class="more" id="fictionOpts"'));
await writeFile('design/reference-preview.html',`<!doctype html><html lang="th"><meta charset="utf-8"><base href="/extension/ui/"><link rel="stylesheet" href="studio.css"><main class="app"><h1>ตัวอย่างการเลือกรูปแบบอ้างอิง</h1><label><input id="bm_references" type="checkbox" checked> บรรณานุกรม</label>${formats}<p>จำนวนคำขอเครือข่าย: <output id="networkCount">0</output></p>${options}<input id="title" value="communication" hidden><input id="bm_about" type="checkbox" hidden><textarea id="aboutAuthor" hidden></textarea></main><script type="module" src="/design/reference-preview.js"></script></html>`);
