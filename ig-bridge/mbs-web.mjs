// mbs-web.mjs — Facebook PAGE story with a swipe-up link, via Meta Business Suite web (T2461). CDP :9222, own tab.
// Why MBS: IG web/MBS cannot put a link on an Instagram story ("This feature is not supported by Instagram",
// probed 2/10) — this path is Facebook-only by design, and prepare() refuses to leave the IG account selected.
// Rules (same as ig-web.mjs): own tab (window.name = TAB_NAME) closed at the end · never restart Chrome · never window
// state · real input events · the ONLY click on a publish control is clickShare(), called by the agent's share step.
import { TAB_NAME, closeOwn } from './ig-web.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const COMPOSER = pageId => `https://business.facebook.com/latest/story_composer/?ref=biz_web_home_stories&asset_id=${encodeURIComponent(pageId)}`;
const norm = t => String(t || '').replace(/[​‎‏]/g, '').replace(/\s+/g, ' ').trim();

// Visible element whose own label (aria-label or text) equals `label` exactly, resolved to its clickable ancestor.
async function byLabel(pg, label, within = 'body') {
  const h = await pg.evaluateHandle((l, within) => {
    const n = t => String(t || '').replace(/[​‎‏]/g, '').replace(/\s+/g, ' ').trim();
    const root = document.querySelector(within) || document.body;
    const e = [...root.querySelectorAll('[aria-label],[role=button],button,[role=option],[role=combobox],span,div')]
      .filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .find(e => n(e.getAttribute('aria-label')) === l || (e.childElementCount <= 2 && n(e.innerText) === l));
    return e ? (e.closest('[role=button],button,[role=option],[role=combobox],a') || e) : null;
  }, label, within);
  return h.asElement();
}
const uiText = pg => pg.evaluate(() => [...document.querySelectorAll('[role=main] *, [role=dialog] *')].filter(e => e.childElementCount === 0 && e.getBoundingClientRect().width > 0)
  .map(e => (e.innerText || '').replace(/[​]/g, '').trim()).filter(Boolean).join(' | '));

export async function openComposer(b, pageId) {
  const pg = await b.defaultBrowserContext().newPage();                  // แบงค์'s logged-in Meta session
  await pg.setViewport({ width: 1366, height: 900 });
  await pg.goto(COMPOSER(pageId), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.evaluate(n => { window.name = n; }, TAB_NAME);
  for (let i = 0; i < 20; i++) { await sleep(1000); if (await byLabel(pg, 'Add photo/video')) return { ok: true, pg }; }
  return { ok: false, pg, why: `story composer did not load (url ${pg.url().slice(0, 90)})` };
}

// The "Share to" picker is the composer's one [role=combobox][aria-haspopup=listbox] (2/10); its text is the
// selection, e.g. "Dream Bank - iagencyaia and dreambankiagencyaia". More or fewer than one = layout moved → null.
const COMBO = '[role=combobox][aria-haspopup=listbox]';
async function shareToCombo(pg) {
  const hs = await pg.$$(COMBO); const vis = [];
  for (const h of hs) if (await h.evaluate(e => e.getBoundingClientRect().width > 0)) vis.push(h);
  return vis.length === 1 ? vis[0] : null;
}
export async function shareToText(pg) {
  const c = await shareToCombo(pg);
  return c ? c.evaluate(e => String(e.innerText || '').replace(/[\u200b\u200e\u200f]/g, '').replace(/\s+/g, ' ').trim()) : null;
}

export async function upload(pg, winFile) {
  const add = await byLabel(pg, 'Add photo/video');
  if (!add) return { ok: false, why: 'no Add photo/video button' };
  const [fc] = await Promise.all([pg.waitForFileChooser({ timeout: 10000 }).catch(() => null), add.click()]);
  if (!fc) return { ok: false, why: 'Add photo/video opened no file chooser' };
  await fc.accept([winFile]);
  for (let i = 0; i < 60; i++) { await sleep(1000); if (await byLabel(pg, 'Add link')) return { ok: true }; }
  return { ok: false, why: 'media never finished (no Add link button after 60s)' };
}

// Leave exactly the Facebook page selected. Reads aria-selected before and after; fail-closed on anything unexpected.
export async function selectOnlyPage(pg, pageName) {
  const field = await shareToText(pg);
  if (!field) return { ok: false, why: 'Share to field not found' };
  if (field === pageName) return { ok: true, field, changed: false };
  const combo = await shareToCombo(pg);
  if (!combo) return { ok: false, why: `cannot open Share to (${field})` };
  await combo.click(); await sleep(1500);
  const opts = () => pg.evaluate(() => [...document.querySelectorAll('[role=option]')].filter(e => e.getBoundingClientRect().width > 0)
    .map(e => ({ text: (e.innerText || '').replace(/[​]/g, '').replace(/\s+/g, ' ').trim(), sel: e.getAttribute('aria-selected') === 'true' })));
  const before = await opts();
  if (!before.some(o => o.text === pageName)) { await pg.keyboard.press('Escape'); return { ok: false, why: `page ${pageName} not in Share to options: ${before.map(o => o.text).join(', ')}` }; }
  for (const o of before) {
    const want = o.text === pageName;
    if (o.sel !== want) { const el = await byLabel(pg, o.text, '[role=listbox]') || await byLabel(pg, o.text); if (!el) return { ok: false, why: `option ${o.text} not clickable` }; await el.click(); await sleep(1200); }
  }
  const after = await opts();
  await pg.keyboard.press('Escape'); await sleep(1000);
  const sel = after.filter(o => o.sel).map(o => o.text);
  const fieldAfter = await shareToText(pg);
  if (sel.length !== 1 || sel[0] !== pageName || fieldAfter !== pageName)
    return { ok: false, why: `selection not page-only: selected=[${sel.join(', ')}] field=${fieldAfter}`, before, after };
  return { ok: true, field: fieldAfter, changed: true, before, after };
}

export async function addLink(pg, url) {
  const add = await byLabel(pg, 'Add link');
  if (!add) return { ok: false, why: 'no Add link button' };
  await add.click(); await sleep(2500);
  const inp = await pg.$('[role=dialog] input[placeholder="Enter a link"], input[placeholder="Enter a link"]');
  if (!inp) return { ok: false, why: 'link dialog has no "Enter a link" input' };
  await inp.click({ clickCount: 3 }); await pg.keyboard.press('Backspace');
  await inp.type(url, { delay: 15 });
  await sleep(4000);                                                     // link preview loads
  const typed = await inp.evaluate(i => i.value);
  if (typed !== url) return { ok: false, why: `typed URL not exact (${typed})` };
  const apply = await byLabel(pg, 'Apply', '[role=dialog]');
  if (!apply) return { ok: false, why: 'no Apply in link dialog' };
  if (await apply.evaluate(e => e.getAttribute('aria-disabled') === 'true')) return { ok: false, why: `Apply disabled — URL rejected? dialog: ${(await uiText(pg)).slice(0, 200)}` };
  await apply.click(); await sleep(2500);
  if (await pg.$('[role=dialog] input[placeholder="Enter a link"]')) return { ok: false, why: 'link dialog still open after Apply' };
  return { ok: true, typed };
}

// Re-open the link dialog read-only and return what it holds, then Cancel — proves the link is attached pre-share.
export async function readLink(pg, shotPath = null) {
  const btn = await byLabel(pg, 'Edit link') || await byLabel(pg, 'Add link');
  if (!btn) return { ok: false, why: 'no link button to read back' };
  const label = await btn.evaluate(e => (e.innerText || e.getAttribute('aria-label') || '').trim());
  await btn.click(); await sleep(2000);
  const val = await pg.$eval('input[placeholder="Enter a link"]', i => i.value).catch(() => null);
  if (shotPath) await pg.screenshot({ path: shotPath }).catch(() => {});   // evidence: the dialog with the URL in it
  const cancel = await byLabel(pg, 'Cancel', '[role=dialog]'); if (cancel) await cancel.click(); else await pg.keyboard.press('Escape');
  await sleep(1500);
  return { ok: true, button: label, value: val };
}

// Is the composer actually shareable? MBS greys out Share (and shows e.g. "Trim video length … can be up to 30
// seconds" / "Video is too long") instead of failing loudly — a 45 s video reached READY before this check (2 Oct 2026).
// Share disabled is the gate; the visible messages are the reason.
export const shareBlockers = pg => pg.evaluate(() => {
  const share = [...document.querySelectorAll('[role=button],button')].filter(e => e.getBoundingClientRect().width > 0 && (e.innerText || '').trim() === 'Share').at(-1);
  const disabled = !share ? null : share.getAttribute('aria-disabled') === 'true' || share.disabled === true;
  const msgs = [...new Set([...document.querySelectorAll('span,div')].filter(e => e.childElementCount === 0 && e.getBoundingClientRect().width > 0)
    .map(e => (e.innerText || '').trim()).filter(t => t.length < 200 && /too long|too short|can be up to|not supported|unsupported|couldn.t|failed|trim video|error/i.test(t)))];
  return { found: !!share, disabled, messages: msgs.slice(0, 6) };
});

export const shareNowSelected = pg => pg.evaluate(() => {
  const b = [...document.querySelectorAll('[role=button],button')].find(e => (e.innerText || '').trim() === 'Share now');
  return b ? (b.getAttribute('aria-pressed') ?? b.getAttribute('aria-checked') ?? b.getAttribute('aria-selected')) : null;
});

// The single publish click. Only the agent's share step (after an explicit confirm) may call this.
export async function clickShare(pg) {
  const btn = await pg.evaluateHandle(() => [...document.querySelectorAll('[role=button],button')]
    .filter(e => e.getBoundingClientRect().width > 0 && (e.innerText || '').trim() === 'Share').at(-1));
  const el = btn.asElement(); if (!el) return { ok: false, why: 'no Share button' };
  if (await el.evaluate(e => e.getAttribute('aria-disabled') === 'true')) return { ok: false, why: 'Share is disabled' };
  await el.click();
  for (let i = 0; i < 36; i++) {
    await sleep(5000);
    if (!(await byLabel(pg, 'Add link')) && !(await byLabel(pg, 'Edit link'))) return { ok: true };   // composer gone = submitted
  }
  return { ok: false, why: `still on the composer after 3 min: ${(await uiText(pg)).slice(0, 200)}` };
}

// Readback in the live story viewer. Only Facebook's own outbound wrapper (l.facebook.com/l.php?u=…) counts;
// a Chrome extension (Reader Mode) injects readermode.io anchors + a "Learn more"
// button into every page, which a whole-document scan reported as story links on a story that has none (2/10 control).
// `rendered` proves the viewer showed the page's story at all; fail-closed (no exact URL match) is the caller's job.
export async function storyLinks(b, storyUrl, pageName) {
  const pg = await b.defaultBrowserContext().newPage();
  try {
    await pg.setViewport({ width: 1366, height: 900 });
    await pg.goto(storyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.evaluate(n => { window.name = n; }, `${TAB_NAME}_READBACK`);
    await sleep(8000);
    return await pg.evaluate((pageName) => {
      // The viewer has no [role=main]; its only [role=dialog] is Messenger's (2/10) — so no region scoping. COUNT only
      // links behind Facebook's own outbound wrapper; other external anchors are reported as `other`, never counted.
      const links = [], other = [];
      for (const a of document.querySelectorAll('a[href]')) {
        let u; try { u = new URL(a.href); } catch { continue; }
        if (/(^|\.)l\.facebook\.com$/.test(u.hostname) && u.searchParams.get('u')) links.push(u.searchParams.get('u'));
        else if (/^https?:$/.test(u.protocol) && !/(^|\.)(facebook|fb|fbcdn|instagram|meta)\.(com|net)$/.test(u.hostname)) other.push(u.hostname);
      }
      const txt = (document.body.innerText || '').replace(/\s+/g, ' ');
      return { links: [...new Set(links)].slice(0, 20), other: [...new Set(other)].slice(0, 10), rendered: !!pageName && txt.includes(pageName),
        cta: [...new Set([...document.querySelectorAll('[role=button],a')].map(e => (e.innerText || '').trim()).filter(t => /^Visit link$/i.test(t)))], url: location.href.slice(0, 120) };
    }, pageName);
  } finally { await pg.close().catch(() => {}); }
}

// Same URL modulo trailing slash, default ports and fbclid-style tracking params Meta may append.
export function sameUrl(a, b) {
  try {
    const f = s => { const u = new URL(s); for (const k of [...u.searchParams.keys()]) if (/^(fbclid|utm_|mibextid|h$)/.test(k)) u.searchParams.delete(k); u.hash = ''; return (u.origin + u.pathname.replace(/\/$/, '') + (u.search || '')).toLowerCase(); };
    return f(a) === f(b);
  } catch { return false; }
}

export { closeOwn, uiText };
