#!/usr/bin/env node
// T2790 control: OWN decoy tab (a page with a ProseMirror-like composer and a Send button that never enables).
//   A. healthy tab + Send disabled → the T2398 reload path still runs (reload happens, returns false, no throw)
//   B. tab that went silent in THIS run (busy-looped through a raw CDP session past one guard window) + Send disabled
//      → TabBusyError (exit 75 in the CLI), NO reload, composer text left as typed (nothing sent)
// Never touches another tab; the decoy is closed in finally. Spike lines go to a temp log, not the fleet log.
//   NODE_PATH=<repo>/node_modules node test/t2790-stalled-send.test.js
'use strict';
const os = require('os'); const path = require('path');
process.env.TAB_SPIKE_LOG = path.join(os.tmpdir(), `t2790-spikes-${process.pid}.log`);
const puppeteer = require('puppeteer-core');
const { guardTab, TabBusyError } = require('../scripts/tab-guard');
const { sendAndConfirm } = require('../scripts/poster');
const HTML = 'data:text/html,' + encodeURIComponent('<title>T2790-DECOY</title><form><div class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid"></div><button type="button" aria-label="Send" disabled>Send</button></form>');
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); origErr(...a); };

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null, protocolTimeout: 120000 });
  const raw = await browser.newPage();
  try {
    await raw.goto(HTML);
    const page = guardTab(raw, { windowMs: 1000, windows: 3 });
    const mark = () => page.evaluate(() => { window.__t2790 = 1; });
    const marked = () => page.evaluate(() => window.__t2790 === 1);
    // A
    await mark(); errs.length = 0;
    let threwA = null, resA;
    try { resA = await sendAndConfirm(page, 'T2790 control text A', { label: 'A', waitEnabledMs: 1500, timeoutMs: 1000 }); } catch (e) { threwA = e; }
    check('A healthy tab: no throw', !threwA, threwA && threwA.message);
    check('A healthy tab: reload path ran', errs.some(l => l.includes('retrying once after reload')) && !(await marked()), 'marker gone = page reloaded');
    check('A healthy tab: returns false (not sent)', resA === false);
    check('A healthy tab: no silent windows counted', !(page.__tabSilentWindows > 0), `count ${page.__tabSilentWindows || 0}`);
    // B: make the tab go silent past one window (busy loop 2.2 s through a raw session, guarded evaluate waits it out)
    await raw.goto(HTML); await mark(); errs.length = 0;
    const s = await raw.target().createCDPSession();
    s.send('Runtime.evaluate', { expression: 'const t=Date.now(); while (Date.now()-t < 2200) {}' }).catch(() => {});
    await new Promise(r => setTimeout(r, 100));
    await page.evaluate(() => 1);
    check('B: tab-guard counted a silent window', page.__tabSilentWindows > 0, `count ${page.__tabSilentWindows}`);
    let threwB = null;
    try { await sendAndConfirm(page, 'T2790 control text B', { label: 'B', waitEnabledMs: 1500, timeoutMs: 1000 }); } catch (e) { threwB = e; }
    check('B stalled tab: TabBusyError', threwB instanceof TabBusyError, threwB ? threwB.message.slice(0, 90) : 'no throw');
    check('B stalled tab: NO reload', !errs.some(l => l.includes('retrying once after reload')) && await marked(), 'marker still there');
    const txt = await page.evaluate(() => document.querySelector('.ProseMirror').innerText.trim());
    check('B stalled tab: text left in composer, not sent', txt.includes('T2790 control text B'), `${txt.length} chars`);
  } finally { await raw.close().catch(() => {}); browser.disconnect(); }
  console.error = origErr;
  const pass = results.filter(Boolean).length; console.log(`T2790 ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error = origErr; console.error('ERROR', e); process.exit(2); });
