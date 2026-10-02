// one-off probe (T2461): story editor (mobile emulation) → Stickers tray → is there a Link sticker? If yes, tap it and
// dump the link UI. NEVER shares — there is no shareStory call in this file; the tab is closed at the end.
import * as web from './ig-web.mjs';
const [winFile, outDir] = process.argv.slice(2);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const txt = pg => pg.evaluate(() => [...new Set([...document.querySelectorAll('[aria-label],button,[role=button],span,img[alt],input,div[tabindex]')]
  .map(e => (e.getAttribute('aria-label') || e.alt || e.placeholder || e.innerText || '').trim()).filter(t => t && t.length < 40))].join(' | '));
const b = await web.connect(); let pg; const out = {};
try {
  pg = await web.openOwnTab(b, 'dreambankiagencyaia');
  out.who = await web.whoami(pg);
  out.editor = await web.openStoryEditor(pg, winFile);
  await pg.evaluate(() => { window.name = 'T2461_PROBE'; });       // not IG_BRIDGE: the agent must never adopt this tab
  if (!out.editor.ok) throw new Error('editor: ' + out.editor.why);
  out.editorUi = (await txt(pg)).slice(0, 500);
  await pg.screenshot({ path: `${outDir}/1-editor.png` });
  out.stickerTap = await pg.evaluate(() => !!document.querySelector('[aria-label*=ticker i]'));
  const h = await pg.evaluateHandle(() => [...document.querySelectorAll('[aria-label],button,[role=button]')].find(e => /^stickers?$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())));
  if (h.asElement()) await h.asElement().tap(); else await pg.touchscreen.tap(185, 29);
  let t = ''; for (let i = 0; i < 15; i++) { await sleep(2000); t = await txt(pg); if (!/Loading/i.test(t) && /link|music|location|mention|search/i.test(t)) break; }
  out.tray = t.slice(0, 900);
  const sheet = () => pg.evaluate(() => { const vh = innerHeight; const els = [...document.querySelectorAll('*')].filter(e => { const r = e.getBoundingClientRect(); return r.top > vh * 0.5 && r.width > 20 && r.height > 20 && e.childElementCount === 0; });
    return { n: els.length, imgs: [...document.querySelectorAll('img')].filter(i => i.getBoundingClientRect().top > vh * 0.5).map(i => (i.alt || i.src.split('/').pop()).slice(0, 40)).slice(0, 30),
      labels: [...new Set(els.map(e => (e.getAttribute('aria-label') || e.innerText || e.placeholder || '').trim()).filter(Boolean))].slice(0, 40), inputs: [...document.querySelectorAll('input')].map(i => i.placeholder || i.getAttribute('aria-label') || i.type) }; });
  await sleep(15000); out.sheetWait = await sheet();
  await pg.touchscreen.touchStart(195, 440); for (let y = 420; y >= 120; y -= 30) { await pg.touchscreen.touchMove(195, y); await sleep(30); } await pg.touchscreen.touchEnd(); await sleep(4000);
  out.sheetSwiped = await sheet(); t = await txt(pg);
  out.hasLink = /(^|\|\s*)Link(\s*\||$)/i.test(t);
  await pg.screenshot({ path: `${outDir}/2-tray.png` });
  if (out.hasLink) {
    const l = await pg.evaluateHandle(() => [...document.querySelectorAll('[aria-label],button,[role=button],span,div[tabindex]')].find(e => /^link$/i.test((e.getAttribute('aria-label') || e.innerText || '').trim())));
    const el = l.asElement(); if (el) { const c = await el.evaluateHandle(e => e.closest('button,[role=button],div[tabindex]') || e); await c.asElement().tap(); }
    await sleep(3000);
    out.linkUi = (await txt(pg)).slice(0, 600);
    out.linkInputs = await pg.evaluate(() => [...document.querySelectorAll('input,textarea,[contenteditable=true]')].map(i => ({ tag: i.tagName, ph: i.placeholder || i.getAttribute('aria-label') || '', type: i.type || '' })));
    await pg.screenshot({ path: `${outDir}/3-link-ui.png` });
  }
} catch (e) { out.error = String(e?.message || e); if (pg) await pg.screenshot({ path: `${outDir}/x-error.png` }).catch(() => {}); }
finally { await web.closeOwn(pg, 'dreambankiagencyaia'); b.disconnect(); console.log(JSON.stringify(out, null, 1)); }
