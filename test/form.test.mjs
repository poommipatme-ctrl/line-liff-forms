/*
 * เทสต์ของหน้าฟอร์ม — ถอด payload จากบอทแล้วประกอบข้อความ ต้องได้ตรงกับที่บอทคาดไว้เป๊ะ
 * รัน: npm test   (ชุดทดสอบ test/fixtures.json สร้างจาก line-group-bot: npm run liff:fixtures)
 */
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { readParams, decodePayload, buildMessage, rowState, tooLong, unitsOver, unitsTotal } from '../form.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

for (const c of fx.cases) {
  const p = decodePayload(readParams(`?${c.query}`));
  check(p !== null && p.fields !== null, `${c.name}: ถอด payload ได้`);
  if (p === null || p.fields === null) continue;
  check(p.maxLen === c.maxLen, '  เพดานความยาวตรงกับบอท', `${p.maxLen} vs ${c.maxLen}`);
  const msg = buildMessage(p.fields, c.values);
  check(msg === c.expected, '  ข้อความตรงกับที่บอทคาดเป๊ะ', `"${msg}" vs "${c.expected}"`);
  check(tooLong(msg, p.maxLen) === (c.tooLong === true), `  ${c.tooLong ? 'ยาวเกิน → ฟอร์มกันการส่ง' : 'ไม่เกินเพดาน'}`);
  /* เพดาน "จำนวนตัวรวม" ของช่องแบบแถว — บอทส่งมาในช่อง ฟอร์มต้องตัดสินตรงกับบอท */
  const many = unitsOver(p.fields, c.values);
  check((many !== null) === (c.unitsOver === true), `  ${c.unitsOver ? 'จำนวนตัวเกิน → ฟอร์มกันการส่ง' : 'จำนวนตัวไม่เกินเพดาน'}`, JSON.stringify(many));
}

/* negative control — ลิงก์ที่ใครก็สร้างได้ ต้องไม่ทำให้หน้าพังหรือจองหน่วยความจำก้อนใหญ่ */
check(decodePayload(readParams('?z=999999.AAAA')) === null, 'ความยาวเกินเพดาน → ปฏิเสธ');
check(decodePayload(readParams('?z=abc')) === null, 'z ผิดรูป → ปฏิเสธ');
check(decodePayload(readParams('?f=!!!')) === null, 'f ผิดรูป → ปฏิเสธ');
check(decodePayload(readParams('?')) === null, 'ไม่มี payload → ปฏิเสธ');
const liffState = `?liff.state=${encodeURIComponent(`?${fx.cases[0].query}`)}`;
check(decodePayload(readParams(liffState)) !== null, 'payload ที่ห่ออยู่ใน liff.state ก็ถอดได้');

/*
 * ชนิดช่องที่หน้านี้ยังไม่รองรับ — ต้องแยกจาก "ลิงก์เสีย" เพราะเกิดได้จริงเมื่อบอทขึ้นก่อนหน้าฟอร์ม
 * (ลำดับที่ถูกคือ deploy หน้าฟอร์มก่อน) · มีตัวควบคุมบวกคู่กันว่า ชนิดที่รองรับยังถอดได้
 */
const zOf = (obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  return `z=${b.length}.${deflateRawSync(b, { level: 9 }).toString('base64url')}`;
};
const ROWS_OK = { kind: 'rows', label: 'โหลด', value: { label: 'กระแสต่อตัว', unit: 'A' }, qty: { label: 'จำนวน', unit: 'ตัว', integer: true, min: 1 }, item: '{v}x{q}', maxUnits: 200 };
const unknown = decodePayload(readParams(`?${zOf({ v: 2, fields: [{ kind: 'future-kind', label: 'x' }] })}`));
check(unknown !== null && unknown.fields === null && unknown.unsupported === true, 'ชนิดช่องที่ไม่รู้จัก → บอกว่า "ไม่รองรับ" ไม่ใช่ลิงก์เสีย');
const known = decodePayload(readParams(`?${zOf({ v: 2, fields: [ROWS_OK] })}`));
check(known !== null && known.fields !== null && known.fields[0].kind === 'rows', '  ตัวควบคุมบวก: ช่องแบบแถวที่รูปถูก ยังถอดได้ปกติ');
check(known !== null && known.fields !== null && known.fields[0].maxUnits === 200, '  และเพดานจำนวนตัวติดมาด้วย');
const badItem = decodePayload(readParams(`?${zOf({ v: 2, fields: [{ ...ROWS_OK, item: '{q}x{v}' }] })}`));
check(badItem === null, '  รูปหนึ่งรายการที่ไม่ใช่ "ค่าxจำนวน" → ปฏิเสธ (หน้านี้ไม่สลับข้างให้เอง)');
const noMax = decodePayload(readParams(`?${zOf({ v: 2, fields: [{ ...ROWS_OK, maxUnits: undefined }] })}`));
check(
  noMax !== null && noMax.fields !== null && noMax.fields[0].maxUnits === null && unitsOver(noMax.fields, [[{ value: '1', qty: '9999' }]]) === null,
  '  ช่องที่ไม่ได้ส่งเพดานมา → ฟอร์มไม่ตั้งเพดานขึ้นเอง',
);

/*
 * แถวว่าง/แถวครึ่งเดียวของช่องแบบแถว — **กติกาของฝั่งฟอร์มเท่านั้น** (ฝั่งบอทถือค่าเป็นตัวเลข
 * จึงไม่มีความหมายของ "ช่องที่ยังว่าง" ให้เทียบในสะพาน fixtures) ⇒ ด่านอยู่ที่นี่กับเทสต์เบราว์เซอร์
 */
{
  const F = known.fields;
  const msg = (rows) => buildMessage(F, [rows]);
  check(msg([{ value: '46.8', qty: '4' }, { value: '', qty: '' }]) === '46.8x4', 'แถวว่างทั้งแถว → ข้าม (ส่งแถวที่กรอกแล้ว)');
  check(msg([{ value: '46.8', qty: '4' }, { value: '', qty: '1' }]) === '46.8x4', '  แถวที่ยังไม่ได้กรอกกระแส (จำนวนติดมาเป็น 1) → ข้ามเหมือนกัน');
  check(rowState(F[0], { value: '', qty: '1' }).hint !== null, '  แต่มี hint ให้หน้าเว็บบอกว่าแถวนั้นจะไม่ถูกส่ง (ไม่ทิ้งเงียบ)');
  check(rowState(F[0], { value: '', qty: '' }).hint === null, '  ตัวควบคุมลบ: แถวที่ว่างทั้งแถวไม่มี hint (ไม่รบกวนตอนเพิ่งเพิ่มแถว)');
  check(msg([{ value: '46.8', qty: '' }]) === null, 'แถวที่กรอกครึ่งเดียว (ไม่มีจำนวน) → ไม่ประกอบข้อความ (ไม่เดาค่าที่ขาด)');
  check(msg([{ value: '', qty: '' }]) === null, 'ไม่มีแถวที่ใช้ได้เลย → ไม่ประกอบข้อความ');
  check(msg([{ value: '46.8', qty: '4' }, { value: '12', qty: '' }]) === null, 'แถวที่สองครึ่งเดียว → ทั้งใบไม่ประกอบ (ไม่ตัดแถวที่ผิดทิ้งเอง)');
  check(unitsTotal(F[0], [{ value: '46.8', qty: '4' }, { value: '3.4', qty: '18' }]) === 22, 'รวมจำนวนตัวได้ 22 ตัว');
  check(unitsTotal(F[0], [{ value: '', qty: '9' }]) === 0, '  ตัวควบคุมลบ: แถวที่ไม่มีกระแสไม่ถูกนับ');
}

console.log(failed === 0 ? `\n✔ หน้าฟอร์มผ่านครบ (${fx.cases.length} กรณีจากบอท)\n` : `\n✘ ล้มเหลว ${failed} ข้อ\n`);
if (failed > 0) process.exit(1);
