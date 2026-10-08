// T2801 read-only probe: open OUR OWN tab on grok.com/imagine in แบงค์'s Chrome (CDP :9222), list the controls as text,
// screenshot to disk, close the tab. Clicks nothing and generates nothing (no SuperGrok budget used).
// Usage: node scripts/grok-imagine-probe.mjs [url] [shot.png] [--click "Video" --click "Speed" …]
// --click only for mode/settings controls; the probe refuses labels that could submit or spend (generate/send/upgrade).
import puppeteer from 'puppeteer-core';
import { ownPage } from '../../Admin-Oracle/scripts/lib/cdp-own-tab.mjs';

const url = process.argv[2] || 'https://grok.com/imagine';
const shot = process.argv[3] || '';
const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null });
let page;
try {
  page = await ownPage(browser, 'dev-t2801-probe');
  // a background tab may not render: emulate focus + keep the page lifecycle "active" (no bringToFront — that would
  // switch the tab แบงค์ is looking at)
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  for (let i = 0; i < 30; i++) {   // ≤30 s for the app to hydrate
    await new Promise((r) => setTimeout(r, 1000));
    const n = await page.evaluate(() => document.body.innerText.trim().length).catch(() => 0);
    if (n > 60) break;
  }
  const clicks = []; process.argv.forEach((a, i) => { if (a === '--click') clicks.push(process.argv[i + 1]); });
  for (const label of clicks) {
    if (/generat|send|submit|upgrade|subscribe|buy|make video|create/i.test(label)) throw new Error(`refusing to click "${label}" in a probe`);
    const ok = await page.evaluate((l) => {
      const el = [...document.querySelectorAll('button,[role=button],[role=menuitem],[role=option],[role=radio]')]
        .find((e) => (e.getAttribute('aria-label') || e.innerText || '').trim() === l && e.getBoundingClientRect().width > 0);
      if (!el) return false; el.click(); return true;
    }, label);
    console.error(`click "${label}": ${ok ? 'ok' : 'NOT FOUND'}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const info = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const lab = (e) => (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return {
      url: location.href, title: document.title,
      buttons: [...document.querySelectorAll('button,[role=button],a[role=tab],[role=tab],[role=menuitem],[role=option],[role=radio]')].filter(vis).map((e) => ({ tag: e.tagName, label: lab(e), testid: e.getAttribute('data-testid') || '' })).slice(0, 60),
      inputs: [...document.querySelectorAll('input,textarea,[contenteditable=true]')].map((e) => ({ tag: e.tagName, type: e.type || '', accept: e.getAttribute('accept') || '', label: lab(e), visible: vis(e) })).slice(0, 20),
      bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 600),
    };
  });
  console.log(JSON.stringify(info, null, 1));
  if (shot) { await page.screenshot({ path: shot }); console.log('shot: ' + shot); }
} finally {
  if (page) await page.close().catch(() => {});
  browser.disconnect();
}
