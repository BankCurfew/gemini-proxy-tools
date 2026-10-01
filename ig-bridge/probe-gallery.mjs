// one-off probe (T2445): open create → upload → open media gallery, dump what the thumbnails are. Never shares; closes the tab.
import * as web from './ig-web.mjs';
const files = process.argv.slice(2);
const b = await web.connect(); let pg;
try {
  pg = await web.openOwnTab(b, 'dreambankiagencyaia');
  console.log('who', await web.whoami(pg));
  console.log('create', await web.openCreatePost(pg));
  console.log('upload', await web.upload(pg, files));
  const before = await pg.evaluate(() => [...document.querySelectorAll('div[role=dialog] svg[aria-label]')].map(s => s.getAttribute('aria-label')));
  console.log('svg labels', JSON.stringify(before));
  const s = [...await pg.$$('div[role=dialog] svg[aria-label="Open media gallery"]')];
  if (s[0]) { const el = await s[0].evaluateHandle(x => x.closest('button,[role=button],div[tabindex]') || x.parentElement); const bx = await el.asElement().boundingBox(); await pg.mouse.click(bx.x + bx.width / 2, bx.y + bx.height / 2); }
  await new Promise(r => setTimeout(r, 1500));
  const dump = await pg.evaluate(() => {
    const d = document.querySelector('div[role=dialog]'); const out = {};
    for (const e of d.querySelectorAll('*')) {
      const r = e.getBoundingClientRect(); if (r.width < 20 || r.width > 200 || r.height < 20 || r.height > 200) continue;
      const bg = getComputedStyle(e).backgroundImage.startsWith('url(');
      const k = `${e.tagName}${bg ? '[bg]' : ''}${e.getAttribute('role') ? '[' + e.getAttribute('role') + ']' : ''} ${Math.round(r.width)}x${Math.round(r.height)} y${Math.round(r.y)}`;
      out[k] = (out[k] || 0) + 1;
    }
    return Object.entries(out).filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 15);
  });
  console.log('gallery candidates (≥4 same shape)', JSON.stringify(dump));
  await pg.screenshot({ path: '/home/curfew/.maw/inbox/ig-bridge/probe-gallery.png' });
} finally { await web.closeOwn(pg, 'dreambankiagencyaia'); b.disconnect(); }
