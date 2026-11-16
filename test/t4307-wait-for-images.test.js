// T4307 (wb 16 Nov 10:2x, slot L4): `poster.js download` printed "No large images found" while the chat held 2 generated
// images. connect() navigates (domcontentloaded + 3 s) and downloadImage listed the images ONCE; ChatGPT renders the blob:
// images later (wb: up to ~45 s after nav). Pure test, no browser: page.evaluate is a fake.
// Run: node --test test/t4307-wait-for-images.test.js
const test = require('node:test');
const assert = require('node:assert');
const poster = require('../scripts/poster');

const IMG = { globalIdx: 7, w: 1254, h: 1254, alt: 'Generated image 1', src: 'blob:https://chatgpt.com/x', hasAlt: true };
const fakePage = (seq) => { let n = 0; return { calls: () => n, evaluate: async () => seq[Math.min(n++, seq.length - 1)] }; };

test('waits until the images render (empty → not decoded → decoded)', async () => {
  assert.strictEqual(typeof poster.listImagesSettled, 'function', 'poster.js must export listImagesSettled');
  const page = fakePage([[], [], [{ ...IMG, w: 0, h: 0 }], [IMG]]);
  const got = await poster.listImagesSettled(page, { timeoutMs: 2000, intervalMs: 5 });
  assert.deepStrictEqual(got, [IMG]);
  assert.strictEqual(page.calls(), 4);
});

test('a chat with no images gives up at the deadline and returns []', async () => {
  const page = fakePage([[]]);
  const t0 = Date.now();
  const got = await poster.listImagesSettled(page, { timeoutMs: 60, intervalMs: 5 });
  assert.deepStrictEqual(got, []);
  assert.ok(Date.now() - t0 >= 60, 'waited the full deadline');
});

test('images listed but never decoded: returned at the deadline (download tries them), not []', async () => {
  const half = [{ ...IMG, w: 0, h: 0 }];
  const got = await poster.listImagesSettled(fakePage([half]), { timeoutMs: 40, intervalMs: 5 });
  assert.deepStrictEqual(got, half);
});

test('binding: both download paths list through the settled wait, not a single listImages', () => {
  const src = require('fs').readFileSync(require.resolve('../scripts/poster'), 'utf8');
  for (const fn of ['downloadImage', 'downloadAll']) {
    const body = src.slice(src.indexOf(`async function ${fn}(`), src.indexOf('\n}\n', src.indexOf(`async function ${fn}(`)));
    assert.match(body, /await listImagesSettled\(page/, `${fn} must call listImagesSettled`);
    assert.doesNotMatch(body, /await listImages\(page\)/, `${fn} must not list once`);
  }
});
