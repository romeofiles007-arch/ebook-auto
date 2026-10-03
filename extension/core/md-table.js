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
  if (d >= lines.length || !isTableDivider(lines[d])) return readLooseTable(lines, i);

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

/**
 * ตารางที่โมเดลเขียนโดยไม่มีแถวคั่น |---| เลย
 *
 * เห็นในเล่มจริง (ตารางบันทึกอาการ หน้า 3): โมเดลเขียนหัวตารางกับแถวข้อมูลเป็นบรรทัดธรรมดา
 * คั่นช่องด้วย | เฉย ๆ ไม่มีขีดเปิดปิดและไม่มีแถวคั่น ตัวอ่านจึงไม่นับเป็นตาราง
 * แล้ว Typst ก็รวบทุกบรรทัดเป็นย่อหน้าเดียว ผู้อ่านเห็น "08:00 | 38.7°C | ปวดหัว | …"
 * ไหลต่อกันเป็นพืดกลางหน้า อ่านไม่ออกว่าช่องไหนเป็นของแถวไหน
 *
 * เกณฑ์ต้องเข้มกว่าตารางปกติ เพราะไม่มีแถวคั่นมายืนยัน:
 *   - อย่างน้อยสามช่อง — ประโยคที่มี | ตัวเดียว ("ก | ข") เป็นข้อความธรรมดาได้
 *   - อย่างน้อยสามแถว และทุกแถวต้องมีจำนวนช่องเท่ากันเป๊ะ
 * ข้อความธรรมดาที่บังเอิญเข้าเกณฑ์นี้ครบทุกข้อ ก็คือสิ่งที่ควรเป็นตารางอยู่แล้ว
 */
function readLooseTable(lines, i) {
  const cellsOf = (line) => splitTableRow(line);
  const width = cellsOf(lines[i]).length;
  if (width < 3) return null;

  const rows = [cellsOf(lines[i])];
  /**
   * ข้อความที่โมเดลเขียนปนมากับตาราง ต้องยังอยู่ในเล่ม — แค่ย้ายออกไปไว้เหนือตาราง
   *
   * เคสจริง: "ให้ทำตาราง 6 ช่องไว้หนึ่งหน้า: วันและเวลา | อุณหภูมิ | …" แล้วตามด้วยบรรทัด
   * "ตัวอย่างสมมติ:" ก่อนถึงแถวข้อมูล ชื่อคอลัมน์จึงอยู่ในประโยค ส่วนตารางที่วาดออกมา
   * ไม่มีหัวเลย และแถวข้อมูลแถวแรกถูกทำตัวหนาเป็นหัวตารางแทน
   * ทั้งคำนำหน้าประโยคและบรรทัดป้ายกำกับเป็นเนื้อหาของผู้เขียน ห้ามทิ้ง
   */
  const lead = [];
  const intro = rows[0][0].match(/^(.{6,}?[:：])\s+(\S.*)$/);
  if (intro) {
    lead.push(intro[1]);
    rows[0][0] = intro[2];
  }
  let next = i + 1;
  for (let k = i + 1; k < lines.length; k++) {
    const line = String(lines[k]);
    if (!line.trim()) continue;
    // บรรทัดป้ายกำกับสั้น ๆ ระหว่างหัวกับแถวข้อมูล ("ตัวอย่างสมมติ:") — ยอมให้คั่นได้ครั้งเดียว
    if (rows.length === 1 && lead.length < 2 && !line.includes('|') && /[:：]\s*$/.test(line) && line.trim().length <= 40) {
      lead.push(line.trim());
      continue;
    }
    if (!line.includes('|') || cellsOf(line).length !== width) break;
    rows.push(cellsOf(line));
    next = k + 1;
  }
  if (rows.length < 3) return null;
  /**
   * แถวแรกที่ขึ้นต้นด้วยตัวเลข (เวลา จำนวน ราคา) คือข้อมูล ไม่ใช่ชื่อคอลัมน์
   * ตารางแบบนี้ไม่มีหัว ต้องบอกปลายทางไว้ ไม่งั้นแถวข้อมูลแถวแรกจะถูกทำตัวหนาเหมือนหัวตาราง
   */
  const header = !rows[0].some((cell) => /^[\d๐-๙]/.test(cell));
  return { rows, align: Array(width).fill('left'), next, lead, header };
}
