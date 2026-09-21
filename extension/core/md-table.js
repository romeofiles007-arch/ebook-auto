/**
 * ตาราง Markdown — ตัวอ่านตัวเดียวที่ทุกปลายทางใช้ร่วมกัน (Typst, หน้าอ่าน, EPUB)
 *
 * เดิมตัวอ่านอยู่ในไฟล์ของ Typst ฝ่ายเดียว หน้าอ่านกับ EPUB จึงพิมพ์แถว | ... | ออกมาดิบ ๆ
 * แยกออกมาไว้ตรงนี้เพื่อให้ตารางเดียวกันถูกอ่านเหมือนกันทุกที่ ไม่ใช่ถูกเข้าใจคนละแบบสามที่
 *
 * ยอมรับทั้งขีดสั้นและขีดยาว เพราะโมเดลบางครั้งแทน --- ด้วย — ตอนเขียนภาษาไทย
 */

export function splitTableRow(line) {
  const s = String(line).trim().replace(/^\|/, '').replace(/\|$/, '');
  return s.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function isTableDivider(line) {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?[\-–—]{1,}:?$/.test(cell.replace(/\s/g, '')));
}

/** การจัดชิดของแต่ละคอลัมน์ อ่านจากตำแหน่งของ : ในแถวคั่น */
export function alignOf(dividerLine) {
  return splitTableRow(dividerLine).map((cell) => {
    const s = cell.replace(/\s/g, '');
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    return left && right ? 'center' : right ? 'right' : 'left';
  });
}

/**
 * อ่านตารางที่เริ่มต้นตรงบรรทัด i — คืน { rows, align, next } หรือ null ถ้าตรงนั้นไม่ใช่ตาราง
 *
 * บรรทัดว่างระหว่างแถวต้องข้ามไป ไม่ใช่ถือว่าตารางจบ
 * เพราะโมเดลชอบเว้นบรรทัดหลังแถวหัวและระหว่างแถวข้อมูลเวลาเขียนภาษาไทย
 * ของเดิมบังคับว่าแถวคั่นต้องอยู่บรรทัดถัดไปพอดี ตารางที่มีบรรทัดว่างคั่นจึงหลุดเป็นข้อความดิบ
 * ผู้ใช้เห็น |---|---:|---:| อยู่กลางหน้าหนังสือ ทั้งในไฟล์ PDF และบนหน้าอ่าน
 * บรรทัดว่างตรงนี้เป็นแค่การจัดหน้าใน markdown ไม่ใช่โครงสร้าง — เหมือนกรณีรายการที่แก้ไปก่อนหน้า
 */
export function readTable(lines, i) {
  if (!String(lines[i] ?? '').includes('|')) return null;

  let d = i + 1;
  while (d < lines.length && !String(lines[d]).trim()) d++;
  if (d >= lines.length || !isTableDivider(lines[d])) return null;

  const rows = [splitTableRow(lines[i])];
  const align = alignOf(lines[d]);
  let next = d + 1;
  for (let k = d + 1; k < lines.length; k++) {
    const line = String(lines[k]);
    if (!line.trim()) continue;
    if (!line.includes('|')) break;
    rows.push(splitTableRow(line));
    next = k + 1;
  }
  return { rows, align, next };
}
