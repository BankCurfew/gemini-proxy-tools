// Reproduce-first test for poster.js estuary URL detection (no browser / no deps).
// Run: node --test scripts/poster-image-matcher.test.js
const test = require('node:test');
const assert = require('node:assert');
const { isPosterImage, isPosterImageOld } = require('./poster-image-matcher');

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
