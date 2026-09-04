/**
 * เครื่องสถานะของงานทั้งเล่ม — "สมอง" ของระบบ
 *
 * หลักการเดียวที่ครอบทุกอย่าง: ทุกเทิร์นเป็นหน่วยที่ทำซ้ำได้และไม่มีผลข้างเคียง
 * เขียนผลลง IndexedDB ก่อนไปต่อเสมอ ไม่มีสถานะสำคัญค้างในหน่วยความจำ
 * ถ้าทำได้ตามนี้ ทุกความพังจะกลายเป็นแค่ "ลองเทิร์นนั้นใหม่"
 */

import * as db from './db.js';
import * as W from './workspace.js';
import * as P from './prompts.js';
import * as X from './extract.js';
import * as B from './bible.js';
import { countUnits } from './thai.js';
import {
  assignQuotas,
  planAdjustment,
  profileHash,
  observedCharsPerPage,
  rebaseQuotas,
  targetPhysicalPages,
  widenBands,
} from './budget.js';
import * as I from './items.js';
import { compileBook, calibrate } from '../typeset/compiler.js';
import { jitter, sleep } from '../transport/index.js';
import { generateImage, DEFAULT_IMAGE_MODEL } from './imageApi.js';
import { wantsAuthorRef, prepareRefImage, dataUrlToFile, AUTHOR_REF_RULE } from './imageRef.js';

export const STEPS = [
  'health',
  'calibrate',
  'outline',
  'gate_outline',
  'write',
  'figures',
  'consistency',
  'fit',
  'gate_edit',
  'style',
  'gate_images',
  'images',
  'done',
];

const MAX_CONTINUES = 2;
const MAX_RETRIES = 1; // ลองใหม่ครั้งเดียว — ทุกครั้งที่ลองคือหนึ่งข้อความจริงที่นับโควตา

/**
 * สารบัญได้โควตาพิเศษ
 *
 * ทุกขั้นหลังจากนี้ยืนอยู่บนสารบัญทั้งหมด ถ้าขั้นนี้ล้ม ทั้งเล่มไปต่อไม่ได้เลย
 * การประหยัดหนึ่งข้อความตรงนี้แล้วเสียทั้งงาน ไม่คุ้มกันเลย
 */
const OUTLINE_ATTEMPTS = 3;
const MAX_FIT_ROUNDS = 4;
const MAX_REWRITES_PER_ROUND = 12; // ปล่อยให้ลูปแก้ได้เต็มที่ในรอบเดียว จะลู่เข้าเร็วกว่า
const NUDGE_LIMIT = 0.04; // ปรับระยะบรรทัดได้ไม่เกิน 4% จากที่ผู้ใช้ตั้ง
const MAX_IMAGE_ATTEMPTS = 2; // ภาพหนึ่งรูปลองอัตโนมัติได้ 2 ครั้ง แล้วหยุดรอคน แทนการกินโควตาวนไม่จบ

/**
 * ความล้มเหลวที่เกิด "ก่อน" ข้อความจะถึง ChatGPT — ยังไม่ได้ใช้โควตาแม้แต่ข้อความเดียว
 *
 * เพดานลองใหม่ทั้งหมดในระบบนี้ตั้งไว้ต่ำ เพราะทุกครั้งที่ลอง = หนึ่งข้อความจริงที่นับโควตา
 * แต่เหตุผลนั้นใช้กับกลุ่มนี้ไม่ได้เลย กดส่งไม่ติดหรือเปิดห้องแชตไม่สำเร็จไม่ได้ส่งอะไรออกไป
 * การนับรวมมันเข้าไปในเพดานเดียวกัน ทำให้ระบบยอมแพ้ทั้งที่ยังไม่เคยได้คุยกับ ChatGPT ด้วยซ้ำ
 * — นี่คือสาเหตุที่งานหยุดบ่อยแล้วต้องมากดปุ่มเองทั้งที่ไม่มีอะไรเสียหาย
 */
const NO_COST_ERRORS = new Set([
  'prompt_not_sent',
  'new_thread_not_ready',
  'chat_page_not_ready',
  'adapter_unavailable',
  'composer_not_found',
  'composer_write_failed',
  'send_action_not_accepted',
  'composer_not_found_before_send',
]);
const MAX_FREE_RETRIES = 4;

const isNoCostFailure = (res) =>
  res?.status !== 'ok' && NO_COST_ERRORS.has(String(res?.meta?.error || ''));

export class Machine {
  /**
   * เครื่องนี้มีสายส่งสองเส้น ไม่ใช่เส้นเดียว
   *
   * งานเขียนกับงานสร้างภาพเลือกแหล่งแยกกันได้ตั้งแต่หน้าตั้งค่า และคนใช้บัญชีฟรี
   * มักเขียนด้วยทางหนึ่งแล้ววาดภาพอีกทางหนึ่ง ถ้าเครื่องมีสายส่งเส้นเดียว
   * เล่มที่เขียนด้วย API จะส่งเทิร์นสร้างภาพไปทาง API ด้วย ซึ่งวาดภาพไม่ได้
   * แล้วภาพทั้งเล่มจะไม่มาโดยที่คำสั่งภาพไม่มีอะไรผิดเลยสักบรรทัด
   */
  constructor({ book, transport, imageTransport = null, onEvent = () => {} }) {
    this.book = book;
    this.tr = transport;
    this.imgTr = imageTransport || transport;
    this.emit = onEvent;
    this.stopRequested = false;
    this.turnNo = book.job?.turnNo || 0;
  }

  // ---------- utility ----------
  get job() {
    return (this.book.job ||= { step: 'health', cursor: 0, round: 0, status: 'idle' });
  }

  async save() {
    this.book.job.turnNo = this.turnNo;
    await db.saveBook(this.book);
    this.emit({ type: 'state', book: this.book });
  }

  log(level, message, extra = {}) {
    this.emit({ type: 'log', level, message, at: Date.now(), ...extra });
  }

  stop() {
    this.stopRequested = true;
  }

  /**
   * เปิดแชทใหม่หรือไม่
   *
   * ค่าเริ่มต้นคือ "แชทเดียวทั้งเล่ม" เพราะเวอร์ชันก่อนเปิดแชทใหม่ทุกบท
   * พองานขาดตอนกลางคัน แชทที่ค้างอยู่ไม่มีบริบทของบทก่อนหน้า ทำต่อไม่ได้
   * อยู่แชทเดียวแล้วประวัติทั้งหมดอยู่ที่เดียว จะกลับมาทำต่อเมื่อไรก็ได้
   * และตัวโมเดลเองก็จำเรื่องที่เขียนไปแล้วได้โดยไม่ต้องป้อนบริบทซ้ำทุกครั้ง
   */
  wantNewThread(isChapterStart = false) {
    if (this.book.threadMode === 'chapter') return isChapterStart;
    if (this.book.threadMode === 'reuse') return false; // ใช้แชทที่เปิดค้างอยู่เลย
    if (!this.job.threadStarted) {
      this.job.threadStarted = true;
      return true; // เปิดแชทใหม่ครั้งเดียวตอนเริ่มเล่ม จากนั้นอยู่แชทนั้นตลอด
    }
    return false;
  }

  /** ยิงหนึ่งเทิร์น พร้อมบันทึกดิบและหน่วงตามจังหวะที่ตั้งไว้ */
  /**
   * คว้าภาพที่ ChatGPT วาดเสร็จแล้วจากหน้าแชตโดยตรง
   *
   * ใช้ช่องทางเดียวกับปุ่มมือ (sw.grabImage → gpt.grabImage) ซึ่งไม่พึ่งตัวตรวจจับจบเทิร์น
   * และเป็นเส้นทางที่พิสูจน์แล้วว่าใช้ได้จริงเวลาผู้ใช้กดเอง
   * วนถามเป็นระยะรวมราวหนึ่งนาทีครึ่ง เพราะภาพจากโมเดลสายคิดก่อนตอบมาช้ากว่าข้อความมาก
   */
  async grabRenderedImage(index, total, j, { tries = 4, gapMs = 5000 } = {}) {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
    for (let i = 0; i < tries; i++) {
      if (this.stopRequested) return null;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'sw.grabImage' });
        if (r?.ok && r.dataUrl) return r;
      } catch (_) {
        /* หน้าแชตยังไม่ตอบ ลองใหม่รอบหน้า */
      }
      if (i === 0) {
        this.emit({
          type: 'image.progress',
          stage: 'grab',
          current: index + 1,
          total,
          name: j.name,
          what: j.what,
        });
        this.log('warn', `ภาพ ${index + 1}/${total} · ${j.what}: ยังไม่เห็นภาพในคำตอบ — รอแล้วไล่คว้าจากหน้าแชตให้อีก ${Math.round((tries * gapMs) / 1000)} วินาที`);
      }
      await sleep(gapMs);
    }
    return null;
  }

  async turn(prompt, opts = {}) {
    if (this.stopRequested) throw new Halt('หยุดโดยผู้ใช้');

    /**
     * ช่วงหน่วงระหว่างเทิร์นมีไว้ให้จังหวะการพิมพ์บนหน้าเว็บดูเป็นคนใช้งานจริง
     * ทาง API ไม่มีหน้าเว็บให้ต้องทำเนียน หน่วงไปก็เสียเวลาเปล่าอย่างเดียว
     * เล่มหนึ่งมีหลายสิบเทิร์น ตรงนี้จึงเป็นเวลาที่ประหยัดได้จริงเมื่อเลือกทาง API
     */
    const activeKind = opts.wantImages ? this.imgTr.kind : this.tr.kind;
    const noPacingNeeded = activeKind === 'fake' || activeKind === 'openai_api';
    const [lo, hi] = this.book.transport?.delayMs || [4000, 9000];
    if (this.turnNo > 0 && !noPacingNeeded) await sleep(jitter([lo, hi]));

    const n = ++this.turnNo;
    this.emit({ type: 'turn.start', n, label: opts.label || '', prompt });

    // เทิร์นที่ขอภาพต้องออกทางสายภาพเสมอ ไม่ใช่สายที่ใช้เขียนข้อความ
    const line = opts.wantImages ? this.imgTr : this.tr;
    const res = await line.send(prompt, opts);
    await db.saveTurn(this.book.id, n, {
      label: opts.label || '',
      prompt,
      raw: res.text,
      status: res.status,
      images: res.images || [],
      meta: res.meta || {},
    });

    this.recordUsage(res);
    this.emit({ type: 'turn.end', n, status: res.status, response: res.text || '', meta: res.meta || {} });

    if (res.status === 'rate_limited') throw new RateLimited();
    if (res.status === 'wrong_model')
      throw new Halt(
        `เว็บสลับโมเดลเป็น "${res.meta?.model}" ซึ่งไม่ตรงกับที่ตั้งไว้ — หยุดไว้ก่อน เพราะเนื้อหาคนละโมเดลจะโทนไม่เท่ากัน`,
      );
    return res;
  }

  /**
   * เก็บ token ที่ใช้จริงของเล่มนี้
   *
   * ตัวเลขที่เซิร์ฟเวอร์รายงานกลับมาคือความจริงเรื่องค่าใช้จ่าย ไม่ใช่การประมาณ
   * เก็บสะสมไว้ในเล่มเพื่อสองอย่าง: บอกผู้ใช้ว่าเล่มนี้จ่ายไปเท่าไรแล้ว
   * และวัดว่าภาษาไทยของเล่มนี้กินกี่ตัวอักษรต่อหนึ่ง token เพื่อให้การประเมิน
   * ของเล่มถัดไปแม่นขึ้นจากของจริง ไม่ใช่จากค่าที่เราเดาไว้ในโค้ด
   */
  recordUsage(res) {
    const m = res?.meta;
    if (!m || m.promptTokens == null) return;
    const u = (this.book.apiUsage ||= { turns: 0, promptTokens: 0, completionTokens: 0, chars: 0, model: '' });
    u.turns += 1;
    u.promptTokens += Number(m.promptTokens) || 0;
    u.completionTokens += Number(m.completionTokens) || 0;
    u.chars += (res.text || '').length;
    u.model = m.model || u.model;
    if (u.completionTokens > 0) u.charsPerToken = Math.round((u.chars / u.completionTokens) * 100) / 100;
  }

  /**
   * เก็บ token ของภาพที่สร้างผ่าน API
   *
   * ราคาภาพคิดเป็น token ไม่ใช่ต่อรูป และเป็นค่าใช้จ่ายก้อนใหญ่กว่างานเขียนมากในหลายเล่ม
   * ถ้านับแต่ฝั่งข้อความ ตัวเลข "เล่มนี้จ่ายไปเท่าไร" จะผิดจนเอาไปตั้งราคาขายไม่ได้
   */
  recordImageUsage(out) {
    const u = out?.usage;
    if (!u || u.outputTokens == null) return 0;
    const img = (this.book.apiUsage ||= {}).image || ((this.book.apiUsage.image = {
      images: 0,
      inputTokens: 0,
      outputTokens: 0,
      model: '',
    }));
    img.images += 1;
    img.inputTokens += Number(u.inputTokens) || 0;
    img.outputTokens += Number(u.outputTokens) || 0;
    img.model = out.model || img.model;
    return (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0);
  }

  /**
   * ยิงซ้ำได้เมื่อพลาดแบบชั่วคราว
   *
   * ระวังการทวีคูณ: หนึ่งเทิร์นที่ล้มเหลวเคยกลายเป็นสามข้อความจริงที่ ChatGPT ตอบไปแล้ว
   * (นับโควตาไปแล้วทุกครั้ง) ถ้าตัวตรวจจับ "ตอบจบ" เพี้ยน ทุกเทิร์นจะหมดเวลาแล้วยิงซ้ำ
   * จึงจำกัดการลองใหม่ไว้ครั้งเดียว และตัดเวลารอลงจาก 5 นาทีเหลือ 2.5 นาที
   */
  async turnWithRetry(prompt, opts = {}) {
    let last = null;
    let free = 0;
    for (let i = 0; i <= MAX_RETRIES; i++) {
      const res = await this.turn(prompt, opts);
      if (res.status === 'ok') return res;
      last = res;

      // ยังไม่ได้ส่งอะไรถึง ChatGPT = ยังไม่เสียโควตา ลองใหม่ได้ฟรีโดยไม่กินเพดาน
      if (isNoCostFailure(res) && free < MAX_FREE_RETRIES) {
        free++;
        i--;
        this.log('warn', `ส่งงานไม่ออกจากเครื่องเรา (${res.meta?.detail || res.meta?.error}) — ยังไม่เสียโควตา ลองส่งใหม่ ${free}/${MAX_FREE_RETRIES}`);
        await sleep(2500);
        continue;
      }
      if (res.status === 'error' || res.status === 'timeout' || res.status === 'empty') {
        if (i >= MAX_RETRIES) break;
        const wait = [8000, 30000][i] || 30000;
        this.log('warn', `เทิร์นล้มเหลว (${res.status}) รอ ${wait / 1000} วินาทีแล้วลองอีกครั้งเดียว`);
        await sleep(wait);
        continue;
      }
      return res;
    }
    return last;
  }

  // ---------- ขั้นตอน ----------

  async runUntilGate() {
    this.stopRequested = false;
    this.job.status = 'running';
    await this.save();
    try {
      for (;;) {
        if (this.stopRequested) throw new Halt('หยุดโดยผู้ใช้');
        const step = this.job.step;
        if (step === 'done') break;
        if (step.startsWith('gate_')) {
          this.job.status = 'waiting_human';
          await this.save();
          this.emit({ type: 'gate', step });
          return { gate: step };
        }
        this.emit({ type: 'step', step, at: Date.now() });
        await this[step]();
        this.emit({ type: 'step_done', step, at: Date.now() });
        await this.save();
      }
      this.job.status = 'done';
      await this.save();
      return { done: true };
    } catch (e) {
      if (e instanceof RateLimited) {
        // เดิมตั้งเวลาลองใหม่เองทุก 30 นาที ซึ่งทำให้งานวิ่งกินโควตาทั้งวันโดยไม่มีใครดู
        // ตอนนี้หยุดสนิทและรอให้คนสั่งทำต่อ งานทั้งหมดถูกบันทึกไว้แล้ว
        this.job.status = 'rate_limited';
        this.job.resumeAt = null;
        this.log(
          'warn',
          `ชนลิมิตข้อความของ ChatGPT ที่ข้อความที่ ${this.turnNo} — หยุดแล้ว ไม่ลองต่อเอง กดทำต่อได้เมื่อโควตากลับมา`,
        );
      } else if (e instanceof Halt) {
        this.job.status = 'paused';
        this.job.error = e.message; // เก็บเหตุผลไว้ให้หน้าจอบอกได้ว่าหยุดเพราะอะไร
        this.log('warn', e.message);
      } else {
        this.job.status = 'error';
        this.job.error = String(e?.message || e);
        this.log('error', this.job.error);
      }
      await this.save();
      return { stopped: this.job.status };
    }
  }

  // 1) ตรวจว่า selector ยังใช้ได้ ก่อนเริ่มงานจริงทุกครั้ง
  async health() {
    const h = await this.tr.health();
    if (!h.ok) {
      throw new Halt(
        `ตรวจสุขภาพไม่ผ่าน: ${h.error || 'หาองค์ประกอบไม่เจอ ' + (h.missing || []).join(', ')} — หน้าตาเว็บอาจเปลี่ยน ให้แก้ตัวเลือกในหน้าตั้งค่า`,
      );
    }
    // ไม่ยิงข้อความทดสอบ "OK" อีกต่อไป เพราะผู้ใช้ต้องเห็นเฉพาะงานจริงที่ระบบส่งให้ ChatGPT
    // การตรวจสุขภาพใช้ adapter/composer/model ที่อ่านจากหน้า ChatGPT เพียงอย่างเดียว
    this.log('ok', `เชื่อมต่อได้ โมเดลที่เห็น: ${h.model || 'ไม่ทราบ'} — พร้อมส่งงานจริง`);
    this.job.step = 'calibrate';
  }

  // 2) หาว่าโปรไฟล์เล่มนี้จุได้กี่อักษรต่อหน้า
  async calibrate() {
    if (this.book.contentMode === 'items') {
      // โหมดรายชิ้นไม่ต้องหาอักษรต่อหน้า เพราะจำนวนหน้ามาจากจำนวนชิ้นตรง ๆ
      this.book.itemSizePt = this.book.itemSizePt || I.suggestItemSize(this.book);
      this.log('ok', `โหมดรายชิ้น ${this.book.itemsPerPage} ชิ้นต่อหน้า ตัวอักษร ${this.book.itemSizePt}pt`);
      this.job.step = 'outline';
      return;
    }
    const hash = profileHash(this.book);
    if (this.book.calibration?.profileHash === hash) {
      this.log('ok', `ใช้ค่า calibration เดิม ${this.book.calibration.charsPerPage} อักษร/หน้า`);
      this.job.step = 'outline';
      return;
    }

    const sample = buildSample(this.book.language);
    const { charsPerPage, pages } = await calibrate({
      book: this.book,
      sampleText: sample.text,
      sampleChars: sample.units,
    });

    this.book.calibration = { charsPerPage, profileHash: hash, measuredAt: Date.now(), pages };
    this.log(
      'ok',
      `calibration: ${sample.units.toLocaleString()} หน่วย เรียงได้ ${pages} หน้า → ${charsPerPage} ต่อหน้า`,
    );
    this.job.step = 'outline';
  }

  // 3) สารบัญ หรือโครงหมวดของโหมดรายชิ้น
  async outline() {
    if (this.book.contentMode === 'items') return this.outlineItems();
    let errs = null;
    let lastRaw = '';
    for (let i = 0; i < OUTLINE_ATTEMPTS; i++) {
      if (i > 0) this.log('ok', `ลองวางสารบัญใหม่ ครั้งที่ ${i + 1} จาก ${OUTLINE_ATTEMPTS}`);
      const res = await this.turnWithRetry(P.outlinePrompt(this.book, errs), {
        label: `outline${i > 0 ? ` (ครั้งที่ ${i + 1})` : ''}`,
        newThread: this.wantNewThread(true),
      });
      lastRaw = String(res.text || '');
      const parsed = X.parseJson(lastRaw);
      errs = X.validateOutline(parsed);
      if (this.book.contentMode === 'fiction' && parsed) errs.push(...fictionOutlineErrors(parsed));

      // ซอยถี่เกินไป = ทั้งเล่มจะเขียนเกินโควตาทุกตอน แล้วจำนวนหน้าจะไม่มีวันเข้าเป้า
      const cap = P.maxSectionsFor(this.book);
      const nSections = (parsed?.chapters || []).reduce((n, c) => n + (c.sections || []).length, 0);
      if (nSections > cap) {
        errs.push(
          `มี ${nSections} ตอน มากเกินไปสำหรับเล่ม ${this.book.targetPages} หน้า — ต้องไม่เกิน ${cap} ตอน ให้ยุบเป็นตอนที่ใหญ่ขึ้น`,
        );
      }
      // ขาดแค่บางช่องของบางตอน = ซ่อมได้ ไม่ต้องทิ้งทั้งชุดแล้วเขียนใหม่
      if (errs.length && parsed) {
        const gaps = outlineGaps(parsed, this.book.contentMode === 'fiction');
        const sectionCount = (parsed.chapters || []).reduce((n, c) => n + (c.sections || []).length, 0);
        if (gaps.length && gaps.length <= Math.max(3, Math.ceil(sectionCount * 0.3))) {
          this.log('warn', `สารบัญขาดข้อมูล ${gaps.length} ตอน (${gaps.map((g) => g.id).join(', ')}) — ขอเติมเฉพาะตอนนั้น ไม่เขียนใหม่ทั้งชุด`);
          try {
            const patch = await this.turnWithRetry(P.outlinePatchPrompt(this.book, gaps), { label: 'เติมข้อมูลสารบัญที่ขาด' });
            applyOutlinePatch(parsed, X.parseJson(patch.text));
          } catch (e) {
            if (e instanceof RateLimited || e instanceof Halt) throw e;
            this.log('warn', `ขอเติมข้อมูลสารบัญไม่สำเร็จ (${e?.message || e})`);
          }
          errs = X.validateOutline(parsed);
          if (this.book.contentMode === 'fiction') errs.push(...fictionOutlineErrors(parsed));

          // ยังไม่ครบอีก: เติมให้เองแล้วเดินต่อ ดีกว่าทิ้งสารบัญทั้งเล่มแล้วหยุดงาน
          if (errs.length) {
            const filled = fillOutlineGaps(parsed, this.book.contentMode === 'fiction');
            if (filled.length) {
              this.log('warn', `เติมข้อมูลให้เองแล้ว ${filled.length} ตอน (${filled.join(', ')}) — แก้ได้ทีหลังในหน้าตรวจงาน`);
              errs = X.validateOutline(parsed);
              if (this.book.contentMode === 'fiction') errs.push(...fictionOutlineErrors(parsed));
            }
          }
        }
      }

      if (!errs.length) {
        const q = assignQuotas(this.book, parsed);
        this.book.outline = q.outline;
        this.book.budget = { budget: q.budget, textPages: q.textPages, breakdown: q.breakdown };
        this.book.warnings = q.warnings;
        this.book.bible = B.emptyBible();
        this.book.bible.voiceCard = parsed.voice_card || this.book.tone;
        if (this.book.contentMode === 'fiction') {
          this.book.bible.characters = structuredClone(parsed.cast || []);
          this.book.bible.worldFacts = structuredClone(parsed.world_rules || []);
          this.book.bible.openThreads = [];
        }

        for (const ch of q.outline.chapters) {
          for (const s of ch.sections) {
            await db.saveSection(this.book.id, {
              id: s.id,
              title: s.title,
              md: '',
              chars: 0,
              status: 'draft',
              locked: false,
              elastic: s.elastic !== false,
              quota: s.quota,
              minChars: s.minChars,
              maxChars: s.maxChars,
              takeaways: s.takeaways || [],
              beats: s.beats || [],
              povCharacter: s.pov_character || '',
              location: s.location || '',
              time: s.time || '',
              sceneGoal: s.scene_goal || '',
              conflict: s.conflict || '',
              turn: s.turn || '',
              hook: s.hook || '',
              chapter: ch.n,
            });
          }
        }
        this.log('ok', `ได้สารบัญ ${q.outline.chapters.length} บท งบรวม ${q.budget.toLocaleString()} หน่วย`);
        for (const w of q.warnings) this.log('warn', w);
        this.job.step = 'gate_outline';
        return;
      }
      // บอกด้วยว่าได้อะไรกลับมาจริง ไม่ใช่บอกแค่ว่าไม่ผ่าน
      const flat = lastRaw.replace(/\s+/g, ' ').trim();
      this.log(
        'warn',
        `สารบัญไม่ผ่านการตรวจ: ${errs.slice(0, 3).join(', ')}\n` +
          `คำตอบที่ได้ยาว ${lastRaw.length.toLocaleString()} ตัวอักษร — ต้นข้อความ: ${flat.slice(0, 180) || '(ว่าง)'}` +
          (flat.length > 360 ? `\nท้ายข้อความ: ${flat.slice(-140)}` : ''),
      );
    }

    /**
     * ยอมแพ้แล้วต้องไม่ใช่ทางตัน
     *
     * Halt พางานกลับไปที่การ์ด "ทำต่อ" ซึ่งกดแล้ววนกลับมาลองสารบัญใหม่ได้ทันที
     * แต่ข้อความเดิมบอกแค่ว่าทำไม่ได้ ไม่ได้บอกว่ากดอะไรต่อ ผู้ใช้เลยคิดว่าจบแค่นั้น
     */
    const why = (errs || []).slice(0, 3).join(', ') || 'ไม่ทราบสาเหตุ';
    throw new Halt(
      `วางสารบัญไม่สำเร็จหลังลอง ${OUTLINE_ATTEMPTS} ครั้ง — ติดที่: ${why} · ` +
        `งานถูกบันทึกไว้ครบแล้ว กด "ทำต่อ" เพื่อให้ลองวางสารบัญใหม่ได้เลย ` +
        `หรือถ้าลองแล้วยังติดซ้ำ ให้ลดจำนวนหน้าลงหรือเปลี่ยนหัวข้อให้แคบลง`,
    );
  }

  /** โครงหมวดของหนังสือรายชิ้น — จำนวนชิ้นคำนวณตรง ๆ ไม่ต้องเดา */
  async outlineItems() {
    const plan = I.planItems(this.book);
    const res = await this.turnWithRetry(I.themePrompt(this.book, plan), {
      label: 'โครงหมวด',
      newThread: this.wantNewThread(true),
    });
    const parsed = X.parseJson(res.text);
    if (!parsed?.themes?.length) throw new Halt('วางโครงหมวดไม่สำเร็จ ลองใหม่อีกครั้ง');

    this.book.outline = { title: parsed.title, subtitle: parsed.subtitle || '', themes: parsed.themes };
    this.book.itemPlan = plan;
    this.book.bible = B.emptyBible();
    this.log(
      'ok',
      `${parsed.themes.length} หมวด ต้องใช้ ${plan.total} ชิ้น (${plan.perPage} ชิ้นต่อหน้า) คาดว่าใช้ราว ${plan.turns} ข้อความ`,
    );
    this.job.step = 'gate_outline';
  }

  /**
   * เขียนชิ้นทีละชุด — ชิ้นสั้นจึงขอได้หลายสิบชิ้นต่อหนึ่งข้อความ
   * ตัวที่ต้องระวังคือความซ้ำ จึงส่งใจความที่ใช้ไปแล้วกลับเข้าไปทุกครั้ง
   */
  async writeItems() {
    await this.ensureAuthorVoice();
    const outline = this.book.outline;
    const plan = this.book.itemPlan || I.planItems(this.book);
    const per = I.itemsPerTurn(this.book.itemKind);

    const existing = await db.loadSections(this.book.id);
    const done = new Map();
    for (const s of existing) if (s.kind === 'item') done.set(s.id, s);

    for (const theme of outline.themes) {
      const want = theme.count || plan.perTheme;
      let have = [...done.keys()].filter((id) => String(id).startsWith(theme.n + '.')).length;

      while (have < want) {
        const count = Math.min(per, want - have);
        const ids = Array.from({ length: count }, (_, i) => `${theme.n}.${have + i + 1}`);

        const res = await this.turnWithRetry(
          I.itemBatchPrompt({
            book: this.book,
            outline,
            theme,
            count,
            startIndex: have + 1,
            avoid: (this.book.bible.usedExamples || []).slice(-30),
          }),
          { label: `หมวด ${theme.n} ชิ้นที่ ${have + 1}-${have + count}` },
        );

        const got = I.extractItems(res.text, ids);
        if (!got.length) {
          this.log('warn', `หมวด ${theme.n}: ไม่ได้ชิ้นกลับมาเลย ข้ามชุดนี้`);
          break;
        }

        for (const it of got) {
          await this.saveItem(theme, it);
          done.set(it.id, it);
          this.book.bible.usedExamples.push(it.text.slice(0, 40));
        }
        this.book.bible.usedExamples = this.book.bible.usedExamples.slice(-60);

        have += got.length;
        this.log('ok', `หมวด ${theme.n} "${theme.title}": ได้ ${have}/${want} ชิ้น`);
        await this.save();

        if (got.length < count) break;
      }
    }

    this.job.step = 'fit';
  }

  async saveItem(theme, it) {
    await db.saveSection(this.book.id, {
      id: it.id,
      kind: 'item',
      theme: theme.n,
      title: theme.title,
      text: it.text,
      attribution: it.attribution || '',
      md: it.text,
      chars: countUnits(it.text, this.book.language),
      status: 'generated',
    });
  }

  /**
   * ปรับจำนวนหน้าของหนังสือรายชิ้น — เพิ่ม/ลดชิ้น ไม่ใช่ยืดข้อความ
   * เพราะชิ้นต่อหน้าคงที่ จึงรู้ล่วงหน้าว่าต้องเพิ่มหรือตัดกี่ชิ้น ไม่ต้องลองผิดลองถูก
   * และการตัดออกไม่ต้องยิง ChatGPT เลย
   */
  async fitItems() {
    const plan = this.book.itemPlan || I.planItems(this.book);
    const target = plan.breakdown.targetPhysical;
    const tol = this.book.pageTolerance ?? 2;
    const perPage = Math.max(1, this.book.itemsPerPage || 1);

    for (let round = 0; round < 3; round++) {
      const sections = await db.loadSections(this.book.id);
      const items = sections.filter((s) => s.kind === 'item');
      const { pages, ms } = await this.measure(sections);
      const err = pages - target;
      this.log(
        Math.abs(err) <= tol ? 'ok' : 'warn',
        `รอบที่ ${round + 1}: ${pages} หน้า จาก ${items.length} ชิ้น (${err >= 0 ? '+' : ''}${err}) คอมไพล์ ${ms} ms`,
      );
      if (Math.abs(err) <= tol) return this.finishFit(pages);

      if (err > 0) {
        const drop = Math.min(items.length - 1, err * perPage);
        const tail = items.sort((a, b) => cmpItem(b.id, a.id)).slice(0, drop);
        for (const s of tail) await db.del('sections', s.key);
        this.log('ok', `ตัดออก ${tail.length} ชิ้นให้พอดีหน้า ไม่ต้องใช้ข้อความเพิ่ม`);
        continue;
      }

      const need = -err * perPage;
      const themes = this.book.outline.themes;
      const theme = themes[round % themes.length];
      const have = items.filter((s) => String(s.id).startsWith(theme.n + '.')).length;
      const ids = Array.from({ length: need }, (_, i) => `${theme.n}.${have + i + 1}`);

      const res = await this.turnWithRetry(
        I.itemBatchPrompt({
          book: this.book,
          outline: this.book.outline,
          theme,
          count: need,
          startIndex: have + 1,
          avoid: (this.book.bible.usedExamples || []).slice(-30),
        }),
        { label: `เพิ่มอีก ${need} ชิ้น` },
      );
      const got = I.extractItems(res.text, ids);
      for (const it of got) await this.saveItem(theme, it);
      this.log('ok', `เพิ่มมาได้ ${got.length} ชิ้น`);
      if (!got.length) break;
    }

    const sections = await db.loadSections(this.book.id);
    const { pages } = await this.measure(sections);
    return this.finishFit(pages);
  }

  /**
   * 4) เขียนเนื้อหา — รวมหลายตอนไว้ในหนึ่งเทิร์น
   *
   * เวอร์ชันแรกยิงหนึ่งข้อความต่อหนึ่งตอน บวกอีกหนึ่งข้อความต่อบทเพื่อให้ตอบว่า "พร้อม"
   * เล่ม 120 หน้าจึงกินราว 45 ข้อความแค่ขั้นนี้ ทั้งที่แต่ละตอนยาวเพียงราว 2,000 อักษร
   * ตอนนี้จัดกลุ่มตอนให้เต็มความยาวที่ตอบไหวในเทิร์นเดียว และผนวกบริบทบทไว้หัวคำสั่ง
   * ไม่ต้องเสียเทิร์นทักทายอีก
   */
  /**
   * การ์ดผู้เขียน: เขียนครั้งเดียวก่อนลงมือเขียนเนื้อหา
   * ทำหลังได้สารบัญจริง การ์ดจะได้อ้างอิงเนื้อหาของเล่มนี้ ไม่ใช่ของกว้าง ๆ
   */
  async ensureAuthorVoice() {
    const mode = this.book.authorVoice || 'auto';
    if (mode === 'off' || this.book.authorVoiceCard?.who) return;
    if (String(this.book.authorVoiceText || '').trim()) return; // ผู้ใช้เขียนเองแล้ว

    this.log('ok', 'สร้างการ์ดผู้เขียน เพื่อให้ทั้งเล่มมีคนพูดคนเดียวและมีจุดยืน');
    try {
      const res = await this.turnWithRetry(P.authorVoicePrompt(this.book, this.book.outline || {}), {
        label: 'การ์ดผู้เขียน',
      });
      const card = X.parseJson(res.text);
      if (card?.who) {
        this.book.authorVoiceCard = {
          who: String(card.who || ''),
          why_this_book: String(card.why_this_book || ''),
          believes: String(card.believes || ''),
          rejects: String(card.rejects || ''),
          was_wrong_about: String(card.was_wrong_about || ''),
          still_unsure_about: String(card.still_unsure_about || ''),
          avoid_words: (Array.isArray(card.avoid_words) ? card.avoid_words : []).slice(0, 6).map(String),
          writtenAt: Date.now(),
        };
        await this.save();
        this.log('ok', `ผู้เขียนของเล่มนี้: ${this.book.authorVoiceCard.who}\nไม่เชื่อว่า: ${this.book.authorVoiceCard.rejects || '-'}`);
      } else {
        this.log('warn', 'อ่านการ์ดผู้เขียนไม่ได้ — เขียนต่อโดยใช้โทนเสียงเดิม');
      }
    } catch (e) {
      if (e instanceof RateLimited || e instanceof Halt) throw e;
      this.log('warn', `สร้างการ์ดผู้เขียนไม่สำเร็จ (${e?.message || e}) — เขียนต่อโดยใช้โทนเสียงเดิม`);
    }
  }

  async write() {
    if (this.book.contentMode === 'items') return this.writeItems();
    await this.ensureAuthorVoice();
    const outline = this.book.outline;
    const batches = this.planBatches(outline);
    this.job.totalBatches = batches.length;

    for (let i = this.job.cursor; i < batches.length; i++) {
      this.job.cursor = i;
      const b = batches[i];
      const pending = [];
      for (const s of b.sections) {
        const rec = await db.loadSection(this.book.id, s.id);
        if (rec?.status === 'approved' || rec?.locked || (rec?.md || '').trim()) continue;
        pending.push(s);
      }
      if (!pending.length) continue;

      await this.writeBatch({ chapter: b.chapter, sections: pending, isChapterStart: b.first });

      /**
       * เตือนทันทีที่ตอนออกมาสั้นกว่าเป้ามาก อย่ารอไปเจอตอนเปิดไฟล์
       *
       * ถ้าทุกตอนสั้นกว่าโควตา เล่มจะบางกว่าที่สั่งไว้หลายเท่า และกว่าจะรู้ก็ตอนได้ PDF มาแล้ว
       * ขั้น fit ตามแก้ให้ได้ แต่ต้องเผาข้อความไปแก้ทีละตอน ซึ่งแพงกว่าการเขียนให้ถูกตั้งแต่แรกมาก
       */
      for (const s of pending) {
        const rec = await db.loadSection(this.book.id, s.id);
        const got = rec?.chars || 0;
        if (s.quota && got && got < s.quota * 0.7) {
          this.log(
            'warn',
            `ตอน ${s.id} สั้นกว่าเป้ามาก — ได้ ${got.toLocaleString()} จาก ${s.quota.toLocaleString()} หน่วย (${Math.round((got / s.quota) * 100)}%) ขั้นปรับจำนวนหน้าจะตามแก้ให้ แต่ถ้าเห็นเตือนแบบนี้ทุกตอน แปลว่าคำสั่งเขียนกำลังบีบให้เขียนสั้นเกินไป`,
          );
        }
      }

      await this.save();
    }

    /**
     * ด่านสุดท้ายของขั้นเขียน: ทุกตอนต้องมีเนื้อหาจริง
     *
     * นี่คือด่านที่ขาดหายไปแล้วทำให้เกิดเล่มที่พิมพ์ออกมาแล้วมีแต่บรรทัด
     * "(ยังไม่มีเนื้อหาของตอน 1.1)" ทั้งเล่ม — ขั้นเขียนพลาดทุกตอน แต่ระบบเดินต่อ
     * ไปวางภาพ ปรับหน้า สร้างปก แล้วส่งออกไฟล์ให้เรียบร้อยราวกับไม่มีอะไรเกิดขึ้น
     * เผาโควตาไปทั้งรอบเพื่อได้เล่มเปล่า
     *
     * ความสมบูรณ์ของเนื้อหาสำคัญกว่าการเดินให้จบขั้นตอน ถ้าเขียนไม่ได้ต้องหยุดตรงนี้
     */
    const all = outline.chapters.flatMap((c) => c.sections || []);
    const written = await db.loadSections(this.book.id);
    const byId = new Map(written.map((s) => [s.id, s]));
    const empty = all.filter((s) => !((byId.get(s.id)?.md || '').trim()));

    if (empty.length) {
      const ids = empty.map((s) => s.id);
      this.log('warn', `ยังมี ${empty.length} ตอนที่ไม่มีเนื้อหา (${ids.join(', ')}) — สั่งเขียนใหม่ทีละตอนก่อนไปต่อ`);
      for (const sec of empty) {
        if (this.stopRequested) throw new Halt('หยุดโดยผู้ใช้');
        const ch = outline.chapters.find((c) => (c.sections || []).some((x) => x.id === sec.id));
        if (!ch) continue;
        try {
          await this.writeBatch({ chapter: ch, sections: [sec], isChapterStart: false });
        } catch (e) {
          if (e instanceof RateLimited || e instanceof Halt) throw e;
          this.log('warn', `ตอน ${sec.id} เขียนซ้ำไม่สำเร็จ (${e?.message || e})`);
        }
        await this.save();
      }

      const after = await db.loadSections(this.book.id);
      const afterById = new Map(after.map((s) => [s.id, s]));
      const stillEmpty = all.filter((s) => !((afterById.get(s.id)?.md || '').trim()));
      if (stillEmpty.length) {
        /**
          * ทางที่ใช้เขียนต่างกัน วิธีตรวจก็คนละเรื่องกัน
          * เดิมไล่ให้ไปดูแท็บ ChatGPT เสมอ ซึ่งไม่มีความหมายเลยกับเล่มที่เขียนด้วย API
          * คำแนะนำที่ใช้ไม่ได้แย่กว่าไม่แนะนำอะไร เพราะพาไปหาปัญหาผิดที่
          */
        const how =
          (this.book.textSource || 'web') === 'api'
            ? 'ตรวจว่า API key ยังใช้ได้และเครดิตยังเหลือ'
            : 'ตรวจว่าแท็บ ChatGPT ยังตอบได้ปกติ';
        throw new Halt(
          `เขียนเนื้อหาไม่สำเร็จ ${stillEmpty.length} จาก ${all.length} ตอน (${stillEmpty.map((s) => s.id).join(', ')}) — ` +
            `หยุดไว้ก่อนเพื่อไม่ให้ได้เล่มที่หน้าเป็นช่องว่าง ` +
            `${how} แล้วกด "ทำต่อจากที่ค้าง" ระบบจะเขียนเฉพาะตอนที่ยังขาด`,
        );
      }
      this.log('ok', `เขียนตอนที่ขาดครบแล้วทั้ง ${empty.length} ตอน`);
    }

    this.job.cursor = 0;
    this.job.step = 'figures';
  }

  /**
   * 4b) วางแผนภาพประกอบ — เป็นเทิร์นข้อความล้วน จึงใช้ได้กับบัญชีที่สร้างภาพไม่ได้
   *
   * แยกการ "วางแผนภาพ" ออกจากการ "สร้างภาพ" โดยตั้งใจ
   * เพราะคนส่วนใหญ่เขียนเนื้อหาด้วยบัญชีฟรีที่สร้างภาพไม่ได้
   * ขั้นนี้จึงได้ทั้งตำแหน่ง คำบรรยาย และ prompt ของทุกภาพเก็บไว้
   * ส่วนไฟล์ภาพจะมาจากไหนค่อยว่ากัน — อัปโหลดเอง สร้างในบัญชีรายเดือน หรือให้ระบบสร้างให้
   */
  async figures() {
    const next = () => (this.job.step = this.book.runConsistency ? 'consistency' : 'fit');
    if (this.book.contentMode === 'items') return next();
    if ((this.book.illustrationLevel || 'none') === 'none') {
      this.log('ok', 'เล่มนี้ไม่ใส่ภาพประกอบ ข้ามไป');
      return next();
    }

    const requestedStyle = this.book.figureStyle || 'box';
    const style = requestedStyle === 'box'
      ? (this.book.figureMode === 'auto' ? (this.book.contentMode === 'fiction' ? 'sketch' : 'line') : (this.book.contentMode === 'fiction' ? 'sketch' : 'box'))
      : requestedStyle;
    const basePrompt = P.figurePlanPrompt(this.book, this.book.outline, this.book.outline.chapters, style);
    const res = await this.turnWithRetry(basePrompt, { label: 'วางแผนภาพประกอบ' });
    let plan = X.parseJson(res.text);
    // turnWithRetry ลองซ้ำเฉพาะตอนเทิร์นพัง (timeout/error/empty) แต่ถ้า ChatGPT ตอบสำเร็จมาเป็น {"figures":[]}
    // (parse ผ่านแต่ไม่มีภาพเลย) มันไม่นับว่าพังจึงไม่ลองซ้ำ — ลองอีกครั้งเดียวแบบเน้นย้ำก่อนยอมแพ้เงียบ ๆ
    if (!plan?.figures?.length) {
      this.log('warn', 'วางแผนภาพประกอบได้ 0 รูปจากครั้งแรก ลองย้ำอีกครั้งก่อนข้าม');
      const res2 = await this.turnWithRetry(
        `${basePrompt}\n\nคำตอบก่อนหน้าไม่มีภาพเลยสักรูป (figures ว่าง) เล่มนี้ตั้งค่าระดับภาพประกอบไว้ว่า "${this.book.illustrationLevel}" ต้องเลือกอย่างน้อย 1-2 ช่วงจากเนื้อหาจริงที่เขียนไปแล้วมาวางเป็นภาพ ห้ามตอบ figures ว่างอีก`,
        { label: 'วางแผนภาพประกอบ (ย้ำ)' },
      );
      plan = X.parseJson(res2.text);
    }
    if (!plan?.figures?.length) {
      this.log('warn', 'วางแผนภาพไม่สำเร็จหลังลองย้ำแล้ว ข้ามไปก่อน แก้เพิ่มเองได้ในโหมดแก้ไข');
      return next();
    }

    const textWidthMm =
      this.book.trim.widthMm - this.book.typography.marginsMm.inner - this.book.typography.marginsMm.outer;

    const figures = [];
    const counter = new Map();

    for (const f of plan.figures) {
      const rec = await db.loadSection(this.book.id, f.section);
      if (!rec?.md) {
        this.log('warn', `ภาพประกอบที่วางไว้อ้างถึงตอน "${f.section}" ซึ่งไม่มีอยู่จริง — ข้ามภาพนี้ไป (ChatGPT อาจอ้าง section id ผิด)`);
        continue;
      }

      const n = (counter.get(f.section) || 0) + 1;
      counter.set(f.section, n);

      if (f.kind === 'box' && f.lines?.length) {
        const marker = [`:::box ${f.caption || ''}`.trim(), ...f.lines.map((l) => `- ${l}`), ':::'].join('\n');
        rec.md = insertFigureAt(rec.md, marker, f.placement);
        figures.push({ id: `${f.section}-${n}`, section: f.section, kind: 'box', caption: f.caption, placement: f.placement || 'middle' });
      } else {
        const name = `fig-${f.section}-${n}.png`;
        const widthPct = Math.min(100, Math.max(40, Number(f.width) || 80));
        const widthMm = Math.round(((textWidthMm * widthPct) / 100) * 10) / 10;
        const aspect = normalizeFigureAspect(f.aspect);
        // ล็อกความสูงตั้งแต่ Phase 1 เพื่อให้ placeholder กับภาพจริงกินพื้นที่เท่ากัน
        // จากนั้น Typst จะ crop แบบ cover แทนการปล่อยให้อัตราส่วนไฟล์จริงดันจำนวนหน้า
        const heightMm = Math.round(Math.min(72, widthMm / aspect.ratio) * 10) / 10;
        rec.md = insertFigureAt(
          rec.md,
          `![${f.caption || ''}](fig:${name} ${widthPct}% ${heightMm}mm)`,
          f.placement,
        );
        figures.push({
          id: `${f.section}-${n}`,
          section: f.section,
          kind: 'image',
          name,
          caption: f.caption || '',
          subject: f.subject || f.caption || '',
          placement: f.placement || 'middle',
          widthPct,
          widthMm,
          heightMm,
          aspect: aspect.label,
          prompt: P.interiorFigurePrompt(
            style,
            f.subject || f.caption || '',
            widthMm,
            heightMm,
            aspect.label,
            {
              color: P.figureColorOn(this.book),
              palette: this.book.style?.palette || [],
              // บอกให้รู้ว่ารูปอื่นในเล่มวาดอะไรไปแล้ว จะได้ไม่วาดซ้ำแนวเดิม
              otherSubjects: figures.filter((x) => x.kind === 'image').map((x) => x.subject || x.caption),
            },
          ),
        });
      }

      rec.chars = countUnits(rec.md, this.book.language);
      await db.saveSection(this.book.id, rec);
    }

    this.book.figures = figures;
    const boxes = figures.filter((f) => f.kind === 'box').length;
    const imgs = figures.length - boxes;
    this.log(
      'ok',
      `วางแผนภาพแล้ว ${figures.length} จุด — กล่องสรุป ${boxes} (Typst วาดเอง) · ภาพจริง ${imgs} รูป` +
        (imgs ? ' · ดู prompt และใส่ไฟล์ได้ในแท็บภาพ' : ''),
    );
    return next();
  }

  /**
   * จัดกลุ่มตอนให้แต่ละเทิร์นยาวไม่เกินเพดานที่ตอบไหว และไม่ข้ามบท
   *
   * โหมด 'section' คือเขียนทีละตอน ได้คุณภาพต่อตอนดีที่สุดเพราะโมเดลทุ่มให้ตอนเดียว
   * แลกกับจำนวนข้อความที่มากกว่า ส่วนโหมด 'batch' รวมหลายตอนเพื่อประหยัดข้อความ
   */
  planBatches(outline) {
    if ((this.book.writeMode || 'section') === 'section') {
      return outline.chapters.flatMap((ch) =>
        ch.sections.map((s, i) => ({ chapter: ch, sections: [s], first: i === 0 })),
      );
    }
    const cap = this.book.maxCharsPerTurn || 6000;
    const out = [];
    for (const ch of outline.chapters) {
      let cur = [];
      let sum = 0;
      let first = true;
      for (const s of ch.sections) {
        if (cur.length && sum + s.quota > cap) {
          out.push({ chapter: ch, sections: cur, first });
          first = false;
          cur = [];
          sum = 0;
        }
        cur.push(s);
        sum += s.quota;
      }
      if (cur.length) out.push({ chapter: ch, sections: cur, first });
    }
    return out;
  }

  async writeBatch({ chapter, sections, isChapterStart }) {
    const outline = this.book.outline;
    const bible = this.book.bible;
    const flat = outline.chapters.flatMap((c) => c.sections);
    const lastId = sections.at(-1).id;
    const next = flat[flat.findIndex((x) => x.id === lastId) + 1] || null;
    const ids = sections.map((s) => s.id);

    const prompt = P.batchPrompt({
      book: this.book,
      outline,
      bible,
      chapter,
      sections,
      prevSummaries: B.prevSummaries(bible, outline, sections[0].id),
      nextSection: next,
      withContext: isChapterStart,
    });

    const label = `บทที่ ${chapter.n} · ตอน ${ids.join(', ')}`;
    let res = await this.turnWithRetry(prompt, { label, newThread: this.wantNewThread(isChapterStart) });
    let raw = res.text || '';

    // ถ้าได้ไม่ครบทุกตอน ให้สั่งเขียนต่อเฉพาะตอนที่ยังขาด แทนที่จะยิงใหม่ทั้งชุด
    for (let attempt = 0; attempt < MAX_CONTINUES; attempt++) {
      const missing = ids.filter((id) => X.extractSection(raw, id).status !== 'ok');
      if (!missing.length) break;
      this.log('warn', `ยังขาดตอน ${missing.join(', ')} — สั่งเขียนต่อ`);
      const cont = await this.turnWithRetry(P.continueBatchPrompt(missing, raw, this.book), {
        label: `เขียนต่อ ${missing.join(', ')}`,
      });
      raw += '\n' + (cont.text || '');
    }

    // ยังขาดอยู่อีก ให้ยิงทีละตอนแบบเดี่ยว ๆ ก่อนยอมแพ้
    // เพราะการขอทีละตอนสำเร็จง่ายกว่าการขอต่อจากของเดิมมาก
    const recovered = new Map();
    const stillMissing = ids.filter((id) => X.extractSection(raw, id).status !== 'ok');
    for (const id of stillMissing) {
      const s = sections.find((x) => x.id === id);
      if (!s) continue;
      this.log('warn', `ตอน ${id} ยังไม่ได้ ลองขอแบบเดี่ยวอีกครั้ง`);
      const solo = await this.turnWithRetry(
        P.batchPrompt({
          book: this.book,
          outline,
          bible,
          chapter,
          sections: [s],
          prevSummaries: [],
          // เดิมใส่ null เสมอ ทำให้ prompt เข้าใจผิดว่านี่คือฉากสุดท้ายของเล่มเสมอเวลาต้องขอเดี่ยว ๆ
          nextSection: flat[flat.findIndex((x) => x.id === id) + 1] || null,
          withContext: false,
        }),
        { label: `ตอน ${id} เดี่ยว` },
      );
      if (X.extractSection(solo.text || '', id).status === 'ok') {
        raw += '\n' + solo.text;
        continue;
      }
      // ทางสุดท้าย: ถ้าตอบเนื้อหามาจริงแต่ไม่ใส่เครื่องหมาย ก็เอามาใช้
      // ดีกว่าปล่อยให้หน้าในหนังสือว่างเปล่า แต่ทำเครื่องหมายไว้ให้คนตรวจ
      const salvaged = X.recoverBody(solo.text || '') || X.recoverBody(raw);
      if (salvaged) {
        recovered.set(id, salvaged);
        this.log('warn', `ตอน ${id} ไม่มีเครื่องหมายกำกับ แต่มีเนื้อหา — กู้มาใช้ ควรอ่านทวนตอนนี้`);
      }
    }

    let meta = null;
    for (const s of sections) {
      const ex = X.extractSection(raw, s.id);
      meta ||= ex.meta || X.extractMeta(raw, sections[0].id);

      const salvage = recovered.get(s.id);
      if (ex.status !== 'ok' && salvage) {
        const chars = countUnits(salvage, this.book.language);
        await db.saveSection(this.book.id, {
          id: s.id,
          title: s.title,
          chapter: chapter.n,
          md: salvage,
          chars,
          status: 'recovered',
          quota: s.quota,
          minChars: s.minChars,
          maxChars: s.maxChars,
          takeaways: s.takeaways || [],
          beats: s.beats || [],
          povCharacter: s.pov_character || '',
          location: s.location || '',
          time: s.time || '',
          sceneGoal: s.scene_goal || '',
          conflict: s.conflict || '',
          turn: s.turn || '',
          hook: s.hook || '',
          elastic: s.elastic !== false,
        });
        this.log('warn', `ตอน ${s.id} ใช้เนื้อหาที่กู้มา ${chars.toLocaleString()} หน่วย`);
        continue;
      }

      if (ex.status !== 'ok') {
        /**
         * เนื้อหาที่ได้มาจริงต้องไม่ถูกทิ้ง ไม่ว่าจะได้มาไม่ครบด้วยเหตุใด
         * ของที่ถูกตัดกลางคันเก็บไว้ใน partial ส่วนของที่เขียนครบแต่สั้นอยู่ใน body
         * เดิมอ่านแต่ partial ตอนที่เขียนสั้นจึงกลายเป็นตอนว่างทั้งที่มีเนื้อหาอยู่
         *
         * ส่วน refused จริง ๆ (ตอบสั้นโดยไม่มีเครื่องหมายกำกับ) ยังต้องทิ้งเหมือนเดิม
         * เพราะข้อความแบบนั้นคือคำปฏิเสธของโมเดล ไม่ใช่เนื้อหาหนังสือ
         */
        const kept = ex.partial || (ex.status === 'short' ? ex.body : '') || '';
        await db.saveSection(this.book.id, {
          id: s.id,
          title: s.title,
          chapter: chapter.n,
          md: kept,
          chars: countUnits(kept, this.book.language),
          status: ex.status === 'short' ? 'short' : 'blocked',
          reason: ex.status,
          quota: s.quota,
          minChars: s.minChars,
          maxChars: s.maxChars,
          takeaways: s.takeaways || [],
          beats: s.beats || [],
          povCharacter: s.pov_character || '',
          location: s.location || '',
          time: s.time || '',
          sceneGoal: s.scene_goal || '',
          conflict: s.conflict || '',
          turn: s.turn || '',
          hook: s.hook || '',
          elastic: s.elastic !== false,
        });
        if (ex.status === 'short')
          this.log(
            'warn',
            `ตอน ${s.id} เขียนสั้นกว่าที่กำหนด — ได้ ${countUnits(kept, this.book.language).toLocaleString()} หน่วย ` +
              `เก็บไว้แล้ว ขั้นปรับจำนวนหน้าจะตามแก้ให้ ถ้าเห็นแบบนี้ทุกตอนแปลว่าโมเดลกำลังเขียนสั้นเกินไปทั้งเล่ม`,
          );
        else this.log('error', `ตอน ${s.id} ไม่ผ่าน (${ex.status}) ข้ามไปก่อน รวบมาให้ดูตอนจบ`);
        continue;
      }

      const chars = countUnits(ex.body, this.book.language);
      await db.saveSection(this.book.id, {
        id: s.id,
        title: s.title,
        chapter: chapter.n,
        md: ex.body,
        chars,
        status: 'generated',
        quota: s.quota,
        minChars: s.minChars,
        maxChars: s.maxChars,
        takeaways: s.takeaways || [],
        beats: s.beats || [],
        povCharacter: s.pov_character || '',
        location: s.location || '',
        time: s.time || '',
        sceneGoal: s.scene_goal || '',
        conflict: s.conflict || '',
        turn: s.turn || '',
        hook: s.hook || '',
        elastic: s.elastic !== false,
        locked: false,
      });
      const off = Math.round(((chars - s.quota) / s.quota) * 100);
      this.log('ok', `ตอน ${s.id} ${chars.toLocaleString()} หน่วย (${off >= 0 ? '+' : ''}${off}%)`);
    }

    // เดิมผูก summary ของทั้ง batch ไว้กับ sections[0].id เพียงตัวเดียว
    // พอ batch มีมากกว่า 3 ตอน (เกิน lookback window ของ prevSummaries) ตอนอื่นในชุดเดียวกันจะไม่มี summary ให้อ้างอิงเลย
    // absorb() ปลอดภัยที่จะเรียกซ้ำด้วย meta เดิม เพราะทุกฟิลด์อื่นกันซ้ำอยู่แล้ว (addUnique/filter) มีแค่ sectionSummaries ที่ต้องการให้ผูกแยกตามตอนจริง ๆ
    if (meta) for (const s of sections) B.absorb(bible, s.id, meta);
  }

  // 5) ตรวจความสอดคล้องรายบท
  async consistency() {
    const chapters = this.book.outline.chapters;
    for (let i = this.job.cursor; i < chapters.length; i++) {
      this.job.cursor = i;
      const ch = chapters[i];
      const recs = [];
      for (const s of ch.sections) recs.push((await db.loadSection(this.book.id, s.id)) || s);

      const res = await this.turnWithRetry(P.consistencyPrompt(ch, recs, this.book.bible, this.book), {
        label: `ตรวจบทที่ ${ch.n}`,
      });
      const r = X.parseJson(res.text);
      if (r) {
        B.setChapterSummary(this.book.bible, ch.n, r.chapter_summary || '');
        const issues =
          (r.duplicates?.length || 0) +
          (r.term_conflicts?.length || 0) +
          (r.continuity_issues?.length || 0) +
          (r.unpaid_promises?.length || 0);
        this.log(issues ? 'warn' : 'ok', `บทที่ ${ch.n}: พบ ${issues} ประเด็นที่ควรดู`);
        this.book.review ||= {};
        this.book.review[ch.n] = r;
      }
      await this.save();
    }
    this.job.cursor = 0;
    this.job.round = 0;
    this.job.step = 'fit';
  }

  // 6) ลูปนับหน้า — หัวใจของระบบ
  async fit() {
    if (this.book.contentMode === 'items') return this.fitItems();
    const target = targetPhysicalPages(this.book, this.book.outline);
    const tol = this.book.pageTolerance ?? 2;
    /**
     * จำนวนหน้าเป็น "เป้าหมายคร่าว ๆ" หรือ "ต้องเป๊ะ"
     *
     * โหมดยืดหยุ่น (ค่าเริ่มต้น) ยอมรับความยาวที่เนื้อหาออกมาเป็นจริง
     * เพราะการไล่ให้เข้าเป้าเป๊ะมีราคาสองต่อที่ผู้ใช้จ่ายโดยไม่ได้อะไรกลับมา:
     * ต่อแรกคือคุณภาพ — สั่งย่อตอนที่เขียนดีอยู่แล้วให้สั้นลงเพื่อตัดหน้าออก คือการตัดเนื้อทิ้ง
     * ส่วนการยืดตอนให้ยาวขึ้นก็ได้แต่น้ำ ไม่ได้เนื้อ
     * ต่อสองคือเวลา — แก้ทีละตอนคือหนึ่งข้อความต่อตอน สูงสุด 12 ตอน × 4 รอบ = 48 ข้อความ
     * ที่ไม่ได้เขียนเนื้อหาใหม่เลย และหลายเล่มจ่ายครบแล้วยังไม่เข้าเป้าอยู่ดี
     *
     * โหมดเป๊ะยังมีไว้ให้งานที่จำนวนหน้าเป็นข้อกำหนดจริง เช่น ส่งโรงพิมพ์ตามยกที่จองไว้
     */
    const soft = (this.book.pageMode || 'soft') !== 'strict';

    for (let round = this.job.round; round < MAX_FIT_ROUNDS; round++) {
      this.job.round = round;
      const sections = await db.loadSections(this.book.id);
      const { pages, ms } = await this.measure(sections);
      const err = pages - target;
      this.log(
        Math.abs(err) <= tol ? 'ok' : 'warn',
        `รอบที่ ${round + 1}: ได้ ${pages} หน้า เป้า ${target} (${err >= 0 ? '+' : ''}${err}) คอมไพล์ ${ms} มิลลิวินาที`,
      );
      if (Math.abs(err) <= tol) return this.finishFit(pages);

      // ยาวกว่าเป้าในโหมดยืดหยุ่น = เนื้อหาดีกว่าที่วางแผนไว้ ไม่ใช่ความผิดพลาดที่ต้องแก้
      // ตรวจก่อนด่านหยุด "ยาวเกินเท่าตัว" เพราะโหมดนี้ตั้งใจไม่ให้จำนวนหน้ามาหยุดงานที่เขียนเสร็จแล้ว
      if (soft && err > 0) {
        this.log(
          pages > target * 2 ? 'warn' : 'ok',
          `เนื้อหาที่เขียนออกมาจริงได้ ${pages} หน้า จากเป้า ${target} หน้า (+${err}) — ` +
            `โหมดจำนวนหน้าแบบยืดหยุ่นรับความยาวนี้ตามจริง ไม่ย่อเนื้อหาที่เขียนดีแล้วเพื่อให้ตัวเลขตรงเป้า` +
            (pages > target * 2
              ? ' · ยาวกว่าเป้าเกินเท่าตัว ถ้าไม่ได้ตั้งใจให้เล่มหนาขนาดนี้ ให้ลดจำนวนตอนในสารบัญแล้วเขียนใหม่'
              : ' และประหยัดขั้นแก้ทีละตอนไปได้ทั้งหมด'),
        );
        return this.finishFit(pages);
      }

      /**
       * เล่มยาวเกินเป้าหลายเท่า = ย่อไม่ไหวจริง ต้องให้คนตัดสินใจ
       *
       * แต่เล่ม "สั้นกว่าเป้าหลายเท่า" เป็นคนละเรื่องกันโดยสิ้นเชิง
       * ของเดิมหยุดทั้งสองทางด้วยเงื่อนไขเดียวกัน ผลคือเล่มที่เขียนได้ 27 หน้าจากเป้า 120
       * ถูกโยนทิ้งกลางทางแล้วจบเป็น "อยู่ดี ๆ ก็เสร็จ" ทั้งที่ยังเขียนต่อได้
       * ความสมบูรณ์ของเล่มสำคัญกว่าการเข้าเป้าเป๊ะ — สั้นไปให้เขียนเพิ่ม ไม่ใช่ให้เลิก
       */
      if (pages > target * 2) {
        throw new Halt(
          `จำนวนหน้าจริง ${pages} หน้า ยาวกว่าเป้า ${target} หน้าเกินเท่าตัว — ` +
            `ระบบหยุดก่อนย่อเนื้อหา เพราะการย่อหลายเท่าจะทำให้เนื้อหาเสีย ` +
            `ให้ปรับจำนวนหน้าเป้าหมายขึ้น หรือตัดบทออกเอง`,
        );
      }

      /**
       * สั้นกว่าเป้ามาก = โครงสารบัญเล็กเกินกว่าจะรองรับจำนวนหน้าที่ตั้งไว้
       *
       * การสั่งยืดตอนเดิมให้ยาวสี่เท่าได้แต่น้ำ ไม่ได้เนื้อ ทางที่ถูกคือเติม "ตอนใหม่"
       * เข้าไปในสารบัญแล้วเขียนตอนนั้นจริง ๆ ทำได้รอบเดียวต่อหนึ่งเล่ม
       * ถ้ายังไม่พออีกก็เดินต่อด้วยเล่มที่สั้นกว่าเป้า ดีกว่าไม่ได้เล่ม
       */
      if (pages * 2 < target && !this.job.expandedOutline) {
        this.job.expandedOutline = true;
        const added = await this.expandOutlineForPages(pages, target);
        if (added > 0) {
          this.log('ok', `เล่มสั้นกว่าเป้ามาก — เติม ${added} ตอนใหม่เข้าสารบัญแล้วเขียนเพิ่ม`);
          await this.save();
          continue;
        }
        this.log('warn', 'เล่มสั้นกว่าเป้ามาก แต่เติมตอนใหม่ไม่สำเร็จ — จะยืดตอนที่มีอยู่เท่าที่ทำได้แทน');
      }

      /**
       * สั้นกว่าเป้าในโหมดยืดหยุ่น: เติมด้วย "ตอนใหม่" ได้ (ทำไปแล้วข้างบน) และปรับเลย์เอาต์ได้
       * แต่ไม่สั่งยืดตอนเดิมให้ยาวขึ้น เพราะการยืดข้อความที่จบความคิดไปแล้วได้แต่คำฟุ่มเฟือย
       */
      if (soft) {
        const solved = await this.solveLineHeight(target, sections);
        if (solved.improved) {
          this.log('ok', `ปรับระยะบรรทัดเป็น ${this.book.typography.lineHeight} ได้ ${solved.pages} หน้า โดยไม่แตะเนื้อหา`);
          await this.save();
          if (Math.abs(solved.pages - target) <= tol) return this.finishFit(solved.pages);
        }
        const got = solved.improved ? solved.pages : pages;
        this.log(
          'warn',
          `เล่มออกมา ${got} หน้า จากเป้า ${target} หน้า — โหมดยืดหยุ่นไม่สั่งยืดตอนเดิมให้ยาวขึ้น ` +
            `เพราะจะได้คำฟุ่มเฟือยแทนเนื้อหา ถ้าต้องการเล่มหนากว่านี้จริง ให้เพิ่มจำนวนหน้าเป้าหมายแล้วสั่งเขียนตอนใหม่`,
        );
        return this.finishFit(got);
      }

      // การคอมไพล์เล่มจริงคือข้อมูล calibration ที่ดีที่สุดที่เรามี
      // ถ้าพลาดเกิน 3% แปลว่าความเข้าใจเรื่องอักษรต่อหน้าผิด ไม่ใช่เนื้อหาผิด
      if (Math.abs(err) / target > 0.03) {
        const observed = observedCharsPerPage(this.book, this.book.outline, sections, pages);
        const old = this.book.calibration.charsPerPage;
        if (observed > 0 && Math.abs(observed - old) / old > 0.05) {
          this.book.calibration.charsPerPage = observed;
          rebaseQuotas(this.book, this.book.outline, sections);
          for (const s of sections) await db.saveSection(this.book.id, s);
          this.log('ok', `ปรับความเข้าใจอักษรต่อหน้า ${old} → ${observed} แล้วตั้งโควตาใหม่ทุกตอน`);
        }
      }

      const cpp = this.book.calibration.charsPerPage;
      let { plan, reason, shortfall } = planAdjustment(sections, err, cpp);

      // ทุกตอนชนกรอบแล้ว — ลองแก้ด้วยเลย์เอาต์ก่อน เพราะไม่เสียเทิร์นและไม่แตะเนื้อหา
      if (!plan.length) {
        const solved = await this.solveLineHeight(target, sections);
        if (solved.improved) {
          this.log(
            'ok',
            `ปรับระยะบรรทัดเป็น ${this.book.typography.lineHeight} ได้ ${solved.pages} หน้า โดยไม่แตะเนื้อหา`,
          );
          await this.save();
          if (Math.abs(solved.pages - target) <= tol) return this.finishFit(solved.pages);
          ({ plan, reason, shortfall } = planAdjustment(sections, solved.pages - target, cpp));
        }
      }

      // ยังไม่พอ — ยอมขยายกรอบยืดหยุ่นครั้งเดียว
      if (!plan.length && !this.job.widened) {
        this.job.widened = true;
        widenBands(sections, 0.4);
        for (const s of sections) await db.saveSection(this.book.id, s);
        this.log('warn', 'ทุกตอนชนกรอบ ±25% แล้ว ขยายเป็น ±40% หนึ่งครั้งเพื่อให้เข้าเป้า');
        ({ plan, reason, shortfall } = planAdjustment(sections, err, cpp));
      }

      if (!plan.length) {
        /**
         * ปรับต่อไม่ได้ ไม่ใช่เหตุผลที่จะทิ้งเล่มที่เขียนเสร็จแล้ว
         *
         * ของเดิมโยน Halt ตรงนี้ งานทั้งหมดจึงค้างอยู่ที่หน้า "หยุดกลางคัน"
         * ทั้งที่เนื้อหาครบทุกตอนแล้ว ขาดแค่จำนวนหน้าไม่ตรงเป๊ะซึ่งเป็นเรื่องรอง
         * ส่งต่อไปขั้นตรวจงานพร้อมบอกส่วนต่างตรง ๆ ให้ผู้ใช้ตัดสินใจเองว่าจะแก้หรือปล่อย
         */
        const off = Math.round((err / target) * 100);
        this.log(
          'warn',
          `ปรับจำนวนหน้าต่อไม่ได้แล้ว (${reason || 'ทุกตอนชนกรอบความยาว'}) — ได้ ${pages} หน้า จากเป้า ${target} หน้า (${err >= 0 ? '+' : ''}${err} หน้า · ${off >= 0 ? '+' : ''}${off}%) เนื้อหาครบทุกตอนแล้ว จึงส่งต่อไปขั้นตรวจงาน`,
        );
        return this.finishFit(pages);
      }

      // แก้ทีละไม่กี่ตอน แล้ววัดใหม่ ดีกว่าสั่งแก้ยี่สิบตอนรวดเดียว
      // เพราะทุกตอนที่แตะคือหนึ่งข้อความ และเสียงรบกวนจากโมเดลจะสะสม
      const capped = plan.slice(0, MAX_REWRITES_PER_ROUND);
      const total = capped.reduce((n, p) => n + Math.abs(p.delta), 0);
      this.log(
        'ok',
        `ต้องแก้ ${capped.length} ตอน รวม ${total.toLocaleString()} หน่วย${plan.length > capped.length ? ` (พักไว้อีก ${plan.length - capped.length} ตอนสำหรับรอบถัดไป)` : ''}${shortfall > 0 ? ` · ยังขาดอีก ${shortfall.toLocaleString()}` : ''}`,
      );
      for (const item of capped) {
        const rec = await db.loadSection(this.book.id, item.id);
        if (!rec?.md) continue;
        await this.rewrite(rec, item.target);
        await this.save();
      }
    }

    const sections = await db.loadSections(this.book.id);
    const { pages } = await this.measure(sections);
    this.log('warn', `ครบ ${MAX_FIT_ROUNDS} รอบแล้วได้ ${pages} หน้า — ส่งให้คนดูในโหมดแก้ไข`);
    return this.finishFit(pages);
  }

  /**
   * เติมตอนใหม่เข้าสารบัญเมื่อโครงเดิมเล็กเกินกว่าจะรองรับจำนวนหน้าเป้าหมาย
   *
   * ขอเฉพาะ "ตอนที่ยังขาด" จากโมเดล ไม่ใช่สั่งเขียนสารบัญใหม่ทั้งชุด
   * เพราะสารบัญเดิมผ่านการเลือกของผู้ใช้มาแล้ว และการเขียนใหม่ทั้งชุดกินหนึ่งข้อความเต็ม ๆ
   * แล้วมักได้โครงที่ขัดกับเนื้อหาที่เขียนไปแล้ว
   */
  async expandOutlineForPages(pages, target) {
    const outline = this.book.outline;
    const chapters = outline?.chapters || [];
    if (!chapters.length) return 0;

    const cpp = this.book.calibration?.charsPerPage || 750;
    const needChars = Math.max(0, (target - pages) * cpp);
    // ขนาดตอนที่ "เล่มนี้เขียนได้จริง" คือค่าเฉลี่ยของตอนที่เขียนไปแล้ว ไม่ใช่โควตาที่ตั้งไว้
    // เพราะโควตาคือสิ่งที่เราหวัง ส่วนค่าเฉลี่ยจริงคือสิ่งที่โมเดลทำได้จริง
    const written = await db.loadSections(this.book.id);
    const avgWritten = written.length
      ? written.reduce((n, x) => n + (x.chars || 0), 0) / written.length
      : 0;
    const perSection = Math.max(1200, Math.round(avgWritten || cpp * 2));
    const cap = P.maxSectionsFor(this.book);
    const current = chapters.reduce((n, c) => n + (c.sections || []).length, 0);
    const want = Math.min(Math.ceil(needChars / perSection), Math.max(0, cap - current), 24);
    if (want < 1) return 0;

    this.log('ok', `ขอสารบัญเพิ่ม ${want} ตอน เพื่อเติมส่วนที่ยังขาดราว ${needChars.toLocaleString()} หน่วย`);
    let parsed = null;
    try {
      const res = await this.turnWithRetry(P.outlineExpandPrompt(this.book, want, needChars), {
        label: `ขอสารบัญเพิ่ม ${want} ตอน`,
      });
      parsed = X.parseJson(res.text);
    } catch (e) {
      if (e instanceof RateLimited || e instanceof Halt) throw e;
      this.log('warn', `ขอสารบัญเพิ่มไม่สำเร็จ (${e?.message || e})`);
      return 0;
    }

    const list = (parsed?.sections || []).filter((s) => s?.title && s?.chapter);
    if (!list.length) return 0;

    let added = 0;
    for (const item of list) {
      const ch = chapters.find((c) => String(c.n) === String(item.chapter)) || chapters[chapters.length - 1];
      if (!ch) continue;
      ch.sections = ch.sections || [];
      const nextIndex = ch.sections.length + 1;
      const id = `${ch.n}.${nextIndex}`;
      if (ch.sections.some((x) => String(x.id) === id)) continue;
      ch.sections.push({
        id,
        title: String(item.title),
        beats: Array.isArray(item.beats) && item.beats.length ? item.beats : ['อธิบายแนวคิด', 'ยกตัวอย่างจริง', 'สรุปสิ่งที่นำไปทำต่อ'],
        takeaways: Array.isArray(item.takeaways) && item.takeaways.length ? item.takeaways : [String(item.title)],
        promises: [],
      });
      added++;
    }
    if (!added) return 0;

    // โควตาต้องถูกคำนวณใหม่ทั้งเล่ม เพราะงบเดิมถูกแบ่งให้ตอนเก่าไปหมดแล้ว
    const q = assignQuotas(this.book, outline);
    for (const w of q.warnings) this.log('warn', w);
    const existing = await db.loadSections(this.book.id);
    const haveIds = new Set(existing.map((s) => s.id));
    rebaseQuotas(this.book, outline, existing);
    for (const s of existing) await db.saveSection(this.book.id, s);

    // เขียนเฉพาะตอนใหม่ ตอนเดิมไม่ถูกแตะ
    const fresh = [];
    for (const c of outline.chapters) {
      for (const sec of c.sections || []) {
        if (!haveIds.has(sec.id)) fresh.push({ chapter: c, section: sec });
      }
    }
    for (const item of fresh) {
      if (this.stopRequested) throw new Halt('หยุดโดยผู้ใช้');
      await this.writeBatch({ chapter: item.chapter, sections: [item.section], isChapterStart: false });
      await this.save();
    }
    return added;
  }

  /**
   * รูปผู้เขียนที่เตรียมไว้แนบ — เตรียมครั้งเดียวแล้วใช้ซ้ำทั้งเล่ม
   *
   * ย่อรูปหนึ่งใบใช้เวลาไม่มาก แต่เล่มหนึ่งมีภาพได้หลายสิบรูป
   * การย่อรูปเดิมซ้ำทุกครั้งคือการทำงานเดิมทิ้งหลายสิบรอบโดยไม่ได้อะไรต่างกันเลย
   */
  async authorRef() {
    if (this._authorRef !== undefined) return this._authorRef;
    this._authorRef = null;
    try {
      const asset = await db.loadAsset(this.book.id, 'author-photo.png');
      if (!asset?.blob) {
        this.log('warn', 'เลือกให้แนบรูปผู้เขียนไปกับภาพ แต่ยังไม่มีไฟล์ author-photo.png — จะสร้างภาพโดยไม่มีรูปอ้างอิง');
        return this._authorRef;
      }
      const ready = await prepareRefImage(asset.blob);
      this._authorRef = { name: 'author-photo.jpg', dataUrl: ready.dataUrl, bytes: ready.bytes, width: ready.width, height: ready.height };
      this.log('ok', `เตรียมรูปผู้เขียนสำหรับแนบแล้ว (${ready.width}×${ready.height}px · ${Math.round(ready.bytes / 1024)} KB)`);
    } catch (e) {
      this.log('warn', `เตรียมรูปผู้เขียนไม่สำเร็จ (${e?.message || e}) — จะสร้างภาพโดยไม่มีรูปอ้างอิง`);
    }
    return this._authorRef;
  }

  async measure(sections) {
    const assets = await db.loadAssets(this.book.id);
    const { pages, ms } = await compileBook({
      book: this.book,
      outline: this.book.outline,
      sections,
      assets,
    });
    this.book.lastCompile = { pages: pages.physical, ms, at: Date.now() };
    return { pages: pages.physical, ms };
  }

  async finishFit(physical) {
    // โรงพิมพ์ต้องการจำนวนหน้าเป็นเลขคู่เสมอ เติมหน้าว่างท้ายเล่มถ้าจำเป็น
    // งานสั้นกว่า 24 หน้าเป็นไฟล์ดิจิทัล/เอกสารแจก ไม่บังคับเพิ่มหน้าให้เกินเป้าหมาย
    this.book.padPages = this.book.targetPages >= 24 && physical % 2 === 1 ? 1 : 0;
    this.book.finalPages = physical + this.book.padPages;
    if (this.book.padPages) this.log('ok', 'เติมหน้าว่างท้ายเล่มหนึ่งหน้าให้จำนวนหน้าเป็นเลขคู่');
    this.job.step = 'gate_edit';
  }

  /**
   * แก้ด้วยเลย์เอาต์แบบ "ค้นหาค่า" ไม่ใช่ "ขยับแล้วหวัง"
   *
   * บทเรียนจากการทดสอบ: จำนวนบรรทัดต่อหน้าเป็นจำนวนเต็ม จำนวนหน้าจึงกระโดดเป็นขั้น
   * การขยับระยะบรรทัดทีละนิดแล้วเชื่อว่าได้ผลตามสัดส่วน ทำให้เลยเป้าไปไกล
   * เมื่อคอมไพล์เร็วระดับต่ำกว่าวินาที การไล่หาค่าที่ดีที่สุดสัก 5 ครั้งจึงคุ้มกว่ามาก
   */
  async solveLineHeight(target, sections) {
    const t = this.book.typography;
    const base = (this.book.baseLineHeight ??= t.lineHeight);
    const original = t.lineHeight;
    let lo = base * (1 - NUDGE_LIMIT);
    let hi = base * (1 + NUDGE_LIMIT);

    let best = { lh: original, pages: this.book.lastCompile?.pages ?? Infinity };
    const evalAt = async (lh) => {
      t.lineHeight = Math.round(lh * 1000) / 1000;
      const { pages } = await this.measure(sections);
      if (Math.abs(pages - target) < Math.abs(best.pages - target)) best = { lh: t.lineHeight, pages };
      return pages;
    };

    // ระยะบรรทัดมาก = หน้ามาก จึงเป็นฟังก์ชันไม่ลด ใช้การแบ่งครึ่งได้
    const pLo = await evalAt(lo);
    const pHi = await evalAt(hi);
    if (target > pHi || target < pLo) {
      t.lineHeight = best.lh;
      const improved = Math.abs(best.pages - target) < Math.abs(this.book.lastCompile.pages - target);
      await this.measure(sections);
      return { improved, pages: best.pages };
    }

    for (let i = 0; i < 4 && Math.abs(best.pages - target) > 0; i++) {
      const mid = (lo + hi) / 2;
      const p = await evalAt(mid);
      if (p < target) lo = mid;
      else hi = mid;
    }

    t.lineHeight = best.lh;
    await this.measure(sections);
    return { improved: best.pages !== original, pages: best.pages };
  }

  async rewrite(rec, targetChars, instruction = '') {
    const res = await this.turnWithRetry(
      P.rewritePrompt({
        book: this.book,
        section: rec,
        currentText: rec.md,
        targetChars,
        instruction,
      }),
      { label: `แก้ตอน ${rec.id} → ${targetChars.toLocaleString()}` },
    );
    const ex = X.extractSection(res.text, rec.id);
    if (ex.status !== 'ok') {
      this.log('warn', `แก้ตอน ${rec.id} ไม่สำเร็จ (${ex.status}) เก็บของเดิมไว้`);
      return false;
    }
    const chars = countUnits(ex.body, this.book.language);
    await db.saveSection(this.book.id, {
      ...rec,
      md: ex.body,
      chars,
      status: 'edited',
      history: [...(rec.history || []).slice(-19), { md: rec.md, chars: rec.chars, at: Date.now(), reason: 'ก่อน AI ปรับความยาว' }],
    });
    B.absorb(this.book.bible, rec.id, ex.meta);
    this.log('ok', `ตอน ${rec.id}: ${rec.chars.toLocaleString()} → ${chars.toLocaleString()} หน่วย`);
    return true;
  }

  async ensureCoverArtDirection({ force = false, invalidateLegacy = false } = {}) {
    const mode = this.book.coverMode || 'prompt';
    if (mode === 'none' || mode === 'upload') return false;

    const modern = isModernCoverDesign(this.book);
    if (!force && modern) return true;

    this.log('ok', modern ? 'ให้ GPT Art Director คิดปกใหม่ทั้งชุด' : 'ปกนี้เป็นรูปแบบเก่า — ส่งข้อมูลทั้งเล่มให้ GPT Art Director ออกแบบใหม่ก่อนสร้างภาพ');

    // ขั้นที่ 1: ย่อเนื้อในจริงก่อน เพื่อให้สีและอารมณ์ของปกมาจากเล่มนี้ ไม่ใช่ค่าเริ่มต้นของหมวดหนังสือ
    const digest = await this.coverDigest();

    // ขั้นที่ 2: ออกแบบ 3 ทางจากบรีฟนั้น
    // อยู่เธรดเดียวกับขั้นย่อเนื้อหา เพราะทั้งสามขั้นเป็นงานชิ้นเดียวกัน
    // และการเปิดเธรดใหม่ซ้ำในงานเดียวคือการทิ้งบริบทที่เพิ่งสร้างมาเปล่า ๆ
    const res = await this.turnWithRetry(P.styleTokenPrompt(this.book, this.book.outline, digest), {
      label: 'ปรึกษา GPT Art Director เรื่องปก',
      newThread: digest ? false : this.wantNewThread(true),
    });
    const consult = X.parseJson(res.text);
    const directions = Array.isArray(consult?.directions) ? consult.directions : [];
    const usable = directions.filter((d) => d?.palette?.length === 3 && d?.typography);

    if (!usable.length) {
      this.log('warn', 'GPT Art Director ตอบโครงสร้างปกไม่ครบ — ยังไม่ใช้ Prompt ปกเก่าต่อ เพื่อป้องกันได้ปกโล่ง/เชยแบบเดิม');
      return false;
    }

    // คำโปรยต้องมีก่อนสร้าง Prompt ปกหลัง ไม่งั้น Prompt จะสั่งให้เว้นกลางปกโล่งไว้รอข้อความ
    // ที่ไม่มีวันถูกเขียน แล้วได้ปกหลังเป็นหน้ากระดาษเปล่าที่มีขีดอยู่มุมเดียว
    await this.ensureBackCoverCopy();

    // ขั้นที่ 3: ให้กรรมการตรวจและเลือก แทนที่จะเชื่อคำแนะนำของคนออกแบบเอง
    const jury = await this.coverJury(digest, usable);
    const winnerId = jury?.winner_id || consult?.recommended_id;
    const picked =
      usable.find((d) => d?.id === winnerId) ||
      usable.find((d) => d?.id === consult?.recommended_id) ||
      usable[0];
    const recommended = applyCoverRevision(picked, jury?.revision);

    if (invalidateLegacy && mode === 'auto') {
      await db.deleteAsset(this.book.id, 'cover-front.png').catch(() => {});
      await db.deleteAsset(this.book.id, 'cover-back.png').catch(() => {});
    }

    // ทางที่ชนะถูกแก้ตามคำสั่งกรรมการแล้ว ต้องเก็บฉบับที่แก้แล้วกลับเข้ารายการด้วย
    // ไม่งั้นการ์ดเลือกแนวในหน้า Phase 2 จะโชว์ชุดสีเดิมที่กรรมการเพิ่งสั่งทิ้ง
    const merged = usable.map((d) => (d === picked ? recommended : d));

    this.book.coverDigest = digest;
    this.book.coverConsultation = {
      editorial_read: consult.editorial_read || null,
      directions: merged,
      recommended_id: recommended.id || consult.recommended_id || null,
      art_director_pick: consult.recommended_id || null,
      why_recommended: jury?.why_winner || consult.why_recommended || '',
      jury: jury
        ? {
            scores: Array.isArray(jury.scores) ? jury.scores : [],
            winner_id: jury.winner_id || null,
            why_winner: jury.why_winner || '',
            revision_notes: jury.revision_notes || '',
            judgedAt: Date.now(),
          }
        : null,
      consultedAt: Date.now(),
    };
    this.book.style = recommended;
    this.book.coverLayout = recommended.typography;
    this.book.coverPrompts = {
      front: P.frontCoverPrompt(recommended, this.book, this.book.outline),
      back: P.backCoverPrompt(recommended, this.book),
    };
    this.book.coverDesignVersion = 6;
    await this.save();
    try { await W.syncProject(this.book.id); } catch {}
    const scored = jury?.scores?.find((s) => s?.id === recommended.id);
    this.log(
      'ok',
      `GPT เสนอปก ${usable.length} ทาง · กรรมการตรวจแล้วเลือก “${recommended.name || recommended.id || 'แนวที่เลือก'}”` +
        (scored?.total != null ? ` (คะแนนรวม ${scored.total})` : '') +
        (jury?.revision_notes ? ` · แก้เพิ่ม: ${jury.revision_notes}` : ''),
    );
    return true;
  }

  /**
   * คำโปรยปกหลัง — ต้องได้ "คำ" ก่อนเสมอ แล้วค่อยเอาไปวาดหรือเรียงพิมพ์
   *
   * ให้โมเดลภาพแต่งคำขายเองไม่ได้ ทั้งเขียนภาษาไทยผิดและคิดคำไม่เป็น
   * จึงใช้เทิร์นข้อความสั้น ๆ ครั้งเดียวเขียนจากสารบัญจริง แล้วส่งไปแบบตรงตัวอักษร
   *
   * เดิมขั้นนี้ทำเฉพาะโหมด 'auto' ทั้งที่โหมดเริ่มต้นของโปรแกรมคือ 'prompt'
   * เล่มส่วนใหญ่จึงไม่เคยมีคำโปรยเลย — Prompt ปกหลังสั่งให้ "เว้นกลางปกให้โล่ง
   * รอระบบพิมพ์ข้อความทับ" แต่ไม่มีข้อความให้พิมพ์ ผลคือปกหลังเป็นหน้ากระดาษเปล่า
   * นี่เป็นงานข้อความล้วน ไม่กินเทิร์นภาพ จึงต้องทำทุกโหมดที่มีปกหลัง
   */
  async ensureBackCoverCopy() {
    const mode = this.book.coverMode || 'prompt';
    if (mode === 'none' || mode === 'upload') return false;

    /**
     * ซ่อมธงที่ปักผิดไว้จากรุ่นก่อน
     *
     * เล่มเก่าถูกปักว่า "ปกหลังมีข้อความวาดมาในภาพแล้ว" ทั้งที่ prompt สั่งห้ามมีตัวอักษร
     * เครื่องเรียงพิมพ์จึงไม่พิมพ์คำโปรยทับให้ และปกหลังออกมาเปล่าตลอดไป
     * ถ้าไม่ล้างธงนี้ เล่มเดิมจะไม่มีวันหายเอง แม้จะแก้โค้ดแล้วก็ตาม
     */
    if (this.book.backCoverTextBaked && !P.backCoverTextBaked(this.book)) {
      this.book.backCoverTextBaked = false;
      await this.save();
      this.log('ok', 'ปลดธงปกหลังที่ปักผิดไว้ — ระบบจะพิมพ์คำโปรยทับปกหลังให้ตามเดิม');
    }

    if (this.book.backCoverCopy?.hook) return true;

    this.log('ok', 'เขียนคำโปรยปกหลังก่อน แล้วค่อยเอาไปวาด/เรียงพิมพ์');
    try {
      const res = await this.turnWithRetry(P.backCoverCopyPrompt(this.book, this.book.outline || {}), {
        label: 'เขียนคำโปรยปกหลัง',
      });
      const copy = X.parseJson(res.text);
      if (!copy?.hook) {
        this.log('warn', 'อ่านคำโปรยปกหลังไม่ได้ — ปกหลังจะเป็น artwork เปล่าไปก่อน');
        return false;
      }
      this.book.backCoverCopy = {
        hook: String(copy.hook || ''),
        body: String(copy.body || ''),
        bullets: (Array.isArray(copy.bullets) ? copy.bullets : []).slice(0, 3).map(String),
        closing: String(copy.closing || ''),
        writtenAt: Date.now(),
      };
      /**
       * คำโปรยต้องถูกส่งต่อให้เครื่องเรียงพิมพ์ด้วย ไม่ใช่เก็บไว้เฉย ๆ
       *
       * โหมดที่ระบบเรียงพิมพ์เองอ่านค่าจาก book.blurb ซึ่งไม่เคยมีใครเขียนลงไปเลยสักที่
       * ปกหลังจึงออกมาเป็นภาพเปล่าไม่มีคำชวนอ่านสักคำ ทั้งที่เขียนไว้แล้ว
       */
      const c = this.book.backCoverCopy;
      this.book.blurb = [c.hook, c.body, (c.bullets || []).map((b) => `• ${b}`).join('\n'), c.closing]
        .filter((x) => x && String(x).trim())
        .join('\n\n');
      await this.save();
      this.log('ok', `ได้คำโปรยปกหลังแล้ว — “${c.hook}”`);
      return true;
    } catch (e) {
      if (e instanceof RateLimited || e instanceof Halt) throw e;
      this.log('warn', `เขียนคำโปรยปกหลังไม่สำเร็จ (${e?.message || e}) — ปกหลังจะเป็น artwork เปล่าไปก่อน`);
      return false;
    }
  }

  /**
   * ย่อเนื้อในจริงของเล่มให้เป็นบรีฟออกแบบปก
   *
   * ล้มแล้วไม่ถือว่าพัง เพราะขั้นออกแบบยังเดินต่อได้ด้วยข้อมูลเดิม
   * แค่จะได้ปกที่อิงชื่อบทอย่างเดียวเหมือนของเก่า
   */
  async coverDigest() {
    const res = await this.turnWithRetry(P.coverDigestPrompt(this.book, this.book.outline), {
      label: 'ย่อเนื้อหาทั้งเล่มเป็นบรีฟออกแบบปก',
      newThread: this.wantNewThread(true),
    });
    const digest = X.parseJson(res.text);
    if (!digest?.one_line) {
      this.log('warn', 'ย่อเนื้อหาสำหรับปกไม่สำเร็จ — ออกแบบต่อจากสารบัญและสรุปบทตามเดิม');
      return null;
    }
    const e = digest.energy || {};
    this.log('ok', `บรีฟเนื้อหาสำหรับปก: ${digest.one_line} · อารมณ์ ${e.label || '-'} ระดับ ${e.level ?? '-'}/5`);
    return digest;
  }

  /** ตรวจสามทางที่เสนอมาแล้วเลือกด้วยเกณฑ์ ไม่ใช่เชื่อคำแนะนำของคนออกแบบเอง */
  async coverJury(digest, directions) {
    const res = await this.turnWithRetry(P.coverJuryPrompt(this.book, this.book.outline, digest, directions), {
      label: 'ตรวจและเลือกแนวปก',
    });
    const jury = X.parseJson(res.text);
    if (!jury?.winner_id && !Array.isArray(jury?.scores)) {
      this.log('warn', 'ขั้นตรวจปกตอบไม่ครบ — ใช้ทางที่ Art Director แนะนำไปก่อน');
      return null;
    }
    const line = (jury.scores || [])
      .map((s) => `${s.id}=${s.total ?? '-'}`)
      .join(' · ');
    this.log('ok', `ผลตรวจปก ${line || 'ไม่มีคะแนน'} → เลือก ${jury.winner_id || '-'}`);
    return jury;
  }

  // 7) ทิศทางภาพของปก
  async style() {
    // Phase 1 ทำเฉพาะงานข้อความ: สรุปทิศทางภาพและสร้าง prompt ให้ครบก่อนหยุด
    // ผู้ใช้จึงเปลี่ยนบัญชี ChatGPT ภายหลังได้โดยไม่เสียเนื้อหา/ตำแหน่งภาพที่วางไว้แล้ว
    if ((this.book.coverMode || 'prompt') === 'none') {
      this.log('ok', 'เล่มนี้ไม่ทำปก ข้ามการคิดทิศทางภาพ');
    } else if (this.book.coverMode === 'upload') {
      this.log('ok', 'ปกใช้ไฟล์ที่คุณจะอัปโหลดเอง ข้ามการคิดทิศทางภาพ');
    } else {
      const ok = await this.ensureCoverArtDirection({ force: true });
      if (!ok) {
        // เดิมทิ้งผลลัพธ์นี้ไป ถ้า GPT ตอบไม่ครบ/parse ไม่ได้ book.coverPrompts จะไม่ถูกตั้งค่า
        // แล้ว plannedImageJobs() ก็จะไม่เห็นงานปกเลยอย่างเงียบ ๆ เล่มที่ไม่มี figure จะถูกปิดเป็น done ทันทีโดยไม่มีปก
        this.book.imagePhase = {
          ...(this.book.imagePhase || {}),
          status: 'partial',
          failedReason: 'GPT Art Director ยังออกแบบปกไม่ครบ (ตอบไม่ครบ/parse ไม่ได้) จึงยังไม่มี Prompt ปกให้ Phase 2',
        };
        this.job.step = 'gate_images';
        this.job.status = 'waiting_human';
        await this.save();
        return;
      }
    }

    const jobs = plannedImageJobs(this.book);
    if (!jobs.length) {
      this.job.step = 'done';
      return;
    }

    this.book.imagePhase = {
      ...(this.book.imagePhase || {}),
      status: 'ready',
      preparedAt: Date.now(),
      total: jobs.length,
      remaining: jobs.map((j) => j.name),
    };
    this.job.imageThreadStarted = false;
    this.job.step = 'gate_images';
    this.log(
      'ok',
      `Phase 1 เสร็จแล้ว — บันทึกเนื้อหา, prompt และขนาดภาพครบ ${jobs.length} รูป · เปลี่ยนไปบัญชีที่สร้างภาพได้แล้วค่อยเริ่ม Phase 2`,
    );
  }

  /**
   * ให้ ChatGPT สร้างภาพจริงในแท็บเดียวกัน — ทำงานเฉพาะบัญชีที่สร้างภาพได้
   *
   * ขั้นนี้เป็นทางเลือก ไม่ใช่ทางหลัก เพราะคนส่วนใหญ่เขียนเนื้อหาด้วยบัญชีฟรี
   * ที่สร้างภาพไม่ได้ ถ้าสร้างไม่สำเร็จก็แค่ข้ามไป prompt ยังอยู่ครบให้เอาไปสร้างที่อื่น
   */
  async images() {
    // โปรเจกต์เก่าบางเล่มมี Prompt ปกก่อนระบบ GPT Art Director และยังคงเว้นพื้นที่โล่งแบบตายตัว
    // ห้ามใช้ Prompt เก่านั้นต่อใน Phase 2: ปรึกษา GPT ใหม่และล้างเฉพาะ asset ปกเก่า 1 ครั้ง
    if (this.book.coverMode === 'auto') {
      // ใช้เกณฑ์เดียวกับ ensureCoverArtDirection() เป๊ะ ๆ (isModernCoverDesign)
      // เดิมสองที่นี้เช็คฟิลด์ไม่ตรงกัน (ที่นี่ไม่เคยเช็ค coverPrompts.front/back) เสี่ยงหลุดไม่ตรงกันในอนาคต
      if (!isModernCoverDesign(this.book)) {
        const ok = await this.ensureCoverArtDirection({ force: true, invalidateLegacy: true });
        if (!ok) {
          this.book.imagePhase = {
            ...(this.book.imagePhase || {}),
            status: 'partial',
            failedReason: 'GPT Art Director ยังออกแบบปกใหม่ไม่ครบ จึงหยุดก่อนสร้างปกจาก Prompt รุ่นเก่า',
          };
          this.job.step = 'gate_images';
          this.job.status = 'waiting_human';
          await this.save();
          return;
        }
      }
    }

    // งานเก่าบางเล่มเปิดโหมดสร้างภาพอัตโนมัติ แต่เคยถูกบันทึก illustrationLevel=none
    // จึงไม่มี figures เลยและ Phase 2 เห็นเพียงปกหน้า/หลัง ให้ย้ายงานแบบนี้ไปใช้ระดับ light
    // แล้วขอ GPT วางแผนภาพจากเนื้อหาที่เขียนจริงก่อนเข้าสายพานสร้างภาพ
    if (this.book.figureMode === 'auto') {
      const havePlannedImages = (this.book.figures || []).some((f) => f.kind === 'image' && f.prompt && f.name);
      if (!havePlannedImages) {
        if ((this.book.illustrationLevel || 'none') === 'none') {
          this.book.illustrationLevel = 'light';
          this.log('ok', 'โหมดสร้างภาพอัตโนมัติถูกเลือกไว้ แต่ยังไม่มีแผนภาพประกอบ — ใช้ระดับพอดีและให้ GPT วางภาพจากเนื้อหาจริงก่อน');
        }
        const resumeStep = this.job.step;
        await this.figures();
        this.job.step = resumeStep;
        await this.save();
      }
    }

    await this.ensureBackCoverCopy();

    const jobs = plannedImageJobs(this.book);
    if (!jobs.length) {
      this.book.imagePhase = { ...(this.book.imagePhase || {}), status: 'complete', completedAt: Date.now(), total: 0, remaining: [] };
      this.job.step = 'done';
      return;
    }

    this.log('ok', `Phase 2 อัตโนมัติ: ตรวจ/สร้างภาพทั้งหมด ${jobs.length} รูปตามลำดับ แล้วค่อยประกอบเล่ม`);
    let made = 0;
    // เก็บสาเหตุจริงของแต่ละรูปไว้รายงานที่ประตู Phase 2
    // ไม่งั้นผู้ใช้จะเห็นแค่ผลของ Final Check ว่า "ไม่พบไฟล์ภาพ" ซึ่งบอกแค่ว่าไฟล์ไม่อยู่
    // แต่ไม่บอกว่าทำไมถึงสร้างไม่ได้ ทำให้กดเริ่มใหม่วนอยู่ที่เดิมโดยไม่รู้ว่าต้องแก้อะไร
    const genErrors = new Map();
    // ผลล้มเหลวของรอบก่อนต้องถูกล้างตั้งแต่เริ่ม ไม่งั้นหน้าจอจะโชว์ของเก่าปนกับรอบใหม่
    this.book.imagePhase = { ...(this.book.imagePhase || {}), failures: [], startedAt: Date.now() };
    /**
     * เริ่มรอบใหม่ = ต้องเปิดห้องแชตใหม่หนึ่งครั้งเสมอ
     *
     * ธงนี้ถูกบันทึกลงไฟล์โครงการ ถ้าไม่ล้างตอนเริ่ม รอบที่กด "ทำต่อ" หลังปิดเบราว์เซอร์
     * จะเชื่อว่ายังอยู่ในห้องเดิมของเมื่อวาน แล้วยิงคำสั่งลงห้องที่ไม่มีอยู่จริงแล้ว
     */
    this.job.imageThreadStarted = false;
    await this.save();

    // ตัวทดสอบเครื่องมือสร้างภาพ ยิงครั้งเดียวต่อหนึ่งรอบงาน ไม่ใช่ต่อหนึ่งรูป
    let probed = false;
    let probeOk = null;
    for (let index = 0; index < jobs.length; index++) {
      const j = jobs[index];
      this.emit({ type: 'image.progress', stage: 'check', current: index + 1, total: jobs.length, name: j.name, what: j.what });

      let existing = await db.loadAsset(this.book.id, j.name);
      if (existing) {
        // ปกแบบ baked ตั้งใจให้มีตัวหนังสืออยู่แล้ว ห้ามเอาเกณฑ์ "artwork เปล่า" ไปตัดสิน
        const coverNeedsCleanArtwork =
          j.kind === 'cover' && !P.coverTextBaked(this.book) && !existing.meta?.artworkOnly;
        if (!coverNeedsCleanArtwork) {
          try {
            if (j.widthMm && j.heightMm && !existing.meta?.resizedTo300Dpi) {
              const fixed = await normalizeGeneratedImage(existing.blob, j);
              await db.saveAsset(this.book.id, j.name, fixed.blob, {
                ...(existing.meta || {}),
                phase: 2,
                kind: j.kind || existing.meta?.kind || null,
                targetWidthMm: j.widthMm,
                targetHeightMm: j.heightMm,
                aspect: j.aspect || existing.meta?.aspect || null,
                ...fixed.meta,
              });
              existing = await db.loadAsset(this.book.id, j.name);
            }
            const checked = await validatePhase2Asset(existing, j);
            if (checked.ok) {
              this.log('ok', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: มีไฟล์ที่ผ่านตรวจแล้ว ข้ามการสร้างซ้ำ (${j.name})`);
              this.emit({ type: 'image.progress', stage: 'saved', current: index + 1, total: jobs.length, name: j.name, what: j.what });
              continue;
            }
            await db.deleteAsset(this.book.id, j.name);
            this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ไฟล์เดิมไม่ผ่านตรวจ (${checked.reason}) — จะสร้างใหม่`);
          } catch (e) {
            await db.deleteAsset(this.book.id, j.name).catch(() => {});
            this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: เปิด/ปรับไฟล์เดิมไม่ได้ (${e?.message || e}) — จะสร้างใหม่`);
          }
        } else {
          await db.deleteAsset(this.book.id, j.name);
          this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ปกเดิมอาจมีข้อความฝัง — ลบแล้วสร้าง artwork ใหม่`);
        }
      }

      let lastError = '';
      let saved = false;
      let freeRetries = 0;
      let dupeHits = 0;
      for (let attempt = 1; attempt <= MAX_IMAGE_ATTEMPTS && !saved; attempt++) {
        this.emit({
          type: 'image.progress',
          stage: attempt === 1 ? 'generate' : 'retry',
          current: index + 1,
          total: jobs.length,
          attempt,
          maxAttempts: MAX_IMAGE_ATTEMPTS,
          name: j.name,
          what: j.what,
        });
        this.log('ok', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ส่งคำสั่งสร้าง${attempt > 1 ? `ใหม่ครั้งที่ ${attempt}` : ''}`);

        /**
         * ห้องแชตเดียวตลอด Phase 2 — เปิดใหม่เฉพาะตอนที่มีเหตุผลจริงเท่านั้น
         *
         * ของเดิมเปิดห้องใหม่ทุกรูปด้วยเหตุผลว่า "ห้องที่มีภาพจะทำให้เครื่องมือเข้าโหมดแก้ภาพ"
         * แต่การเปิดห้องใหม่มีราคาที่มองไม่เห็น: ทุกครั้งที่เปิด ภาพที่ยังไม่ได้เก็บจะหายไปพร้อมห้องเก่า
         * และหน้าเว็บต้องวาดใหม่ทั้งหน้า ซึ่งเป็นจังหวะที่ Prompt ถูกล้างทิ้งบ่อยที่สุด
         * ที่ผ่านมาจึงเสียภาพที่วาดเสร็จแล้วไปหลายรูปเพราะเหตุนี้โดยตรง
         *
         * ตอนนี้แยกภาพใหม่จากภาพเก่าได้แน่นอนแล้ว (ปักหมุดที่ข้อความของเราในเทิร์นนี้
         * บวกกับตัวกันภาพซ้ำที่จำลายนิ้วมือของทุกภาพที่ใช้ไปแล้ว) จึงอยู่ห้องเดิมได้
         * เปิดห้องใหม่เมื่อรูปก่อนหน้ามีปัญหาเท่านั้น — ตัวที่ตั้ง imageThreadStarted = false
         */
        /**
         * โหมด API ไม่ต้องยุ่งกับหน้าเว็บเลย จึงไม่มีเรื่องห้องแชตให้จัดการ
         * ตัวแปรเกี่ยวกับห้องยังต้องคงค่าไว้ เผื่อผู้ใช้สลับกลับไปโหมดหน้าเว็บกลางคัน
         */
        const useApi = this.book.imageSource === 'api';
        const newThread = !useApi && !this.job.imageThreadStarted;
        if (newThread) this.job.lastImageInThread = null; // ห้องใหม่ = ไม่มีภาพเก่าให้อ้างอีกแล้ว
        if (!useApi) this.job.imageThreadStarted = true;
        this.book.imagePhase = {
          ...(this.book.imagePhase || {}),
          status: 'running',
          total: jobs.length,
          current: index + 1,
          currentName: j.name,
          currentWhat: j.what,
          attempt,
          remaining: jobs.slice(index).map((x) => x.name),
          lastAttemptAt: Date.now(),
        };
        await this.save();
        try { await W.syncProject(this.book.id); } catch {}

        let res;

        /**
         * รูปอ้างอิงเป็นเรื่องของงานภาพชิ้นนี้ ไม่ใช่ของเส้นทางใดเส้นทางหนึ่ง
         * ตัดสินใจที่เดียวตรงนี้ แล้วทั้งโหมด API และโหมดหน้าเว็บใช้คำตอบเดียวกัน
         * ไม่งั้นผู้ใช้จะได้ผลไม่เหมือนกันเพียงเพราะสลับโหมด ทั้งที่ตั้งค่าไว้อย่างเดียวกัน
         */
        const ref = j.needsAuthorRef ? await this.authorRef() : null;

        /**
         * ทางที่ 1: เรียก Images API ตรง ๆ
         *
         * ไม่มีช่องพิมพ์ ไม่มีปุ่มส่ง ไม่มีการเดาว่าตอบจบหรือยัง ไม่ต้องคว้าภาพจาก DOM
         * ทุกจุดที่เคยพังของโหมดหน้าเว็บไม่มีอยู่ในเส้นทางนี้เลย
         * ส่งคำสั่งไปแล้วได้ไฟล์กลับมา หรือได้เหตุผลว่าทำไมไม่ได้ — จบในขั้นตอนเดียว
         */
        if (useApi) {
          try {
            const key = await db.setting('openaiApiKey');
            if (!key) throw new Error('ยังไม่ได้ใส่ OpenAI API key ในหน้าตั้งค่า');
            const model =
              this.book.imageApiModel || (await db.setting('imageApiModel')) || DEFAULT_IMAGE_MODEL;
            const out = await generateImage({
              apiKey: key,
              model,
              prompt: j.prompt,
              widthMm: j.widthMm,
              heightMm: j.heightMm,
              quality: this.book.imageApiQuality || 'medium',
              refImages: ref ? [await dataUrlToFile(ref.dataUrl, ref.name)] : [],
            });
            res = { status: 'ok', text: '', images: [], imageDataUrl: out.dataUrl, meta: { via: 'api', size: out.size, ref: !!ref } };
            const spent = this.recordImageUsage(out);
            this.log(
              'ok',
              `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ได้ภาพจาก API แล้ว (${model} · ${out.size} · ${Math.round(out.bytes / 1024)} KB` +
                (ref ? ' · แนบรูปผู้เขียนไปด้วย' : '') +
                (spent ? ` · token ${spent.toLocaleString()}` : '') +
                ')',
            );
          } catch (e) {
            if (e instanceof RateLimited || e instanceof Halt) throw e;
            lastError = `เรียก API สร้างภาพไม่สำเร็จ: ${e?.message || e}`;
            this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ${lastError}`);
            await sleep(2000);
            continue;
          }
        } else {
        try {
          /**
           * ปกหลังต้องเข้าชุดกับปกหน้า — ถ้าปกหน้าเพิ่งวาดในห้องนี้ ให้ชี้ไปที่ภาพนั้นเลย
           * ถ้าไม่ได้อยู่ห้องเดียวกัน (ปกหน้ามาจากไฟล์เดิมหรือคนละรอบ) ค่อยกลับไปวาดจากสเปกล้วน
           */
          const continuation =
            j.name === 'cover-back.png' && this.job.lastImageInThread === 'cover-front.png'
              ? 'ปกหน้าของเล่มนี้'
              : null;
          res = await this.turn(P.imageTurn(j.prompt, { attempt, continuation }), {
            label: `สร้าง${j.what}${attempt > 1 ? ` (ลอง ${attempt})` : ''}`,
            wantImages: true,
            newThread,
            attachments: ref ? [{ name: ref.name, dataUrl: ref.dataUrl }] : [],
          });

          /**
           * แนบไม่ติดต้องพูดออกมา ไม่ใช่ปล่อยเงียบ
           *
           * Prompt บอกโมเดลไปแล้วว่า "มีรูปผู้เขียนแนบมาด้วย" ถ้าไฟล์ไม่ได้ไปถึงจริง
           * ภาพที่ได้จะเป็นหน้าคนที่โมเดลแต่งขึ้นเอง ซึ่งดูผ่านตาแล้วเหมือนใช้ได้
           * ผู้ใช้จะรู้ตัวก็ต่อเมื่อเปิดเล่มจริงแล้วพบว่าไม่ใช่หน้าตัวเอง
           */
          if (ref && res?.meta?.attachment && !res.meta.attachment.attached) {
            this.log(
              'warn',
              `ภาพ ${index + 1}/${jobs.length} · ${j.what}: แนบรูปผู้เขียนเข้าหน้า ChatGPT ไม่สำเร็จ ` +
                `(${res.meta.attachment.errors?.[0] || 'ไม่ทราบสาเหตุ'}) — หน้าคนในภาพนี้จะเป็นหน้าที่โมเดลแต่งขึ้นเอง`,
            );
          } else if (ref && res?.meta?.attachment?.attached) {
            this.log('ok', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: แนบรูปผู้เขียนเข้าห้องแชตแล้ว`);
          }
        } catch (e) {
          // rate limit / ผู้ใช้กดหยุด / wrong model ต้องให้ state machine จัดการตามปกติ
          // ห้ามนับเป็น "ภาพพัง" แล้วเผาโควตาลองซ้ำอีกครั้ง
          if (e instanceof RateLimited || e instanceof Halt) throw e;
          lastError = e?.message || String(e);
          this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: เทิร์นสร้างภาพไม่สำเร็จ (${lastError})`);

          /**
           * เทิร์นล้ม ไม่ได้แปลว่า ChatGPT ไม่ได้วาด
           *
           * เคสที่เจอบ่อยที่สุดคือคำสั่งส่งไปแล้ว ChatGPT วาดเสร็จเรียบร้อย
           * แต่ฝั่งเราหมดเวลารอหรือเสียการเชื่อมต่อกับหน้าเว็บระหว่างทาง
           * ถ้า continue ทันทีจะไปเปิดห้องแชตใหม่ แล้วภาพที่วาดเสร็จแล้วหายไปพร้อมห้องเก่า
           */
          const rescued = await this.grabRenderedImage(index, jobs.length, j, { tries: 4 });
          if (!rescued?.dataUrl) continue;
          this.log('ok', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: เทิร์นล้มแต่ภาพวาดเสร็จแล้ว — คว้ามาจากหน้าแชตได้`);
          res = { status: 'ok', text: '', images: [], imageDataUrl: rescued.dataUrl, meta: {} };
        }
        }

        /**
         * ล้มก่อนที่ Prompt จะถึง ChatGPT = ยังไม่เสียโควตา ห้ามนับเป็นครั้งที่ลอง
         * ไม่งั้นรูปหนึ่งรูปจะหมดสิทธิ์ตั้งแต่ยังไม่เคยได้สั่งวาดจริงสักครั้ง
         */
        if (isNoCostFailure(res) && freeRetries < MAX_FREE_RETRIES) {
          freeRetries++;
          attempt--;
          this.log(
            'warn',
            `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ส่งคำสั่งไม่ออกจากเครื่องเรา (${res.meta?.detail || res.meta?.error}) — ยังไม่เสียโควตา ลองส่งใหม่ ${freeRetries}/${MAX_FREE_RETRIES}`,
          );
          lastError = res.meta?.detail || res.meta?.error || '';
          await sleep(2500);
          continue;
        }

        let url = res.images?.[0];

        /**
         * ตัวตรวจจับไม่เจอภาพ ไม่ได้แปลว่า ChatGPT ไม่ได้วาด
         *
         * ปุ่ม "ภาพเสร็จแล้ว → ดึงมาเลย" ทำงานได้เสมอเพราะมันไม่พึ่งตัวตรวจจับจบเทิร์นเลย
         * มันแค่ไปคว้าภาพที่อยู่หลังข้อความล่าสุดของเราในหน้านั้น
         * ก่อนจะตัดสินว่ารูปนี้พัง ให้ทำสิ่งเดียวกันนั้นเองแบบอัตโนมัติก่อน
         * โมเดลสายคิดก่อนตอบใช้เวลาเป็นนาที (เห็น "Worked for 1m 24s") กว่าภาพจะขึ้น
         * จึงต้องวนคว้าเป็นระยะ ไม่ใช่คว้าครั้งเดียวแล้วยอมแพ้
         */
        if (!url && !res.imageDataUrl && !useApi) {
          const grabbed = await this.grabRenderedImage(index, jobs.length, j);
          if (grabbed?.dataUrl) {
            res.imageDataUrl = grabbed.dataUrl;
            this.log(
              'ok',
              `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ตัวตรวจจับไม่เห็นภาพ แต่ไปคว้าจากหน้าแชตมาได้เอง${grabbed.width ? ` (${grabbed.width}×${grabbed.height}px)` : ''}`,
            );
          }
        }

        if (!url && !res.imageDataUrl) {
          /**
           * อยู่ห้องเดิม แม้รอบนี้จะไม่ได้ภาพ
           *
           * เดิมสั่งเปิดห้องใหม่ทุกครั้งที่พลาด ด้วยความเชื่อว่าห้องที่มีภาพทำให้เครื่องมือ
           * เข้าโหมดแก้ภาพ — ซึ่งพิสูจน์แล้วว่าไม่จริง (ห้องใหม่เอี่ยมก็ถูกปฏิเสธเหมือนกัน
           * ตัวการคือหัวคำสั่ง ไม่ใช่บริบทของห้อง)
           *
           * ราคาของความเชื่อนั้นคือ: พลาดหนึ่งครั้ง = เปิดห้องใหม่ = ภาพที่ยังไม่ได้เก็บ
           * หายไปพร้อมห้องเก่าทันที ยิ่งพลาดบ่อยยิ่งเปิดห้องบ่อย จนกลายเป็น
           * "new chat ตลอด เก็บรูปไม่ทัน"
           */
          const captureError = res.meta?.imageCapture?.errors?.[0];
          const sawImages = (res.meta?.imageCapture?.seen || []).length > 0;
          // "ไม่พบไฟล์ภาพ" เฉย ๆ ใช้แก้อะไรไม่ได้
          // ถ้า ChatGPT ตอบเป็นข้อความ (ปฏิเสธ/ถามกลับ) ข้อความนั้นคือคำอธิบายที่ดีที่สุดที่มี
          const seen = res.meta?.imageCapture?.seen || [];
          const said = String(res.text || '').replace(/\s+/g, ' ').trim();
          // เทิร์นที่ล้มก่อนได้ส่ง Prompt (เช่นเปิดห้องแชตใหม่ไม่สำเร็จ) ไม่มีทั้งภาพและข้อความ
          // ถ้าไม่ยกเหตุผลจาก meta ขึ้นมา ผู้ใช้จะเห็นแค่ "ตรวจไม่พบภาพใด ๆ" ซึ่งชี้ผิดจุด
          const turnFailure = res.status !== 'ok' ? res.meta?.detail || res.meta?.error || res.status : '';
          // ตอบเป็นข้อความขอไฟล์ต้นฉบับ = ตีความผิดว่าเป็นงานแก้ภาพ ต้องบอกให้ตรงอาการ
          // ไม่ใช่แค่ "ตอบเป็นข้อความ" ซึ่งอ่านแล้วไม่รู้ว่าต้องทำอะไรต่อ
          const askedForSource = /อัปโหลด|อัพโหลด|ต้นฉบับ|แนบ(ไฟล์|ภาพ|รูป)|upload|attach|reference image|source image|original image/i.test(said);
          /**
           * ChatGPT บอกเองว่าเครื่องมือสร้างภาพของมันล้มเหลว
           *
           * เคสนี้ไม่เกี่ยวกับคำสั่งของเราเลย และการไปแก้คำสั่งจะยิ่งพาออกนอกทาง
           * ที่ทำได้คือลองใหม่ ซึ่งบางครั้งก็ผ่าน — แต่ถ้าเจอซ้ำ ๆ มักแปลว่า
           * บัญชีชนลิมิตการสร้างภาพของรอบนั้นแล้ว ต้องรอหรือเปลี่ยนบัญชี
           */
          const gptSideFailure =
            res.meta?.imageCapture?.reason === 'generation_failed' ||
            /something went wrong while generating your image|error generating image/i.test(said);
          lastError = gptSideFailure
            ? 'ChatGPT แจ้งว่าเครื่องมือสร้างภาพของตัวเองล้มเหลว (ไม่ใช่ปัญหาคำสั่งของเรา) — ถ้าเจอซ้ำหลายรูป มักแปลว่าบัญชีชนลิมิตการสร้างภาพแล้ว'
            : turnFailure
            ? `เทิร์นสร้างภาพไม่ได้เริ่ม: ${turnFailure}`
            : captureError && sawImages
            ? `ChatGPT วาดภาพเสร็จแล้วแต่ดึงไฟล์จากหน้าเว็บไม่ได้: ${captureError}`
            : captureError
            ? `ChatGPT แสดงภาพแล้วแต่ดึง bytes ไม่ได้: ${captureError}`
            : askedForSource
              ? `ChatGPT ตีความว่าเป็นงานแก้ภาพเดิมแล้วขอไฟล์ต้นฉบับแทนที่จะวาดใหม่ — จะย้ำคำสั่งแล้วลองใหม่ในห้องแชตใหม่ (“${said.slice(0, 160)}”)`
              : said
                ? `ChatGPT ตอบเป็นข้อความแทนภาพ: “${said.slice(0, 220)}”`
                : seen.length
                  ? `ตรวจไม่พบภาพที่สร้างใหม่ · ภาพที่เห็นในคำตอบ: ${seen.join(" | ")}`
                  : 'ตรวจไม่พบภาพใด ๆ ในคำตอบ';
          this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ${lastError}`);
          continue;
        }

        /**
         * ห้ามรับภาพที่เคยใช้ไปแล้วในเล่มนี้
         *
         * ตัวคว้าภาพหยิบ "ภาพที่อยู่หลังข้อความล่าสุดของเราในหน้านั้น" ซึ่งถูกเสมอ
         * ตราบใดที่ข้อความของเราถูกส่งจริง แต่ถ้ารอบนั้นส่งไม่ออก ข้อความล่าสุดคือของรอบก่อน
         * มันจึงคว้าภาพของรูปก่อนหน้ากลับมาแล้วบันทึกลงช่องใหม่แบบเงียบ ๆ
         * ผลที่เห็นในเล่มจริง: ภาพหน้า 12 เป็นไฟล์เดียวกับหน้า 8 ต่างกันแค่จุดที่ครอป
         */
        if (res.imageDataUrl && this.usedImageKeys?.has(imageFingerprint(res.imageDataUrl))) {
          dupeHits++;
          lastError = 'คว้าได้ภาพเดียวกับรูปก่อนหน้า (ไม่ใช่ภาพใหม่ของรูปนี้)';
          this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ${lastError} — ไม่รับ แล้วสั่งวาดใหม่`);
          if (dupeHits <= 2) attempt--; // ไม่ใช่ความผิดของคำสั่ง ให้โอกาสสั่งวาดใหม่จริง ๆ
          await sleep(1500);
          continue;
        }

        try {
          this.emit({ type: 'image.progress', stage: 'download', current: index + 1, total: jobs.length, name: j.name, what: j.what });
          let rawBlob;
          if (res.imageDataUrl) {
            // ทางหลัก: Adapter ดึงไฟล์ในบริบทหน้า ChatGPT แล้วส่ง bytes กลับมา
            // จึงรองรับ blob: URL ของภาพที่ 2+ ซึ่ง Studio fetch ตรง ๆ ไม่ได้
            rawBlob = await db.dataUrlToBlob(res.imageDataUrl);
          } else {
            // fallback สำหรับ CDN URL ที่ extension เข้าถึงได้โดยตรง
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            rawBlob = await response.blob();
          }
          if (!rawBlob?.size) throw new Error('ไฟล์ภาพว่าง 0 byte');

          const sourceCheck = await validateGeneratedSource(rawBlob, j);
          if (!sourceCheck.ok) throw new Error(`ไฟล์ต้นฉบับไม่ผ่านตรวจ: ${sourceCheck.reason}`);
          // crop เยอะ ๆ ไม่ใช่ข้อผิดพลาด แต่ต้องเห็นได้ เผื่อภาพออกมาแล้วองค์ประกอบเบี้ยว
          if (sourceCheck.crop > 0.2) {
            this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ต้นฉบับสัดส่วนไม่ตรงช่อง ตัดขอบออก ${Math.round(sourceCheck.crop * 100)}% แบบกลางภาพ`);
          }
          const normalized = await normalizeGeneratedImage(rawBlob, j);
          const candidate = {
            blob: normalized.blob,
            meta: {
              from: 'chatgpt',
              phase: 2,
              kind: j.kind || null,
              artworkOnly: j.kind === 'cover' && !(j.name === 'cover-front.png' && P.coverTextBaked(this.book)),
              textBaked: j.name === 'cover-front.png' && P.coverTextBaked(this.book),
              generationVersion: 5,
              targetWidthMm: j.widthMm || null,
              targetHeightMm: j.heightMm || null,
              aspect: j.aspect || null,
              ...normalized.meta,
            },
          };
          const checked = await validatePhase2Asset(candidate, j);
          if (!checked.ok) throw new Error(`ภาพไม่ผ่านตรวจ: ${checked.reason}`);

          await db.saveAsset(this.book.id, j.name, candidate.blob, candidate.meta);
          const stored = await db.loadAsset(this.book.id, j.name);
          const storedCheck = await validatePhase2Asset(stored, j);
          if (!storedCheck.ok) {
            await db.deleteAsset(this.book.id, j.name);
            throw new Error(`ไฟล์หลังบันทึกไม่ผ่านตรวจ: ${storedCheck.reason}`);
          }

          made++;
          saved = true;
          // จำว่าภาพล่าสุดในห้องแชตนี้คือรูปไหน เพื่อให้รูปถัดไปอ้างถึงได้ถูกตัว
          this.job.lastImageInThread = j.name;
          // ปกหลังที่วาดตัวอักษรมาในภาพแล้ว ห้ามให้เครื่องเรียงพิมพ์วางคำโปรยทับซ้ำอีก
          // ต้องถามด้วยเกณฑ์เดียวกับตอนเขียน prompt ไม่ใช่แค่ "มีคำโปรยไหม"
          // ไม่งั้นภาพที่สั่งไปว่า "ห้ามมีตัวอักษร" จะถูกปักธงว่ามีข้อความแล้ว
          if (j.name === 'cover-back.png' && P.backCoverTextBaked(this.book)) {
            this.book.backCoverTextBaked = true;
          }
          // จำลายนิ้วมือของภาพที่ใช้ไปแล้ว เพื่อไม่ให้รูปถัดไปได้ภาพเดียวกัน
          if (!this.usedImageKeys) this.usedImageKeys = new Set();
          if (res.imageDataUrl) this.usedImageKeys.add(imageFingerprint(res.imageDataUrl));
          const px = candidate.meta?.widthPx ? ` · ${candidate.meta.widthPx}×${candidate.meta.heightPx}px` : '';
          const dpi = candidate.meta?.effectiveDpi ? ` · ต้นฉบับราว ${candidate.meta.effectiveDpi} dpi` : '';
          this.log('ok', `✓ ภาพ ${index + 1}/${jobs.length} · ${j.what}: ตรวจผ่านและบันทึก ${j.name}${px}${dpi}`);
          this.emit({ type: 'image.progress', stage: 'saved', current: index + 1, total: jobs.length, name: j.name, what: j.what });

          this.book.imagePhase = {
            ...(this.book.imagePhase || {}),
            status: 'running',
            total: jobs.length,
            completed: index + 1,
            current: index + 1,
            currentName: j.name,
            remaining: jobs.slice(index + 1).map((x) => x.name),
            lastSavedAt: Date.now(),
          };
          await this.save();
          try { await W.syncProject(this.book.id); } catch {}
        } catch (e) {
          lastError = e?.message || String(e);
          // อยู่ห้องเดิม — ภาพที่วาดเสร็จแล้วยังอยู่ในห้องนี้ ยังกดดึงเองได้
          this.log('warn', `ภาพ ${index + 1}/${jobs.length} · ${j.what}: รับ/ปรับ/ตรวจไฟล์ไม่สำเร็จ (${lastError})`);
        }
      }

      if (!saved) {
        /**
         * รูปแรกพังทั้งสองครั้ง = ต้องรู้ให้ได้ว่าปัญหาอยู่ฝั่งไหนก่อนไปต่อ
         *
         * ที่ผ่านมาระบบเดาจากคำอธิบายที่ ChatGPT พิมพ์กลับมา ซึ่งเป็นการ "เล่าเหตุผล"
         * ของโมเดลเอง ไม่ใช่หลักฐาน แล้วก็พาไปไล่แก้ถ้อยคำใน prompt ครั้งแล้วครั้งเล่า
         * ยิงคำสั่งบรรทัดเดียวที่ไม่มีศัพท์เทคนิคเลยหนึ่งครั้ง ตัดสินได้ทันทีว่า
         * เป็นเรื่องคำสั่งของเรา หรือเป็นเรื่องโมเดลในแท็บนั้นสร้างภาพไม่ได้
         */
        if (!probed && !useApi) {
          probed = true;
          try {
            this.log('warn', 'ทดสอบเครื่องมือสร้างภาพด้วยคำสั่งบรรทัดเดียว เพื่อดูว่าปัญหาอยู่ที่คำสั่งของเราหรือที่บัญชี ChatGPT');
            const probe = await this.turn(P.IMAGE_PROBE_PROMPT, {
              label: 'ทดสอบว่าบัญชีนี้สร้างภาพได้ไหม',
              wantImages: true,
              newThread: true,
            });
            probeOk = !!(probe.images?.[0] || probe.imageDataUrl);
            // ห้ามสรุปว่า "บัญชีสร้างภาพไม่ได้" จากตัวตรวจจับตัวเดียว
            // ถ้ากล่าวหาผิด ผู้ใช้จะไปนั่งสลับโมเดลทั้งที่ปัญหาอยู่ที่การอ่านหน้าเว็บของเรา
            if (!probeOk) {
              const rescued = await this.grabRenderedImage(index, jobs.length, j, { tries: 3, gapMs: 4000 });
              probeOk = !!rescued?.dataUrl;
            }
            this.log(
              probeOk ? 'ok' : 'warn',
              probeOk
                ? 'บัญชีนี้สร้างภาพได้ปกติ — ปัญหาอยู่ที่คำสั่งภาพของเล่มนี้ ไม่ใช่ที่บัญชี'
                : `บัญชี/โมเดลในแท็บ ChatGPT นี้สร้างภาพไม่ได้ — คำสั่งง่ายที่สุดยังไม่ได้ภาพกลับมา (ตอบว่า “${String(probe.text || '').replace(/\s+/g, ' ').trim().slice(0, 160)}”)`,
            );
          } catch (e) {
            if (e instanceof RateLimited || e instanceof Halt) throw e;
            this.log('warn', `ทดสอบเครื่องมือสร้างภาพไม่สำเร็จ (${e?.message || e})`);
          }
        }
        if (probed && probeOk === false) {
          lastError = `${lastError || 'สร้างภาพไม่สำเร็จ'} · ทดสอบแล้ว: บัญชี/โมเดลในแท็บ ChatGPT นี้สร้างภาพไม่ได้เลย แม้แต่คำสั่งง่ายที่สุด — ต้องสลับโมเดลที่สร้างภาพได้ หรือใช้ “คัดลอก Prompt” ไปสร้างที่อื่นแล้วอัปโหลด`;
        }

        genErrors.set(j.name, lastError || '');

        /**
         * หยุดทั้งคิว "เฉพาะเมื่อมีอะไรให้รักษาไว้ในแชตนี้จริง"
         *
         * เหตุผลเดิมของการหยุดคือ เทิร์นถัดไปจะเปิดแชตใหม่แล้วลบหลักฐานทิ้ง —
         * ภาพที่ ChatGPT วาดเสร็จแล้วแต่เราดึงไม่ทันจะหายไปพร้อมแชตเก่า
         * เหตุผลนั้นใช้ได้ก็ต่อเมื่อ "มีภาพอยู่บนจอจริง" เท่านั้น
         *
         * ถ้าหน้านั้นไม่มีภาพให้เก็บเลย การหยุดทั้งคิวไม่ได้รักษาอะไรไว้
         * มันแค่ทำให้ภาพที่เหลืออีกห้ารูปไม่ได้ถูกสร้าง ทั้งที่ไม่เกี่ยวข้องกันเลย
         * — นี่คืออาการ "พลาดรูปเดียวแล้วพังทั้งงาน"
         */
        const somethingToRescue =
          /ดึง bytes ไม่ได้|แสดงภาพแล้ว|ภาพที่เห็นในคำตอบ/.test(lastError || '');

        if (!somethingToRescue) {
          this.book.imagePhase = {
            ...(this.book.imagePhase || {}),
            status: 'running',
            failures: [
              ...(this.book.imagePhase?.failures || []).filter((f) => f.name !== j.name),
              { name: j.name, what: j.what, reason: lastError || 'สร้างภาพไม่สำเร็จ' },
            ],
            remaining: jobs.slice(index + 1).map((x) => x.name),
          };
          await this.save();
          try { await W.syncProject(this.book.id); } catch {}
          this.log(
            'warn',
            `ภาพ ${index + 1}/${jobs.length} · ${j.what}: ไม่สำเร็จหลังลอง ${MAX_IMAGE_ATTEMPTS} ครั้ง (${lastError || 'ไม่ทราบสาเหตุ'}) — ไม่มีภาพค้างในแชตนี้ให้เก็บ จึงข้ามไปทำรูปถัดไปก่อน แล้วค่อยกลับมาจัดการรูปนี้ตอนท้าย`,
          );
          this.emit({ type: 'image.progress', stage: 'failed', current: index + 1, total: jobs.length, name: j.name, what: j.what, reason: lastError });
          continue;
        }

        this.book.imagePhase = {
          ...(this.book.imagePhase || {}),
          status: 'partial',
          failedName: j.name,
          failedWhat: j.what,
          failedReason: lastError || 'สร้างภาพไม่สำเร็จ',
          failures: [
            ...(this.book.imagePhase?.failures || []).filter((f) => f.name !== j.name),
            { name: j.name, what: j.what, reason: lastError || 'สร้างภาพไม่สำเร็จ' },
          ],
          stoppedAt: Date.now(),
          stoppedReason: `หยุดไว้ที่ ${j.what} เพื่อไม่ให้แชตที่มีภาพถูกเปลี่ยนทิ้ง — ถ้าเห็นว่า ChatGPT วาดเสร็จแล้ว กด "ภาพเสร็จแล้ว → ดึงมาเลย" ที่แถวนี้`,
          remaining: jobs.slice(index).map((x) => x.name),
        };
        this.job.step = 'gate_images';
        this.job.status = 'waiting_human';
        await this.save();
        try { await W.syncProject(this.book.id); } catch {}
        this.log('warn', `${j.what}: สร้างไม่สำเร็จ (${lastError || 'ไม่ทราบสาเหตุ'}) — หยุดไว้ก่อน ไม่เปลี่ยนแชต เพื่อให้ดึงภาพจากแชตนี้ได้`);
        this.emit({ type: 'image.progress', stage: 'failed', current: index + 1, total: jobs.length, name: j.name, what: j.what, reason: lastError });
        return;
      }
    }

    // Final Check: ห้ามประกอบเล่มจนกว่าทุก asset จะเปิดได้จริงและมีขนาดตรงช่อง
    this.emit({ type: 'image.progress', stage: 'verify_all', current: jobs.length, total: jobs.length });
    this.log('ok', `กำลัง Final Check ภาพทั้งหมด ${jobs.length} รูปก่อนประกอบเล่ม`);
    const invalid = [];
    for (const j of jobs) {
      const asset = await db.loadAsset(this.book.id, j.name);
      const checked = await validatePhase2Asset(asset, j);
      if (!checked.ok) {
        // สาเหตุตอนสร้างมีน้ำหนักกว่าผลตรวจปลายทางเสมอ ("ดึง bytes ไม่ได้" ใช้แก้ปัญหาได้ "ไม่พบไฟล์ภาพ" ใช้ไม่ได้)
        const genWhy = genErrors.get(j.name);
        invalid.push({ name: j.name, what: j.what, reason: genWhy || checked.reason });
        if (asset) await db.deleteAsset(this.book.id, j.name);
      }
    }

    if (invalid.length) {
      const remaining = invalid.map((x) => x.name);
      this.book.imagePhase = {
        ...(this.book.imagePhase || {}),
        status: 'partial',
        total: jobs.length,
        completed: jobs.length - invalid.length,
        remaining,
        failedName: invalid[0].name,
        failedWhat: invalid[0].what,
        failedReason: invalid[0].reason,
        failures: invalid.map((x) => ({ name: x.name, what: x.what, reason: x.reason })),
        verifiedAt: Date.now(),
      };
      this.job.step = 'gate_images';
      this.job.status = 'waiting_human';
      await this.save();
      try { await W.syncProject(this.book.id); } catch {}
      this.log('warn', `Final Check ไม่ผ่าน ${invalid.length} รูป — ไม่ประกอบเล่มจนกว่าจะสร้าง/แก้ภาพที่ขาด`);
      return;
    }

    this.log('ok', `✓ Images OK · ครบ ${jobs.length}/${jobs.length} รูป ทุกไฟล์เปิดได้และขนาดตรงช่อง`);
    this.emit({ type: 'image.progress', stage: 'compile', current: jobs.length, total: jobs.length });

    // ตรวจเล่มจริงหลังแทน placeholder ด้วยภาพครบทุกภาพ
    const sections = await db.loadSections(this.book.id);
    const assets = await db.loadAssets(this.book.id);
    const before = Number(this.book.lastCompile?.pages) || 0;
    const { pages, ms } = await compileBook({
      book: this.book,
      outline: this.book.outline,
      sections,
      assets,
    });
    const physical = pages.physical;
    this.book.padPages = this.book.targetPages >= 24 && physical % 2 === 1 ? 1 : 0;
    this.book.finalPages = physical + this.book.padPages;
    this.book.imageCompile = { pages: physical, before, delta: before ? physical - before : 0, ms, at: Date.now() };
    this.book.imagePhase = {
      ...(this.book.imagePhase || {}),
      status: 'complete',
      total: jobs.length,
      completed: jobs.length,
      remaining: [],
      verified: true,
      verifiedAt: Date.now(),
      completedAt: Date.now(),
    };
    this.log(
      before === physical ? 'ok' : 'warn',
      `Phase 2 ครบ ${jobs.length} รูป · Final Check ผ่าน · ประกอบภาพลงตำแหน่งเดิมแล้ว · จำนวนหน้า ${physical}${before ? ` (ก่อนใส่ภาพ ${before}, ต่าง ${physical - before >= 0 ? '+' : ''}${physical - before})` : ''}`,
    );
    await this.save();
    try { await W.syncProject(this.book.id); } catch {}
    this.job.step = 'done';
  }
}

// ---------- helpers ----------

/**
 * เอาคำสั่งแก้ของกรรมการมาทับทางที่ชนะ
 *
 * รับเฉพาะช่องที่กรรมการเขียนกลับมาจริง และ palette ต้องครบสามสีเป็น #RRGGBB
 * เพราะค่าที่กรอกครึ่ง ๆ กลาง ๆ จะทำให้ prompt ปกอ้างสีที่ไม่มีอยู่แล้วภาพเพี้ยนทั้งใบ
 */
function applyCoverRevision(dir, revision) {
  if (!dir || !revision || typeof revision !== 'object') return dir;
  const out = { ...dir };
  const txt = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

  for (const key of ['human_element', 'human_render_style', 'composition', 'lighting', 'texture', 'mood', 'color_strategy']) {
    const v = txt(revision[key]);
    if (v) out[key] = v;
  }

  const palette = Array.isArray(revision.palette)
    ? revision.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(String(c?.hex || '')))
    : [];
  if (palette.length === 3) {
    out.palette = palette.map((c, i) => ({
      hex: c.hex,
      name: c.name || dir.palette?.[i]?.name || `สีที่ ${i + 1}`,
      role: c.role || dir.palette?.[i]?.role || '',
    }));
  }

  const avoid = Array.isArray(revision.avoid) ? revision.avoid.map(txt).filter(Boolean) : [];
  if (avoid.length) out.avoid = [...new Set([...(dir.avoid || []), ...avoid])];

  return out;
}

/** เช็คว่าปกเล่มนี้ผ่านการออกแบบโดย GPT Art Director รุ่นปัจจุบันครบทุกฟิลด์แล้วหรือยัง ใช้เกณฑ์เดียวทั้งไฟล์เพื่อไม่ให้หลุดไม่ตรงกัน */
function isModernCoverDesign(book) {
  return (
    Number(book.coverDesignVersion || 0) >= 6 &&
    Array.isArray(book.coverConsultation?.directions) &&
    book.coverConsultation.directions.length >= 1 &&
    !!book.style?.typography &&
    !!book.coverLayout &&
    !!book.coverPrompts?.front &&
    !!book.coverPrompts?.back
  );
}

/**
 * รับ dataURL ของภาพเข้าสู่โครงการผ่านสายตรวจเดียวกับที่ Phase 2 ใช้
 *
 * ใช้กับทางมือ (ผู้ใช้กด "ภาพเสร็จแล้ว" หรืออัปโหลดไฟล์ที่สร้างจากที่อื่น)
 * ต้องผ่าน validate/normalize ชุดเดียวกัน ไม่งั้นจะได้ไฟล์ที่ขนาดไม่ตรงช่องแล้วพังตอนประกอบเล่ม
 */
export async function ingestImageDataUrl(book, name, dataUrl) {
  const job = plannedImageJobs(book).find((j) => j.name === name);
  if (!job) throw new Error(`ไม่รู้จักช่องภาพ ${name}`);

  const rawBlob = await db.dataUrlToBlob(dataUrl);
  if (!rawBlob?.size) throw new Error('ไฟล์ภาพว่าง 0 byte');

  const sourceCheck = await validateGeneratedSource(rawBlob, job);
  if (!sourceCheck.ok) throw new Error(`ไฟล์ต้นฉบับไม่ผ่านตรวจ: ${sourceCheck.reason}`);

  const normalized = await normalizeGeneratedImage(rawBlob, job);
  const candidate = {
    blob: normalized.blob,
    meta: {
      from: 'manual',
      phase: 2,
      kind: job.kind || null,
      artworkOnly: job.kind === 'cover' && !(name === 'cover-front.png' && P.coverTextBaked(book)),
      textBaked: name === 'cover-front.png' && P.coverTextBaked(book),
      generationVersion: 5,
      targetWidthMm: job.widthMm || null,
      targetHeightMm: job.heightMm || null,
      aspect: job.aspect || null,
      ...normalized.meta,
    },
  };
  const checked = await validatePhase2Asset(candidate, job);
  if (!checked.ok) throw new Error(`ภาพไม่ผ่านตรวจ: ${checked.reason}`);

  await db.saveAsset(book.id, name, candidate.blob, candidate.meta);
  return candidate.meta;
}

/** Prompt ของช่องภาพหนึ่ง ๆ สำหรับเอาไปสร้างเองที่อื่น */
export function promptForImage(book, name) {
  return plannedImageJobs(book).find((j) => j.name === name)?.prompt || '';
}

/** ช่องที่นิยายต้องมีครบทุกฉาก */
const FICTION_SECTION_FIELDS = ['pov_character', 'scene_goal', 'conflict', 'turn'];

function fictionOutlineErrors(parsed) {
  const errs = [];
  if (!Array.isArray(parsed?.cast) || !parsed.cast.length) errs.push('นิยายขาด cast ตัวละคร');
  for (const ch of parsed?.chapters || []) {
    for (const s of ch.sections || []) {
      for (const f of FICTION_SECTION_FIELDS) if (!s[f]) errs.push(`ฉาก ${s.id || '?'} ขาด ${f}`);
    }
  }
  return errs;
}

/** ตอนไหนขาดช่องอะไรบ้าง — ใช้ขอเติมเฉพาะจุด แทนการสั่งเขียนสารบัญใหม่ทั้งชุด */
function outlineGaps(parsed, fiction) {
  const gaps = [];
  for (const ch of parsed?.chapters || []) {
    for (const s of ch.sections || []) {
      const missing = [];
      if (!Array.isArray(s.beats) || !s.beats.length) missing.push('beats');
      if (fiction) for (const f of FICTION_SECTION_FIELDS) if (!s[f]) missing.push(f);
      if (missing.length) gaps.push({ id: s.id || '', title: s.title || '', chapter: ch.title || '', missing });
    }
  }
  return gaps.filter((g) => g.id);
}

function applyOutlinePatch(parsed, patch) {
  const byId = new Map((patch?.sections || []).filter((x) => x?.id).map((x) => [String(x.id), x]));
  if (!byId.size) return 0;
  let applied = 0;
  for (const ch of parsed?.chapters || []) {
    for (const s of ch.sections || []) {
      const fix = byId.get(String(s.id));
      if (!fix) continue;
      if ((!Array.isArray(s.beats) || !s.beats.length) && Array.isArray(fix.beats) && fix.beats.length) s.beats = fix.beats;
      for (const f of FICTION_SECTION_FIELDS) if (!s[f] && fix[f]) s[f] = fix[f];
      applied++;
    }
  }
  return applied;
}

/**
 * ทางสุดท้าย: เติมช่องที่ยังขาดให้เองแล้วเดินต่อ
 * สารบัญทั้งเล่มที่ดีอยู่แล้วมีค่ามากกว่าความสมบูรณ์ของสามบรรทัดในตอนเดียว
 * และผู้ใช้แก้ทีหลังได้ในหน้าตรวจงาน ต่างจากการหยุดงานซึ่งแก้อะไรไม่ได้เลย
 */
function fillOutlineGaps(parsed, fiction) {
  const fixed = [];
  for (const ch of parsed?.chapters || []) {
    for (const s of ch.sections || []) {
      let touched = false;
      if (!Array.isArray(s.beats) || !s.beats.length) {
        s.beats = [
          `เปิดตอนด้วยสถานการณ์ของ “${s.title || ch.title || 'ตอนนี้'}”`,
          'ขยายแก่นของตอนนี้ด้วยตัวอย่างที่จับต้องได้',
          'ปิดตอนด้วยสิ่งที่ผู้อ่านเอาไปใช้ต่อได้ทันที',
        ];
        touched = true;
      }
      if (fiction) {
        if (!s.pov_character) { s.pov_character = parsed?.cast?.[0]?.name || 'ตัวละครหลัก'; touched = true; }
        if (!s.scene_goal) { s.scene_goal = `สิ่งที่ตัวละครต้องการในฉาก “${s.title || ''}”`; touched = true; }
        if (!s.conflict) { s.conflict = 'แรงต้านที่ขวางเป้าหมายของฉากนี้'; touched = true; }
        if (!s.turn) { s.turn = 'จุดเปลี่ยนที่ทำให้ฉากถัดไปจำเป็นต้องเกิด'; touched = true; }
      }
      if (touched) fixed.push(s.id || '?');
    }
  }
  return fixed;
}

const PLACEMENT_LABEL = { top: 'ต้นตอน', middle: 'กลางตอน', bottom: 'ท้ายตอน' };

/**
 * ความเข้มของลวดลายพื้นหลังหลังผสมกับกระดาษขาว
 * เกินกว่านี้เริ่มแย่งสายตากับเนื้อหา และเปลืองหมึกทั้งเล่มโดยไม่ได้อะไรกลับมา
 */
export const PATTERN_ALPHA = { soft: 0.04, medium: 0.07, strong: 0.1 };

/** มม. → พิกเซลที่ 300 dpi ตัวเลขที่เอาไปตั้งขนาดในเครื่องมือสร้างภาพอื่นได้ตรง ๆ */
const px300 = (mm) => (mm ? Math.round((Number(mm) / 25.4) * 300) : 0);

/**
 * บอกว่าภาพนี้ไปอยู่ตรงไหนของเล่ม ด้วยภาษาที่คนอ่านแล้วเห็นภาพ
 *
 * ชื่อไฟล์อย่าง fig-2.3-1.png บอกตำแหน่งจริงอยู่แล้วในเชิงระบบ แต่คนที่จะไปสร้างภาพเอง
 * ต้องรู้ว่ามันคือ "ภาพแรกของตอน 2.3 ชื่ออะไร อยู่ในบทไหน วางช่วงไหนของตอน"
 * ไม่งั้นได้ภาพสวยแต่วางผิดที่ แล้วต้องมานั่งไล่จับคู่ใหม่ทีหลัง
 */
function describeFigurePlacement(book, f) {
  const sectionId = f.section || '';
  let chapter = null;
  let section = null;
  for (const c of book.outline?.chapters || []) {
    const hit = (c.sections || []).find((s) => String(s.id) === String(sectionId));
    if (hit) {
      chapter = c;
      section = hit;
      break;
    }
  }
  const nth = String(f.id || '').split('-').pop();
  const parts = [];
  if (chapter) parts.push(`บทที่ ${chapter.n} “${chapter.title}”`);
  parts.push(section ? `ตอน ${sectionId} “${section.title}”` : `ตอน ${sectionId}`);
  parts.push(`${PLACEMENT_LABEL[f.placement] || 'กลางตอน'}${nth && nth !== '1' ? ` · ภาพที่ ${nth} ของตอนนี้` : ''}`);
  return parts.join(' › ');
}

export function plannedImageJobs(book) {
  const jobs = [];
  const bleed = Number(book.trim?.bleedMm) || 3;
  const coverW = (Number(book.trim?.widthMm) || 148) + bleed;
  const coverH = (Number(book.trim?.heightMm) || 210) + bleed * 2;
  const coverRatio = `${Math.round(coverW * 10)}:${Math.round(coverH * 10)}`;

  if (book.coverMode === 'auto' && book.coverPrompts) {
    const baked = P.coverTextBaked(book);

    /**
     * เขียน prompt ปกใหม่จากแนวที่เลือกไว้ทุกครั้ง แทนการใช้ของที่แช่ไว้ตั้งแต่ Phase 1
     *
     * book.coverPrompts ถูกสร้างครั้งเดียวตอนปรึกษา Art Director แล้วไม่เคยอัปเดตอีก
     * พอผู้ใช้สลับ "ตัวหนังสือบนปก" หรือเปลี่ยนแนวปกทีหลัง prompt ที่ส่งจริงยังเป็นของเก่า
     * ผลคือสั่งให้วาดตัวหนังสือมาในภาพ แต่ ChatGPT ได้คำสั่งเดิมว่า "ห้ามมีตัวอักษรใด ๆ"
     * แล้วส่งปกที่เป็นผนังว่างเปล่ากลับมา ซึ่งคือสิ่งที่เกิดขึ้นจริง
     */
    const frontPrompt = book.style ? P.frontCoverPrompt(book.style, book, book.outline || {}) : book.coverPrompts.front;
    const backPrompt = book.style ? P.backCoverPrompt(book.style, book) : book.coverPrompts.back;
    // ปกหน้าแบบ baked ต้องมีตัวหนังสือ ส่วนปกหลังยังเป็น artwork เปล่าเสมอ (ระบบวางเนื้อหาปกหลังเอง)
    const sizeRule = `\n\nOUTPUT SIZE RULE: compose for exactly ${coverW.toFixed(1)} × ${coverH.toFixed(1)} mm (${coverRatio}, portrait). Keep all important objects inside the central 86%.`;
    const noTextRule = `${sizeRule} Artwork only, no typography. Absolutely no readable text anywhere: papers, signs, screens, labels and receipts must be blank or use abstract non-letter marks. The system will typeset the real title and author later.`;
    const frontRule = baked ? sizeRule : noTextRule;
    jobs.push({
      name: 'cover-front.png',
      prompt: frontPrompt + frontRule,
      what: 'ปกหน้า',
      where: `หน้าปกด้านหน้าของเล่ม · แนวตั้งเต็มหน้า${baked ? ' · มีชื่อหนังสือวาดอยู่ในภาพ' : ' · ไม่มีตัวอักษร ระบบเรียงพิมพ์ทับให้ทีหลัง'}`,
      spec: `${coverW.toFixed(1)}×${coverH.toFixed(1)} มม. · ${coverRatio} · ${px300(coverW)}×${px300(coverH)} px ที่ 300dpi · ภาพสี`,
      widthMm: coverW,
      heightMm: coverH,
      aspect: coverRatio,
      grayscale: false,
      kind: 'cover',
    });
    /**
     * ปกหลังเคยถูกต่อท้ายด้วย "ห้ามมีตัวอักษรใด ๆ" เสมอ แม้ตัว prompt จะเพิ่งสั่งให้
     * วาดคำโปรยลงไปในภาพ คำสั่งสองอันขัดกันเอง โมเดลเลือกทางที่ไม่วาดข้อความ
     * แล้วองค์ประกอบก็สั่งให้เว้นกลางปกไว้ ผลคือได้ปกหลังเป็นหน้ากระดาษเปล่า
     * ซ้ำร้ายระบบยังปักธงว่า "วาดข้อความมาแล้ว" เครื่องเรียงพิมพ์จึงไม่พิมพ์ทับให้ด้วย
     */
    const backBaked = P.backCoverTextBaked(book);
    jobs.push({
      name: 'cover-back.png',
      prompt: backPrompt + (backBaked ? sizeRule : noTextRule),
      what: 'ปกหลัง',
      where: `หน้าปกด้านหลังของเล่ม · แนวตั้งเต็มหน้า${backBaked ? ' · มีคำโปรยวาดอยู่ในภาพ' : ' · ไม่มีตัวอักษร ระบบวางเนื้อหาปกหลังทับให้ทีหลัง'}`,
      spec: `${coverW.toFixed(1)}×${coverH.toFixed(1)} มม. · ${coverRatio} · ${px300(coverW)}×${px300(coverH)} px ที่ 300dpi · ภาพสี`,
      widthMm: coverW,
      heightMm: coverH,
      aspect: coverRatio,
      grayscale: false,
      kind: 'cover',
    });
  }
  /**
   * ลวดลายพื้นหลังเป็นภาพ "ของทั้งเล่ม" ไม่ใช่ของตอนใดตอนหนึ่ง
   * จึงไม่มีช่องขนาดตายตัวแบบภาพประกอบ ใช้สัดส่วนหน้ากระดาษจริงเป็นเป้า
   */
  if (book.pagePattern && book.pagePattern !== 'none' && book.style) {
    const pw = Number(book.trim?.widthMm) || 148;
    const ph = Number(book.trim?.heightMm) || 210;
    jobs.push({
      name: 'page-pattern.png',
      prompt: P.pagePatternPrompt(book.style, book),
      what: 'ลวดลายพื้นหลังทั้งเล่ม',
      where: `พิมพ์จาง ๆ ใต้ตัวหนังสือทุกหน้าของเล่ม · ความเข้ม ${Math.round((PATTERN_ALPHA[book.pagePattern] || 0.04) * 100)}%`,
      spec: `${pw}×${ph} มม. · เต็มหน้ากระดาษ · ระบบลดความเข้มให้เองก่อนบันทึก`,
      widthMm: pw,
      heightMm: ph,
      aspect: `${Math.round(pw * 10)}:${Math.round(ph * 10)}`,
      grayscale: false,
      kind: 'pattern',
      patternAlpha: PATTERN_ALPHA[book.pagePattern] || 0.04,
    });
  }

  if (book.figureMode === 'auto') {
    for (const f of book.figures || []) {
      if (f.kind !== 'image' || !f.prompt) continue;
      const grayscale = !P.figureColorOn(book);
      jobs.push({
        name: f.name,
        prompt: f.prompt,
        what: `ภาพตอน ${f.section}`,
        where: describeFigurePlacement(book, f),
        caption: f.caption || f.subject || '',
        spec: [
          f.widthMm ? `${f.widthMm}×${f.heightMm || 45} มม.` : null,
          f.aspect || null,
          f.widthMm ? `${px300(f.widthMm)}×${px300(f.heightMm || 45)} px ที่ 300dpi` : null,
          `กว้าง ${f.widthPct || 80}% ของหน้ากระดาษ`,
          grayscale ? 'ขาวดำ' : 'ภาพสี',
        ]
          .filter(Boolean)
          .join(' · '),
        widthMm: f.widthMm || null,
        heightMm: f.heightMm || 45,
        aspect: f.aspect || null,
        grayscale,
        kind: 'interior',
      });
    }
  }
  /**
   * กฎเรื่องรูปอ้างอิงต้องติดไปกับ prompt ตั้งแต่ตรงนี้ ไม่ใช่ไปต่อท้ายตอนจะส่ง
   *
   * prompt ชุดเดียวกันนี้ถูกใช้สามทาง: เครื่องส่งเอง, ปุ่มส่งออกไฟล์ Prompt ทั้งหมด
   * และช่องแสดง prompt รายรูปในหน้า Phase 2 ถ้าต่อท้ายตอนส่งอย่างเดียว
   * คนที่เอา Prompt ไปวาดที่อื่นจะไม่มีวันรู้ว่าต้องแนบรูปผู้เขียนไปด้วย
   */
  return jobs.map((j) => (wantsAuthorRef(book, j) ? { ...j, prompt: j.prompt + AUTHOR_REF_RULE, needsAuthorRef: true } : j));
}

/**
 * ตรวจ asset ก่อนถือว่า "ผ่าน" Phase 2
 * - ต้องมี blob และไม่ใช่ไฟล์ว่าง
 * - browser ต้อง decode เป็นภาพได้จริง
 * - ถ้ามีขนาดช่องล็อกไว้ ภาพหลัง normalize ต้องตรง pixel 300 dpi ที่คำนวณไว้
 */
async function validatePhase2Asset(asset, job) {
  if (!asset?.blob) return { ok: false, reason: 'ไม่พบไฟล์ภาพ' };
  if (!asset.blob.size || asset.blob.size < 1024) return { ok: false, reason: `ไฟล์เล็กผิดปกติ (${asset.blob.size || 0} bytes)` };

  let bmp;
  try {
    bmp = await createImageBitmap(asset.blob);
  } catch (e) {
    return { ok: false, reason: `เปิดไฟล์ภาพไม่ได้: ${e?.message || e}` };
  }

  try {
    if (!bmp.width || !bmp.height) return { ok: false, reason: 'ภาพมีขนาด 0×0' };
    if (job?.widthMm && job?.heightMm) {
      const expectedW = Math.max(1, Math.round((job.widthMm / 25.4) * 300));
      const expectedH = Math.max(1, Math.round((job.heightMm / 25.4) * 300));
      if (bmp.width !== expectedW || bmp.height !== expectedH) {
        return { ok: false, reason: `ขนาด ${bmp.width}×${bmp.height}px ไม่ตรงช่อง ${expectedW}×${expectedH}px` };
      }
    }
    return { ok: true, width: bmp.width, height: bmp.height };
  } finally {
    bmp.close?.();
  }
}

/**
 * ตรวจไฟล์ดิบก่อน crop/resize เพราะการบังคับภาพแนวตั้งให้เป็นช่องแนวนอน
 * อาจทำให้ไฟล์มีจำนวนพิกเซลถูกต้อง แต่เนื้อหาถูกตัดจนใช้จริงไม่ได้
 */
async function validateGeneratedSource(blob, job) {
  if (!blob?.size) return { ok: false, reason: 'ไฟล์ภาพว่าง' };
  const bmp = await createImageBitmap(blob);
  try {
    if (!bmp.width || !bmp.height) return { ok: false, reason: 'ภาพมีขนาด 0×0' };
    if (!job?.widthMm || !job?.heightMm) return { ok: true };

    /**
     * ลวดลายพื้นหลังไม่มีเรื่องสัดส่วน
     *
     * มันคือพื้นผิวที่กระจายเท่ากันทั้งผืน จะครอปจากด้านไหนก็ยังเป็นลายเดิม
     * การบังคับให้ตรงสัดส่วนหน้ากระดาษจึงไม่ได้ปกป้องอะไร มีแต่จะปฏิเสธภาพที่ใช้ได้จริง
     * เครื่องมือสร้างภาพคืนได้แค่ 1:1, 3:2, 2:3 ส่วนหน้ากระดาษ A5 คือ 0.70
     * ถ้ามันคืนแนวนอนมา (1.5) จะคิดเป็น "ต้องตัดทิ้ง 53%" แล้วตกทันทีทุกครั้ง
     * — เสียหนึ่งข้อความต่อหนึ่งรอบไปกับภาพที่ไม่มีอะไรผิดเลย
     */
    if (job.kind === 'pattern') return { ok: true, crop: 0 };

    const expected = job.widthMm / job.heightMm;
    const actual = bmp.width / bmp.height;

    /**
     * วัด "จะต้องตัดทิ้งกี่เปอร์เซ็นต์" ไม่ใช่ "สัดส่วนเพี้ยนกี่เปอร์เซ็นต์"
     *
     * ขั้นถัดไป (normalizeGeneratedImage) crop แบบ center-cover อยู่แล้ว และ Typst
     * ก็ crop ซ้ำตอนวางลงหน้าอีกที ตัวตรวจที่ปฏิเสธเพราะ "ไม่ยอม crop" จึงขัดกับ
     * ระบบของตัวเองที่ crop ทุกภาพอยู่แล้ว
     *
     * สิ่งที่ควรกันจริง ๆ มีอย่างเดียว: ภาพที่ถ้า crop แล้วองค์ประกอบจะพังทั้งภาพ
     * เช่นภาพแนวตั้งถูกยัดลงช่องแนวนอน (ตัดทิ้งเกินครึ่ง) ส่วนจัตุรัส → 3:2 ตัดทิ้ง 33%
     * เป็นการ crop ปกติที่ช่างภาพทำทุกวัน ไม่ใช่ความผิดพลาดที่ต้องกลบ
     */
    const loss = 1 - Math.min(actual, expected) / Math.max(actual, expected);
    const shape = (r) => (r > 1.15 ? 'แนวนอน' : r < 0.87 ? 'แนวตั้ง' : 'ใกล้จัตุรัส');
    if (loss > 0.48) {
      return {
        ok: false,
        reason: `ต้นฉบับ ${bmp.width}×${bmp.height}px (${shape(actual)}) ต้องตัดทิ้ง ${Math.round(loss * 100)}% เพื่อลงช่อง ${job.aspect || `${job.widthMm}:${job.heightMm}`} (${shape(expected)}) — มากเกินกว่าที่ภาพจะเหลือความหมาย ต้องสั่งวาดใหม่ให้ได้แนวที่ถูก`,
      };
    }
    return { ok: true, crop: loss };
  } finally {
    bmp.close?.();
  }
}

/**
 * บังคับไฟล์ที่ ChatGPT ส่งกลับมาให้ตรง "ช่องจริง" ก่อนบันทึก
 * ไม่เชื่อ aspect ratio ของไฟล์ต้นทาง เพราะ image model อาจคืน 1:1 แม้ prompt ขอแนวตั้ง
 * ใช้ center-cover crop แล้ว resize เป็น 300 dpi ตามขนาดพิมพ์ เพื่อให้ Typst ไม่ต้องเดาขนาดอีก
 */
async function normalizeGeneratedImage(blob, job) {
  if (!job?.widthMm || !job?.heightMm) return { blob, meta: {} };

  const bmp = await createImageBitmap(blob);
  const srcW = bmp.width;
  const srcH = bmp.height;
  const targetW = Math.max(1, Math.round((job.widthMm / 25.4) * 300));
  const targetH = Math.max(1, Math.round((job.heightMm / 25.4) * 300));
  const targetRatio = targetW / targetH;
  const srcRatio = srcW / srcH;

  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  if (srcRatio > targetRatio) {
    sw = Math.round(srcH * targetRatio);
    sx = Math.round((srcW - sw) / 2);
  } else if (srcRatio < targetRatio) {
    sh = Math.round(srcW / targetRatio);
    sy = Math.round((srcH - sh) / 2);
  }

  const effectiveDpi = Math.round(
    Math.min(sw / (job.widthMm / 25.4), sh / (job.heightMm / 25.4)),
  );
  const cv = new OffscreenCanvas(targetW, targetH);
  const cx = cv.getContext('2d');
  cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, targetW, targetH);

  /**
   * ลวดลายพื้นหลังต้องถูกลดความเข้มตั้งแต่ตอนบันทึกไฟล์ ไม่ใช่ไปหวังพึ่งเครื่องเรียงพิมพ์
   *
   * Typst ไม่มีคำสั่งลดความทึบของภาพให้ใช้ตรง ๆ และการหวังให้โมเดลวาดจางพอเองไม่เคยได้ผล
   * มันวาดลายสวยแต่เข้มเสมอ ผสมกับกระดาษขาวตรงนี้จึงคุมได้แน่นอนและเห็นผลก่อนพิมพ์
   */
  if (job.kind === 'pattern') {
    const alpha = Math.min(0.25, Math.max(0.01, Number(job.patternAlpha) || 0.04));
    const d = cx.getImageData(0, 0, targetW, targetH);
    for (let i = 0; i < d.data.length; i += 4) {
      d.data[i] = Math.round(255 + (d.data[i] - 255) * alpha);
      d.data[i + 1] = Math.round(255 + (d.data[i + 1] - 255) * alpha);
      d.data[i + 2] = Math.round(255 + (d.data[i + 2] - 255) * alpha);
      d.data[i + 3] = 255;
    }
    cx.putImageData(d, 0, 0);
  }

  if (job.grayscale) {
    const d = cx.getImageData(0, 0, targetW, targetH);
    for (let i = 0; i < d.data.length; i += 4) {
      const g = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = g;
    }
    cx.putImageData(d, 0, 0);
  }

  /**
   * ภาพนี้มีสีจริงไหม — ตรวจตอนนี้ ไม่ใช่ไปเดาตอนเปิด PDF
   *
   * ปกที่ควรเป็นสีแต่ออกมาขาวดำในไฟล์จบ แกะย้อนหลังยากมาก
   * เพราะไม่รู้ว่าสีหายตั้งแต่ ChatGPT วาด ตอนอัปโหลด หรือตอนประกอบเล่ม
   * บันทึกไว้ตั้งแต่ตอนบันทึกไฟล์ แล้วหน้าจอค่อยเตือนได้ว่าภาพนี้ไม่มีสีมาตั้งแต่ต้นทาง
   */
  let hasColour = false;
  try {
    const probe = cx.getImageData(0, 0, targetW, targetH).data;
    const step = Math.max(4, Math.floor(probe.length / 4 / 4000) * 4);
    for (let i = 0; i < probe.length; i += step) {
      const r = probe[i];
      const g = probe[i + 1];
      const b = probe[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 12) {
        hasColour = true;
        break;
      }
    }
  } catch (_) {
    hasColour = !job.grayscale;
  }

  const out = await cv.convertToBlob({ type: 'image/png' });
  bmp.close?.();
  return {
    blob: out,
    meta: {
      hasColour,
      sourceWidthPx: srcW,
      sourceHeightPx: srcH,
      crop: { sx, sy, sw, sh },
      widthPx: targetW,
      heightPx: targetH,
      effectiveDpi,
      resizedTo300Dpi: true,
    },
  };
}

/**
 * ขอได้เฉพาะสัดส่วนที่เครื่องมือสร้างภาพของ ChatGPT วาดออกมาได้จริง
 *
 * มันคืนได้แค่สามแบบ: 1024×1024 (1:1), 1536×1024 (3:2) และ 1024×1536 (2:3)
 * ของเดิมเปิดให้ช่องเป็น 4:3 กับ 16:9 ซึ่งไม่มีทางตรงกับอะไรเลย
 * 16:9 (1.78) ที่ใกล้สุดคือ 3:2 (1.5) ยังเพี้ยน 16% ซึ่งเกินเกณฑ์ตัวตรวจไฟล์
 * ผลคือภาพในเล่มถูกปฏิเสธทุกรูปตั้งแต่ก่อนเริ่ม ไม่ว่า ChatGPT จะวาดดีแค่ไหน
 * — ช่องที่ขอสิ่งที่เป็นไปไม่ได้ ไม่ใช่มาตรฐาน แต่เป็นกับดัก
 */
const NATIVE_ASPECTS = { '3:2': 3 / 2, '1:1': 1, '2:3': 2 / 3 };

function normalizeFigureAspect(value) {
  if (Object.prototype.hasOwnProperty.call(NATIVE_ASPECTS, value)) {
    return { label: value, ratio: NATIVE_ASPECTS[value] };
  }
  // ค่าเก่า (4:3, 16:9) และค่าแปลก ๆ ให้เกาะสัดส่วนที่วาดได้ซึ่งใกล้ที่สุด
  const legacy = { '4:3': 4 / 3, '16:9': 16 / 9, '1:1': 1, '2:3': 2 / 3 }[value];
  const want = legacy || 4 / 3;
  let label = '3:2';
  let best = Infinity;
  for (const [k, r] of Object.entries(NATIVE_ASPECTS)) {
    const d = Math.abs(Math.log(r / want));
    if (d < best) {
      best = d;
      label = k;
    }
  }
  return { label, ratio: NATIVE_ASPECTS[label] };
}

/**
 * ลายนิ้วมือของภาพแบบเบา ๆ — ไม่ต้องถอดรหัส base64 ทั้งก้อนซึ่งอาจใหญ่หลาย MB
 * เอาความยาวรวมกับชิ้นส่วนหัว/กลาง/ท้ายก็แยกภาพคนละรูปได้ขาดแล้วในทางปฏิบัติ
 */
function imageFingerprint(dataUrl) {
  const s = String(dataUrl || '');
  const mid = Math.floor(s.length / 2);
  return `${s.length}|${s.slice(0, 96)}|${s.slice(mid, mid + 96)}|${s.slice(-96)}`;
}

class Halt extends Error {}
class RateLimited extends Error {}

/**
 * แทรกภาพหรือกล่องไว้ราวสองในสามของตอน ไม่ใช่ห้อยท้าย
 * เพราะภาพที่อยู่ท้ายสุดของตอนมักไปโผล่หัวหน้าถัดไปแล้วดูหลุด
 * ผู้ใช้ย้ายเองได้ทีหลังด้วยการตัดแปะข้อความในโหมดแก้ไข
 */
function insertFigureAt(md, marker, placement = 'middle') {
  const parts = String(md).split(/\n{2,}/);
  if (parts.length < 3) return `${md.trim()}\n\n${marker}`;
  const ratio = { after_intro: 0.25, middle: 0.55, before_conclusion: 0.82 }[placement] || 0.55;
  const at = Math.min(parts.length - 1, Math.max(1, Math.round(parts.length * ratio)));
  parts.splice(at, 0, marker);
  return parts.join('\n\n');
}

function cmpItem(a, b) {
  const [a1, a2] = String(a).split('.').map(Number);
  const [b1, b2] = String(b).split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

function stripFence(t) {
  return String(t || '').replace(/^```[\w]*\s*/m, '').replace(/```\s*$/m, '');
}

/** ข้อความตัวอย่างสำหรับ calibration — ต้องเป็นแนวเดียวกับหนังสือจริง */
function buildSample(lang) {
  const th = `รายได้ที่ไม่เข้าทุกเดือนไม่ได้แปลว่าวางแผนไม่ได้ แต่แปลว่าเครื่องมือที่ใช้กันทั่วไปนั้นออกแบบมาสำหรับคนที่มีเงินเดือน เมื่อเอามาใช้กับคนที่รายได้ขึ้นลงจึงพังตั้งแต่สมมติฐานแรก งบรายเดือนตั้งอยู่บนความเชื่อว่ารายรับกับรายจ่ายเกิดขึ้นในจังหวะเดียวกัน ซึ่งไม่จริงสำหรับฟรีแลนซ์ที่ได้เงินก้อนเดียวแล้วต้องใช้ไปอีกสามเดือน`;
  const en = `Income that does not arrive every month is not income that cannot be planned. It only means the ordinary tools were designed for people on a salary, and they break at the first assumption when you hand them to someone whose income moves. A monthly budget assumes money comes in and goes out on the same rhythm.`;
  const unit = lang === 'th' ? th : en;
  const text = Array.from({ length: 40 }, (_, i) => unit + (i % 4 === 3 ? '\n\n' : ' ')).join('');
  return { text, units: countUnits(text, lang) };
}
