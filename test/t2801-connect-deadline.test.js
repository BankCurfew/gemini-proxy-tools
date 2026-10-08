#!/usr/bin/env node
// T2801 (designer 8 Oct 16:3x "poster.js hangs at connect, no output in 40 s") control — no real Chrome is touched:
//   A. a live VideoEditor render marker → the CLI says it is waiting BEFORE connecting, then exits 75 (TAB BUSY)
//   B. a CDP that answers /json/version but never completes the websocket upgrade (what a render-loaded Chrome did)
//      → exits 75 within the connect deadline with a message, instead of hanging silently
//   C. positive control for B: without the deadline knob the same fake hangs past the deadline (the probe can fail)
//   node test/t2801-connect-deadline.test.js
'use strict';
const os = require('os'); const fs = require('fs'); const path = require('path'); const http = require('http');
const { spawn, spawnSync } = require('child_process');
const POSTER = path.join(__dirname, '..', 'scripts', 'poster.js');
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 't2801-render-'));
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 't2801-norender-'));
const run = (env, ms) => new Promise((res) => {
  const t = Date.now(); let out = '';
  const c = spawn('node', [POSTER, 'status'], { env: { ...process.env, ...env } });
  c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => out += d);
  const kill = setTimeout(() => c.kill('SIGKILL'), ms);
  c.on('exit', (code, sig) => { clearTimeout(kill); res({ code, sig, out, ms: Date.now() - t }); });
});

(async () => {
  // A
  const forever = spawn('sleep', ['60']); fs.writeFileSync(path.join(DIR, String(forever.pid)), 'test');
  const a = await run({ POSTER_RENDER_DIR: DIR, POSTER_RENDER_WAIT_MS: '2000', POSTER_CDP_URL: 'http://127.0.0.1:9' }, 20000);
  check('A live render: says it is waiting before connect', /render-gate running .*waiting up to/.test(a.out), a.out.split('\n')[0].slice(0, 100));
  check('A live render: exit 75 TAB BUSY, no connect attempted', a.code === 75 && /TAB BUSY: VideoEditor render-gate/.test(a.out) && !/connect/i.test(a.out.replace(/\[connect\]/g, '')), `code ${a.code} ${a.ms} ms`);
  forever.kill();
  // B: fake stalled CDP
  const srv = http.createServer((req, res) => {
    const port = srv.address().port;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ Browser: 'Fake/1', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/t2801` }));
  });
  srv.on('upgrade', () => { /* never answer: the attach stalls, like a render-loaded Chrome */ });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const b = await run({ POSTER_RENDER_DIR: EMPTY, POSTER_CDP_URL: url, POSTER_CONNECT_MS: '2000' }, 20000);
  check('B stalled CDP: exit 75 within the deadline', b.code === 75 && b.ms < 10000, `code ${b.code} sig ${b.sig} ${b.ms} ms`);
  check('B stalled CDP: says why', /TAB BUSY: Chrome CDP (connect|tab list) gave no answer in 2 s/.test(b.out), b.out.trim().split('\n').pop().slice(0, 110));
  // C: same fake, deadline far away → still running at 6 s (proves B's exit came from the deadline, not the fake)
  const c = await run({ POSTER_RENDER_DIR: EMPTY, POSTER_CDP_URL: url, POSTER_CONNECT_MS: '600000' }, 6000);
  check('C positive control: without the deadline it hangs (killed at 6 s)', c.sig === 'SIGKILL', `code ${c.code} sig ${c.sig}`);
  srv.close(); fs.rmSync(DIR, { recursive: true, force: true }); fs.rmSync(EMPTY, { recursive: true, force: true });
  const pass = results.filter(Boolean).length; console.log(`T2801-connect ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
