// lib.mjs — pure helpers for the IG bridge (no browser, no MQTT). Tested by test/ig-bridge-lib.test.mjs.

export const MAX_ITEMS = 20;            // instagram.com / app carousel cap (Graph API caps at 10)
export const MAX_CAPTION = 2200;
export const RATIOS = { '4:5': 0.8, '1:1': 1, '9:16': 0.5625, original: null };
export const RATIO_TOLERANCE = 0.02;    // relative, per plan "crop ratio within 2%"

const IMG = /\.(png|jpe?g)$/i;
const VID = /\.(mp4|mov)$/i;

// Instagram shortcode → numeric media pk (base64url alphabet, first 11 chars carry the id).
const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
export function shortcodeToPk(code) {
  if (typeof code !== 'string' || !code) throw new Error('shortcode required');
  let n = 0n;
  for (const ch of code.slice(0, 11)) {
    const v = ALPHA.indexOf(ch);
    if (v < 0) throw new Error(`bad shortcode char ${JSON.stringify(ch)}`);
    n = n * 64n + BigInt(v);
  }
  return n.toString();
}

export function shortcodeFromUrl(url) {
  const m = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels)\/([A-Za-z0-9_-]+)/.exec(url || '');
  return m ? m[1] : null;
}

// IG keeps the caption as typed apart from line endings / trailing space; compare on that.
export function normCaption(s) {
  return String(s ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
}
export const captionExact = (shown, expected) => normCaption(shown) === normCaption(expected);

export function ratioOk(measured, ratio) {
  const target = RATIOS[ratio];
  if (target == null) return { ok: true, target: null, measured };            // "original": nothing to compare
  if (!(measured > 0)) return { ok: false, target, measured, why: 'crop box not measured' };
  const off = Math.abs(measured - target) / target;
  return { ok: off <= RATIO_TOLERANCE, target, measured, off, why: off <= RATIO_TOLERANCE ? null : `crop ${measured.toFixed(3)} vs ${target} (${(off * 100).toFixed(1)}% off)` };
}

// Validate an MQTT command before any browser work. Returns [] when OK, else a list of reasons.
export function validateCommand(cmd, { allowUsers = [] } = {}) {
  const errs = [];
  if (!cmd || typeof cmd !== 'object') return ['command must be a JSON object'];
  if (!cmd.id || typeof cmd.id !== 'string') errs.push('id (string) required');
  const posting = cmd.action === 'post_carousel' || cmd.action === 'post_reel';
  if (posting || cmd.action === 'edit_caption') {
    if (!cmd.expectUser) errs.push('expectUser required');
    else if (!allowUsers.map(u => u.toLowerCase()).includes(String(cmd.expectUser).toLowerCase()))
      errs.push(`expectUser ${cmd.expectUser} is not in IG_BRIDGE_ALLOW (${allowUsers.join(',') || 'empty'})`);
    if (typeof cmd.caption !== 'string') errs.push('caption (string) required');
    else if (cmd.caption.length > MAX_CAPTION) errs.push(`caption ${cmd.caption.length} chars > ${MAX_CAPTION}`);
  }
  if (cmd.action === 'post_carousel') {
    const f = cmd.files;
    if (!Array.isArray(f) || f.length < 2) errs.push('files: need 2+ images for a carousel');
    else {
      if (f.length > MAX_ITEMS) errs.push(`files: ${f.length} > ${MAX_ITEMS} (IG cap) — refused before upload`);
      const bad = f.filter(p => !IMG.test(p)); if (bad.length) errs.push(`files: not png/jpg: ${bad.slice(0, 3).join(', ')}`);
    }
    if (!(cmd.ratio in RATIOS)) errs.push(`ratio must be one of ${Object.keys(RATIOS).join('|')}`);
  }
  if (cmd.action === 'post_reel') {
    if (typeof cmd.file !== 'string' || !VID.test(cmd.file)) errs.push('file: one mp4/mov required');
    if (cmd.ratio && cmd.ratio !== '9:16') errs.push('reel ratio is 9:16');
  }
  if (cmd.action === 'edit_caption' && !shortcodeFromUrl(cmd.permalink)) errs.push('permalink: instagram.com/p|reel/<code> required');
  if (cmd.action === 'share' && !cmd.confirm) errs.push('confirm: <prepare id> required (share is a second, explicit command)');
  return errs;
}

// Compare what IG stored with what we asked for. Never "success" on a partial match.
export function classifyReadback(expected, info) {
  if (!info) return { state: 'SHARED_UNVERIFIED', defects: ['readback returned nothing'] };
  const defects = [];
  if (expected.mediaType && info.media_type !== expected.mediaType) defects.push(`media_type ${info.media_type} ≠ ${expected.mediaType}`);
  if (expected.count && (info.carousel_media_count ?? 1) !== expected.count) defects.push(`children ${info.carousel_media_count ?? 1} ≠ ${expected.count}`);
  if (!captionExact(info.caption, expected.caption)) defects.push(`caption mismatch (${normCaption(info.caption).length} vs ${normCaption(expected.caption).length} chars)`);
  return { state: defects.length ? 'SHARED_WITH_DEFECT' : 'SHARED', defects, captionOnly: defects.length > 0 && defects.every(d => d.startsWith('caption')) };
}

// IG web media_type codes: 1 image, 2 video/reel, 8 carousel
export const MEDIA_TYPE = { image: 1, video: 2, carousel: 8 };
