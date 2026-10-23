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
