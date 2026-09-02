/**
 * เขียนเนื้อหาผ่าน OpenAI API — ทางเลือกแทนการขับหน้าเว็บ ChatGPT
 *
 * ทำไมถึงต้องมีทางนี้
 *   ทางขับหน้าเว็บฟรีจริง แต่ต้องพึ่งช่องพิมพ์ ปุ่มส่ง ตัวตรวจจับว่าตอบจบ และการอ่าน
 *   คำตอบจาก DOM ทุกชิ้นคือการเดาจากหน้าตาเว็บที่ OpenAI เปลี่ยนเมื่อไรก็ได้
 *   และมันยังกินเวลาต่อเทิร์นมากกว่า เพราะต้องรอหน้าเว็บพิมพ์ทีละตัวอักษรจนจบ
 *
 *   ทางนี้ส่ง HTTP แล้วได้ข้อความกลับมาตรง ๆ เร็วกว่า เสถียรกว่า ไม่มีลิมิตข้อความ
 *   ต่อสามชั่วโมงแบบแพ็กเกจรายเดือน และไม่เสี่ยงต่อบัญชี ChatGPT ของผู้ใช้
 *   แลกกับการจ่ายตามจำนวน token ที่ใช้จริง
 *
 * ทำไมเทิร์นถึงไม่ต้องจำบทสนทนา
 *   ระบบนี้ออกแบบให้ทุก prompt เล่าบริบทของตัวเองครบตั้งแต่แรก (Book Bible, สรุปตอนก่อนหน้า,
 *   ข้อความดิบของเทิร์นที่ต้องเขียนต่อ) เพราะทางขับหน้าเว็บสลับเธรดได้ตลอด
 *   ข้อจำกัดนั้นกลายเป็นข้อได้เปรียบตรงนี้ — ยิงทีละเทิร์นแบบไม่มีสถานะได้เลย
 *   ไม่ต้องสะสมประวัติแชทที่ยิ่งยาวยิ่งแพงและยิ่งทำให้โมเดลไขว้เขว
 *
 * ตั้ง baseUrl เองได้ จึงชี้ไปที่บริการอื่นที่พูดภาษาเดียวกับ OpenAI ได้ด้วย
 * (เช่น โมเดลที่รันในเครื่องผ่าน Ollama หรือ LM Studio) โดยไม่ต้องแก้โค้ดตรงนี้
 */

import { DEFAULT_TEXT_MODEL } from '../core/pricing.js';

const DEFAULT_BASE = 'https://api.openai.com/v1';

// ชื่อโมเดลตั้งต้นอยู่ที่เดียวกับตารางราคา จะได้ไม่มีวันหลุดจากกัน
export { DEFAULT_TEXT_MODEL };

/**
 * แปลงข้อผิดพลาดของเซิร์ฟเวอร์เป็นประโยคที่บอกว่าต้องไปแก้ตรงไหน
 * ข้อความดิบของ API บอกถูกแต่ไม่ได้บอกว่าผู้ใช้ต้องทำอะไรต่อ
 */
function apiErrorMessage(status, body) {
  const detail = body?.error?.message || body?.message || '';
  if (/model/i.test(detail) && /not (found|exist)|does not exist|unknown|invalid/i.test(detail))
    return `ไม่มีโมเดลชื่อนี้ในบัญชี — เปลี่ยนชื่อโมเดลในช่องตั้งค่า (${detail})`;
  if (status === 401) return 'API key ไม่ถูกต้องหรือหมดอายุ — ตรวจคีย์ในหน้าตั้งค่า';
  if (status === 403) return `บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้โมเดลนี้${detail ? ` (${detail})` : ''}`;
  if (status === 429) return detail || 'ยิงถี่เกินไปหรือเครดิตหมด';
  if (status >= 500) return `เซิร์ฟเวอร์ขัดข้อง (${status})${detail ? ` — ${detail}` : ''}`;
  return detail || `เรียก API ไม่สำเร็จ (HTTP ${status})`;
}

export class OpenAiApiTransport {
  constructor(opts = {}) {
    this.apiKey = String(opts.apiKey || '').trim();
    this.model = String(opts.model || DEFAULT_TEXT_MODEL).trim() || DEFAULT_TEXT_MODEL;
    this.baseUrl = String(opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 300000;
    this.onProgress = opts.onProgress || (() => {});
  }

  get kind() {
    return 'openai_api';
  }

  /**
   * สัญญาเดียวกับ transport ตัวอื่นทุกประการ ส่วนอื่นของระบบจึงไม่ต้องรู้ว่ากำลังใช้ทางไหน
   * @returns {Promise<{status:string,text:string,meta?:object}>}
   *  status: ok | empty | rate_limited | error | timeout
   */
  async send(prompt, opts = {}) {
    if (!this.apiKey) {
      return { status: 'error', text: '', meta: { error: 'ยังไม่ได้ใส่ OpenAI API key' } };
    }
    /**
     * เทิร์นที่ขอภาพต้องไม่มาทางนี้
     *
     * การสร้างภาพมีเส้นทางของตัวเองอยู่แล้วที่ core/imageApi.js ซึ่งใช้ Images API คนละตัวกัน
     * ถ้าปล่อยให้เทิร์นภาพหลุดมาที่นี่ จะได้ข้อความบรรยายภาพกลับไปแทนไฟล์ภาพ
     * แล้วระบบจะบันทึกมันเป็น "ภาพที่สร้างไม่สำเร็จ" โดยไม่มีใครรู้ว่าทำไม
     */
    if (opts.wantImages) {
      return {
        status: 'error',
        text: '',
        meta: { error: 'ทางนี้ใช้เขียนข้อความเท่านั้น — ให้ตั้งแหล่งสร้างภาพเป็น OpenAI API หรือสร้างภาพเอง' },
      };
    }

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    this.onProgress?.({ type: 'gpt.progress', phase: 'sending', detail: `ส่งให้ ${this.model}` });

    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok) {
        const message = apiErrorMessage(res.status, body);
        // ชนลิมิตต้องแยกออกจากความผิดพลาดอื่น เพราะระบบหยุดรอคนสั่งทำต่อ ไม่ใช่ลองใหม่เอง
        return {
          status: res.status === 429 ? 'rate_limited' : 'error',
          text: '',
          meta: { error: message, http: res.status },
        };
      }

      const choice = body?.choices?.[0];
      const text = String(choice?.message?.content || '').trim();
      if (!text) {
        return {
          status: 'empty',
          text: '',
          meta: { error: 'โมเดลตอบกลับมาว่าง', finish: choice?.finish_reason || '' },
        };
      }

      return {
        status: 'ok',
        text,
        meta: {
          model: body?.model || this.model,
          ms: Date.now() - startedAt,
          // เก็บจำนวน token ไว้ให้ผู้ใช้เห็นว่าเทิร์นนี้ราคาประมาณเท่าไร
          promptTokens: body?.usage?.prompt_tokens ?? null,
          completionTokens: body?.usage?.completion_tokens ?? null,
          // ตอบไม่จบเพราะชนเพดานความยาว = คำตอบถูกตัด ระบบต้องรู้เพื่อสั่งเขียนต่อ
          truncated: choice?.finish_reason === 'length',
        },
      };
    } catch (e) {
      if (e?.name === 'AbortError') return { status: 'timeout', text: '', meta: { ms: timeoutMs } };
      return { status: 'error', text: '', meta: { error: e?.message || String(e) } };
    } finally {
      clearTimeout(timer);
    }
  }

  /** ตรวจว่าคีย์ใช้ได้และมีโมเดลชื่อนี้จริง ก่อนเริ่มเล่มที่กินเวลาเป็นชั่วโมง */
  async health() {
    if (!this.apiKey) return { ok: false, error: 'ยังไม่ได้ใส่ OpenAI API key' };
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, error: apiErrorMessage(res.status, body) };

      const names = (body?.data || []).map((m) => m?.id).filter(Boolean);
      if (names.length && !names.includes(this.model)) {
        const near = names.filter((n) => /^(gpt|o[0-9]|chatgpt)/i.test(n)).slice(0, 8);
        return {
          ok: false,
          error: `บัญชีนี้ไม่มีโมเดลชื่อ “${this.model}”${near.length ? ` — ที่ใช้ได้เช่น ${near.join(', ')}` : ''}`,
        };
      }
      return { ok: true, model: this.model, models: names.length };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}
