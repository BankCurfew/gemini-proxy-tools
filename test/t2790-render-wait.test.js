#!/usr/bin/env node
// T2790 (bob → A) control: poster.js waits while a VideoEditor render-gate marker's pid is alive, never touching the composer.
//   C. live marker that never ends → TabBusyError (exit 75 in the CLI), composer still EMPTY (nothing typed, nothing sent)
//   D. live marker whose pid exits mid-wait → 'render-gate finished, sending' and the send path runs
//   E. stale marker (dead pid) → no wait at all
// OWN decoy tab + a temp marker dir (POSTER_RENDER_DIR); never touches another tab or the real marker dir.
//   NODE_PATH=<repo>/node_modules node test/t2790-render-wait.test.js
'use strict';
const os = require('os'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't2790-render-'));
process.env.POSTER_RENDER_DIR = DIR; process.env.POSTER_RENDER_WAIT_MS = '4000';
process.env.TAB_SPIKE_LOG = path.join(os.tmpdir(), `t2790-spikes-${process.pid}.log`);
const puppeteer = require('puppeteer-core');
const { guardTab, TabBusyError } = require('../scripts/tab-guard');
const { sendAndConfirm, liveRenders } = require('../scripts/poster');
const HTML = 'data:text/html,' + encodeURIComponent('<title>T2790-RENDER-DECOY</title><form><div class="ProseMirror" contenteditable="true"></div><button type="button" aria-label="Send" disabled>Send</button></form>');
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const logs = []; const o = { log: console.log, err: console.error };
console.log = (...a) => { logs.push(a.join(' ')); o.log(...a); }; console.error = (...a) => { logs.push(a.join(' ')); o.err(...a); };
const mark = (pid) => fs.writeFileSync(path.join(DIR, String(pid)), 'test');
const clear = () => { for (const f of fs.readdirSync(DIR)) fs.unlinkSync(path.join(DIR, f)); };

(async () => {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null, protocolTimeout: 120000 });
  const raw = await browser.newPage();
  try {
    await raw.goto(HTML); const page = guardTab(raw, { windowMs: 5000, windows: 3 });
    const composer = () => page.evaluate(() => document.querySelector('.ProseMirror').innerText.trim());
    // C
    const forever = spawn('sleep', ['60']); mark(forever.pid); logs.length = 0;
    let t = Date.now(), threw = null;
    try { await sendAndConfirm(page, 'T2790 C must not be typed', { label: 'C', waitEnabledMs: 1000, timeoutMs: 1000 }); } catch (e) { threw = e; }
    check('C live marker: liveRenders sees it', liveRenders().includes(String(forever.pid)));
    check('C live marker: TabBusyError after the wait', threw instanceof TabBusyError && Date.now() - t >= 3500, `${Date.now() - t} ms · ${threw && threw.message.slice(0, 70)}`);
    check('C live marker: composer untouched', (await composer()) === '', `"${await composer()}"`);
    forever.kill(); clear();
    // D
    const short = spawn('sleep', ['1.5']); mark(short.pid); logs.length = 0; threw = null;
    try { await sendAndConfirm(page, 'T2790 D text', { label: 'D', waitEnabledMs: 1000, timeoutMs: 1000 }); } catch (e) { threw = e; }
    check('D marker pid exits mid-wait: no render TabBusyError', !(threw instanceof TabBusyError) || !/render-gate/.test(threw.message), threw && threw.message.slice(0, 60));
    check('D: logged waiting then finished', logs.some(l => /render-gate running/.test(l)) && logs.some(l => /render-gate finished, sending/.test(l)));
    clear();
    // E
    await raw.goto(HTML); mark(999999); logs.length = 0; threw = null; t = Date.now();
    try { await sendAndConfirm(page, 'T2790 E text', { label: 'E', waitEnabledMs: 500, timeoutMs: 500 }); } catch (e) { threw = e; }
    check('E stale marker (dead pid): no wait', !logs.some(l => /render-gate running/.test(l)), `${liveRenders().length} live`);
    clear();
  } finally { await raw.close().catch(() => {}); browser.disconnect(); fs.rmSync(DIR, { recursive: true, force: true }); }
  console.log = o.log; console.error = o.err;
  const pass = results.filter(Boolean).length; console.log(`T2790-render ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.log = o.log; console.error = o.err; console.error('ERROR', e); process.exit(2); });
