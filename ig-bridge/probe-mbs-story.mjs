// one-off probe (T2461 #2): Meta Business Suite web → story composer → is there a link sticker/option?
// Own tab in the default context (แบงค์'s logged-in Chrome), NEVER publish/schedule — no click on Share/Publish/Schedule
// anywhere in this file; the tab is closed at the end. Steps are passed as argv so each run is one small read.
import { createRequire } from 'module';
const puppeteer = createRequire(import.meta.url)('../node_modules/puppeteer-core');
const [url, outDir, step = 'list'] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const FORBID = /^(share|share now|share story|publish|publish now|post|post now|schedule|schedule story|โพสต์|แชร์|แชร์ตอนนี้|เผยแพร่|กำหนดเวลา)$/i;   // exact publish labels; 'Share to' (target picker) is allowed
const ui = pg => pg.evaluate(() => [...new Set([...document.querySelectorAll('[aria-label],button,[role=button],[role=menuitem],[role=tab],a[role=link],span,input')]
  .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map(e => (e.getAttribute('aria-label') || e.placeholder || e.innerText || '').trim().replace(/\s+/g, ' ')).filter(t => t && t.length < 50))].join(' | '));
const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
const pg = await b.newPage(); const out = {};
try {
  await pg.setViewport({ width: 1366, height: 900 });
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.evaluate(() => { window.name = 'T2461_MBS_PROBE'; });
  await sleep(9000);
  // optional: click a sequence of visible texts (argv 4..), refusing any publish-like label
  for (const label of process.argv.slice(5)) {
    if (FORBID.test(label)) throw new Error(`refused to click publish-like label ${label}`);
    const h = await pg.evaluateHandle(l => [...document.querySelectorAll('[aria-label],button,[role=button],[role=menuitem],[role=tab],span,div')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .find(e => (e.getAttribute('aria-label') || e.innerText || '').trim() === l), label);
    const el = h.asElement(); if (!el) { out.missing = label; break; }
    const tgt = await el.evaluateHandle(e => e.closest('[role=button],button,a,[role=menuitem],[role=tab]') || e);
    const tl = await tgt.evaluate(e => (e.getAttribute('aria-label') || e.innerText || '').trim());
    if (FORBID.test(tl)) throw new Error(`refused: click target resolves to ${tl}`);
    await tgt.asElement().click(); await sleep(6000);
  }
  if (process.env.UPLOAD) {
    const inp = await pg.$('input[type=file]');
    if (inp) { await inp.uploadFile(process.env.UPLOAD); await sleep(12000); out.uploaded = true; }
    else {
      const clickText = async (t) => { const h = await pg.evaluateHandle(l => [...document.querySelectorAll('[role=button],button,[role=menuitem],span,div')].filter(e => e.getBoundingClientRect().width > 0)
        .find(e => (e.innerText || e.getAttribute('aria-label') || '').trim() === l), t); const el = h.asElement(); if (!el) return false;
        const tg = await el.evaluateHandle(e => e.closest('[role=button],button,[role=menuitem]') || e); await tg.asElement().click(); return true; };
      let [fc] = await Promise.all([pg.waitForFileChooser({ timeout: 6000 }).catch(() => null), clickText('Add photo/video')]);
      if (!fc) { await sleep(1500); out.addMenu = (await ui(pg)).slice(0, 300);
        for (const t of ['Upload from desktop', 'Upload from computer', 'Upload']) { [fc] = await Promise.all([pg.waitForFileChooser({ timeout: 6000 }).catch(() => null), clickText(t)]); if (fc) break; } }
      if (fc) { await fc.accept([process.env.UPLOAD]); await sleep(15000); out.uploaded = true; } else out.uploaded = 'no file chooser';
    }
  }
  for (const label of (process.env.AFTER || '').split('||').filter(Boolean)) {
    if (FORBID.test(label)) throw new Error(`refused to click publish-like label ${label}`);
    const h = await pg.evaluateHandle(l => [...document.querySelectorAll('[aria-label],[role=button],button,[role=combobox],span,div')].filter(e => e.getBoundingClientRect().width > 0)
      .find(e => (e.getAttribute('aria-label') || e.innerText || '').trim().replace(/[\u200b]/g, '').replace(/\s+/g, ' ') === l), label);
    const el = h.asElement(); if (!el) { (out.afterMissing ||= []).push(label); continue; }
    const tg = await el.evaluateHandle(e => e.closest('[role=button],button,[role=combobox]') || e);
    const tl = await tg.evaluate(e => (e.getAttribute('aria-label') || e.innerText || '').trim());
    if (FORBID.test(tl)) throw new Error(`refused: target resolves to ${tl}`);
    await tg.asElement().click(); await sleep(3000);
    (out.after ||= []).push({ label, ui: (await ui(pg)).replace(/\| Meta AI business[\s\S]*/, '').slice(0, 1200),
      inputs: await pg.evaluate(() => [...document.querySelectorAll('input,textarea')].filter(i => i.getBoundingClientRect().width > 0).map(i => i.placeholder || i.getAttribute('aria-label') || i.type)) });
    await pg.screenshot({ path: `${outDir}/mbs-after-${(out.after.length)}.png` });
  }
  out.dialogs = await pg.evaluate(() => [...document.querySelectorAll('[role=dialog]')].map(d => d.innerText.replace(/\s+/g, ' ').slice(0, 1500)));
  out.url = pg.url(); out.title = await pg.title();
  out.ui = (await ui(pg)).slice(0, 2500);
  out.links = await pg.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => a.href).filter(h => /story|composer|create/i.test(h)).slice(0, 15));
  await pg.screenshot({ path: `${outDir}/mbs-${step}.png` });
} catch (e) { out.error = String(e?.message || e); }
finally { await pg.close().catch(() => {}); b.disconnect(); console.log(JSON.stringify(out, null, 1)); }
