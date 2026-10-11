#!/usr/bin/env node
// T2890: open (or close) a Gemini tab the AI Browser Proxy extension can see.
// The extension lists tabs of Chrome :9222's DEFAULT browser context only (admin 11 Oct 08:1x): a tab from
// puppeteer createBrowserContext / a pw-cli session is invisible to it. Target.createTarget with no
// browserContextId lands in the default context. GR#5 carve-out: our own tab only, closed by the caller.
//
//   node scripts/gemini-open-tab.mjs            → prints the new tab's targetId (keep it to close later)
//   node scripts/gemini-open-tab.mjs --close ID → closes that tab
// Exit 0 ok · 1 CDP error (ends with fix:)
import WebSocket from 'ws';

const CDP = process.env.CDP_URL || 'http://localhost:9222';
const close = process.argv.indexOf('--close');

const fail = (why) => { console.error(`gemini-open-tab: ${why}\nfix: curl -s ${CDP}/json/version   (Chrome :9222 must be up; never restart แบงค์'s Chrome)`); process.exit(1); };
const ver = await fetch(`${CDP}/json/version`).then((r) => r.json()).catch((e) => fail(`cannot reach ${CDP}: ${e.message}`));
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((ok, no) => { ws.once('open', ok); ws.once('error', no); }).catch((e) => fail(`websocket: ${e.message}`));
let n = 0;
const call = (method, params) => new Promise((ok, no) => {
  const id = ++n;
  const on = (raw) => { const m = JSON.parse(raw); if (m.id !== id) return; ws.off('message', on); m.error ? no(new Error(m.error.message)) : ok(m.result); };
  ws.on('message', on);
  ws.send(JSON.stringify({ id, method, params }));
});
try {
  if (close > 0) {
    const id = process.argv[close + 1];
    if (!id) fail('--close needs a targetId');
    await call('Target.closeTarget', { targetId: id });
    console.log(`closed ${id}`);
  } else {
    const { targetId } = await call('Target.createTarget', { url: 'https://gemini.google.com/app', background: true });
    console.log(targetId);
  }
} catch (e) { fail(e.message); } finally { ws.close(); }
