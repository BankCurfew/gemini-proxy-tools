#!/usr/bin/env node
// T2806 (designer 8 Oct 16:54): "Imagine page not ready" printed a raw self.__next_f script as Grok's message, because
// grokSays() counted <script> leaves as text. Control on an OWN decoy tab (data: URL), never a real Grok tab:
//   the scripts/grok-imagine.mjs filter must NOT match text that only lives in <script>/<style>, and must still match visible text.
//   NODE_PATH=<repo>/node_modules node test/t2806-groksays-scripts.test.js
'use strict';
const fs = require('fs'); const path = require('path'); const puppeteer = require('puppeteer-core');
const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'grok-imagine.mjs'), 'utf8');
const SEL = src.match(/e\.closest\('([^']+)'\)/)[1];   // the selector the CLI really uses
const RE = '[^\\n]*\\b(usage limit|rate limit|limit reached)\\b[^\\n]*';
const page = (inner) => 'data:text/html,' + encodeURIComponent(`<title>T2806-DECOY</title><main>${inner}</main>`);
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
(async () => {
  const b = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null, protocolTimeout: 30000 });
  const pg = await b.newPage();
  const says = () => pg.evaluate((sel, re) => { const s = document.querySelector('main'); const t = [...s.querySelectorAll('*')].filter((e) => !e.closest(sel) && !e.children.length).map((e) => e.innerText || '').join('\n'); const m = t.match(new RegExp(re, 'i')); return m ? m[0] : ''; }, SEL, RE);
  try {
    check('CLI selector excludes script', /script/.test(SEL), SEL);
    await pg.goto(page('<div>What should we imagine?</div><script>self.__next_f.push([1,"you hit the rate limit"])</script><style>/* usage limit */</style>'));
    check('script/style text is not a Grok message', (await says()) === '', JSON.stringify(await says()));
    await pg.goto(page('<div>You have reached your usage limit. Upgrade to SuperGrok</div>'));
    check('visible limit text still matches (positive control)', /usage limit/.test(await says()), JSON.stringify(await says()));
  } finally { await pg.close(); b.disconnect(); }
  const pass = results.filter(Boolean).length; console.log(`T2806 ${pass}/${results.length} ${pass === results.length ? 'PASS' : 'FAIL'}`);
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(2); });
