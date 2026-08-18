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
  const generatedAlt = alt.startsWith("Generated");
  // Known generated-image sources. estuary = new OpenAI CDN for gpt-image/DALL-E output.
  const knownSrc =
    src.includes("blob:") ||
    src.includes("oaidalleapi") ||
    src.includes("estuary");
  return generatedAlt || knownSrc;
}

// Selector string for page.evaluate on getImageCount (kept in sync with isPosterImage).
const POSTER_IMG_SELECTOR = 'img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"], img[src*="estuary"]';

module.exports = { isPosterImageOld, isPosterImage, POSTER_IMG_SELECTOR };
