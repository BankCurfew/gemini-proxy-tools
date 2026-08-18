// Reproduce-first test for poster.js estuary URL detection (no browser / no deps).
// Run: node --test scripts/poster-image-matcher.test.js
const test = require('node:test');
const assert = require('node:assert');
const { isPosterImage, isPosterImageOld, POSTER_IMG_SELECTOR } = require('./poster-image-matcher');

// DOM-like fixture: a generated image served from the NEW estuary CDN.
// Note: generic alt ("Image"), no blob:/oaidalleapi src -> old logic misses it.
const estuaryImg = {
  alt: 'Image',
  src: 'https://chatgpt.com/backend-api/estuary/content?id=file_abc123',
  naturalWidth: 1024, naturalHeight: 1792, width: 1024, height: 1792,
};
const legacyBlobImg = {
  alt: 'Generated image',
  src: 'blob:https://chatgpt.com/uuid',
  naturalWidth: 1024, naturalHeight: 1792, width: 1024, height: 1792,
};
const oaiDalleImg = {
  alt: 'Image',
  src: 'https://chatgpt.com/backend-api/oaidalleapi/...',
  naturalWidth: 1024, naturalHeight: 1792, width: 1024, height: 1792,
};
const tinyAvatar = {
  alt: 'Image',
  src: 'https://chatgpt.com/backend-api/estuary/content?id=file_x',
  naturalWidth: 40, naturalHeight: 40, width: 40, height: 40,
};
const uiIcon = {
  alt: 'send',
  src: 'https://chatgpt.com/backend-api/estuary/content?id=file_y',
  naturalWidth: 24, naturalHeight: 24, width: 24, height: 24,
};

test('REPRO: old predicate misses estuary image (the bug)', () => {
  assert.strictEqual(isPosterImageOld(estuaryImg), false, 'old logic returned 0 for estuary -> bug');
});

test('FIX: new predicate detects estuary image', () => {
  assert.strictEqual(isPosterImage(estuaryImg), true);
});

test('FIX: legacy blob: image still detected', () => {
  assert.strictEqual(isPosterImage(legacyBlobImg), true);
});

test('FIX: oaidalleapi image still detected', () => {
  assert.strictEqual(isPosterImage(oaiDalleImg), true);
});

test('FIX: size gate still excludes tiny estuary UI assets', () => {
  assert.strictEqual(isPosterImage(tinyAvatar), false);
  assert.strictEqual(isPosterImage(uiIcon), false);
});

// Guard: the browser selector (POSTER_IMG_SELECTOR, used by getImageCount + listImages)
// and the Node predicate (isPosterImage, used by this test) must encode the SAME rule.
// They drifted once (listImages filtered Node-side -> 0). Keep them in sync.
test('SYNC GUARD: browser selector and Node predicate agree on estuary', () => {
  // A minimal DOM stub that supports matches() against the selector list.
  const mk = (src, alt, w, h) => ({
    src, alt, naturalWidth: w, naturalHeight: h, width: w, height: h,
    matches(sel) {
      return sel.split(',').some((part) => {
        const m = part.trim().match(/^img\[([^=]+)(?:=?)\*?="?([^"]*)"?\]$/);
        if (!m) return false;
        const attr = m[1].replace('*', '');
        const val = m[2];
        const cur = attr === 'alt' ? this.alt : attr === 'src' ? this.src : '';
        return cur && cur.includes(val);
      });
    },
  });
  const est = mk('https://chatgpt.com/backend-api/estuary/content?id=file_abc', 'Image', 1024, 1792);
  assert.strictEqual(est.matches(POSTER_IMG_SELECTOR), true, 'selector must match estuary');
  assert.strictEqual(isPosterImage(est), true, 'predicate must match estuary');
  const legacy = mk('blob:https://chatgpt.com/uuid', 'Generated image', 1024, 1792);
  assert.strictEqual(legacy.matches(POSTER_IMG_SELECTOR), true);
  assert.strictEqual(isPosterImage(legacy), true);
});
