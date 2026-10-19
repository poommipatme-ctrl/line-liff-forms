/*
 * การวาดช่องกรอกลงหน้า (แตะ DOM) — แยกออกจาก index.html เพื่อ **ทดสอบด้วยเบราว์เซอร์จริงได้**
 * (test/browser.test.mjs เปิด test/harness.html ซึ่ง import ไฟล์นี้ตัวเดียวกับที่หน้าจริงใช้
 *  ⇒ ไม่ใช่สำเนาของตรรกะการวาด และหน้าจริงไม่มีทางลับไว้ให้เทสต์)
 *
 * ⚠️ หน้านี้เป็นสาธารณะ ใครก็สร้าง URL ที่มี f/z อะไรก็ได้
 *   · ป้ายและตัวเลือกแสดงด้วย textContent เท่านั้น **ห้ามใช้ innerHTML**
 *   · การตัดสินว่าแถวใช้ได้ไหมอยู่ที่ `rowState()` ของ form.js ที่เดียว (ไฟล์นี้แค่เอามาทาสี)
 * ⚠️ ไม่คำนวณอะไรเลย — ตัวเลขทุกตัวที่โชว์มาจากที่ผู้ใช้กรอกหรือจากลิงก์ของบอท
 */
import { buildMessage, decodePayload, readParams, rowState, tooLong, unitsOver, unitsTotal } from './form.js';

const el = (tag, props = {}) => Object.assign(document.createElement(tag), props);
const $ = (id) => document.getElementById(id);

function numberInput(f) {
  const input = el('input', { type: 'number', inputMode: f.integer ? 'numeric' : 'decimal', step: f.integer ? '1' : 'any' });
  if (f.min !== undefined) input.min = String(f.min);
  if (f.max !== undefined) input.max = String(f.max);
  return input;
}

/** ช่องตัวเลข — คืนฟังก์ชันอ่านค่า */
function renderNumber(box, f, i, onChange) {
  const wrap = el('div', { className: 'field' });
  const label = el('label', { htmlFor: `v${i}`, textContent: f.label + (f.optional ? '' : ' *') });
  if (f.optional) label.appendChild(el('span', { className: 'opt', textContent: ' (ไม่ใส่ก็ได้)' }));
  const row = el('div', { className: 'row' });
  const input = numberInput(f);
  input.id = `v${i}`;
  input.addEventListener('input', onChange);
  row.append(input, el('span', { className: 'unit', textContent: f.unit }));
  wrap.append(label, row);
  box.appendChild(wrap);
  return () => input.value;
}

/** ช่องรายการ — แถวละ ตัวเลือก + ตัวเลข · เพิ่ม/ลบแถวได้ · คืนฟังก์ชันอ่านแถวทั้งหมด */
function renderList(box, f, onChange) {
  const wrap = el('div', { className: 'field' });
  wrap.appendChild(el('div', { className: 'flabel', textContent: `${f.label} *` }));
  const rowsBox = el('div');
  const rows = [];
  const syncRemove = () => rows.forEach((r) => { r.rm.hidden = rows.length === 1; });
  function addRow() {
    const row = el('div', { className: 'row' });
    const sel = el('select');
    sel.appendChild(el('option', { value: '', textContent: '— เลือก —' }));
    f.options.forEach((o, k) => sel.appendChild(el('option', { value: String(k), textContent: f.unit ? `${o.label} ${f.unit}` : o.label })));
    const qty = numberInput(f.qty);
    qty.className = 'qty';
    qty.placeholder = f.qty.label;
    const rm = el('button', { type: 'button', className: 'rm', textContent: '✕' });
    const r = { row, sel, qty, rm };
    rm.addEventListener('click', () => { rows.splice(rows.indexOf(r), 1); row.remove(); syncRemove(); onChange(); });
    sel.addEventListener('change', onChange);
    qty.addEventListener('input', onChange);
    row.append(sel, qty, el('span', { className: 'unit', textContent: f.qty.unit }), rm);
    rowsBox.appendChild(row);
    rows.push(r);
    syncRemove();
  }
  const add = el('button', { type: 'button', className: 'add', textContent: '+ เพิ่มรายการ' });
  add.addEventListener('click', () => { addRow(); onChange(); });
  addRow();
  wrap.append(rowsBox, add);
  box.appendChild(wrap);
  return () => rows.map((r) => ({ value: r.sel.value === '' ? '' : f.options[Number(r.sel.value)].value, qty: r.qty.value }));
}

/**
 * ช่องแบบแถว (`kind:'rows'`) — แถวละ **ตัวเลขอิสระ + จำนวน** เพิ่ม/ลบแถวได้ · เหลืออย่างน้อยหนึ่งแถวเสมอ
 *
 * ⚠️ แถวที่ยังกรอกไม่ครบ/ค่าใช้ไม่ได้ ขึ้นกรอบเตือนพร้อมเหตุผลใต้แถวนั้น — **ไม่เดาค่าที่ขาดให้**
 * ⚠️ บรรทัด "รวม N ตัว" คือผลบวกของช่องจำนวนที่กรอกมา ไม่ใช่ผลคำนวณอะไร · เกินเพดานที่ลิงก์
 *   ส่งมา (`maxUnits`) จะเตือนและ `index.html` จะไม่ให้กดส่ง (บอทก็ปฏิเสธข้อความนั้นอยู่ดี)
 */
function renderRows(box, f, onChange) {
  const wrap = el('div', { className: 'field' });
  wrap.appendChild(el('div', { className: 'flabel', textContent: `${f.label} *` }));
  /*
   * ⚠️ บรรทัดบอกวิธีใช้ต่างกันตามว่าช่องมีหน่วยให้เลือกไหม — payload เก่า (ไม่มี `units`)
   * ต้องได้ข้อความเดิมทุกตัวอักษร ไม่ใช่ข้อความใหม่ที่พูดถึงหน่วยที่หน้านั้นไม่มีให้เลือก
   */
  const unitNames = f.units === null || f.units === undefined ? null : f.units.map((u) => u.valueUnit).join(' หรือ ');
  wrap.appendChild(
    el('div', {
      className: 'hint',
      textContent:
        unitNames === null
          ? `${f.value.label} (${f.value.unit}) · ${f.qty.label} (${f.qty.unit}) — เพิ่มแถวได้เท่าจำนวนโหลดที่มี`
          : `แต่ละแถวเลือกหน่วยได้ (${unitNames}) · ${f.qty.label} (${f.qty.unit}) — ผสมหน่วยกันในฟอร์มเดียวได้ เพิ่มแถวได้เท่าจำนวนโหลดที่มี`,
    }),
  );
  const rowsBox = el('div');
  const rows = [];
  const total = el('div', { className: 'count' });

  const read = () =>
    rows.map((r) => (r.unit === null ? { value: r.val.value, qty: r.qty.value } : { value: r.val.value, qty: r.qty.value, unit: r.unit.value }));
  const syncRemove = () => rows.forEach((r) => { r.rm.hidden = rows.length === 1; });
  const paint = () => {
    const vals = read();
    rows.forEach((r, k) => {
      const s = rowState(f, vals[k]);
      const bad = !s.skip && s.problem !== null;
      /* ⚠️ แถวที่ยังไม่ถูกแตะเลย ไม่ขึ้นคำเตือน (แถวแรก/แถวที่เพิ่งกดเพิ่มยังว่างอยู่เป็นเรื่องปกติ) */
      const text = bad ? s.problem : r.dirty && s.hint ? s.hint : '';
      r.note.textContent = text;
      r.note.hidden = text === '';
      r.row.className = bad ? 'row bad' : 'row';
    });
    const units = unitsTotal(f, vals);
    const over = f.maxUnits !== null && units > f.maxUnits;
    total.textContent = over
      ? `รวม ${units} ตัว — เกิน ${f.maxUnits} ตัวที่บอทรับต่อครั้ง ลดจำนวนลง`
      : `รวม ${units} ตัว`;
    total.className = over ? 'count warn' : 'count';
  };
  const changed = () => { paint(); onChange(); };

  function addRow() {
    const rowBox = el('div', { className: 'rowbox' });
    const row = el('div', { className: 'row' });
    const val = numberInput(f.value);
    val.className = 'amp';
    const qty = numberInput(f.qty);
    qty.className = 'qty';
    qty.placeholder = f.qty.label;
    /* ⚠️ จำนวนเริ่มต้นหนึ่งตัว — ค่าที่คนกรอกบ่อยที่สุดและไม่ได้เดาแทนเขา (แก้ได้ทันที) */
    qty.value = '1';
    const rm = el('button', { type: 'button', className: 'rm', textContent: '✕' });
    const note = el('div', { className: 'note', hidden: true });

    /*
     * ตัวเลือกหน่วยต่อแถว — มีเฉพาะเมื่อ payload ประกาศ `units` มา
     *
     * ⚠️ ใช้ `<select>` ไม่ใช่ปุ่มสลับ เพราะกดง่ายบนมือถือ (ระบบเปิดเป็นวงล้อ/เมนูเต็มจอ
     *   ให้เอง นิ้วไม่ต้องเล็งปุ่มเล็ก) และขยายเป็นสามหน่วยขึ้นไปได้โดยหน้าไม่ล้น
     * ⚠️ **ไม่ล้างตัวเลขที่กรอกไว้เมื่อสลับหน่วย** — คนกรอกเลขแล้วเพิ่งนึกได้ว่าเลือก
     *   หน่วยผิด การล้างให้คือการลบงานของเขา · เปลี่ยนแค่ป้าย/placeholder/ตัวย่อ
     * ⚠️ ตัวย่อของหน่วยที่เลือกอยู่ **แสดงข้างช่องตัวเลขตลอด** (ช่อง `unitTag`)
     *   เพื่อให้เห็นว่าเลขที่กรอกเป็นหน่วยอะไรโดยไม่ต้องเปิด dropdown ดู
     */
    const hasUnits = f.units !== null && f.units !== undefined;
    const unit = hasUnits ? el('select', { className: 'usel' }) : null;
    /*
     * ⚠️ ป้ายในตัวเลือกใช้ **ตัวย่อ** (`valueUnit`: A / kW) ไม่ใช่ป้ายยาว (`label`)
     *   เพราะ `<select>` ที่ปิดอยู่จะโชว์ข้อความของตัวเลือกที่เลือก ⇒ ตัวย่อสั้นทำให้
     *   หน่วยที่เลือก "อยู่ข้างช่องตัวเลขและเห็นตลอด" ได้จริงบนจอ 390 px
     *   ส่วนป้ายยาวไปอยู่ที่ `title` ของตัวเลือกและที่บรรทัดบอกวิธีใช้เหนือช่อง
     *   (ถ้าใช้ป้ายยาวในตัวเลือก แถวจะกว้างเกินจอและช่องตัวเลขถูกบีบจนกรอกยาก)
     */
    if (unit !== null) {
      for (const u of f.units) unit.appendChild(el('option', { value: u.id, textContent: u.valueUnit, title: u.label }));
      unit.value = f.units[0].id;
    }
    /* payload เก่า: ป้ายหน่วยคงที่เหมือนเดิมทุกตัวอักษร */
    const unitTag = hasUnits ? null : el('span', { className: 'unit', textContent: f.value.unit });

    const r = { row, val, qty, rm, note, unit, dirty: false };
    const touched = () => { r.dirty = true; changed(); };
    rm.addEventListener('click', () => {
      rows.splice(rows.indexOf(r), 1);
      rowBox.remove();
      syncRemove();
      changed();
    });
    val.addEventListener('input', touched);
    qty.addEventListener('input', touched);
    if (unit !== null) {
      unit.addEventListener('change', () => {
        const u = f.units.find((x) => x.id === unit.value) ?? f.units[0];
        /* ป้ายช่องเปลี่ยนตามหน่วย — **ค่าที่กรอกไว้ไม่ถูกแตะ** (ดูเหตุผลข้างบน) */
        val.placeholder = u.valueLabel;
        unit.title = u.label;
        touched();
      });
      unit.title = f.units[0].label;
    }
    val.placeholder = hasUnits ? f.units[0].valueLabel : f.value.label;
    row.append(
      val,
      ...(unitTag === null ? [] : [unitTag]),
      ...(unit === null ? [] : [unit]),
      qty,
      el('span', { className: 'unit', textContent: f.qty.unit }),
      rm,
    );
    rowBox.append(row, note);
    rowsBox.appendChild(rowBox);
    rows.push(r);
    syncRemove();
  }

  const add = el('button', { type: 'button', className: 'add', textContent: '+ เพิ่มแถว' });
  add.addEventListener('click', () => { addRow(); changed(); });
  addRow();
  wrap.append(rowsBox, add, total);
  box.appendChild(wrap);
  paint();
  return read;
}

/** วาดทุกช่องลงใน `box` — คืนรายการฟังก์ชันอ่านค่าตามลำดับช่อง (ค่าที่อ่านได้ส่งเข้า buildMessage ตรง ๆ) */
export function renderFields(box, fields, onChange) {
  const readers = [];
  fields.forEach((f, i) => {
    if (f.kind === 'list') readers.push(renderList(box, f, onChange));
    else if (f.kind === 'rows') readers.push(renderRows(box, f, onChange));
    else readers.push(renderNumber(box, f, i, onChange));
  });
  return readers;
}

/**
 * วาดฟอร์มทั้งใบ + พรีวิว + ประตูปุ่มส่ง — ใช้ร่วมกับโครง id เดิมของหน้า
 * (`fields` · `preview` · `count` · `submit` · `form`)
 *
 * ⚠️ ปุ่มส่งใช้ได้เมื่อ **ทุกแถว/ทุกช่องถูกต้อง** และข้อความไม่เกินเพดานที่บอทรับ (ตัวอักษร/จำนวนตัว)
 * ⚠️ ไฟล์นี้ไม่รู้จัก LIFF เลย — การส่งเข้าแชทเป็นหน้าที่ของ `onSubmit` ที่หน้าจริงส่งเข้ามา
 *   ⇒ เทสต์เบราว์เซอร์เรียกตัวนี้ได้ตรง ๆ โดยไม่ต้องมี LINE และหน้าจริงไม่มีทางลับไว้ให้เทสต์
 */
export function mountForm({ fields, maxLen }, onSubmit) {
  const box = $('fields');
  const readers = [];
  const update = () => {
    const values = readers.map((read) => read());
    const text = buildMessage(fields, values);
    $('preview').textContent = text ?? '—';
    const long = tooLong(text, maxLen);
    /* ⚠️ จำนวนตัวรวมเกินเพดานที่บอทรับไหว — กันที่นี่ด้วย ไม่ใช่แค่ทาสีเตือนข้างช่อง */
    const many = unitsOver(fields, values);
    const over = long || many !== null;
    const count = $('count');
    if (maxLen !== null && text !== null) {
      count.hidden = false;
      count.textContent = long
        ? `ยาว ${[...text].length} ตัวอักษร เกินที่บอทรับต่อครั้ง (${maxLen}) — ลดจำนวนรายการลง`
        : `${[...text].length} / ${maxLen} ตัวอักษร`;
    } else {
      count.hidden = true;
    }
    $('submit').disabled = text === null || over;
    return over ? null : text;
  };
  readers.push(...renderFields(box, fields, update));
  update();
  $('form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = update();
    if (text === null) return;
    $('submit').disabled = true;
    onSubmit(text, () => { $('submit').disabled = false; });
  });
  $('form').hidden = false;
  return update;
}

/**
 * ข้อความแทนหน้าว่าง — **ทางพิมพ์เองต้องอยู่ในทุกข้อความ** เพราะทุกกรณีที่นี่คือกรณีที่ฟอร์มใช้ไม่ได้
 * `liff` ใช้ที่ index.html (หน้านี้ไม่รู้จัก LIFF) ส่วนอีกสองตัวใช้ที่ openForm()
 */
export const MESSAGES = {
  broken: 'ลิงก์ฟอร์มไม่ครบ — กลับไปพิมพ์ในแชทได้ตามเดิม',
  unsupported: 'ปุ่มนี้เก่า/ใหม่เกินไปสำหรับหน้าฟอร์มนี้ — ให้พิมพ์คำตอบในแชทเองตามตัวอย่างที่บอทบอกไว้',
  liff: 'เปิดฟอร์มไม่สำเร็จ — กลับไปพิมพ์ในแชทได้ตามเดิม',
};

export function showMessage(text) {
  const m = $('msg');
  m.textContent = text;
  m.hidden = false;
}

/**
 * เปิดฟอร์มจาก query ของหน้า — วาดฟอร์ม หรือขึ้นข้อความแทนหน้าว่าง · คืนว่าเกิดอะไรขึ้น
 *
 * ⚠️ สามทาง: ใช้ได้ · ลิงก์เสีย/ไม่ครบ · **ชนิดช่องที่หน้านี้ยังไม่รองรับ** (บอทใหม่กว่าหน้าฟอร์ม
 * — เกิดได้จริงเพราะสอง repo ขึ้นจริงคนละรอบ ลำดับที่ถูกคือ deploy หน้านี้ก่อนแล้วค่อยอัปบอท)
 */
export function openForm(search, onSubmit) {
  const payload = decodePayload(readParams(search));
  if (payload === null) {
    showMessage(MESSAGES.broken);
    return { kind: 'broken' };
  }
  if (payload.fields === null) {
    showMessage(MESSAGES.unsupported);
    return { kind: 'unsupported' };
  }
  return { kind: 'ok', update: mountForm(payload, onSubmit) };
}
