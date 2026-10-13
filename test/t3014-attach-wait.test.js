#!/usr/bin/env node
// T3014 (designer 14 Oct): ChatGPT mounts the composer form late on a long image chat; attach checked once → "no file
// input". attachFiles now waits for `form input[type="file"]`. Fake page objects only, no Chrome.
//   A. input never mounts → false after the wait, message says how long it waited
//   B. it waited on the composer file input selector (not a one-shot query)
//   D. sendAndConfirm (new-chat seed, every prompt) waits for the composer before the first send step
//   C. positive control: input already there → no "no file input" error (upload path reached)
//   node test/t3014-attach-wait.test.js
'use strict';
process.env.POSTER_COMPOSER_WAIT_MS = '3000';
process.env.POSTER_RENDER_DIR = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 't3014-aw-'));   // no render marker → no render wait
const { attachFiles, sendAndConfirm } = require('../scripts/poster.js');
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
const capture = async (fn) => { const orig = console.error; let err = ''; console.error = (...a) => { err += a.join(' ') + '\n'; }; try { return { r: await fn(), err }; } finally { console.error = orig; } };
(async () => {
  const waited = [];
  const never = { waitForSelector: (sel, o) => { waited.push([sel, o.timeout]); return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), o.timeout)); }, $: async () => null, on() {}, off() {} };
  const t0 = Date.now(); const a = await capture(() => attachFiles(never, ['/x/a.png']));
  check('A never mounts → false', a.r === false, `${Date.now() - t0} ms`);
  check('A message says it waited 3 s', /no file input in the composer after 3 s/.test(a.err), a.err.trim().slice(0, 100));
  check('B waited on form input[type="file"] with the knob timeout', JSON.stringify(waited) === JSON.stringify([['form input[type="file"]', 3000]]), JSON.stringify(waited));
  const input = { uploadFile: async () => { throw new Error('upload reached'); } };
  const there = { waitForSelector: async () => input, $: async () => input, on() {}, off() {}, evaluate: async () => false };
  const c = await capture(() => attachFiles(there, ['/x/a.png']).catch((e) => e.message));
  check('C input present → no "no file input", upload path reached', !/no file input/.test(c.err) && /upload reached|browserPath|ENOENT|wslpath/i.test(String(c.r) + c.err), String(c.r).slice(0, 80));
  // D (new-chat 2/2 "no visible composer"): sendAndConfirm polls the composer-ready check BEFORE its first send step
  const seen = [];
  const late = { evaluate: async (fn) => {
    const src = typeof fn === 'function' ? fn.toString() : 'install';
    if (src === 'install') return;
    if (/__posterComposer\(\) && !window.__posterBusy\(\)/.test(src)) { seen.push('ready?'); return seen.length >= 2; }   // ready on the 2nd poll: by count, not wall time (a loaded box flaked 1/20 when >1.5 s passed before poll 1)
    seen.push('send-step'); throw new Error('stop after first send step');
  } };
  await sendAndConfirm(late, 'seed', { label: 'new-chat' }).catch(() => {});
  const firstSend = seen.indexOf('send-step');
  check('D send waits for the late composer before its first send step (polled until ready)', firstSend === 2 && seen[0] === 'ready?' && seen[1] === 'ready?', seen.slice(0, 6).join(','));
  const pass = results.filter(Boolean).length; console.log(`T3014-attach ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
