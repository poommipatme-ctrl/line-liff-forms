/*
 * เทสต์ของหน้าฟอร์ม — ถอด payload จากบอทแล้วประกอบข้อความ ต้องได้ตรงกับที่บอทคาดไว้เป๊ะ
 * รัน: npm test   (ชุดทดสอบ test/fixtures.json สร้างจาก line-group-bot: npm run liff:fixtures)
 */
import { readFileSync } from 'node:fs';
import { readParams, decodePayload, buildMessage, tooLong } from '../form.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

for (const c of fx.cases) {
  const p = decodePayload(readParams(`?${c.query}`));
  check(p !== null, `${c.name}: ถอด payload ได้`);
  if (p === null) continue;
  check(p.maxLen === c.maxLen, '  เพดานความยาวตรงกับบอท', `${p.maxLen} vs ${c.maxLen}`);
  const msg = buildMessage(p.fields, c.values);
  check(msg === c.expected, '  ข้อความตรงกับที่บอทคาดเป๊ะ', `"${msg}" vs "${c.expected}"`);
  check(tooLong(msg, p.maxLen) === (c.tooLong === true), `  ${c.tooLong ? 'ยาวเกิน → ฟอร์มกันการส่ง' : 'ไม่เกินเพดาน'}`);
}

/* negative control — ลิงก์ที่ใครก็สร้างได้ ต้องไม่ทำให้หน้าพังหรือจองหน่วยความจำก้อนใหญ่ */
check(decodePayload(readParams('?z=999999.AAAA')) === null, 'ความยาวเกินเพดาน → ปฏิเสธ');
check(decodePayload(readParams('?z=abc')) === null, 'z ผิดรูป → ปฏิเสธ');
check(decodePayload(readParams('?f=!!!')) === null, 'f ผิดรูป → ปฏิเสธ');
check(decodePayload(readParams('?')) === null, 'ไม่มี payload → ปฏิเสธ');
const liffState = `?liff.state=${encodeURIComponent(`?${fx.cases[0].query}`)}`;
check(decodePayload(readParams(liffState)) !== null, 'payload ที่ห่ออยู่ใน liff.state ก็ถอดได้');

console.log(failed === 0 ? `\n✔ หน้าฟอร์มผ่านครบ (${fx.cases.length} กรณีจากบอท)\n` : `\n✘ ล้มเหลว ${failed} ข้อ\n`);
if (failed > 0) process.exit(1);
