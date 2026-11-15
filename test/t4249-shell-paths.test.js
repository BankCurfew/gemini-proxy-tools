// T4249 follow-up (security LOW on #68): a file name must never reach a shell.
// browserPath ran `wslpath -w "<f>"` and qaGate ran `identify ... "<f>"` through execSync, so `$(...)` in a
// file name ran as a command. Now both use execFileSync with an argv array.
//   A. browserPath with `$(touch MARKER)` in the name: MARKER is not created
//   B. qaGate with the same name: MARKER is not created
//   D. resizeToIG (convert) with `$(touch MARKER)` in a real png name: MARKER is not created, file still 1080x1920
//   C. positive control: the same name through a shell DOES create MARKER (the probe can see a run)
//   node test/t4249-shell-paths.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { browserPath, qaGate, resizeToIG } = require('../scripts/poster.js');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't4249-shell-'));
const marker = path.join(dir, 'MARKER');
process.chdir(dir);   // a shell would run `touch MARKER` here
const evil = path.join(dir, 'x$(touch MARKER).png');
fs.writeFileSync(evil, Buffer.alloc(2048 * 1024));   // past qaGate's size gate so identify runs
const fakePage = { evaluate: async () => true };   // pretend the browser is Windows Chrome

let fails = 0;
const check = (ok, name, got) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${got}`); if (!ok) fails++; };

(async () => {
  await browserPath(fakePage, evil);
  check(!fs.existsSync(marker), 'A browserPath does not run $() from the file name', fs.existsSync(marker) ? 'MARKER created' : 'no MARKER');
  fs.rmSync(marker, { force: true });

  qaGate(evil);
  check(!fs.existsSync(marker), 'B qaGate does not run $() from the file name', fs.existsSync(marker) ? 'MARKER created' : 'no MARKER');
  fs.rmSync(marker, { force: true });

  const evilPng = path.join(dir, 'y$(touch MARKER).png');
  require('child_process').execFileSync('convert', ['-size', '600x600', 'xc:white', evilPng]);   // argv: makes the file, runs nothing
  check(fs.existsSync(evilPng) && !fs.existsSync(marker), 'D0 fixture png exists, no MARKER yet', fs.existsSync(evilPng) ? 'png ok' : 'NO png');
  resizeToIG(evilPng);
  const dims = (() => { try { return require('child_process').execFileSync('identify', ['-format', '%wx%h', evilPng]).toString(); } catch { return '?'; } })();
  check(!fs.existsSync(marker) && dims === '1080x1920', 'D resizeToIG does not run $() from the file name', `${fs.existsSync(marker) ? 'MARKER created' : 'no MARKER'}, ${dims}`);
  fs.rmSync(marker, { force: true });

  try { execSync(`true ${JSON.stringify(evil)}`); } catch {}
  check(fs.existsSync(marker), 'C control: a shell does run it', fs.existsSync(marker) ? 'MARKER created' : 'no MARKER');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`T4249-shell-paths ${5 - fails}/5 ${fails ? 'FAIL' : 'ALL PASS'}`);
  process.exit(fails ? 1 : 0);
})();
