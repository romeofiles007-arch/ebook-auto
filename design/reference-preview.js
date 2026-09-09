let calls=0;
globalThis.fetch=async()=>{document.getElementById('networkCount').textContent=String(++calls);throw new Error('ตัวอย่างนี้ไม่เรียกเครือข่าย');};
globalThis.chrome={storage:{local:{get:async()=>({preferredReferenceStyle:'apa'}),set:async()=>{}}}};
await import('/extension/ui/references-ui.js');
