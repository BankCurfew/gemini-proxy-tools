#!/usr/bin/env node
// T4443 (designer 22 Nov 00:18): `poster.js prompt` logged "NOT SENT" + "prompt did not land" but exited 0, so a chained
// wait + download pulled an OLD image. promptCmd() must return non-zero whenever the send did not land.
// Pure: stubbed send, no browser, no CDP, no slot.   NODE_PATH=<repo>/node_modules node test/t4443-prompt-exit.test.js
'use strict';
const { promptCmd } = require('../scripts/poster');
const results = []; const check = (n, ok, d) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); };
(async () => {
  const quiet = console.error; console.error = () => {};
  let calls = 0;
  const notSent = async () => { calls++; return false; };
  const sent = async () => { calls++; return true; };
  const a = await promptCmd({}, 'a red poster of a city skyline', 'iagencyaia', notSent);
  const b = await promptCmd({}, 'a red poster of a city skyline', 'iagencyaia', sent);
  calls = 0;
  const c = await promptCmd({}, 'WealthBanks cover with logo', 'iagencyaia', sent);
  console.error = quiet;
  check('A send did not land (NOT SENT / no new turn) → exit 1', a === 1, `got ${a}`);
  check('B send landed → exit 0', b === 0, `got ${b}`);
  check('C cross-brand prompt → exit 4, send never called', c === 4 && calls === 0, `got ${c}, send calls ${calls}`);
  const pass = results.filter(Boolean).length;
  console.log(`${pass} of ${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})();
