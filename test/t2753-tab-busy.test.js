#!/usr/bin/env node
// T2753 control (admin's T2741 pattern): OWN decoy tab (about:blank#T2753-DECOY) is busy-looped through a raw CDP
// session; a guarded evaluate on it must report TAB BUSY and then return the right answer when the loop ends, a loop
// longer than every window must end in TabBusyError (not a hang), and a healthy tab must answer with no TAB BUSY.
// Never touches another tab; the decoy is closed in finally. Spike lines go to a temp log, not the fleet log.
//   NODE_PATH=<repo>/node_modules node test/t2753-tab-busy.test.js
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const log = path.join(os.tmpdir(), `t2753-spikes-${process.pid}.log`);
process.env.TAB_SPIKE_LOG = log;
const puppeteer = require('puppeteer-core');
const { guardTab, TabBusyError } = require('../scripts/tab-guard');

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null, protocolTimeout: 120000 });
  // background tab (never focus/raise bank's window)
  const bs = await browser.target().createCDPSession();
  const { targetId } = await bs.send('Target.createTarget', { url: 'about:blank#T2753-DECOY', background: true });
  const target = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 15000 });
  const page = await target.page();
  const errs = [];
  const origErr = console.error; console.error = (...a) => { errs.push(a.join(' ')); origErr(...a); };
  try {
    const cdp = await page.createCDPSession();
    const opts = { windowMs: 1000, windows: 3 };
    guardTab(page, opts);

    // 1. healthy: answers, no TAB BUSY
    errs.length = 0;
    check('healthy tab answers', (await page.evaluate(() => 6 * 7)) === 42);
    check('healthy tab: no TAB BUSY', !errs.some((e) => e.includes('TAB BUSY')));

    // 2. busy 2.5 s (< 3 windows): TAB BUSY printed, then the SAME call returns its answer
    errs.length = 0;
    cdp.send('Runtime.evaluate', { expression: '{ const e=Date.now()+2500; while(Date.now()<e){} } 1' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    const v = await page.evaluate(() => 'recovered');
    check('busy 2.5 s → answer after recovery', v === 'recovered', `${Date.now() - t0} ms`);
    check('busy 2.5 s → TAB BUSY printed', errs.some((e) => e.includes('TAB BUSY')));
    const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    check('TAB-SLOW lines logged (BUSY + recovered)', /TAB-SLOW poster\.js evaluate · BUSY 1\/3/.test(lines) && /recovered/.test(lines));

    // 3. busy 5 s (> 3 windows): TabBusyError, not a hang; no re-login wording
    errs.length = 0;
    cdp.send('Runtime.evaluate', { expression: '{ const e=Date.now()+5000; while(Date.now()<e){} } 1' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    let err = null; const t1 = Date.now();
    try { await page.evaluate(() => 1); } catch (e) { err = e; }
    check('busy 5 s → TabBusyError', err instanceof TabBusyError, `${Date.now() - t1} ms · ${err && err.message}`);
    check('no re-login wording', !/re-?login|session expired/i.test(err ? err.message : ''));
    await new Promise((r) => setTimeout(r, 2500));   // let the loop end before the next check

    // 4. side effect runs ONCE: a call that sets a counter during a busy window is not re-issued
    await page.evaluate(() => { window.__n = 0; });
    cdp.send('Runtime.evaluate', { expression: '{ const e=Date.now()+2000; while(Date.now()<e){} } 1' }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    await page.evaluate(() => { window.__n += 1; });
    check('side effect applied once', (await page.evaluate(() => window.__n)) === 1);

    // 5. $ / $$ guarded too
    check('$$ guarded', Array.isArray(await page.$$('body')));
  } finally {
    console.error = origErr;
    await bs.send('Target.closeTarget', { targetId }).catch(() => {});
    browser.disconnect();
    try { fs.unlinkSync(log); } catch {}
  }
  const ok = results.every(Boolean);
  console.log(`${results.filter(Boolean).length}/${results.length} ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
