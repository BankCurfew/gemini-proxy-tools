// T3264 (designer 24 Oct): a poster run that ends without an image must not leave its HB stream open.
// Run: node --test scripts/poster-hb-close.test.js   (no browser: requires poster.js as a module, HOME = temp dir)
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function run(body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3264-'));
  fs.mkdirSync(path.join(home, '.oracle'));
  const r = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(path.join(__dirname, 'poster.js'))}); ${body}`],
    { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000 });
  const feed = fs.existsSync(path.join(home, '.oracle/feed.log')) ? fs.readFileSync(path.join(home, '.oracle/feed.log'), 'utf8') : '';
  return { r, lines: feed.split('\n').filter(Boolean).map((l) => l.split('HB: ')[1]) };
}

test('timeout exit: the stream gets a closing 100% done line', () => {
  const { lines } = run(`p.heartbeat('T9001', 5, 'generation-started'); p.heartbeat('T9001', 0, 'timeout'); process.exitCode = 1;`);
  assert.match(lines.at(-1), /^T9001 100% done ended without image \(exit 1, last: timeout\)$/);
});

test('refused then process.exit(2): closed once', () => {
  const { lines } = run(`p.heartbeat('T9002', 0, 'refused'); process.exit(2);`);
  assert.deepStrictEqual(lines.filter((l) => l.startsWith('T9002 100%')), ['T9002 100% done ended without image (exit 2, last: refused)']);
});

test('success: no extra line after 100% done', () => {
  const { lines } = run(`p.heartbeat('T9003', 95, 'image-detected'); p.heartbeat('T9003', 100, 'done');`);
  assert.deepStrictEqual(lines, ['T9003 95% image-detected', 'T9003 100% done']);
});

test('two ids: only the open one is closed', () => {
  const { lines } = run(`p.heartbeat('T9004', 100, 'done'); p.heartbeat('T9005', 50, 'T9-mismatch-retry');`);
  assert.strictEqual(lines.filter((l) => / 100% done ended/.test(l)).join(), 'T9005 100% done ended without image (exit 0, last: T9-mismatch-retry)');
});

// T3282 (QA N3 on T3264): poster writes under the CALLING oracle's ticket id. When that oracle already had the id open
// (its own work stream), poster's last line must not close it: it ends with the oracle's last % and "poster run ended".
function runWithFeed(seed, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3282-'));
  fs.mkdirSync(path.join(home, '.oracle'));
  fs.writeFileSync(path.join(home, '.oracle/feed.log'), seed);
  const r = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(path.join(__dirname, 'poster.js'))}); ${body}`],
    { env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000 });
  const feed = fs.readFileSync(path.join(home, '.oracle/feed.log'), 'utf8');
  return feed.split('\n').filter(Boolean).filter((l) => l.includes('HB: ')).map((l) => l.split('HB: ')[1]);
}
const own = (id, pct, s) => `2026-10-25 01:00:00 | Designer-Oracle | h | Notification | Designer-Oracle | heartbeat » HB: ${id} ${pct}% ${s}\n`;

test('T3282: oracle had the id open → a run with no image ends without closing it', () => {
  const lines = runWithFeed(own('T9100', 15, 'café art gen'), `p.heartbeat('T9100', 5, 'generation-started'); p.heartbeat('T9100', 0, 'timeout'); process.exitCode = 1;`);
  assert.strictEqual(lines.filter((l) => /^T9100 100%/.test(l)).length, 0);
  assert.match(lines.at(-1), /^T9100 15% poster run ended: no image \(exit 1, last: timeout\)$/);
});

test('T3282: oracle had the id open → a successful run ends without closing it', () => {
  const lines = runWithFeed(own('T9101', 40, 'poster set 2/4'), `p.heartbeat('T9101', 95, 'image-detected'); p.heartbeat('T9101', 100, 'done');`);
  assert.strictEqual(lines.filter((l) => /^T9101 100%/.test(l)).length, 0);
  assert.strictEqual(lines.at(-1), 'T9101 40% poster run ended: image done');
});

test('T3282: the id was closed (100%) or never open → poster closes its own stream as before', () => {
  const lines = runWithFeed(own('T9102', 100, 'done earlier') + own('T9103', 30, 'other id'), `p.heartbeat('T9102', 5, 'generation-started'); p.heartbeat('T9102', 0, 'refused'); process.exit(2);`);
  assert.strictEqual(lines.at(-1), 'T9102 100% done ended without image (exit 2, last: refused)');
});

test('T3282: another oracle\'s open stream on the same id does not count', () => {
  const other = `2026-10-25 01:00:00 | QA-Oracle | h | Notification | QA-Oracle | heartbeat » HB: T9104 20% qa check\n`;
  const lines = runWithFeed(other, `p.heartbeat('T9104', 95, 'image-detected'); p.heartbeat('T9104', 100, 'done');`);
  assert.strictEqual(lines.at(-1), 'T9104 100% done');
});

test('T3282 (designer): the oracle\'s state word (waiting:Txxx) comes back with its % on the final line', () => {
  const lines = runWithFeed(own('T9105', 60, 'waiting:T9001 gen batch 3'), `p.heartbeat('T9105', 95, 'image-detected'); p.heartbeat('T9105', 100, 'done');`);
  assert.strictEqual(lines.at(-1), 'T9105 60% waiting:T9001 poster run ended: image done');
});

test('T3282 (designer): last line 100%/done = not open → poster closes its own run there', () => {
  const lines = runWithFeed(own('T9106', 100, 'done set 1'), `p.heartbeat('T9106', 95, 'image-detected'); p.heartbeat('T9106', 100, 'done');`);
  assert.strictEqual(lines.at(-1), 'T9106 100% done');
});
