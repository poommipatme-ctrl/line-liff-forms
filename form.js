/*
 * ตรรกะของหน้าฟอร์ม (ไม่แตะ DOM) — ถอด payload และประกอบข้อความ · ทดสอบด้วย `npm test`
 *
 * ⚠️ สัญญากับบอท (line-group-bot · src/line/liff-form.ts):
 *   f=<base64url(JSON อาร์เรย์ช่องตัวเลข)>                       — ช่องตัวเลขล้วน (รูปเดิม)
 *   z=<ความยาว>.<base64url(deflate-raw(JSON {v, fields, maxLen?}))> — มีช่องรายการ
 *   ข้อความที่ส่งเข้าแชท = รูปเดียวกับที่ผู้ใช้พิมพ์เอง · บอทเป็นผู้ตัดสินค่าตัวเดียว
 * ⚠️ test/fixtures.json สร้างจากฝั่งบอท (npm run liff:fixtures) — buildMessage ต้องได้ข้อความตรงเป๊ะ
 */
import inflate from './vendor/tiny-inflate.js';

export const MAX_FIELDS = 10;
export const MAX_OPTIONS = 60;
export const MAX_LABEL = 80;
/** เพดานขนาดหลังคลาย — กันลิงก์ที่ใครก็สร้างได้มาจองหน่วยความจำก้อนใหญ่ */
export const MAX_Z_BYTES = 20000;
const ITEMS = ['{v} {q}', '{q}x{v}', '{v}x{q}'];
const JOIN = ' + ';

function b64ToBytes(s) {
  let b = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b.length % 4) b += '=';
  return Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
}

/** อ่าน f / z — มาได้ทั้งใน query ปกติ หรือยังห่ออยู่ใน liff.state */
export function readParams(search) {
  const q = new URLSearchParams(search);
  let f = q.get('f');
  let z = q.get('z');
  const state = q.get('liff.state');
  if (!f && !z && state) {
    const inner = new URLSearchParams(state.slice(state.indexOf('?') + 1));
    f = inner.get('f');
    z = inner.get('z');
  }
  return { f, z };
}

const str = (x) => String(x ?? '').slice(0, MAX_LABEL);

function cleanNum(x) {
  return {
    label: str(x.label),
    unit: x.unit === undefined ? '' : str(x.unit),
    optional: x.optional === true,
    integer: x.integer === true,
    min: typeof x.min === 'number' ? x.min : undefined,
    max: typeof x.max === 'number' ? x.max : undefined,
    prefix: typeof x.prefix === 'string' ? x.prefix.slice(0, 4) : '',
  };
}

function cleanField(x) {
  if (x === null || typeof x !== 'object') return null;
  if (x.kind !== 'list') return cleanNum(x);
  if (!Array.isArray(x.options) || x.options.length === 0 || x.options.length > MAX_OPTIONS) return null;
  if (!ITEMS.includes(x.item)) return null;
  return {
    kind: 'list',
    label: str(x.label),
    unit: x.unit === undefined ? '' : str(x.unit),
    options: x.options.map((o) =>
      Array.isArray(o) ? { label: str(o[0]), value: str(o[1]) } : { label: str(o), value: str(o) },
    ),
    qty: cleanNum(x.qty ?? {}),
    item: x.item,
  };
}

/** ถอด payload — คืน `{ fields, maxLen }` หรือ `null` ถ้าอ่านไม่ได้ (ไม่ throw) */
export function decodePayload({ f, z }) {
  try {
    let obj;
    if (z) {
      const dot = z.indexOf('.');
      const len = Number(z.slice(0, dot));
      if (dot < 1 || !Number.isInteger(len) || len <= 0 || len > MAX_Z_BYTES) return null;
      const out = inflate(b64ToBytes(z.slice(dot + 1)), new Uint8Array(len));
      obj = JSON.parse(new TextDecoder('utf-8').decode(out));
    } else if (f) {
      obj = { fields: JSON.parse(new TextDecoder('utf-8').decode(b64ToBytes(f))) };
    } else {
      return null;
    }
    const list = obj?.fields;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_FIELDS) return null;
    const fields = list.map(cleanField);
    if (fields.some((x) => x === null)) return null;
    const maxLen = typeof obj.maxLen === 'number' && obj.maxLen > 0 ? obj.maxLen : null;
    return { fields, maxLen };
  } catch {
    return null;
  }
}

/**
 * ประกอบข้อความ — values[i]: ช่องตัวเลข = สตริงจากช่องกรอก · ช่องรายการ = [{ value, qty }]
 * ช่องตัวเลข optional ท้ายที่ว่างตัดทิ้ง · แถวรายการที่ว่างทั้งแถวข้าม · `null` = ยังกรอกไม่ครบ/ไม่ถูกต้อง
 */
export function buildMessage(fields, values) {
  const emptyNum = (i) => fields[i].kind !== 'list' && String(values[i] ?? '').trim() === '';
  let last = fields.length - 1;
  while (last >= 0 && emptyNum(last) && fields[last].optional) last -= 1;
  const parts = [];
  for (let i = 0; i <= last; i += 1) {
    const f = fields[i];
    if (f.kind === 'list') {
      const rows = (values[i] ?? []).filter((r) => !(r.value === '' && String(r.qty ?? '').trim() === ''));
      if (rows.length === 0) return null;
      const out = [];
      for (const r of rows) {
        const q = String(r.qty ?? '').trim();
        const n = Number(q);
        if (r.value === '' || q === '' || !Number.isFinite(n)) return null;
        if (!f.options.some((o) => o.value === r.value)) return null;
        out.push(f.item.replace('{v}', () => r.value).replace('{q}', () => String(n)));
      }
      parts.push(out.join(JOIN));
    } else {
      const s = String(values[i] ?? '').trim();
      const n = Number(s);
      if (s === '' || !Number.isFinite(n)) return null;
      parts.push(f.prefix + String(n));
    }
  }
  return parts.length === 0 ? null : parts.join(' ');
}

/** ยาวเกินเพดานที่บอทนับเป็นคำตอบไหม — นับแบบเดียวกับบอท (code point ไม่ใช่ UTF-16) */
export const tooLong = (msg, maxLen) => maxLen !== null && msg !== null && [...msg].length > maxLen;
