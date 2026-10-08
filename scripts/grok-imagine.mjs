#!/usr/bin/env node
// T2801 grok-imagine: image → video on grok.com Imagine in แบงค์'s Chrome (CDP :9222, his SuperGrok login; GR#5 carve-out).
//   node scripts/grok-imagine.mjs --image in.png --prompt-file p.txt [--duration 6] [--res 720p] [--aspect 1:1] --out out.mp4 [--dry-run]
// - opens its OWN tab (cdp-own-tab registry) and closes it in finally; never touches แบงค์'s tabs, never bringToFront
// - --dry-run does everything except submit: prints the submit control it would press + a screenshot path
// - Grok's own error text (usage limit, moderation, login) is printed verbatim; exit 1. No image data on stdout.
// Each real run spends one generation from the shared SuperGrok pool (designer pilot budget: ~6).
import puppeteer from 'puppeteer-core';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { ownPage } from '../../Admin-Oracle/scripts/lib/cdp-own-tab.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const image = opt('image'), promptFile = opt('prompt-file'), out = opt('out');
const duration = `${String(opt('duration', '6')).replace(/s$/, '')}s`, res = opt('res', '720p'), aspect = opt('aspect', '1:1');
const dry = flag('dry-run'), timeoutMin = Number(opt('timeout-min', '8'));
// before the browser is connected die() exits; after, it THROWS so `finally` always closes our tab (process.exit skips finally)
let connected = false;
const die = (m, code = 1) => { if (!connected) { console.error(`grok-imagine: ${m}`); process.exit(code); } const e = new Error(m); e.exitCode = code; throw e; };
if (!image || !promptFile || (!out && !dry)) die('usage: --image <png> --prompt-file <txt> --out <mp4> [--duration 6|10|15] [--res 480p|720p|1080p] [--aspect 1:1] [--dry-run]', 2);
if (!fs.existsSync(image)) die(`image not found: ${image}`, 2);
const prompt = fs.readFileSync(promptFile, 'utf-8').trim();
if (!prompt) die('prompt file is empty', 2);
const ASPECT = { '1:1': '1:1 Square', '2:3': '2:3 Tall', '3:2': '3:2 Wide', '9:16': '9:16 Vertical', '16:9': '16:9 Widescreen', auto: 'Auto' };
const shotDir = path.resolve(path.dirname(out || promptFile));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
let page, code = 0;
connected = true;
try {
  page = await ownPage(browser, 'grok-imagine');
  const cdp = await page.createCDPSession();
  // a background tab may not render; emulate focus instead of bringing it to the front (that would switch แบงค์'s view)
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await page.goto('https://grok.com/imagine', { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 30 && (await page.evaluate(() => document.body.innerText.length)) < 60; i++) await sleep(1000);
  await sleep(1500);
  // Grok's own error text, from the MAIN area only: the sidebar lists chat titles ("… Unlimited NSFW …" matched /limit/)
  const grokSays = () => page.evaluate(() => {
    const scope = document.querySelector('main') || document.body;
    const t = [...scope.querySelectorAll('*')].filter((e) => !e.closest('nav,aside,[data-sidebar]') && !e.children.length).map((e) => e.innerText || '').join('\n');
    const m = t.match(/[^\n]*\b(usage limit|rate limit|limit reached|hit your [a-z ]*limit|upgrade to supergrok|sign in to|log in to|moderat\w*|content polic\w*|not allowed|try again later|something went wrong)\b[^\n]*/i);
    return m ? m[0].trim().slice(0, 300) : '';
  });
  if (!(await page.$('button[aria-label="Video"]'))) die(`Imagine page not ready${(await grokSays()) ? ' — Grok says: ' + (await grokSays()) : ''}`);

  // 1. Video mode + settings (Radix menus open on real pointer events, so use handle.click)
  await (await page.$('button[aria-label="Video"]')).click(); await sleep(1200);
  const pick = async (menu, item) => {
    const h = await page.$(`button[aria-label="${menu}"]`);
    if (!h) die(`control missing: ${menu}`);
    await h.click(); await sleep(900);
    const ok = await page.evaluate((item) => {
      const e = [...document.querySelectorAll('[role=menuitem],[role=menuitemradio],[role=option],[role=radio]')]
        .find((x) => x.getBoundingClientRect().width > 0 && x.innerText.trim().replace(/\s+/g, ' ') === item);
      if (!e) return false; e.click(); return true;
    }, item);
    if (!ok) { await page.keyboard.press('Escape'); die(`option "${item}" not in ${menu}`); }
    await sleep(700);
    const now = await page.evaluate((m) => document.querySelector(`button[aria-label="${m}"]`)?.innerText.trim(), menu);
    console.error(`${menu}: ${now}`);
  };
  await pick('Video duration', duration);
  await pick('Video resolution', res);
  await pick('Aspect Ratio', ASPECT[aspect.toLowerCase()] || aspect);

  // 2. upload the image through the page's own file input. "Attached" is judged INSIDE the composer only (the element
  //    holding both the prompt box and Submit): the gallery below is full of grok-hosted images, so a page-wide check
  //    passes with nothing attached.
  const composerImgs = () => page.evaluate(() => {
    let root = document.querySelector('[contenteditable=true]');
    while (root && !root.querySelector('button[aria-label="Video duration"]')) root = root.parentElement;   // Submit only renders once there is text
    return root ? [...root.querySelectorAll('img')].filter((i) => i.getBoundingClientRect().width > 8).length : -1;
  });
  const imgsBefore = await composerImgs();
  if (imgsBefore < 0) die('composer not found');
  // the composer's form input (name="files", multiple, inside the prompt FORM — probed 8 Oct). The Upload button opens a
  // menu, not a file chooser, so the input is fed directly; nothing pops up on แบงค์'s screen.
  const fileInput = await page.$('form input[type=file][name=files]');
  if (!fileInput) die('composer file input (form input[name=files]) missing');
  // แบงค์'s Chrome runs on WINDOWS: a Linux path reads as an empty file there ("Cannot upload an empty file." — grok's
  // tooltip, 8 Oct). Hand Chrome the \\wsl.localhost\… form of the path.
  let chromePath = path.resolve(image);
  try { chromePath = execFileSync('wslpath', ['-w', chromePath], { encoding: 'utf-8' }).trim(); } catch {}
  await fileInput.uploadFile(chromePath);
  for (let i = 0; ; i++) {
    await sleep(1000);
    const n = await composerImgs();
    if (n > imgsBefore) {
      await sleep(2000);
      // a rejected upload still shows a tile, with grok's warning icon + a tooltip saying why
      const warn = await page.evaluate(() => !!document.querySelector('form [id="name=warning"]'));
      if (warn) {
        const tile = await page.$('form img[src^="blob:"]'); if (tile) await tile.hover(); await sleep(1000);
        const why = await page.evaluate(() => [...document.querySelectorAll('[role=tooltip]')].map((e) => e.innerText.trim()).join(' | '));
        die(`Grok rejected the image: ${why || '(warning icon, no tooltip text)'}`);
      }
      console.error(`image attached (composer images ${imgsBefore} → ${n})`); break;
    }
    if (i === 29) die(`image did not attach to the composer (images ${imgsBefore} → ${n})${(await grokSays()) ? ' — Grok says: ' + (await grokSays()) : ''}`);
  }

  // 3. prompt into the composer (contenteditable)
  const box = await page.$('[contenteditable=true]');
  if (!box) die('prompt box missing');
  await box.click(); await page.keyboard.type(prompt, { delay: 2 });

  // 4. the submit control: the enabled button nearest the composer whose label says submit/send/generate/make
  const submit = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) =>
    !b.disabled && b.getBoundingClientRect().width > 0 && /submit|send|generate|make video|create/i.test(b.getAttribute('aria-label') || b.innerText || '')));
  const submitLabel = await page.evaluate((b) => b ? (b.getAttribute('aria-label') || b.innerText).trim() : '', submit);
  const shot = path.join(shotDir, `grok-imagine-${dry ? 'dry' : 'submit'}-${Date.now()}.png`);
  await page.screenshot({ path: shot });
  if (dry) { console.log(JSON.stringify({ dryRun: true, submit: submitLabel || null, duration, res, aspect, screenshot: shot })); }
  else {
    if (!submitLabel) die(`no submit control found (screenshot ${shot})`);
    const before = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src).filter(Boolean));
    await submit.asElement().click();
    console.error(`submitted via "${submitLabel}", waiting ≤${timeoutMin} min`);
    // 5. wait for a NEW video element with a real source
    let src = '';
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMin * 60000) {
      await sleep(4000);
      const said = await grokSays();
      if (said) die(`Grok says: ${said}`);
      src = await page.evaluate((before) => {
        const v = [...document.querySelectorAll('video')].map((v) => v.currentSrc || v.src).filter((s) => s && !before.includes(s) && !s.startsWith('blob:'));
        return v[v.length - 1] || '';
      }, before);
      if (src) break;
    }
    if (!src) die(`no video after ${timeoutMin} min (screenshot ${shot})`);
    // 6. download through the page (same cookies), base64 only across the CDP pipe, never to stdout
    const b64 = await page.evaluate(async (u) => {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return 'ERR:' + r.status;
      const buf = new Uint8Array(await r.arrayBuffer()); let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    }, src);
    if (b64.startsWith('ERR:')) die(`download failed ${b64.slice(4)} for ${src}`);
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    const md5 = crypto.createHash('md5').update(fs.readFileSync(out)).digest('hex');
    let probe = {};
    try { probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', out], { encoding: 'utf-8' })); } catch {}
    console.log(JSON.stringify({ out: path.resolve(out), md5, bytes: fs.statSync(out).size, duration: Number(probe.format?.duration) || null, width: probe.streams?.[0]?.width ?? null, height: probe.streams?.[0]?.height ?? null }));
  }
} catch (e) {
  console.error(`grok-imagine: ${e?.message || e}`); code = e?.exitCode || 1;
} finally {
  if (page) await page.close().catch(() => {});
  browser.disconnect();
}
process.exit(code);
