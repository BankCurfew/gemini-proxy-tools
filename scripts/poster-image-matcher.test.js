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
        // T2477: clauses may end in :not([alt^="…"]) (user-attachment exclusion)
        const m = part.trim().match(/^img\[([^=]+)(?:=?)\*?="?([^"]*)"?\](?::not\(\[alt\^="([^"]*)"\]\))?$/);
        if (!m) return false;
        const attr = m[1].replace('*', '');
        const val = m[2];
        if (m[3] && (this.alt || '').startsWith(m[3])) return false;
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

// T2477 (gemini-proxy-tools#21): a user's reference attachment is blob: + big enough, and was listed as a poster —
// `images` showed it as a DALL-E image, every index after it shifted, and the gen count check could pass on it.
// Fixture copied from the live iagencyaia-market chat 3/10 (alt, src scheme and size as rendered).
const userAttachment = { alt: 'User attachment', src: 'blob:https://chatgpt.com/c-4832-b757-1762fe3b61a4', naturalWidth: 600, naturalHeight: 600, width: 600, height: 600 };
const generatedBlob = { alt: 'Generated image 1', src: 'blob:https://chatgpt.com/1-449e-b538-9cdfa1c0271f', naturalWidth: 941, naturalHeight: 1672, width: 941, height: 1672 };

test('T2477: selector and predicate agree a user attachment is NOT a poster (SYNC GUARD stub)', () => {
  const stubMatches = (img) => POSTER_IMG_SELECTOR.split(',').some((part) => {
    const m = part.trim().match(/^img\[([^=]+)(?:=?)\*?="?([^"]*)"?\](?::not\(\[alt\^="([^"]*)"\]\))?$/);
    if (!m) return false;
    if (m[3] && (img.alt || '').startsWith(m[3])) return false;
    const cur = m[1].replace('*', '') === 'alt' ? img.alt : img.src;
    return !!cur && cur.includes(m[2]);
  });
  assert.strictEqual(stubMatches(userAttachment), false);
  assert.strictEqual(stubMatches(generatedBlob), true);
});

test('T2477: a user attachment is not a poster', () => {
  assert.strictEqual(isPosterImage(userAttachment), false);
  assert.strictEqual(isPosterImage(generatedBlob), true);   // control: the generated blob next to it still is
});

test('T2477: every selector clause excludes user attachments', () => {
  const clauses = POSTER_IMG_SELECTOR.split(',').map((c) => c.trim());
  assert.strictEqual(clauses.length, 4);
  for (const c of clauses) assert.ok(c.endsWith(':not([alt^="User attachment"])'), c);
});


// ── T2478: key-based new-image detection (ChatGPT sliding DOM window + reload) ──
const { posterImageKeys, newestUnseen } = require('./poster-image-matcher');

// Fake DOM: each img sits in a message (msg id) or not (null); src is a per-document blob.
function withDom(imgs, fn) {
  const prev = global.document;
  global.document = { querySelectorAll: () => imgs.map(({ msg, src }) => ({
    src, closest: () => (msg ? { getAttribute: () => msg } : null) })) };
  try { return fn(); } finally { global.document = prev; }
}
const doc = (msgs, gen) => msgs.map((m) => ({ msg: m, src: `blob:https://chatgpt.com/${gen}-${m}` }));
// count gate as it was before T2478 (waitForImage: imgCount > lastCount)
const oldCountGate = (before, after) => after.length > before.length;

test('T2478: sliding window — 6 before, 6 after, newest is new → detected (count gate misses it)', () => {
  const before = withDom(doc(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'], 'a'), () => posterImageKeys('img'));
  const after = withDom(doc(['m2', 'm3', 'm4', 'm5', 'm6', 'm7'], 'a'), () => posterImageKeys('img'));   // m1 unmounted, m7 new
  assert.strictEqual(oldCountGate(before, after), false);   // the regression
  assert.deepStrictEqual(newestUnseen(after, new Set(before)), { key: 'msg:m7#0', idx: 5 });
});

test('T2478: reload changes every blob src but not the message ids → no false new image', () => {
  const before = withDom(doc(['m1', 'm2', 'm3'], 'a'), () => posterImageKeys('img'));
  const reloaded = withDom(doc(['m1', 'm2', 'm3'], 'b'), () => posterImageKeys('img'));
  assert.strictEqual(newestUnseen(reloaded, new Set(before)), null);
});

test('T2478: image landed before a stall-reload is found against the pre-send baseline', () => {
  const before = withDom(doc(['m1', 'm2'], 'a'), () => posterImageKeys('img'));
  const reloaded = withDom(doc(['m1', 'm2', 'm3'], 'b'), () => posterImageKeys('img'));
  assert.strictEqual(newestUnseen(reloaded, new Set(before)).key, 'msg:m3#0');
});

test('T2478: an older image re-mounting above the newest is not a new image', () => {
  const before = withDom(doc(['m4', 'm5', 'm6'], 'a'), () => posterImageKeys('img'));
  const scrolled = withDom(doc(['m3', 'm4', 'm5', 'm6'], 'a'), () => posterImageKeys('img'));   // m3 re-mounts at the top
  assert.strictEqual(newestUnseen(scrolled, new Set(before)), null);
});

test('T2478: gallery — second image in the same message gets its own key', () => {
  const keys = withDom([{ msg: 'm1', src: 'blob:x' }, { msg: 'm1', src: 'blob:y' }, { msg: null, src: 'blob:z' }], () => posterImageKeys('img'));
  assert.deepStrictEqual(keys, ['msg:m1#0', 'msg:m1#1', 'src:blob:z#0']);
  assert.strictEqual(newestUnseen([], new Set()), null);
});
