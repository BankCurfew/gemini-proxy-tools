// ig-web.mjs — instagram.com steps over CDP :9222 (แบงค์'s logged-in Chrome). Selectors from bob's lab
// (BoB-Oracle/ψ/lab/ig-post-carousel.mjs, ig-post-reel.mjs, ig-edit-caption.mjs), measured 30/9–1/10.
// Rules: own tab only (window.name = TAB_NAME) and close it at the end · never restart Chrome · never window state ·
// real input events only (puppeteer keyboard/mouse = CDP Input), never execCommand.
import { createRequire } from 'module';
import { captionExact, shortcodeFromUrl, shortcodeToPk } from './lib.mjs';
const puppeteer = createRequire(import.meta.url)('../node_modules/puppeteer-core');

export const TAB_NAME = 'IG_BRIDGE';
const IG_APP_ID = '936619743392459';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CAPTION_SEL = 'div[role=dialog] div[aria-label^="Write a caption"], div[role=dialog] [contenteditable=true]';

export async function connect() {
  return puppeteer.connect({ browserURL: process.env.IG_BRIDGE_CDP || 'http://localhost:9222', defaultViewport: null });
}

export async function findOwnTab(b) {
  for (const t of b.targets()) {
    if (t.type() !== 'page' || !t.url().includes('instagram.com')) continue;
    const pg = await t.asPage();
    if (await pg.evaluate(() => window.name).catch(() => '') === TAB_NAME) return pg;
  }
  return null;
}

export async function openOwnTab(b, url = 'https://www.instagram.com/') {
  const pg = await b.newPage();
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pg.evaluate(n => { window.name = n; }, TAB_NAME);
  await sleep(4000);
  return pg;
}

export const dialogText = pg => pg.evaluate(() => [...document.querySelectorAll('div[role=dialog]')].map(d => d.innerText.replace(/\s+/g, ' ').slice(0, 300)).join(' | '));

// Username of the logged-in account, from the nav profile link.
export const whoami = pg => pg.evaluate(() => {
  const a = [...document.querySelectorAll('a[href^="/"]')].find(x => /Profile/i.test(x.innerText) || x.querySelector('img[alt*="profile picture" i]'));
  return a ? a.getAttribute('href').replace(/\//g, '') : null;
});

// Real mouse click on the element's centre (el.click() in page JS can "work" without IG registering it — lab 1/10).
async function realClick(pg, handle) {
  const el = handle?.asElement?.(); if (!el) return false;
  await el.scrollIntoView().catch(() => {});
  const box = await el.boundingBox(); if (!box) return false;
  await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}
const svgButton = (pg, label, scope = 'body') => pg.evaluateHandle((label, scope) => {
  const s = [...document.querySelectorAll(`${scope} svg[aria-label]`)].find(x => (label instanceof Array ? label : [label]).includes(x.getAttribute('aria-label')));
  return s ? (s.closest('a,button,[role=link],[role=button],div[tabindex]') || s.parentElement) : null;
}, label, scope);
const textButton = (pg, src, scope = 'div[role=dialog]') => pg.evaluateHandle((src, scope) => {
  const rx = new RegExp(src, 'i');
  return [...document.querySelectorAll(`${scope} button, ${scope} [role=button], ${scope} div, ${scope} span`)]
    .find(e => e.childElementCount < 3 && rx.test((e.innerText || e.getAttribute('aria-label') || '').trim())) || null;
}, src, scope);

export async function openCreatePost(pg) {
  if (!await realClick(pg, await svgButton(pg, ['New post', 'Create']))) return 'no Create button';
  await sleep(2000);
  // Some layouts open a Post/Reel/Live submenu, others go straight to the uploader.
  if (!await pg.$('div[role=dialog] input[type=file]')) {
    await realClick(pg, await svgButton(pg, 'Post')) || await realClick(pg, await textButton(pg, '^Post$', 'body'));
    await sleep(2500);
  }
  return await pg.$('div[role=dialog] input[type=file], input[type=file]') ? null : `no file input: ${await dialogText(pg)}`;
}

export async function upload(pg, winPaths) {
  const input = await pg.$('div[role=dialog] input[type=file], input[type=file]');
  await input.uploadFile(...winPaths);
  for (let i = 0; i < 40; i++) {                         // wait for the crop step (Select crop control appears)
    await sleep(1000);
    if (await pg.$('div[role=dialog] svg[aria-label="Select crop"]')) return null;
  }
  return `upload: crop step never appeared: ${await dialogText(pg)}`;
}

export async function setCrop(pg, ratio) {
  if (ratio === 'original') return null;
  if (!await realClick(pg, await svgButton(pg, 'Select crop', 'div[role=dialog]'))) return 'no Select crop control';
  await sleep(1200);
  const label = ratio === '9:16' ? '9:16' : ratio;
  if (!await realClick(pg, await textButton(pg, `^${label.replace(':', '\\:')}$`))) return `no ${label} crop option`;
  await sleep(1500);
  return null;
}

// The crop preview is a background-image div, not an <img> (lab: img/video ratio read 0) → measure the largest
// visual box inside the dialog: an img/video/canvas, or any element painting a background-image.
export const measureCrop = pg => pg.evaluate(() => {
  const d = document.querySelector('div[role=dialog]'); if (!d) return { ratio: 0, how: 'no dialog' };
  let best = null;
  for (const e of d.querySelectorAll('*')) {
    const visual = /^(IMG|VIDEO|CANVAS)$/.test(e.tagName) || getComputedStyle(e).backgroundImage.startsWith('url(');
    if (!visual) continue;
    const r = e.getBoundingClientRect(); const a = r.width * r.height;
    if (a > 10000 && (!best || a > best.a)) best = { a, w: r.width, h: r.height, tag: e.tagName };
  }
  return best ? { ratio: best.w / best.h, how: `${best.tag} ${Math.round(best.w)}x${Math.round(best.h)}` } : { ratio: 0, how: 'no visual box' };
});

// Media count on the crop/edit step. IG shows one indicator dot per item under the preview; the
// "Open media gallery" panel lists one thumbnail per item. Use the gallery (dots are capped/condensed for long carousels).
export async function countMedia(pg) {
  const opened = await realClick(pg, await svgButton(pg, 'Open media gallery', 'div[role=dialog]'));
  await sleep(1200);
  const n = await pg.evaluate(() => {
    const d = document.querySelector('div[role=dialog]'); if (!d) return 0;
    // gallery thumbnails are background-image tiles of equal small size, in one row
    const tiles = [...d.querySelectorAll('*')].filter(e => getComputedStyle(e).backgroundImage.startsWith('url(')).map(e => e.getBoundingClientRect()).filter(r => r.width > 30 && r.width < 140 && Math.abs(r.width - r.height) < 4);
    return tiles.length;
  });
  if (opened) { await realClick(pg, await svgButton(pg, 'Open media gallery', 'div[role=dialog]')); await sleep(600); }
  return { count: n, how: opened ? 'gallery thumbnails' : 'no gallery button' };
}

export async function next(pg) {
  const ok = await realClick(pg, await textButton(pg, '^Next$'));
  await sleep(3500);
  return ok;
}

// Type the caption with real key events; newlines = Shift+Enter (insertText drops them, execCommand showed text IG never saved).
export async function typeCaption(pg, caption) {
  const box = await pg.$(CAPTION_SEL);
  if (!box) return { ok: false, why: `no caption box: ${await dialogText(pg)}` };
  await box.click(); await sleep(400);
  // clear whatever is there (edit flow starts with the old caption)
  await pg.keyboard.down('Control'); await pg.keyboard.press('a'); await pg.keyboard.up('Control'); await pg.keyboard.press('Backspace');
  const lines = caption.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await pg.keyboard.sendCharacter(lines[i]);
    if (i < lines.length - 1) { await pg.keyboard.down('Shift'); await pg.keyboard.press('Enter'); await pg.keyboard.up('Shift'); }
    await sleep(120);
  }
  await sleep(1200);
  const shown = await pg.evaluate(sel => (document.querySelector(sel) || {}).innerText || '', CAPTION_SEL);
  return { ok: captionExact(shown, caption), shownChars: shown.trim().length };
}

export async function clickShare(pg) {
  if (!await realClick(pg, await textButton(pg, '^Share$'))) return { ok: false, why: 'no Share button' };
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const t = await dialogText(pg);
    if (/has been shared|been shared|Your (post|reel) has been/i.test(t)) return { ok: true, text: t.slice(0, 150) };
    if (/couldn.t be shared|something went wrong|try again/i.test(t)) return { ok: false, why: t.slice(0, 200) };
  }
  return { ok: false, why: 'no share confirmation in 5 min' };
}

// Read a post back through instagram.com's own web API (works for any logged-in account, no Graph token).
export async function mediaInfo(pg, code) {
  const pk = shortcodeToPk(code);
  return pg.evaluate(async (pk, appId) => {
    const r = await fetch(`/api/v1/media/${pk}/info/`, { headers: { 'X-IG-App-ID': appId }, credentials: 'include' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const i = (await r.json())?.items?.[0]; if (!i) return { error: 'no item' };
    return { code: i.code, media_type: i.media_type, carousel_media_count: i.carousel_media_count ?? null, caption: i.caption?.text ?? '', taken_at: i.taken_at, user: i.user?.username };
  }, pk, IG_APP_ID);
}

// After share: find the new post on the profile grid. Pinned posts sit first, so take the first code whose
// taken_at is after the share started (max 6 lookups).
export async function findNewPost(pg, user, sinceSec) {
  await pg.goto(`https://www.instagram.com/${user}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  const codes = await pg.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')].map(a => a.getAttribute('href')))].slice(0, 6));
  for (const href of codes) {
    const code = shortcodeFromUrl('https://www.instagram.com' + href); if (!code) continue;
    const info = await mediaInfo(pg, code);
    if (!info.error && info.taken_at >= sinceSec - 60) return { ...info, permalink: `https://www.instagram.com${href}` };
    await sleep(800);
  }
  return null;
}

export async function editCaption(pg, permalink, caption) {
  await pg.goto(permalink, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await sleep(5000);
  if (!await realClick(pg, await svgButton(pg, 'More options'))) return { ok: false, why: 'no More options' };
  await sleep(1500);
  if (!await realClick(pg, await textButton(pg, '^Edit$'))) return { ok: false, why: 'no Edit' };
  await sleep(3000);
  const typed = await typeCaption(pg, caption);
  if (!typed.ok) return { ok: false, why: `typed caption not exact (${typed.why || typed.shownChars + ' chars shown'}) — not saving` };
  const done = await pg.evaluateHandle(() => [...document.querySelectorAll('div[role=dialog] *')].find(x => (x.innerText || '').trim() === 'Done' && x.childElementCount === 0));
  if (!await realClick(pg, done)) return { ok: false, why: 'no Done' };
  for (let i = 0; i < 20; i++) { await sleep(1000); if (!(await pg.$('div[role=dialog] [contenteditable=true]'))) return { ok: true }; }
  return { ok: false, why: 'edit dialog did not close after Done' };
}
