#!/usr/bin/env node
// T2753 control (admin's T2741 pattern): OWN decoy tab (about:blank#T2753-DECOY) is busy-looped through a raw CDP
// session; a guarded evaluate on it must report TAB BUSY and then return the right answer when the loop ends, a loop
// longer than every window must end in TabBusyError (not a hang), and a healthy tab must answer with no TAB BUSY.
// T3016 (bob 14 Oct): the decoy is the test's OWN slot tab (cdp-window.mjs getWindow, L4 like poster; T2753_SLOT to
// change), released in finally. It used to be Target.createTarget({ background: true }) with no window = a throttled
// background tab in whatever window was last focused (แบงค์'s): GR5.3, and a 4/10 flake under load. The run asserts that
// every page tab outside the slot window is the same set before and after (ids; browser-level calls, nothing attached).
// Spike lines go to a temp log, not the fleet log.
//   NODE_PATH=<repo>/node_modules node test/t2753-tab-busy.test.js
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const log = path.join(os.tmpdir(), `t2753-spikes-${process.pid}.log`);
process.env.TAB_SPIKE_LOG = log;
const { pathToFileURL } = require('url');
const { guardTab, TabBusyError } = require('../scripts/tab-guard');
const SLOT = process.env.T2753_SLOT || 'L4';
const CDP_WINDOW = process.env.POSTER_CDP_WINDOW || path.join(os.homedir(), '.oracle/tools/cdp-window.mjs');

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const { getWindow } = await import(pathToFileURL(CDP_WINDOW).href);
  const w = await getWindow(SLOT, { waitLockMs: 60000, protocolTimeout: 120000 });
  // a minimized slot (no display) is throttled like a background tab: the 1 s windows below would time Chrome, not tab-guard
  if (!w.pinned && !w.bounds) { await w.release(); console.error(`SKIP: slot ${SLOT} has no display (minimized, throttled)\nfix: T2753_SLOT=<a slot pinned in ~/.oracle/state/cdp-slots/layout-bank.json>`); process.exit(2); }
  // every page tab OUTSIDE the slot window (แบงค์'s and other oracles'), by id: browser-level calls only, no attach
  const others = async () => {
    const { targetInfos } = await w.sess.send('Target.getTargets');
    const ids = [];
    for (const t of targetInfos.filter((x) => x.type === 'page')) {
      const r = await w.sess.send('Browser.getWindowForTarget', { targetId: t.targetId }).catch(() => ({}));
      if (r.windowId !== w.windowId) ids.push(t.targetId);
    }
    return ids.sort();
  };
  const before = await others();
  const page = w.page;
  await page.goto('about:blank#T2753-DECOY');
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
    // T3016 accept (bob): the tabs outside the slot window are exactly the ones that were there before the run
    const after = await others().catch(() => null);
    check(`tabs outside slot ${SLOT} unchanged (${before.length} before)`, !!after && JSON.stringify(after) === JSON.stringify(before), after ? `${after.length} after` : 'unreadable');
    await w.release();   // closes stray tabs IN the slot window only, drops the slot lock, disconnects
    try { fs.unlinkSync(log); } catch {}
  }
  // 6. exit code: TAB BUSY has its own code (75), not 4 (= T599 cross-brand ABORT), and 75 means nothing else
  const src = fs.readFileSync(path.join(__dirname, '../scripts/poster.js'), 'utf8');
  check('TAB BUSY exits 75 (EX_TEMPFAIL)', /const EXIT_TAB_BUSY = 75;/.test(src) && /TabBusyError\)[^\n]*process\.exit\(EXIT_TAB_BUSY\)/.test(src));
  check('75 used for nothing else', !/exit(Code\s*=\s*|\()75\b/.test(src));
  check('TabBusyError path no longer exits 4', !/TabBusyError\)[^\n]*process\.exit\(4\)/.test(src));
  const ok = results.every(Boolean);
  console.log(`${results.filter(Boolean).length}/${results.length} ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
