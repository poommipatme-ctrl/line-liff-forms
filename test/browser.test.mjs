/*
 * เทสต์หน้าฟอร์มใน **เบราว์เซอร์จริง** (Chromium ผ่าน DevTools Protocol — ไม่เพิ่มไลบรารี)
 * รัน: npm run test:browser
 *
 * ═════════════════════════════════════════════════════════════════════
 * ทำไมต้องเปิดเบราว์เซอร์ ไม่ใช่ทดสอบตรรกะเปล่า
 * ═════════════════════════════════════════════════════════════════════
 * `form.test.mjs` วัด buildMessage/decodePayload ซึ่งไม่แตะ DOM — แต่สิ่งที่พังได้จริงของงานนี้คือ
 * ชั้นที่ผู้ใช้กด: ปุ่มเพิ่ม/ลบแถว · แถวที่กรอกครึ่งเดียว · ประตูปุ่มส่ง · และ **ความกว้างจอมือถือ**
 * ⇒ เปิด test/harness.html (โครง id · form.css · ui.js ชุดเดียวกับ index.html) ที่ความกว้าง 360px
 *   แล้วกดจริง อ่านค่าที่หน้าจอแสดงจริง
 *
 * ⚠️ ข้อความที่คาดหวังมาจาก test/fixtures.json ที่ฝั่งบอทสร้าง (npm run liff:fixtures)
 *   ⇒ ถ้าหน้าเว็บประกอบข้อความต่างจากบอทแม้ตัวอักษรเดียว ข้อนี้แดง
 * ⚠️ ไม่มี Chromium ในเครื่อง = **ข้าม** (พิมพ์บอกไว้) ไม่ใช่ผ่าน — ชุดนี้ไม่เคยถือว่าผ่านเงียบ ๆ
 */
import { spawn } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = new URL('.', import.meta.url);
const fx = JSON.parse(readFileSync(new URL('./fixtures.json', HERE), 'utf8'));
const caseByName = (needle) => {
  const c = fx.cases.find((x) => x.name.includes(needle));
  if (c === undefined) throw new Error(`ไม่มีกรณีชื่อ "${needle}" ใน fixtures.json — รัน npm run liff:fixtures ที่ฝั่งบอทก่อน`);
  return c;
};

let failed = 0;
let checks = 0;
const check = (ok, label, detail = '') => {
  checks += 1;
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};

/* ------------------------------------------------------------------ */
/* หา Chromium                                                        */
/* ------------------------------------------------------------------ */
function findChromium() {
  if (process.env.CHROMIUM_PATH && existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const pw = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (existsSync(pw)) {
    const dirs = readdirSync(pw).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const exe = join(pw, d, 'chrome-win64', 'chrome.exe');
      if (existsSync(exe)) return exe;
    }
  }
  for (const p of [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ]) if (existsSync(p)) return p;
  return null;
}

const exe = findChromium();
if (exe === null) {
  console.log('\n⊘ ข้าม: ไม่พบ Chromium/Chrome ในเครื่องนี้ (ตั้ง CHROMIUM_PATH เพื่อระบุเอง)\n');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* CDP ขั้นต่ำ — WebSocket ของ Node เอง                                 */
/* ------------------------------------------------------------------ */
/* ⚠️ พอร์ตช่วง 15xxx: ช่วง dynamic ของ Windows (49152+) ถูกจองไว้แบบสุ่มบนเครื่องนี้ */
const PORT = 15300 + Math.floor(Math.random() * 400);
const profile = mkdtempSync(join(tmpdir(), 'liff-form-test-'));
const child = spawn(exe, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  '--window-size=360,900',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function version() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* ยังไม่ขึ้น */ }
    await sleep(100);
  }
  throw new Error('เบราว์เซอร์ไม่เปิดพอร์ต debug ภายใน 10 วินาที');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.waiting.has(m.id)) {
        const { resolve, reject } = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      }
    });
  }
  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    const msg = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) };
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(msg));
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`CDP ${method} ไม่ตอบ`)); }, 20000);
    });
  }
}

/** เปิดหน้าใหม่ที่ url แล้วคืนตัวประเมินนิพจน์ในหน้านั้น */
async function openPage(browser, url) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Emulation.setDeviceMetricsOverride',
    { width: 360, height: 900, deviceScaleFactor: 1, mobile: true }, sessionId);
  await browser.send('Page.navigate', { url }, sessionId);
  const evaluate = async (expression) => {
    const r = await browser.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(`ในหน้า: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`);
    return r.result.value;
  };
  for (let i = 0; i < 100; i += 1) {
    const ready = await evaluate('!!window.__ready').catch(() => false);
    if (ready === true) break;
    await sleep(100);
  }
  const close = () => browser.send('Target.closeTarget', { targetId });
  return { evaluate, close };
}

const HARNESS = pathToFileURL(join(process.cwd(), 'test', 'harness.html')).href;
const page = (query) => `${HARNESS}?${query}`;

/** ตัวช่วยในหน้า — กรอกแถวที่ k แล้วยิง event input จริง */
const FILL = `
  window.__rows = () => [...document.querySelectorAll('.rowbox')];
  window.__set = (k, amps, qty) => {
    const box = window.__rows()[k];
    const a = box.querySelector('.amp');
    const q = box.querySelector('.qty');
    a.value = String(amps); a.dispatchEvent(new Event('input', { bubbles: true }));
    q.value = String(qty);  q.dispatchEvent(new Event('input', { bubbles: true }));
  };
  window.__add = (n) => { for (let i = 0; i < n; i += 1) document.querySelector('.add').click(); };
  window.__preview = () => document.getElementById('preview').textContent;
  window.__disabled = () => document.getElementById('submit').disabled;
  window.__notes = () => [...document.querySelectorAll('.note')].filter((n) => !n.hidden).map((n) => n.textContent);
  window.__total = () => (document.querySelector('.count') ? document.querySelector('.count').textContent : '');
  true;
`;

let browser;
try {
  const v = await version();
  browser = await Cdp.open(v.webSocketDebuggerUrl);
  console.log(`\n── ${v.Browser} · harness ที่ความกว้าง 360px ──`);

  /* ════════════════════════════════════════════════════════════════ */
  /* 1. ช่องแบบแถว — รายการโหลดของตู้ไฟ (กรณีหลักจาก fixtures)          */
  /* ════════════════════════════════════════════════════════════════ */
  const main = caseByName('รายการโหลดของตู้');
  {
    const p = await openPage(browser, page(main.query));
    await p.evaluate(FILL);
    check(await p.evaluate('window.__opened.kind') === 'ok', 'เปิดฟอร์มช่องแบบแถวได้', String(await p.evaluate('window.__opened.kind')));
    check(await p.evaluate('window.__rows().length') === 1, 'เริ่มต้นหนึ่งแถว');
    check(await p.evaluate("window.__rows()[0].querySelector('.qty').value") === '1', '  จำนวนเริ่มต้น 1');
    check(await p.evaluate("window.__rows()[0].querySelector('.rm').hidden") === true, '  แถวเดียว → ปุ่มลบซ่อน (ลบแถวสุดท้ายไม่ได้)');
    check(await p.evaluate("window.__rows()[0].querySelector('.amp').getAttribute('inputmode')") === 'decimal', '  ช่องกระแสขึ้นแป้นทศนิยม');
    check(await p.evaluate("window.__rows()[0].querySelector('.qty').getAttribute('inputmode')") === 'numeric', '  ช่องจำนวนขึ้นแป้นตัวเลข');
    check(await p.evaluate('window.__disabled()') === true, '  ยังไม่กรอกกระแส → กดส่งไม่ได้');

    /* เพิ่มแถวให้ครบตามกรณีของ fixtures แล้วกรอกค่าทุกแถว */
    const rows = main.values[0];
    await p.evaluate(`window.__add(${rows.length - 1}); true;`);
    check(await p.evaluate('window.__rows().length') === rows.length, `กดเพิ่มแถวได้ครบ ${rows.length} แถว`);
    check(await p.evaluate("window.__rows()[0].querySelector('.rm').hidden") === false, '  หลายแถว → ปุ่มลบโผล่');
    for (let k = 0; k < rows.length; k += 1) {
      await p.evaluate(`window.__set(${k}, ${JSON.stringify(rows[k].value)}, ${JSON.stringify(rows[k].qty)}); true;`);
    }
    const preview = await p.evaluate('window.__preview()');
    check(preview === main.expected, 'ข้อความในพรีวิวตรงกับที่บอทคาดเป๊ะ', `"${preview}" vs "${main.expected}"`);
    check(await p.evaluate('window.__notes().length') === 0, '  ไม่มีแถวไหนขึ้นคำเตือน');
    check(await p.evaluate('window.__disabled()') === false, '  กดส่งได้');
    const units = rows.reduce((n, r) => n + Number(r.qty), 0);
    check(await p.evaluate('window.__total()') === `รวม ${units} ตัว`, `  สรุปสด "รวม ${units} ตัว"`, await p.evaluate('window.__total()'));

    /* กดส่งจริง → ข้อความที่จะเข้าแชทต้องเป็นตัวเดียวกับพรีวิว */
    await p.evaluate("document.getElementById('submit').click(); true;");
    const sent = await p.evaluate('window.__sent');
    check(sent.length === 1 && sent[0] === main.expected, 'กดยืนยัน → ส่งข้อความเดียวกันเข้าแชท', JSON.stringify(sent));

    /* ความกว้างจอมือถือ — ห้ามล้นแนวนอน */
    const w = await p.evaluate('({ doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth })');
    check(w.doc <= 360 && w.body <= 360, `หน้าไม่ล้มล้นแนวนอนที่ 360px (doc ${w.doc} · body ${w.body})`);
    const clipped = await p.evaluate(`
      (() => {
        const bad = [];
        for (const r of window.__rows()) {
          const rect = r.getBoundingClientRect();
          if (rect.right > 360.5 || rect.left < -0.5) bad.push('แถวล้น ' + rect.left + '-' + rect.right);
          for (const inp of r.querySelectorAll('input')) {
            const b = inp.getBoundingClientRect();
            if (b.width < 48) bad.push('ช่องแคบเกินไป ' + b.width);
            if (b.right > 360.5) bad.push('ช่องล้นขอบ ' + b.right);
          }
        }
        return bad;
      })()`);
    check(clipped.length === 0, '  ทุกแถว/ทุกช่องอยู่ในขอบและกว้างพอกด', clipped.slice(0, 3).join(' | '));

    /* แถวที่กรอกครึ่งเดียว = ผิด (ไม่เดาค่าที่ขาด) */
    await p.evaluate("window.__add(1); window.__rows().at(-1).querySelector('.amp').value='12'; window.__rows().at(-1).querySelector('.qty').value=''; window.__rows().at(-1).querySelector('.qty').dispatchEvent(new Event('input',{bubbles:true})); true;");
    const notes = await p.evaluate('window.__notes()');
    check(notes.length === 1 && notes[0].includes('จำนวน'), 'แถวกรอกครึ่งเดียว → ขึ้นเหตุผลข้างแถว', JSON.stringify(notes));
    check(await p.evaluate('window.__disabled()') === true, '  และกดส่งไม่ได้');
    check(await p.evaluate('window.__preview()') === '—', '  พรีวิวว่าง (ไม่ประกอบข้อความครึ่ง ๆ)');

    /* แถวที่กรอกแต่จำนวน (ยังไม่มีกระแส) → ข้ามแถวนั้น แต่ต้องบอกว่าจะไม่ถูกส่ง */
    await p.evaluate("(() => { const r = window.__rows().at(-1); r.querySelector('.amp').value=''; r.querySelector('.amp').dispatchEvent(new Event('input',{bubbles:true})); r.querySelector('.qty').value='5'; r.querySelector('.qty').dispatchEvent(new Event('input',{bubbles:true})); })(); true;");
    const hints = await p.evaluate('window.__notes()');
    check(hints.length === 1 && hints[0].includes('ไม่ถูกส่ง'), 'แถวที่มีแต่จำนวน → บอกว่าแถวนั้นจะไม่ถูกส่ง (ไม่ทิ้งเงียบ)', JSON.stringify(hints));
    check(await p.evaluate('window.__preview()') === main.expected, '  และข้อความที่จะส่งไม่มีแถวนั้น');
    check(await p.evaluate('window.__disabled()') === false, '  ส่งได้ (แถวอื่นถูกต้องครบ)');

    /* ลบแถวที่ผิดออก → กลับมาส่งได้ */
    await p.evaluate("window.__rows().at(-1).querySelector('.rm').click(); true;");
    check(await p.evaluate('window.__rows().length') === rows.length, 'กดลบแถวได้ (เหลือจำนวนเดิม)');
    check(await p.evaluate('window.__preview()') === main.expected && await p.evaluate('window.__disabled()') === false, '  และข้อความกลับมาเหมือนเดิม');

    /* เกินเพดานจำนวนตัว → เตือนและกดส่งไม่ได้ */
    await p.evaluate(`window.__set(0, 46.8, 300); true;`);
    const total = await p.evaluate('window.__total()');
    check(/เกิน 200 ตัว/.test(total), 'รวมเกินเพดาน → เตือนที่สรุปสด', total);
    check(await p.evaluate('window.__disabled()') === true, '  และกดส่งไม่ได้');
    check(await p.evaluate("document.querySelector('.count.warn') !== null") === true, '  สรุปสดเปลี่ยนเป็นสีเตือน');
    await p.close();
  }

  /* ════════════════════════════════════════════════════════════════ */
  /* 2. ตัวควบคุมบวก — ช่องชนิดเดิมยังวาดและประกอบข้อความได้เหมือนเดิม    */
  /* ════════════════════════════════════════════════════════════════ */
  {
    const num = caseByName('น้ำร้อนจำนวนคน');
    const p = await openPage(browser, page(num.query));
    const vals = num.values;
    for (let i = 0; i < vals.length; i += 1) {
      await p.evaluate(`(() => { const e = document.getElementById('v${i}'); e.value = ${JSON.stringify(String(vals[i]))}; e.dispatchEvent(new Event('input',{bubbles:true})); })(); true;`);
    }
    const got = await p.evaluate("document.getElementById('preview').textContent");
    check(got === num.expected, 'ช่องตัวเลขล้วน (f=) ยังได้ข้อความเดิม', `"${got}" vs "${num.expected}"`);
    await p.close();
  }
  {
    const lst = caseByName('ท่อประปาสาธารณะ');
    const p = await openPage(browser, page(lst.query));
    const rows = lst.values[0];
    await p.evaluate(`(() => {
      const add = document.querySelector('.add');
      for (let i = 1; i < ${rows.length}; i += 1) add.click();
      const sels = [...document.querySelectorAll('select')];
      const qtys = [...document.querySelectorAll('.qty')];
      const want = ${JSON.stringify(rows)};
      const opts = window.__fields[0].options;
      want.forEach((r, k) => {
        const idx = opts.findIndex((o) => o.value === r.value);
        sels[k].value = String(idx); sels[k].dispatchEvent(new Event('change',{bubbles:true}));
        qtys[k].value = String(r.qty); qtys[k].dispatchEvent(new Event('input',{bubbles:true}));
      });
    })(); true;`);
    const got = await p.evaluate("document.getElementById('preview').textContent");
    check(got === lst.expected, 'ช่องรายการ (z=) ยังได้ข้อความเดิม', `"${got}" vs "${lst.expected}"`);
    await p.close();
  }

  /* ════════════════════════════════════════════════════════════════ */
  /* 3. ชนิดช่องที่หน้านี้ไม่รู้จัก → บอกให้พิมพ์เอง ไม่ใช่หน้าว่าง        */
  /* ════════════════════════════════════════════════════════════════ */
  {
    const json = Buffer.from(JSON.stringify({ v: 2, fields: [{ kind: 'future-kind', label: 'อะไรไม่รู้' }] }), 'utf8');
    const z = `z=${json.length}.${deflateRawSync(json, { level: 9 }).toString('base64url')}`;
    const p = await openPage(browser, page(z));
    const kind = await p.evaluate('window.__opened.kind');
    const msg = await p.evaluate("document.getElementById('msg').textContent");
    const hidden = await p.evaluate("document.getElementById('msg').hidden");
    const formHidden = await p.evaluate("document.getElementById('form').hidden");
    check(kind === 'unsupported', 'ชนิดช่องที่ไม่รู้จัก → ไม่พยายามวาดฟอร์ม', String(kind));
    check(hidden === false && /พิมพ์/.test(msg), '  ขึ้นข้อความชวนให้พิมพ์เองแทนหน้าว่าง', msg);
    check(formHidden === true, '  และไม่โชว์ฟอร์มเปล่า');
    await p.close();
  }
} catch (e) {
  console.log(`  ✘ รันเทสต์เบราว์เซอร์ไม่สำเร็จ — ${e.message}`);
  failed += 1;
} finally {
  try { await browser?.send('Browser.close'); } catch { /* ปิดไปแล้ว */ }
  child.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* โปรไฟล์ชั่วคราว */ }
}

console.log(failed === 0 ? `\n✔ หน้าฟอร์มในเบราว์เซอร์จริงผ่านครบ (${checks} ข้อ)\n` : `\n✘ ล้มเหลว ${failed} / ${checks} ข้อ\n`);
if (checks === 0) {
  console.log('✘ ไม่มีข้อใดถูกรันเลย — ถือว่าตก');
  process.exit(1);
}
process.exit(failed === 0 ? 0 : 1);
