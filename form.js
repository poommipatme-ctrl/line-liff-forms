/*
 * ตรรกะของหน้าฟอร์ม (ไม่แตะ DOM) — ถอด payload และประกอบข้อความ · ทดสอบด้วย `npm test`
 *
 * ⚠️ สัญญากับบอท (line-group-bot · src/line/liff-form.ts):
 *   f=<base64url(JSON อาร์เรย์ช่องตัวเลข)>                       — ช่องตัวเลขล้วน (รูปเดิม)
 *   z=<ความยาว>.<base64url(deflate-raw(JSON {v, fields, maxLen?}))> — มีช่องรายการ/ช่องแบบแถว
 *   ข้อความที่ส่งเข้าแชท = รูปเดียวกับที่ผู้ใช้พิมพ์เอง · บอทเป็นผู้ตัดสินค่าตัวเดียว
 * ⚠️ test/fixtures.json สร้างจากฝั่งบอท (npm run liff:fixtures) — buildMessage ต้องได้ข้อความตรงเป๊ะ
 *
 * ชนิดช่องที่หน้านี้รู้จัก
 *   (ไม่มี kind)   ช่องตัวเลขหนึ่งค่า
 *   kind 'list'    เลือกจากรายการตายตัว + ตัวเลข (ชื่อสุขภัณฑ์ · ขนาดท่อ)
 *   kind 'rows'    **ตัวเลขอิสระ + จำนวน** เพิ่ม/ลบแถวได้ (รายการโหลดของตู้ไฟ)
 * ⚠️ ชนิดที่ไม่รู้จัก = ลิงก์จากบอทรุ่นที่ใหม่กว่าหน้านี้ — **ไม่ใช่ลิงก์เสีย** จึงบอกให้พิมพ์เองแทน
 * (หน้าฟอร์ม deploy แยกจากบอท ลำดับการขึ้นจริงจึงสลับกันได้)
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

/** ค่าที่ cleanField คืนเมื่อ `kind` เป็นชนิดที่หน้านี้ยังไม่รองรับ (ต่างจาก `null` = ลิงก์เสีย) */
export const UNSUPPORTED = 'unsupported-kind';

/** จำนวนหน่วยที่ยอมให้ช่องหนึ่งประกาศ — กันไม่ให้ payload ที่เพี้ยนทำให้หน้าเต็มไปด้วยปุ่ม */
const MAX_UNITS_PER_FIELD = 6;

/**
 * ตรวจรายการหน่วยที่มาจาก payload — คืน `null` เมื่อไม่มี/อ่านไม่ได้ (ถือว่าช่องไม่มีหน่วย)
 *
 * ⚠️ `suffix` คือสิ่งเดียวที่เดินทางเข้าข้อความที่ส่งกลับเข้าตัวอ่านของบอท
 *   ถ้ามันหายหรือผิด ค่าขนาดมอเตอร์จะถูกอ่านเป็นกระแสเงียบ ๆ
 *   ⇒ รับได้เฉพาะสตริง (ว่างได้ — หน่วยเริ่มต้นต้องว่าง) และต้องเป็นสตริงจริง ๆ
 * ⚠️ ไม่เติมค่าแทนสิ่งที่หาย: หน่วยที่ขาดคีย์ใดคีย์หนึ่ง = payload ใช้ไม่ได้ ⇒ `null`
 *   ทั้งก้อน ดีกว่าขึ้นตัวเลือกที่ป้ายว่างหรือ suffix ผิด
 */
function cleanUnits(u) {
  if (!Array.isArray(u) || u.length === 0 || u.length > MAX_UNITS_PER_FIELD) return null;
  const out = [];
  for (const x of u) {
    if (x === null || typeof x !== 'object') return null;
    if (typeof x.id !== 'string' || x.id === '') return null;
    if (typeof x.suffix !== 'string') return null;
    if (typeof x.label !== 'string' || x.label === '') return null;
    if (typeof x.valueLabel !== 'string' || x.valueLabel === '') return null;
    if (typeof x.valueUnit !== 'string' || x.valueUnit === '') return null;
    out.push({ id: x.id, label: x.label, valueLabel: x.valueLabel, valueUnit: x.valueUnit, suffix: x.suffix });
  }
  if (new Set(out.map((x) => x.id)).size !== out.length) return null;
  return out;
}

/**
 * หน่วยของแถว — `null` เมื่อช่องไม่มีหน่วย · `undefined` เมื่อแถวเลือกหน่วยที่ไม่มีในรายการ
 *
 * ⚠️ แถวที่ไม่ระบุหน่วยได้หน่วยแรก (ค่าเริ่มต้น) ตรงกับตัวอ้างอิงฝั่งบอท
 */
export function unitOfRow(f, row) {
  const id = row?.unit;
  const asked = typeof id === 'string' && id !== '';
  if (f.units === null || f.units === undefined) {
    /*
     * ⚠️ ช่องไม่มีหน่วยให้เลือก แต่แถวระบุหน่วยมา ⇒ **ใช้ไม่ได้** ไม่ใช่ "ทิ้งหน่วยแล้วส่งต่อ"
     * การทิ้งเงียบ ๆ คือบั๊กเดียวกับ "5.5 kW ถูกอ่านเป็น 5.5 A" และตัวอ้างอิงฝั่งบอท
     * (`composeFormMessage`) ก็คืน null ในกรณีนี้ — fixtures เป็นตัวผูกให้สองฝั่งตรงกัน
     */
    return asked ? undefined : null;
  }
  if (!asked) return f.units[0];
  return f.units.find((u) => u.id === id);
}

function cleanField(x) {
  if (x === null || typeof x !== 'object') return null;
  if (x.kind === undefined) return cleanNum(x);
  if (x.kind === 'rows') {
    /* ⚠️ รูปของหนึ่งแถวต้องเป็นรูปที่ตัวอ่านของบอทรับอยู่แล้ว — ค่าอยู่ซ้าย จำนวนอยู่ขวา */
    if (x.item !== '{v}x{q}') return null;
    return {
      kind: 'rows',
      label: str(x.label),
      value: cleanNum(x.value ?? {}),
      qty: cleanNum(x.qty ?? {}),
      item: x.item,
      /* เพดานจำนวนตัวรวมที่บอทรับไหว — เกินแล้วหน้านี้ไม่ให้กดส่ง (คู่ขนานกับ maxLen) */
      maxUnits: typeof x.maxUnits === 'number' && x.maxUnits > 0 ? x.maxUnits : null,
      /*
       * หน่วยที่แถวนี้เลือกได้ — `null` = ช่องนี้ไม่มีหน่วยให้เลือก (payload เก่า)
       * ⚠️ `null` ต้องทำให้หน้าฟอร์มทำงาน **เหมือนก่อนมีฟีเจอร์นี้ทุกอย่าง**
       *   (ไม่มีตัวเลือกหน่วย · ข้อความที่ประกอบไม่มี suffix) เพราะปุ่มที่ส่งไปแล้ว
       *   ในแชทของผู้ใช้ยังเปิดหน้านี้อยู่ และบอทรุ่นเก่าไม่ได้ส่ง `units` มา
       */
      units: cleanUnits(x.units),
    };
  }
  if (x.kind !== 'list') return UNSUPPORTED;
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
    /* ⚠️ ชนิดที่ยังไม่รองรับ: บอกแยกจากลิงก์เสีย — หน้านี้จะชวนให้พิมพ์เองแทนที่จะบอกว่าลิงก์ไม่ครบ */
    if (fields.some((x) => x === UNSUPPORTED)) return { fields: null, maxLen: null, unsupported: true };
    const maxLen = typeof obj.maxLen === 'number' && obj.maxLen > 0 ? obj.maxLen : null;
    return { fields, maxLen };
  } catch {
    return null;
  }
}

/**
 * สถานะของหนึ่งแถวในช่องแบบแถว — **ที่เดียว** ที่ตัดสินว่าแถวนั้นใช้ได้ไหม
 * (ทั้งข้อความที่จะส่ง · ข้อความเตือนข้างแถว · การนับจำนวนตัว ใช้ตัวนี้ตัวเดียว)
 *
 *   `{ skip:true, hint }`          ยังไม่ได้กรอกค่าในแถวนี้ — ข้ามได้ถ้ามีแถวอื่นที่ใช้ได้
 *   `{ problem:'...' }`            กรอกครึ่งเดียว/ค่าใช้ไม่ได้ — **ไม่เดาค่าที่ขาดให้**
 *   `{ problem:null, text, units }` ใช้ได้
 *
 * ⚠️ **แถวที่ยังไม่ได้กรอกค่า = ข้าม** (คนกด "เพิ่มแถว" ไว้แล้วไม่ได้ใช้ · ช่องจำนวนมีค่า 1
 * ติดมาให้ตั้งแต่ต้น) แต่ถ้ากรอกจำนวนไว้แล้วไม่มีค่า จะมี `hint` ให้หน้าเว็บบอกว่าแถวนั้น
 * **จะไม่ถูกส่ง** — ไม่ทิ้งเงียบ ๆ และไม่เดาค่าที่ขาดให้
 * ⚠️ ค่า ≤ 0 และจำนวนที่ไม่ใช่จำนวนเต็มบวก = ผิด เพราะรูป `ค่าxจำนวน` ที่ตัวอ่านฝั่งบอทรับ
 * เขียนค่าพวกนั้นออกมาไม่ได้อยู่แล้ว (ฝั่งจำนวนรับแต่เลขจำนวนเต็ม) — ไม่ใช่กติกาใหม่ของหน้านี้
 */
export function rowState(f, row) {
  const v = String(row?.value ?? '').trim();
  const q = String(row?.qty ?? '').trim();
  const a = Number(v);
  const n = Number(q);
  const min = f.qty.min === undefined ? 1 : Math.max(f.qty.min, 1);
  /*
   * ⚠️ หน่วยของแถว — ป้ายในข้อความเตือนก็เปลี่ยนตามหน่วยที่เลือก (เช่น
   * "ขนาดมอเตอร์ต่อตัวต้องมากกว่า 0" ไม่ใช่ "กระแสต่อตัว...") จึงต้องหาก่อนตรวจค่า
   */
  const u = unitOfRow(f, row);
  /*
   * หน่วยที่ไม่อยู่ในรายการของช่อง (หรือช่องไม่มีหน่วยให้เลือกเลย) ⇒ ส่งไม่ได้
   * **ไม่เดาเป็นหน่วยเริ่มต้นและไม่ทิ้งหน่วยทิ้ง** — ดูเหตุผลที่ `unitOfRow()`
   */
  if (u === undefined) return { skip: false, problem: 'หน่วยของแถวนี้ใช้ไม่ได้ — เลือกหน่วยใหม่' };
  const vLabel = u === null ? f.value.label : u.valueLabel;
  const suffix = u === null ? '' : u.suffix;
  if (v === '') {
    return { skip: true, problem: null, hint: q === '' ? null : `ยังไม่ได้กรอก${vLabel} — แถวนี้จะไม่ถูกส่ง` };
  }
  if (!Number.isFinite(a) || !(a > 0)) return { skip: false, problem: `${vLabel}ต้องมากกว่า 0` };
  if (q === '') return { skip: false, problem: `ยังไม่ได้กรอก${f.qty.label}` };
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    return { skip: false, problem: `${f.qty.label}ต้องเป็นจำนวนเต็มตั้งแต่ ${min} ขึ้นไป` };
  }
  return {
    skip: false,
    problem: null,
    text: f.item.replace('{v}', () => `${String(a)}${suffix}`).replace('{q}', () => String(n)),
    units: n,
  };
}

/**
 * ประกอบข้อความ — values[i]: ช่องตัวเลข = สตริงจากช่องกรอก · ช่องรายการ = [{ value, qty }]
 * ช่องตัวเลข optional ท้ายที่ว่างตัดทิ้ง · แถวรายการที่ว่างทั้งแถวข้าม · `null` = ยังกรอกไม่ครบ/ไม่ถูกต้อง
 */
export function buildMessage(fields, values) {
  const emptyNum = (i) => fields[i].kind === undefined && String(values[i] ?? '').trim() === '';
  let last = fields.length - 1;
  while (last >= 0 && emptyNum(last) && fields[last].optional) last -= 1;
  const parts = [];
  for (let i = 0; i <= last; i += 1) {
    const f = fields[i];
    if (f.kind === 'rows') {
      const out = [];
      for (const r of values[i] ?? []) {
        const s = rowState(f, r);
        if (s.skip) continue;
        if (s.problem !== null) return null;
        out.push(s.text);
      }
      if (out.length === 0) return null;
      parts.push(out.join(JOIN));
      continue;
    }
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

/**
 * รวมจำนวนตัวของช่องแบบแถว — คืน `{ units, max }` เมื่อเกินเพดานที่ลิงก์ส่งมา · `null` เมื่อไม่เกิน
 *
 * ⚠️ คู่ขนานกับ `tooLong()`: เพดานมาจากบอท หน้านี้แค่กันไม่ให้กดส่งสิ่งที่บอทจะปฏิเสธอยู่ดี
 * (ไม่ใช่กติกาของหน้านี้เอง และไม่ได้คำนวณอะไรให้ — รวมเลขจำนวนตัวที่ผู้ใช้กรอกมาเท่านั้น)
 */
export function unitsOver(fields, values) {
  for (let i = 0; i < fields.length; i += 1) {
    const f = fields[i];
    if (f.kind !== 'rows' || f.maxUnits === null) continue;
    if (unitsTotal(f, values[i]) > f.maxUnits) return { units: unitsTotal(f, values[i]), max: f.maxUnits };
  }
  return null;
}

/** จำนวนตัวรวมของช่องแบบแถว (แสดงใต้ฟอร์ม) — นับจากแถวที่ `rowState()` บอกว่าใช้ได้เท่านั้น */
export function unitsTotal(f, rows) {
  let units = 0;
  for (const r of rows ?? []) {
    const s = rowState(f, r);
    if (!s.skip && s.problem === null) units += s.units;
  }
  return units;
}
