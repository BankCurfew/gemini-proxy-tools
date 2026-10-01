// ig-web.mjs — instagram.com steps over CDP :9222 (แบงค์'s logged-in Chrome). Selectors from bob's lab
// (BoB-Oracle/ψ/lab/ig-post-carousel.mjs, ig-post-reel.mjs, ig-edit-caption.mjs), measured 30/9–1/10.
// Rules: own tab only (window.name = TAB_NAME) and close it at the end · never restart Chrome · never window state ·
// real input events only (puppeteer keyboard/mouse = CDP Input), never execCommand.
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

// Which browser context an account runs in (bob ruling 1/10): only the production account uses แบงค์'s own
// (default) context. Every other account gets an ISOLATED context — its own cookie store, loaded from a jar —
// so a test login can never switch or log out the DreamBank session.
const DEFAULT_CTX_USERS = (process.env.IG_BRIDGE_DEFAULT_CTX_USERS || 'dreambankiagencyaia').split(',').map(s => s.trim().toLowerCase());
const JAR_DIR = process.env.IG_BRIDGE_DATA || path.join(os.homedir(), '.oracle', 'ig-bridge');
export const jarPath = user => path.join(JAR_DIR, `jar-${user.toLowerCase()}.json`);
export const usesDefaultContext = user => DEFAULT_CTX_USERS.includes(String(user).toLowerCase());

async function contextFor(b, user) {
  if (usesDefaultContext(user)) return { ctx: b.defaultBrowserContext(), isolated: false };
  if (!fs.existsSync(jarPath(user))) throw new Error(`no cookie jar for ${user} — run: ig-post.sh login ${user}`);
  const ctx = await b.createBrowserContext();
  await ctx.setCookie(...JSON.parse(fs.readFileSync(jarPath(user), 'utf8')));
  return { ctx, isolated: true };
}

export async function saveJar(pg, user) {
  if (usesDefaultContext(user)) return false;
  const cookies = (await pg.browserContext().cookies()).filter(c => /instagram\.com$/.test(c.domain.replace(/^\./, '')));
  fs.mkdirSync(JAR_DIR, { recursive: true });
  fs.writeFileSync(jarPath(user) + '.tmp', JSON.stringify(cookies), { mode: 0o600 });
  fs.renameSync(jarPath(user) + '.tmp', jarPath(user));
  return cookies.length;
}

// Close our tab, and the whole context if it was an isolated one (refreshing the jar first: IG rotates session cookies).
export async function closeOwn(pg, user) {
  if (!pg) return;
  const ctx = pg.browserContext();
  const isolated = ctx !== pg.browser().defaultBrowserContext();
  if (isolated && user) await saveJar(pg, user).catch(() => {});
  await pg.close().catch(() => {});
  if (isolated) await ctx.close().catch(() => {});
}

export async function openOwnTab(b, user, url = 'https://www.instagram.com/') {
  const { ctx } = await contextFor(b, user);
  const pg = await ctx.newPage();
  await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pg.evaluate(n => { window.name = n; }, TAB_NAME);
  await sleep(4000);
  return pg;
}

// One-time login for a test account: opens the login page in a fresh isolated context and waits for a human to
// sign in (password/2FA never pass through us), then stores the cookies in the jar (0600).
export async function login(b, user, timeoutMs = 10 * 60 * 1000) {
  if (usesDefaultContext(user)) return { ok: false, why: `${user} runs in the default context — never log in/out there` };
  const ctx = await b.createBrowserContext();
  const pg = await ctx.newPage();
  try {
    await pg.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await pg.evaluate(n => { window.name = n; }, TAB_NAME + '_LOGIN');
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      await sleep(5000);
      if (!/\/accounts\/login/.test(pg.url())) {
        const who = await whoami(pg).catch(() => null);
        if (who) {
          if (who.toLowerCase() !== user.toLowerCase()) return { ok: false, why: `signed in as ${who}, expected ${user} — jar not saved` };
          return { ok: true, cookies: await saveJar(pg, user) };
        }
      }
    }
    return { ok: false, why: 'login not completed in time' };
  } finally { await pg.close().catch(() => {}); await ctx.close().catch(() => {}); }
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

// ---------- Stories (instagram.com in MOBILE emulation — bob probe 1/10, BoB-Oracle/ψ/lab/ig-mweb-probe.mjs) ----------
// Desktop instagram.com has no Story composer; the iPhone-emulated site shows "+" → Post | Story → editor → "Share story".
const IPHONE = { viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const tapText = async (pg, src) => {
  const h = await pg.evaluateHandle(src => { const rx = new RegExp(src, 'i');
    const e = [...document.querySelectorAll('button,[role=button],a,div[tabindex],svg[aria-label],span')].find(e => rx.test((e.getAttribute('aria-label') || e.innerText || '').trim()));
    return e ? (e.tagName === 'svg' || e.tagName === 'SPAN' ? (e.closest('a,button,[role=button],div[tabindex]') || e) : e) : null; }, src);
  const el = h.asElement(); if (!el) return false;
  await el.tap(); return true;
};
const pageText = pg => pg.evaluate(() => [...new Set([...document.querySelectorAll('[aria-label],button,[role=button],span,img[alt]')].map(e => (e.getAttribute('aria-label') || e.alt || e.innerText || '').trim()).filter(t => t && t.length < 40))].join(' | '));

export async function openStoryEditor(pg, winFile) {
  await pg.emulate(IPHONE);
  await pg.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await pg.evaluate(n => { window.name = n; }, TAB_NAME);
  await sleep(7000);
  await tapText(pg, '^Not now$'); await sleep(1500);
  // "+" top-right has no aria-label and the right-most icon is not it → bob's measured point at 390px width;
  // the Story-option check below fails loudly if the layout moved.
  const p = { x: 322, y: 22 };
  await pg.touchscreen.tap(p.x, p.y); await sleep(3000);
  if (!/(^|\|\s*)Story(\s*\||$)/.test(await pageText(pg))) return { ok: false, why: `"+" menu has no Story option (tapped ${Math.round(p.x)},${Math.round(p.y)})` };
  const [fc] = await Promise.all([pg.waitForFileChooser({ timeout: 10000 }).catch(() => null), tapText(pg, '^Story$')]);
  if (!fc) return { ok: false, why: 'Story tapped but no file chooser' };
  await fc.accept([winFile]);
  for (let i = 0; i < 30; i++) { await sleep(1000); if (/Share story|Your story/i.test(await pageText(pg))) return { ok: true }; }
  return { ok: false, why: `story editor never showed "Share story": ${(await pageText(pg)).slice(0, 200)}` };
}

// Phase 1b (UNPROVEN): does the sticker tray offer Music in emulation? Report what the tray shows; never guess.
export async function probeMusicSticker(pg, waitMs = 30000) {
  if (!await tapText(pg, '^Stickers?$')) await pg.touchscreen.tap(185, 29);
  const until = Date.now() + waitMs; let t = '';
  while (Date.now() < until) { await sleep(2000); t = await pageText(pg); if (!/Loading/i.test(t) && /music|search/i.test(t)) break; }
  return { music: /(^|\|\s*)Music(\s*\||$)/i.test(t), loading: /Loading/i.test(t), tray: t.slice(0, 400) };
}

export async function shareStory(pg) {
  if (!await tapText(pg, '^(Share story|Your story)$')) return { ok: false, why: 'no Share story button' };
  for (let i = 0; i < 36; i++) { await sleep(5000); if (!/Share story/i.test(await pageText(pg))) return { ok: true }; }
  return { ok: false, why: 'still on the story editor after 3 min' };
}

// Readback: the account's live story items (ds_user_id cookie = the logged-in account id).
export async function latestStory(pg, sinceSec) {
  const uid = (await pg.browserContext().cookies()).find(c => c.name === 'ds_user_id')?.value;
  if (!uid) return { error: 'no ds_user_id cookie' };
  return pg.evaluate(async (uid, appId, since) => {
    const r = await fetch(`/api/v1/feed/reels_media/?reel_ids=${uid}`, { headers: { 'X-IG-App-ID': appId }, credentials: 'include' });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const items = (await r.json())?.reels?.[uid]?.items || [];
    const fresh = items.filter(i => i.taken_at >= since - 60);
    return { total: items.length, fresh: fresh.length, newest: fresh.at(-1) && { pk: fresh.at(-1).pk, media_type: fresh.at(-1).media_type, taken_at: fresh.at(-1).taken_at } };
  }, uid, IG_APP_ID, sinceSec);
}
