// Pure, dependency-free image matcher for poster.js.
// Shared by getImageCount() and listImages() so DALL-E / gpt-image output is detected
// regardless of which CDN ChatGPT currently serves it from.
//
// BUG HISTORY (gemini-proxy-tools / poster.js / iCheck illustration gen):
//   Old logic matched only alt*="Generated" + src*blob: + src*oaidalleapi.
//   OpenAI now also serves generated images via estuary URLs:
//     https://chatgpt.com/backend-api/estuary/content?id=file_*
//   Those images have a generic alt (e.g. "Image") and no blob:/oaidalleapi src,
//   so getImageCount()/listImages() returned 0 -> "images" command saw nothing
//   even though DALL-E had generated. Reproduced + fixed 2026-08-18.

// Old predicate (kept ONLY to prove the regression in the test suite).
function isPosterImageOld(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const hasAlt = !!(img.alt && img.alt.startsWith("Generated"));
  return w > 300 && h > 300 && hasAlt;
}

// New predicate: size gate + (Generated alt OR known generated-image src host).
function isPosterImage(img) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h || w <= 300 || h <= 300) return false;
  const alt = img.alt || "";
  const src = img.src || "";
  // T2477: a reference image the USER attached renders as blob: too (alt "User attachment", 600x300 on 3/10) —
  // counting it shifted every index and could satisfy the gen count check before the real image existed.
  if (alt.startsWith("User attachment")) return false;
  const generatedAlt = alt.startsWith("Generated");
  // Known generated-image sources. estuary = new OpenAI CDN for gpt-image/DALL-E output.
  const knownSrc =
    src.includes("blob:") ||
    src.includes("oaidalleapi") ||
    src.includes("estuary");
  return generatedAlt || knownSrc;
}

// Selector string for page.evaluate on getImageCount (kept in sync with isPosterImage).
// T2477: every clause excludes user attachments (alt "User attachment" — blob: srcs, no turn markers in today's DOM).
const NOT_ATTACH = ':not([alt^="User attachment"])';
const POSTER_IMG_SELECTOR = ['img[alt*="Generated"]', 'img[src*="blob:"]', 'img[src*="oaidalleapi"]', 'img[src*="estuary"]']
  .map((s) => s + NOT_ATTACH).join(', ');

// T2478: identity of a poster image that survives ChatGPT's sliding DOM window AND a page reload.
// ChatGPT unmounts older/offscreen <img>s, so the poster count can stay flat while a new image arrives (Designer #21:
// 6 before = 6 after a real gen) — a count gate then reads "nothing new" → stall → reload → re-send = duplicate gen.
// src is blob: (new per document, proven 3/10: src_same=false across two tabs); the enclosing message id
// (data-chatgpt-search-message-ids) is server-side and identical across documents (msg_same=true, 5/5 unique).
// Key = message id + position inside that message (one message can hold a gallery). No message id → src (same-document only).
// Runs inside page.evaluate — keep it self-contained (no closures over module scope).
function posterImageKeys(sel) {
  const seen = {};
  return [...document.querySelectorAll(sel)].map((img) => {
    const m = img.closest('[data-chatgpt-search-message-ids]');
    const base = m ? 'msg:' + m.getAttribute('data-chatgpt-search-message-ids') : 'src:' + img.src;
    seen[base] = (seen[base] || 0) + 1;
    return base + '#' + (seen[base] - 1);
  });
}

// The newest poster image (last in document order) is new iff its key is not in the pre-send baseline.
// Only the LAST key counts: an older image re-mounting while scrolling has a key missing from the baseline too,
// but it mounts ABOVE the newest one, never after it. Returns {key, idx} (idx = listImages() index) or null.
function newestUnseen(keys, baseline) {
  if (!keys.length) return null;
  const key = keys[keys.length - 1];
  return baseline.has(key) ? null : { key, idx: keys.length - 1 };
}

module.exports = { isPosterImageOld, isPosterImage, POSTER_IMG_SELECTOR, posterImageKeys, newestUnseen };
