// T3014 test double for ~/.oracle/tools/cdp-window.mjs: tests never take a REAL slot lock or read the real monitors.
// FAKE_SLOT_MODE: 'held' → the lock error the real module throws · 'stall' → never answers · default → puppeteer.connect
// to CDP_URL (the T2801 fake stalled CDP) like the real module does. Every call is appended to FAKE_SLOT_LOG.
import { createRequire } from 'module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
export async function getWindow(slot, opts = {}) {
  if (process.env.FAKE_SLOT_LOG) fs.appendFileSync(process.env.FAKE_SLOT_LOG, `${slot}\n`);
  if (process.env.FAKE_SLOT_MODE === 'held') throw new Error(`slot ${slot} is held by pid 4242 · fix: wait, or use another slot`);
  if (process.env.FAKE_SLOT_MODE === 'stall') return new Promise(() => {});
  // canary: a test must never reach แบงค์'s real Chrome (T3014 caught poster.config.json overriding the fake CDP url)
  if (/:9222\b/.test(process.env.CDP_URL || '')) throw new Error(`fake-cdp-window: refusing the real Chrome ${process.env.CDP_URL}`);
  const browser = await require('puppeteer-core').connect({ browserURL: process.env.CDP_URL, defaultViewport: null, protocolTimeout: opts.protocolTimeout });
  throw new Error(`fake connected to ${browser.wsEndpoint()}: unexpected`);
}
