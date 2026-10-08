'use strict';
const fs = require('fs');
const path = require('path');

// ── T2753: a busy/hidden ChatGPT tab can stop answering Runtime calls for seconds-to-minutes (T2741: E86761DE 3.8 s,
// then 10 s ×2, while the rest of :9222 answered in ms). Without a per-call bound every page.evaluate/$/$$ waited the
// shared protocolTimeout (300 s) and the run died looking like a dead session. Each call now gets windows of
// tab_call_timeout_ms: after each silent window → "TAB BUSY" + a TAB-SLOW line in ~/.oracle/cdp-latency-spikes.log,
// and we keep waiting on the SAME call (never re-issue it: the first call is still queued in the page and would run
// later, so a re-send could type the prompt twice or click Send twice). After tab_busy_windows silent windows →
// TabBusyError ("tab busy, retry later"), never re-login wording.
class TabBusyError extends Error {}
const TICK = Symbol('tick');
const SPIKE_LOG = process.env.TAB_SPIKE_LOG || path.join(process.env.HOME || '/home/curfew', '.oracle/cdp-latency-spikes.log');
function tabId(page) { try { return String(page.target()._targetId || '').slice(0, 8).toUpperCase(); } catch { return '?'; } }
function logTabSlow(page, label, waitedS, result) {
  const ts = new Date(Date.now() + 7 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
  let url = ''; try { url = page.url(); } catch {}
  try { fs.appendFileSync(SPIKE_LOG, `${ts} | TAB-SLOW poster.js ${label} · ${result} after ${waitedS.toFixed(2)}s · page ${tabId(page)} · ${url}\n`); } catch {}
}
async function boundedTabCall(page, label, run, windowMs, windows) {
  const t0 = Date.now();
  const call = run();
  call.catch(() => {});   // a late rejection after we gave up must not crash the process
  for (let w = 1; w <= windows; w++) {
    let timer;
    const tick = new Promise((res) => { timer = setTimeout(() => res(TICK), windowMs); });
    const r = await Promise.race([call, tick]).finally(() => clearTimeout(timer));
    if (r !== TICK) {
      if (w > 1) { const s = (Date.now() - t0) / 1000; console.log(`[tab] ${tabId(page)} answered after ${s.toFixed(1)}s (${label})`); logTabSlow(page, label, s, 'recovered'); }
      return r;
    }
    const s = (Date.now() - t0) / 1000;
    page.__tabSilentWindows = (page.__tabSilentWindows || 0) + 1;   // T2790: callers ask "did this tab stall in this run?"
    console.error(`⏳ TAB BUSY: ChatGPT tab ${tabId(page)} did not answer ${label} in ${s.toFixed(0)}s — waiting (${w}/${windows})`);
    logTabSlow(page, label, s, `BUSY ${w}/${windows}`);
  }
  throw new TabBusyError(`TAB BUSY: ChatGPT tab ${tabId(page)} did not answer ${label} in ${((Date.now() - t0) / 1000).toFixed(0)}s — tab busy, retry later (session is not the problem)`);
}
function guardTab(page, { windowMs = 30000, windows = 3 } = {}) {
  if (!page || page.__tabGuarded) return page;
  for (const m of ['evaluate', '$', '$$']) {
    const raw = page[m].bind(page);
    page[m] = (...args) => {
      const fn = args[0];
      // an in-page fetch (image download, conversation read) legitimately runs longer → 4 windows per window
      const isAsync = typeof fn === 'function' && fn.constructor && fn.constructor.name === 'AsyncFunction';
      return boundedTabCall(page, m === 'evaluate' ? 'evaluate' : `query ${m}`, () => raw(...args), isAsync ? windowMs * 4 : windowMs, windows);
    };
  }
  page.__tabGuarded = true;
  return page;
}

module.exports = { TabBusyError, boundedTabCall, guardTab, logTabSlow };
