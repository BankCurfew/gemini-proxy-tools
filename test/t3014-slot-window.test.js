#!/usr/bin/env node
// T3014: poster.js connects through its own CDP slot window (cdp-window.mjs getWindow), never browser.pages() over
// แบงค์'s tabs. No real Chrome, no real slot lock: POSTER_CDP_WINDOW = test/fixtures/fake-cdp-window.mjs.
//   A. slot held by another run → exit 75 TAB BUSY saying so, slot asked for = L4
//   B. slot window never answers → exit 75 within the connect deadline
//   C. positive control for B: deadline far away → still hanging at 6 s
//   D. POSTER_SLOT picks another slot (L1)
//   F. slot window with no display (minimized, throttled) → exit 1 at once with the fix, slot released
//   E. source guard: no browser.pages() call left in poster.js (the attach-every-tab call that stalled)
//   node test/t3014-slot-window.test.js
'use strict';
const os = require('os'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const POSTER = path.join(__dirname, '..', 'scripts', 'poster.js');
const FAKE = path.join(__dirname, 'fixtures', 'fake-cdp-window.mjs');
// a real configured brand: connect resolves the brand chat BEFORE it connects (T3014), so status needs one here
const BRAND = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'poster.config.json'), 'utf8')).brands)[0];
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const NORENDER = fs.mkdtempSync(path.join(os.tmpdir(), 't3014-norender-'));
const LOG = path.join(NORENDER, 'slots.log');
const run = (env, ms) => new Promise((res) => {
  const t = Date.now(); let out = '';
  fs.rmSync(LOG, { force: true });
  const c = spawn('node', [POSTER, 'status', '--brand', BRAND], { env: { ...process.env, POSTER_RENDER_DIR: NORENDER, POSTER_CDP_WINDOW: FAKE, FAKE_SLOT_LOG: LOG, POSTER_CDP_URL: 'http://127.0.0.1:9', ...env } });
  c.stdout.on('data', (d) => out += d); c.stderr.on('data', (d) => out += d);
  const kill = setTimeout(() => c.kill('SIGKILL'), ms);
  c.on('exit', (code, sig) => { clearTimeout(kill); res({ code, sig, out, ms: Date.now() - t, slots: fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : [] }); });
});
(async () => {
  const a = await run({ FAKE_SLOT_MODE: 'held' }, 20000);
  check('A slot held: exit 75', a.code === 75, `code ${a.code}`);
  check('A slot held: says the slot is in use', /TAB BUSY: CDP slot L4 is in use by another run/.test(a.out), a.out.trim().split('\n').pop().slice(0, 110));
  check('A asked for slot L4 (bob DECISION A), once', JSON.stringify(a.slots) === '["L4"]', JSON.stringify(a.slots));
  const b = await run({ FAKE_SLOT_MODE: 'stall', POSTER_CONNECT_MS: '2000' }, 20000);
  check('B slot never answers: exit 75 within the deadline', b.code === 75 && b.ms < 10000, `code ${b.code} ${b.ms} ms`);
  check('B says why', /TAB BUSY: Chrome CDP slot L4 window gave no answer in 2 s/.test(b.out), b.out.trim().split('\n').pop().slice(0, 110));
  const c = await run({ FAKE_SLOT_MODE: 'stall', POSTER_CONNECT_MS: '600000' }, 6000);
  check('C positive control: without the deadline it hangs (killed at 6 s)', c.sig === 'SIGKILL', `code ${c.code} sig ${c.sig}`);
  const d = await run({ FAKE_SLOT_MODE: 'held', POSTER_SLOT: 'L1' }, 20000);
  check('D POSTER_SLOT=L1 → asks for L1', JSON.stringify(d.slots) === '["L1"]' && /slot L1 is in use/.test(d.out), JSON.stringify(d.slots));
  const f = await run({ FAKE_SLOT_MODE: 'nodisplay' }, 20000);
  check('F slot with no display (minimized window) → fails at once, says why, nothing sent', f.code === 1 && f.ms < 10000 && /SLOT L4 HAS NO DISPLAY/.test(f.out), `code ${f.code} ${f.ms} ms`);
  check('F the slot is released before failing', JSON.stringify(f.slots) === '["L4","released"]', JSON.stringify(f.slots));
  const src = fs.readFileSync(POSTER, 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  check('E no browser.pages() call in poster.js', !/\.pages\(\)/.test(src));
  fs.rmSync(NORENDER, { recursive: true, force: true });
  const pass = results.filter(Boolean).length; console.log(`T3014-slot ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
