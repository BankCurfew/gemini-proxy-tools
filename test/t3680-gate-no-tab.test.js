#!/usr/bin/env node
// T3680 (designer 4 Nov): the session gate's "no ChatGPT tab open in CDP" (shared slot L4 left on aia's agent portal)
// must not stop a poster run; every real session failure still must. Runs a COPY of Admin-Oracle's
// chatgpt-session-ensure.sh against a fake CDP endpoint (only the port changed), so the verdict reads the gate's real output.
//   node test/t3680-gate-no-tab.test.js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { sessionGateVerdict } = require('../scripts/poster');
const GATE = path.join(os.homedir(), 'repos/github.com/BankCurfew/Admin-Oracle/scripts/chatgpt-session-ensure.sh');
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); };

(async () => {
  if (!fs.existsSync(GATE)) { console.error(`SKIP: no gate at ${GATE}`); process.exit(2); }
  let tabs = [];
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(req.url.startsWith('/json/version') ? JSON.stringify({ Browser: 'Chrome/T3680-fake' }) : JSON.stringify(tabs));
  });
  await new Promise((r) => srv.listen(0, 'localhost', r));   // the gate curls localhost:<port>
  const port = srv.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't3680-'));
  const gate = path.join(tmp, 'gate.sh');
  const src = fs.readFileSync(GATE, 'utf8');
  if (!/^CDP_PORT=9222$/m.test(src)) { console.error('FAIL: gate no longer sets CDP_PORT=9222 · fix: update this test'); process.exit(1); }
  fs.writeFileSync(gate, src.replace(/^CDP_PORT=9222$/m, `CDP_PORT=${port}`));
  // async spawn: a sync one would block this process, and the fake CDP server here could never answer
  const run = () => new Promise((res) => {
    const g = spawn('bash', [gate]); let out = '';
    g.stdout.on('data', (d) => { out += d }); g.stderr.on('data', (d) => { out += d });
    const t = setTimeout(() => g.kill('SIGKILL'), 20000);
    g.on('close', (code) => { clearTimeout(t); res({ code, out }) });
  });

  tabs = [{ id: 'A', type: 'page', url: 'https://agent.aia.co.th/portal', title: 'AIA agent portal' }];
  let r = await run();
  check('no ChatGPT tab (L4 on the agent portal) → no-tab = continue', sessionGateVerdict(r.code, r.out) === 'no-tab', `exit ${r.code}: ${r.out.trim().split('\n').pop()}`);

  tabs = [{ id: 'B', type: 'page', url: 'https://accounts.google.com/o/oauth2/auth/oauthchooseaccount?client_id=x&audience=openai', title: 'Choose an account' }];
  r = await run();
  check('ChatGPT stuck at the Google chooser (dead session) → still a failure', !['ok', 'no-tab'].includes(sessionGateVerdict(r.code, r.out)), `exit ${r.code}: ${r.out.trim().split('\n').pop()}`);

  srv.close();
  r = await run();
  check('CDP unreachable → still a failure', !['ok', 'no-tab'].includes(sessionGateVerdict(r.code, r.out)), `exit ${r.code}: ${r.out.trim().split('\n').pop()}`);

  check('exit 0 → ok, exit 3 → busy (unchanged)', sessionGateVerdict(0, '') === 'ok' && sessionGateVerdict(3, '') === 'busy');
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`${results.filter(Boolean).length}/${results.length}`);
  process.exit(results.every(Boolean) ? 0 : 1);
})();
