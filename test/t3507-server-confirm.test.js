#!/usr/bin/env node
// T3507 control (designer gen-45/45b, 30 Oct): after a reload the turn count starts at 0 before the chat renders, so the
// turns already there read as "new turn (0 → 5)", and a changed URL read as "confirmed" too; the prompt landed nowhere.
// Fake ChatGPT on 127.0.0.1 + a HEADLESS local Chromium (never แบงค์'s Chrome). The page renders the 5 old turns only
// after Send; the fake backend decides what the server "has".
//   A  server reachable, message never recorded, DOM shows 0 → 5        → sendAndConfirm = false (was true = the bug)
//   B  server records the message at once                               → true, 1 POST
//   C  no session token (server unreadable) + DOM 0 → 5                  → true via the old DOM hint (fallback kept)
//   E  server shows the message only from the reload on, DOM nothing    → true after reload, still 1 POST (no double send)
//   F  a stale Stop button where Send should be                         → false, 0 POSTs, NO synthetic Enter dispatched
//   G  stale Stop, server idle (last turn finished, end_turn, 60 s old)    → Stop clicked once, then sent: true, 1 POST (31 Oct L4)
//   H  Stop while the server is generating (assistant in_progress)        → Stop NOT clicked, not sent: false, 0 POSTs
//   POSTER=<path to poster.js> node test/t3507-server-confirm.test.js   (default ../scripts/poster.js)
'use strict';
const http = require('http'); const path = require('path'); const fs = require('fs');
const puppeteer = require('puppeteer-core');
const PORT = 37507; process.env.POSTER_CHATGPT_ORIGIN = `http://127.0.0.1:${PORT}`;   // fake origin (security SHOULD 2 guard)
const POSTER = process.env.POSTER ? path.resolve(process.env.POSTER) : path.join(__dirname, '../scripts/poster.js');
const { sendAndConfirm } = require(POSTER);
const CHROME = process.env.CHROME || (() => {
  const base = path.join(process.env.HOME, '.cache/ms-playwright');
  const d = fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().pop();
  return path.join(base, d, 'chrome-linux64/chrome');
})();
const CID = '6ab8d30e-0000-4000-8000-000000000001';
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };

let mode = {}; let posts = 0; let enters = 0; let stops = 0; let msgs = []; let pendingOnReload = null;
const PAGE = `<!doctype html><title>T3507-FAKE</title><div id="chat"></div><form>
<div class="ProseMirror" contenteditable="true" style="min-height:40px;border:1px solid"></div>
<button type="button" aria-label="Send">Send</button></form><script>
window.__enters = 0; document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isTrusted) { window.__enters++; fetch('/enter', { method: 'POST' }); } }, true);
if (location.search.includes('stale-stop')) { const btn = document.querySelector('button'); btn.setAttribute('aria-label', 'Stop'); btn.innerText = 'Stop'; }
document.querySelector('button').onclick = async () => {
  const btn = document.querySelector('button');
  if (btn.getAttribute('aria-label') === 'Stop') { await fetch('/stop', { method: 'POST' }); btn.setAttribute('aria-label', 'Send'); btn.innerText = 'Send'; return; }
  const c = document.querySelector('.ProseMirror'); const text = c.innerText; c.innerText = '';
  const r = await (await fetch('/click', { method: 'POST', body: text })).json();
  for (let i = 0; i < r.reveal; i++) { const h = document.createElement('div'); h.setAttribute('data-message-id', 'old-' + i);
    const b = document.createElement('div'); b.setAttribute('data-user-message-bubble', 'true'); b.innerText = 'older prompt ' + i;
    h.appendChild(b); document.getElementById('chat').appendChild(h); }
};</script>`;
const srv = http.createServer((req, res) => {
  const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/click') { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    posts++; const rec = () => msgs.push({ text: b, t: Date.now() / 1000 });
    if (mode.record === 'now') rec(); else if (mode.record === 'onReload') pendingOnReload = rec;
    json({ reveal: mode.reveal || 0 }); }); return; }
  if (req.url === '/enter') { enters++; return json({}); }
  if (req.url === '/stop') { stops++; return json({}); }
  if (req.url === '/api/auth/session') return json(mode.noToken ? {} : { accessToken: 't3507' });
  if (req.url.startsWith('/backend-api/conversation/')) {
    const mapping = Object.fromEntries(msgs.map((m, i) =>
      [`m${i}`, { message: { author: { role: 'user' }, create_time: m.t, status: 'finished_successfully', content: { parts: [m.text] } } }]));
    let current_node;   // G/H: the chat's last turn as the server has it (F: none = unknown)
    if (mode.srv) { mapping.a0 = { message: { author: { role: 'assistant' }, create_time: Date.now() / 1000 - 60, end_turn: mode.srv === 'idle',
      status: mode.srv === 'idle' ? 'finished_successfully' : 'in_progress', content: { parts: ['older reply'] } } }; current_node = 'a0'; }
    return json({ mapping, current_node });
  }
  if (req.url.startsWith('/backend-api/conversations')) return json({ items: [] });
  if (pendingOnReload) { pendingOnReload(); pendingOnReload = null; }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE);
});

(async () => {
  await new Promise((r) => srv.listen(PORT, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}/c/${CID}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  const run = async (name, m, text) => {
    mode = m; posts = 0; enters = 0; stops = 0; msgs = []; pendingOnReload = null;
    const page = await browser.newPage(); await page.goto(url + (m.query || ''));
    const t0 = Date.now(); let r, err = null;
    try { r = await sendAndConfirm(page, text, { label: name, timeoutMs: 4000, waitEnabledMs: 1500 }); } catch (e) { err = e; }
    await page.close();
    return { r, err, posts, enters, stops, ms: Date.now() - t0 };
  };
  try {
    const A = await run('A', { reveal: 5 }, 'T3507 prompt A: generate a NEW image now');
    check('A server has nothing, DOM 0 → 5: NOT confirmed', A.r === false && !A.err, `returned ${A.r}, posts ${A.posts}`);
    const B = await run('B', { reveal: 5, record: 'now' }, 'T3507 prompt B: generate a NEW image now');
    check('B server has it: confirmed, 1 POST', B.r === true && B.posts === 1, `returned ${B.r}, posts ${B.posts}`);
    const C = await run('C', { reveal: 5, noToken: true }, 'T3507 prompt C: generate a NEW image now');
    check('C server unreadable: DOM hint fallback confirms', C.r === true && C.posts === 1, `returned ${C.r}, posts ${C.posts}`);
    const E = await run('E', { record: 'onReload' }, 'T3507 prompt E: generate a NEW image now');
    check('E server has it after reload, nothing in DOM: confirmed, NO double send', E.r === true && E.posts === 1, `returned ${E.r}, posts ${E.posts}, ${E.ms} ms`);
    const F = await run('F', { query: '?stale-stop' }, 'T3507 prompt F: generate a NEW image now');
    check('F stale Stop: not sent, no synthetic Enter', F.r === false && F.posts === 0 && F.enters === 0, `returned ${F.r}, posts ${F.posts}, synthetic enters ${F.enters}`);
    const G = await run('G', { query: '?stale-stop', srv: 'idle', record: 'now' }, 'T3507 prompt G: generate a NEW image now');
    check('G stale Stop + server idle: Stop cleared once, then sent and confirmed', G.r === true && G.stops === 1 && G.posts === 1 && G.enters === 0, `returned ${G.r}, stop clicks ${G.stops}, posts ${G.posts}, enters ${G.enters}`);
    const H = await run('H', { query: '?stale-stop', srv: 'busy', record: 'now' }, 'T3507 prompt H: generate a NEW image now');
    check('H Stop + server generating: Stop NOT clicked, not sent', H.r === false && H.stops === 0 && H.posts === 0, `returned ${H.r}, stop clicks ${H.stops}, posts ${H.posts}`);
  } finally { await browser.close(); srv.close(); }
  const ok = results.every(Boolean);
  console.log(`${ok ? 'ALL PASS' : 'FAILED'} ${results.filter(Boolean).length}/${results.length} (${path.relative(process.cwd(), POSTER)})`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
