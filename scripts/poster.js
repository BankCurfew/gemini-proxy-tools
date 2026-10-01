#!/usr/bin/env node
// Poster CLI v3 — CDP-based ChatGPT DALL-E poster generation
// T1: auto-refresh recovery (page.reload on stall)
// T2: refusal detection (EN+THAI regex, distinct exit code 2)
// T4: config from poster.config.json
// T5: heartbeat during generation (Rule #9)
// Task: gemini-proxy-tools#13

const puppeteer = require('puppeteer-core');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { POSTER_IMG_SELECTOR } = require('./poster-image-matcher');

// ── T4: Config from file ──
const CONFIG_PATH = path.join(__dirname, 'poster.config.json');
const defaults = {
  chatgpt_url: 'https://chatgpt.com',
  brand_chat_id: '6a2e2fee-f228-83ec-a55a-e85f221d620f',
  output_dir: '/mnt/c/Users/mbank/OneDrive/AIA/Posters',
  downloads_dir: '/mnt/c/Users/mbank/Downloads',
  cdp_url: 'http://localhost:9222',
  cdp_protocol_timeout: 120000,
  generation_timeout_ms: 180000,
  poll_interval_ms: 5000,
  stall_threshold_polls: 6,
  max_retries: 1,
  heartbeat_oracle: 'Designer-Oracle',
  brands: {},
};
let cfg = { ...defaults };
try {
  const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  cfg = { ...defaults, ...file };
} catch {}

// --brand flag: select active brand (normalised to lowercase)
const BRAND_FLAG = (() => {
  const idx = process.argv.indexOf('--brand');
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1].toLowerCase() : null;
})();

function resolveBrand(slug) {
  if (!slug) return null;
  const key = slug.toLowerCase();
  if (cfg.brands && cfg.brands[key]) return { slug: key, chat_id: cfg.brands[key].chat_id };
  return null;
}

function getActiveBrandChatId() {
  if (!BRAND_FLAG) {
    console.error('\n🚫 ERROR: --brand is required. No unbranded default exists.');
    console.error('   Available brands: ' + Object.keys(cfg.brands || {}).join(', '));
    console.error('   Usage: node poster.js <command> --brand <name>\n');
    process.exitCode = 1;
    process.exit(1);
  }
  const resolved = resolveBrand(BRAND_FLAG);
  if (!resolved) {
    console.error(`\n🚫 ERROR: Brand "${BRAND_FLAG}" not found in config.`);
    console.error('   Available brands: ' + Object.keys(cfg.brands || {}).join(', '));
    console.error(`   To create: node poster.js new-chat --brand ${BRAND_FLAG}\n`);
    process.exitCode = 1;
    process.exit(1);
  }
  return resolved.chat_id;
}

// Commands that don't need --brand
const BRAND_EXEMPT_CMDS = new Set(['help', 'resolve', 'status', 'st', 'images', 'imgs']);
const currentCmd = process.argv[2];
let BRAND_CHAT_URL;
if (BRAND_EXEMPT_CMDS.has(currentCmd) || !currentCmd) {
  BRAND_CHAT_URL = cfg.chatgpt_url;
} else if (currentCmd === 'new-chat') {           // T2406: new-chat CREATES the brand, so it may not exist yet (--brand still required below)
  BRAND_CHAT_URL = cfg.chatgpt_url;
} else {
  BRAND_CHAT_URL = `${cfg.chatgpt_url}/c/${getActiveBrandChatId()}`;
}
const FORK_CHAT_ID = null; // legacy removed — brands.<slug>.chat_id is the sole source
const FORCE_FLAG = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');

// ── T599: Cross-brand contamination guard ──
// RULE (BoB, 2026-08-17): brand is selected by DESTINATION, not by chat.
//   - Discord posting (news/content of wingman) = iAgencyAIA brand ALWAYS.
//   - WealthBanks brand = wealthbanks.net covers ONLY.
//   The two brands must NEVER cross. If a prompt destined for brand X contains a
//   token that signals brand Y, the send is ABORTED (not warned).
const BRAND_FORBID = {
  iagencyaia: ['wealthbanks', 'prestige white', 'wealth-bank', 'wealthbanks.net', 'wb-'],
  wealthbanks: ['iagencyaia', 'iagency', 'i-agency', '@iagencyaia', 'd31145', 'c8102e', 'discord', '@iagency'],
};
// Canonical brand name each slug must self-declare in a composed prompt.
const BRAND_SELF_NAME = {
  iagencyaia: 'iAgencyAIA',
  wealthbanks: 'WealthBanks',
};
// Destination → the ONLY permitted brand. Enforced by callers choosing --brand.
const DESTINATION_BRAND = {
  discord: 'iagencyaia',      // wingman news/content posters
  wealthbanks_net: 'wealthbanks', // wealthbanks.net covers
};
// T2301/gpt#20: a series slug (e.g. iagencyaia-education) names its brand via brands.<slug>.base_brand.
// Every brand lookup goes through this; keying on the raw slug gave a series an EMPTY forbid list.
function baseBrand(slug) {
  const key = (slug || '').toLowerCase();
  const b = cfg.brands && cfg.brands[key];
  return (b && b.base_brand ? String(b.base_brand) : key).toLowerCase();
}
function assertBrandMatch(brand, prompt) {
  const base = baseBrand(brand);
  const forbid = BRAND_FORBID[base];
  // Fail CLOSED: a brand with no forbid list is not "nothing forbidden", it is "unchecked".
  if (!forbid) {
    return { ok: false, reason: `no cross-brand forbid list for --brand ${brand} (base "${base}"); set brands.${brand}.base_brand to one of: ${Object.keys(BRAND_FORBID).join(', ')}` };
  }
  const lower = (prompt || '').toLowerCase();
  for (const tok of forbid) {
    if (lower.includes(tok)) {
      return { ok: false, reason: `cross-brand token "${tok}" in --brand ${brand} prompt (destination rule: Discord→iAgencyAIA, wealthbanks.net→WealthBanks; brands must not cross)` };
    }
  }
  return { ok: true };
}
const FEED_LOG = path.join(process.env.HOME || '/home/curfew', '.oracle/feed.log');

function logToFeed(chatId, promptHash, action) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const oracle = cfg.heartbeat_oracle || 'Designer-Oracle';
  const line = `${ts} | ${oracle} | poster.js | ${action} | chat=${chatId} prompt_hash=${promptHash}\n`;
  try { fs.appendFileSync(FEED_LOG, line); } catch {}
}

function promptHash(text) {
  const crypto = require('crypto');
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 8);
}

// ── T7: Build BRAND_TEMPLATE at runtime from DocCon CLAUDE_brand_ci.md ──
const BRAND_CI_PATH = path.join(
  process.env.HOME || '/home/curfew',
  'repos/github.com/BankCurfew/DocCon-Oracle/CLAUDE_brand_ci.md'
);

// ── T7: Load brand template from DocCon CLAUDE_brand_ci.md (Designer's proven template) ──

// T2197/check 12: badge label <-> hex = the series-colour registry (DocCon CLAUDE_daily_news_pipeline_conduct.md,
// mirrored in brand_ci §9). Exact labels, never codes (MB/FND/VRL were retired). Navy pill = fallback for no-series posters.
const TYPE_MAP = {
  atw:        { badge: 'ATW',        name: 'Around The World', icon: 'globe',  colorName: 'blue',   color: '#3b82f6' },
  mb:         { badge: 'MARKET',     name: 'Market Brief',     icon: 'chart',  colorName: 'green',  color: '#16a34a' },
  holdings:   { badge: 'HOLDINGS',   name: 'Fund Holdings',    icon: 'coins',  colorName: 'gold',   color: '#fbbf24' },
  insights:   { badge: 'INSIGHTS',   name: 'Fund Insights',    icon: 'chart',  colorName: 'purple', color: '#8b5cf6' },
  breaking:   { badge: 'BREAKING',   name: 'Breaking',         icon: 'alert',  colorName: 'red',    color: '#dc2626' },
  viral:      { badge: 'VIRAL',      name: 'Viral',            icon: 'fire',   colorName: 'orange', color: '#f97316' },
  motivation: { badge: 'MOTIVATION', name: 'Motivation',       icon: 'flame',  colorName: 'pink',   color: '#ec4899' },
  aia:        { badge: 'AIA',        name: 'AIA Event',        icon: 'star',   colorName: 'teal',   color: '#0d9488' },
  education:  { badge: 'EDUCATION',  name: 'Education',        icon: 'book',   colorName: 'cyan',   color: '#06b6d4' },
  promo:      { badge: 'PROMO',      name: 'Promo',            icon: 'gift',   colorName: 'navy',   color: '#1a1a2e' }, // not a registered series: navy fallback
};
TYPE_MAP.fund = TYPE_MAP.holdings; // old alias: 'fund' was split into HOLDINGS / INSIGHTS (T1701)

const BRAND_SEED = 'Top-right corner: ALWAYS leave it completely empty and clean for our logo overlay. Never draw any logo, wordmark or brand name anywhere in the image. BG: clean bright WHITE, warm and human (never dark, never textured, never off-white paper). Warm realistic hero photo + simple round icons, generous white space. Text colours: navy #1a1a2e, AIA red #D31145 for key Thai words. NO text unless exact Thai text given.';

function loadBrandTemplate() {
  try {
    const ci = fs.readFileSync(BRAND_CI_PATH, 'utf-8');
    // Try to extract canonical template from CLAUDE_brand_ci.md
    const templateMatch = ci.match(/## \d+\. POSTER PROMPT TEMPLATE[^\n]*\n[\s\S]*?```\n([\s\S]*?)```/);
    if (templateMatch) {
      const sectionNum = ci.match(/## (\d+)\. POSTER PROMPT TEMPLATE/)?.[1];
      console.log(`[T7] Brand template loaded from CLAUDE_brand_ci.md §${sectionNum}`);
      return templateMatch[1].trim();
    }
  } catch {}
  // Fallback: Designer's proven template (from thread #17, msg 638)
  console.log('[T7] Using Designer proven template (DocCon section not found yet)');
  return null;
}

const LOADED_TEMPLATE = loadBrandTemplate();

const BRAND_TEMPLATE = LOADED_TEMPLATE || `Generate an image: {TYPE} poster, 9:16 vertical.
Clean white BG, generous spacing, top-right corner left EMPTY for the logo overlay (never draw a logo),
header padding, Asian people.

Badge: {BADGE_CODE} ({BADGE_NAME}) top-left with {BADGE_ICON} icon, {BADGE_COLOR}. Top-right: leave empty (logo is composited later).

Headline ({MOOD}, {ACCENT_COLOR}):
{HEADLINE_TEXT}

Hero: {HERO_DESCRIPTION}

Key data with illustrated icons:
{DATA_ITEMS}

Source line (above footer bar): Source: {SOURCE} | {DATE}

Footer bar (gold #C1A368 bar at absolute bottom, navy #1A2A45 text):
Line 1: WealthBanks | wealthbanks.net
Line 2: PRIVATE WEALTH ADVISORY | {DATE}

{LIGHT_NOTES}. Prestige White palette (ivory #FDFCF9 / gold #C1A368 / navy #1A2A45). NO AIA red. Square 1:1. Generate now.`;

// ── T599: WealthBanks brand template (sourced from WEALTHBANKS-BRAND.md §2/§5/§6) ──
// Prestige White DNA. Square 1:1 article cover. Logo = OVERLAY ONLY (never drawn by DALL-E).
// Contains NO iAgency tokens → passes assertBrandMatch for --brand wealthbanks.
const BRAND_TEMPLATE_WEALTHBANKS = `Generate an image: {TYPE} branded content graphic, SQUARE 1:1 composition 1024x1024 pixels.
Ivory #FDFCF9 background with subtle warm gradient.
Leave TOP-LEFT corner blank/clean for logo overlay (do NOT draw any logo, wordmark, or brand text — logo is composited in post).

Large Thai headline navy #1A2A45 bold:
{HEADLINE_TEXT}

Photo: {HERO_DESCRIPTION}. Right 50% of composition, blending into ivory background with soft gradient. Photo-realistic, warm natural lighting, NOT CGI.

3 gold #C1A368 icon pill cards on left side:
{DATA_ITEMS}

Prestige White palette only (ivory #FDFCF9 / gold #C1A368 / navy #1A2A45). NO numbers NO data NO red.
NO logos NO watermarks NO brand text anywhere in the image.

Source line (above footer bar): Source: wealthbanks.net | {DATE}

Footer bar (gold #C1A368 bar at absolute bottom, navy #1A2A45 text):
Line 1: WealthBanks | wealthbanks.net
Line 2: PRIVATE WEALTH ADVISORY | {DATE}

{LIGHT_NOTES}. Prestige White palette (ivory #FDFCF9 / gold #C1A368 / navy #1A2A45). NO AIA red. Square 1:1. Generate now.`;

// ── T2: Refusal patterns (EN + THAI) ──
const REFUSAL_PATTERNS = [
  /i (?:can't|cannot|am unable to|won't) (?:create|generate|produce|make)/i,
  /(?:violates?|against|contrary to) (?:my |our )?(?:policies?|guidelines?|content policy|terms)/i,
  /(?:not able to|unable to) (?:generate|create|produce|fulfill)/i,
  /this (?:request|prompt) (?:isn't|is not) something I can/i,
  /ไม่สามารถสร้าง/,
  /ขัดต่อนโยบาย/,
  /ไม่สามารถทำตาม/,
  /ไม่เหมาะสม/,
  /ละเมิดนโยบาย/,
  /ฝ่าฝืนข้อกำหนด/,
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── T5: Heartbeat ──
function heartbeat(taskId, pct, status) {
  // GR#9 canonical stamp: YYYY-MM-DD HH:MM:SS, Bangkok LOCAL wall-clock.
  // Bangkok is a FIXED +07:00 with NO DST, so we compute it WITHOUT any locale machinery:
  // shift the epoch by +7h and read UTC fields. This removes the ICU dependency entirely —
  // ICU 72 injected U+202F (narrow no-break space) into en-US time formats, so a locale-based
  // stamp can regress silently and the dashboard would drop every HB (original bug). GR#9 forbids
  // date -u only because the dashboard parses feed.log as LOCAL; this still yields Bangkok-local
  // time, just constructed deterministically. Do NOT loosen the parser's replace(" ","T"); that
  // would make DD/MM silently parse as a WRONG date. Fix stays at the emitter. (Designer T621 + addendum 3c95b8c)
  //
  // Doctrine (BoB): fail-closed applies to VERIFIER/CLAIM, not PAYLOAD. HB is observability of the
  // poster job — it must FAIL-VISIBLE: the stamp (payload) always survives, and any break fires a
  // LOUD alert. We never let HB abort the pipeline it observes. So: build the stamp in a try/catch;
  // on failure, fall back to the same locale-independent canonical shape and emit a loud alert line.
  // The only throw is under HB_PIN_TEST (CI) — that is the verifier, where loud failure belongs.
  let ts;
  try {
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    ts = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  } catch (e) {
    // Fallback canonical stamp — payload MUST survive. Built from toISOString() of the +7h-
    // shifted Date (single method, independent of the UTC-field getters used above) so a break
    // in one Date accessor cannot take down the fallback too. If even this fails, fall back to a
    // fixed placeholder so the HB write never throws.
    let fb;
    try {
      fb = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    } catch {
      fb = '1970-01-01 00:00:00';
    }
    ts = fb;
    const alert = `${ts} | Echo-Oracle | ${require('os').hostname()} | Alert | Echo-Oracle | heartbeat » ALERT: HB timestamp construction failed, emitted fallback canonical stamp (${JSON.stringify(String(e && e.message))}) — investigate poster.js heartbeat()\n`;
    try { fs.appendFileSync(path.join(process.env.HOME || '/home/curfew', '.oracle/feed.log'), alert); } catch {}
  }
  // Test-only pin (Designer addendum 3c95b8c + BoB doctrine): a loud throw belongs in CI (the
  // verifier), never mid-generation (the payload). Production never throws.
  if (process.env.HB_PIN_TEST) {
    const HB_TS_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/;
    if (!HB_TS_RE.test(ts)) {
      throw new Error(`heartbeat timestamp not GR#9 canonical: ${JSON.stringify(ts)}`);
    }
  }
  const oracle = cfg.heartbeat_oracle;
  const hostname = require('os').hostname();
  const line = `${ts} | ${oracle} | ${hostname} | Notification | ${oracle} | heartbeat » HB: ${taskId} ${pct}% ${status}` + '\n';
  const feedPath = path.join(process.env.HOME || '/home/curfew', '.oracle/feed.log');
  try { fs.appendFileSync(feedPath, line); } catch {}
}

let _createdPages = [];
async function connect() {
  const browser = await puppeteer.connect({
    browserURL: cfg.cdp_url,
    defaultViewport: null,
    protocolTimeout: cfg.cdp_protocol_timeout,
  });
  const pages = await browser.pages();
  const activeChatId = getActiveBrandChatId();
  // T599: ONLY accept the active brand chat. Never fall back to ANY other chatgpt.com/c/
  // tab — that is the cross-brand contamination vector (a WB prompt could land in the iAgency chat).
  let page = pages.find(p => p.url().includes(activeChatId));

  if (!page) {
    // T833: the tab may be at chatgpt.com/ home — try navigating an existing ChatGPT tab
    const chatgptPage = pages.find(p => p.url().includes('chatgpt.com'));
    if (!chatgptPage) {
      throw new Error(
        `🚫 CONNECT FAILED: No ChatGPT tab open in browser.\n` +
        `   Open https://chatgpt.com/c/${activeChatId} in แบงค์'s Chrome, then retry.`
      );
    }
    console.log(`[connect] ChatGPT tab at ${chatgptPage.url()} — navigating to brand chat...`);
    // T2197: build the URL from activeChatId. BRAND_CHAT_URL is the bare home URL for brand-exempt
    // commands (status/images), so navigating there could never contain the chat id and always failed.
    await chatgptPage.goto(`${cfg.chatgpt_url}/c/${activeChatId}`, { waitUntil: 'networkidle2' });
    await sleep(3000);
    // Verify navigation reached the target chat — ChatGPT may redirect to home or new chat
    if (!chatgptPage.url().includes(activeChatId)) {
      throw new Error(
        `🚫 CONNECT FAILED: Navigated to brand chat but landed at ${chatgptPage.url()}\n` +
        `   Expected URL to contain: ${activeChatId.slice(0, 8)}...\n` +
        `   The chat may have been deleted or the session expired.\n` +
        `   Fix: open https://chatgpt.com/c/${activeChatId} manually, or run: node poster.js new-chat --brand ${BRAND_FLAG}`
      );
    }
    page = chatgptPage;
  }

  return { browser, page };
}

async function connectAnyChatgptTab() {
  const browser = await puppeteer.connect({ browserURL: cfg.cdp_url, defaultViewport: null, protocolTimeout: cfg.cdp_protocol_timeout });
  const page = (await browser.pages()).find(p => p.url().includes('chatgpt.com'));
  if (!page) throw new Error(`🚫 CONNECT FAILED: No ChatGPT tab open in browser. Open ONE https://chatgpt.com/ tab, then retry.`);
  return { browser, page };
}

async function cleanupCreatedPages() {
  for (const p of _createdPages) {
    try { if (!p.isClosed()) await p.close(); } catch {}
  }
  _createdPages = [];
}

// ── T6: Brand-chat rotation — open fresh chat when count >= max_chat_images ──
async function getImageCount(page) {
  // POSTER_IMG_SELECTOR covers Generated-alt, blob:, oaidalleapi, AND estuary
  // (new OpenAI CDN: chatgpt.com/backend-api/estuary/content?id=file_*).
  return page.evaluate((sel) => document.querySelectorAll(sel).length, POSTER_IMG_SELECTOR);
}

async function rollBrandChat(page) {
  // Wait for DOM to settle — images load lazily after navigation
  await sleep(2000);
  let count = await getImageCount(page);
  // Verify count is stable (not still loading)
  await sleep(1000);
  const count2 = await getImageCount(page);
  if (count2 > count) count = count2;

  const max = cfg.max_chat_images || 40;

  if (count < max) {
    console.log(`Brand chat: ${count}/${max} images — OK`);
    return false;
  }

  console.log(`Brand chat: ${count}/${max} images — ROTATING to fresh chat...`);
  heartbeat('#13', 2, `roll-brand (${count} images)`);

  await page.goto(`${cfg.chatgpt_url}`, { waitUntil: 'networkidle2' });
  await sleep(2000);

  // Click "New chat" or navigate to base URL (which opens new chat)
  const newChatUrl = await page.evaluate(() => window.location.href);
  console.log(`New chat opened: ${newChatUrl}`);

  // Re-seed brand kit — T599: must match the ACTIVE brand, never hardcode iAgencyAIA.
  // Cross-brand contamination happened here: rotation re-seeded the WB chat with iAgencyAIA priming.
  const brandSlug = BRAND_FLAG || 'iagencyaia';
  const seedForBrand = {
    iagencyaia: `${BRAND_SEED}\n\nYou are creating posters for iAgencyAIA brand. Always 9:16 vertical. Clean white backgrounds, generous spacing, Asian people. Acknowledge with "Ready for iagencyaia posters."`,
    wealthbanks: `Brand: WealthBanks — Prestige White theme. BG: ivory #FDFCF9. Palette: navy #1A2A45 + gold #C1A368 + bronze. Asian Thai models 30-50, warm natural lighting, NO text in image (CAR-dalle-nav). Asian family/couple planning finances at ivory-warm table. Acknowledge with "Ready for wealthbanks posters."`,
  };
  const primer = seedForBrand[brandSlug] || seedForBrand.iagencyaia;
  await sleep(1000);

  // T2397: shared visible-composer send with read-back + new-turn confirmation.
  if (await sendAndConfirm(page, primer, { label: 'primer' })) {
    await sleep(5000); // Wait for ack
  } else {
    console.error('[primer] brand seed did not land — the rotated chat has no primer');
  }

  console.log('Brand chat rotated + re-seeded.');
  return true;
}

// ── T9: Verify image belongs to THIS prompt's assistant message ──
// T1203: ChatGPT removed data-message-author-role from DOM (nobi found on Dreams 2026-09-01).
// Primary path: scoped assistant-message check. Fallback: pure count-based (estuary direct-poll).
async function verifyImageGeneration(page, promptText, beforeCount) {
  return page.evaluate((prompt, before, imgSel) => {
    // T1203 fallback selectors — try data-message-author-role first, then alternatives
    const assistantMsgs =
      document.querySelectorAll('[data-message-author-role="assistant"]');
    const scopedMsgs = assistantMsgs.length
      ? assistantMsgs
      : document.querySelectorAll('[data-testid^="conversation-turn-"],[data-message-id]');

    const allImgs = document.querySelectorAll(imgSel);
    if (allImgs.length <= before) {
      return { valid: false, reason: `total count ${allImgs.length} not greater than baseline ${before}` };
    }

    // If we have scoped messages, verify the last one contains an image
    if (scopedMsgs.length) {
      const lastMsg = scopedMsgs[scopedMsgs.length - 1];
      const msgImages = lastMsg.querySelectorAll(imgSel);
      if (msgImages.length > 0) {
        return { valid: true, imgCount: msgImages.length, totalCount: allImgs.length, method: 'scoped' };
      }
    }

    // T1203 fallback: count increased → image was generated (estuary direct-poll)
    return { valid: true, imgCount: allImgs.length - before, totalCount: allImgs.length, method: 'count-fallback' };
  }, promptText, beforeCount, POSTER_IMG_SELECTOR);
}

// ── Auto-resize to 1080x1920 (IG Story) — pad on brand canvas, never distort ──
function resizeToIG(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return filePath;

  const { execSync } = require('child_process');
  const outPath = filePath.replace(/\.png$/, '-1080x1920.png');

  try {
    // Scale to fit within 1080x1920 maintaining aspect ratio, then pad with brand BG color
    execSync(
      `convert "${filePath}" -resize 1080x1920 -gravity center -background "#FFFFFF" -extent 1080x1920 "${outPath}"`,
      { timeout: 15000 }
    );

    if (fs.existsSync(outPath)) {
      const size = Math.round(fs.statSync(outPath).size / 1024);
      // Replace original with resized
      fs.renameSync(outPath, filePath);
      console.log(`  Resized → 1080x1920 (${size}KB, padded on #FFFFFF)`);
      return filePath;
    }
  } catch (e) {
    console.error(`  Resize failed: ${e.message} — delivering original`);
  }
  return filePath;
}

// ── T8: QA gate — verify exact 1080x1920 + file size ──
function qaGate(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { pass: false, reason: 'file not found' };
  }

  const stats = fs.statSync(filePath);
  const sizeKB = Math.round(stats.size / 1024);
  const minSize = cfg.qa_min_size_kb || 50;

  if (sizeKB < minSize) {
    return { pass: false, reason: `file too small: ${sizeKB}KB (min ${minSize}KB)` };
  }

  // Check dimensions via ImageMagick identify
  try {
    const { execSync } = require('child_process');
    const dims = execSync(`identify -format "%wx%h" "${filePath}"`, { timeout: 5000 }).toString().trim();
    if (dims !== '1080x1920') {
      return { pass: false, reason: `wrong dimensions: ${dims} (required: 1080x1920)` };
    }
    console.log(`QA PASS: ${sizeKB}KB, 1080x1920`);
    return { pass: true, sizeKB, dimensions: dims };
  } catch {
    // identify not available — pass on size alone
    console.log(`QA PASS: ${sizeKB}KB (dimensions not verified)`);
    return { pass: true, sizeKB };
  }
}

// T2167: ChatGPT's send button is now <button type="submit" aria-label="Send"> inside the composer form, with no
// data-testid (probed 2026-09-24, read-only). None of the old selectors matched, so new-chat never sent its seed and
// waited 45s for a /c/<id> that could not appear. One helper for every send site; returns the path that clicked
// (or null) so callers can fail loudly instead of waiting on a URL.
async function clickSend(page) {
  await installComposerFinder(page);
  return page.evaluate(() => {
    // T2397: search inside the composer's own form — a project page carries other forms/textareas.
    const composer = window.__posterComposer();
    const scope = (composer && composer.closest('form')) || document;
    const known = scope.querySelector('button[data-testid="send-button"], button[data-testid="composer-send-button"], '
      + 'button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]');
    if (known && !known.disabled) { known.click(); return 'send-button'; }
    const submit = scope.querySelector('button[type="submit"]:not([disabled])');
    if (submit) { submit.click(); return 'form-submit'; }
    const form = composer ? composer.closest('form, div[class*="composer"]') : null;
    if (form) {
      for (const b of form.querySelectorAll('button:not([disabled])')) {
        // gpt#20: an attachment chip renders as <button aria-label="Remove <file>"> with an svg — never click it
        if (/^(Remove|Add files)/i.test(b.getAttribute('aria-label') || '')) continue;
        if (b.querySelector('svg') || b.querySelector('path')) { b.click(); return 'svg-fallback'; }
      }
    }
    if (composer) { composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); return 'enter-key'; }
    return null;
  });
}

// T2397 (30/9): '#prompt-textarea' is gone — the composer is div.ProseMirror[contenteditable] with no id — and a
// project page also holds 3 hidden <textarea>s. The old selector list took the first match in document order, so the
// prompt could go into a hidden textarea and the send never landed. Only a VISIBLE element counts, ProseMirror first.
const COMPOSER_FINDER_SRC = `window.__posterComposer = () => {
  const visible = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const sels = ['div.ProseMirror[contenteditable="true"]', '#prompt-textarea', 'div[contenteditable="true"]',
                'textarea[data-id]', 'form textarea'];
  for (const s of sels) for (const e of document.querySelectorAll(s)) if (visible(e)) return e;
  return null;
};
window.__posterComposerText = () => {
  const el = window.__posterComposer();
  if (!el) return null;
  return (el.tagName === 'TEXTAREA' ? el.value : el.innerText || '').replace(/\\s+/g, ' ').trim();
};
// USER turns only. 30/9 probe: none of data-message-author-role / conversation-turn-* / data-message-id / article exist on
// today's DOM; a sent message renders as [data-user-message-bubble=true] inside [data-content-search-unit-key$=":user"].
window.__posterTurns = () => Math.max(
  document.querySelectorAll('[data-user-message-bubble="true"]').length,
  document.querySelectorAll('[data-content-search-unit-key$=":user"]').length,
  document.querySelectorAll('[data-message-author-role="user"]').length,
  document.querySelectorAll('[data-turn="user"]').length);
// T2398: busy = a stop button or a 'still writing' notice. NOT 'Loading chats' / 'Loading older messages…' — those
// stay on screen indefinitely (sidebar + lazy history), so waiting on them never ends (probe 30/9).
// T2398: text of the newest user message — confirms a send even when older turns are unmounted (count stays flat).
window.__posterLastUser = () => {
  const b = document.querySelectorAll('[data-user-message-bubble="true"]');
  return b.length ? (b[b.length - 1].innerText || '').replace(/\\s+/g, ' ').trim() : '';
};
// T2398 atw: id of the newest user message. Text is NOT identity: locked-template prompts share a long identical head,
// so last night's turn matched the first 60 chars and a dropped send read as 'confirmed (no resend)'.
window.__posterLastUserId = () => {
  const b = document.querySelectorAll('[data-user-message-bubble="true"]');
  const holder = b.length ? b[b.length - 1].closest('[data-chatgpt-search-message-ids], [data-message-id]') : null;
  return holder ? (holder.getAttribute('data-chatgpt-search-message-ids') || holder.getAttribute('data-message-id') || '') : '';
};
window.__posterBusy = () => !!document.querySelector('button[data-testid="stop-button"], button[aria-label*="Stop"]')
  || [...document.querySelectorAll('[role=alert], [role=status]')].some((e) => /still (writing|generating)/i.test(e.innerText || ''));`;

async function installComposerFinder(page) {
  await page.evaluate(COMPOSER_FINDER_SRC);
}

const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// T2398 S1: ChatGPT clips a long user bubble to ~1.7k chars and appends '… Show more', so a sent prompt read as
// "not landed" and got resent (3x on S1, 30/9). Identity is the NEW message id (checked by callers); the text only has
// to be this prompt's visible start: strip the clip marker, then the shown part must be a prefix of the prompt.
const CLIP_RE = /\s*(?:…|\.\.\.)?\s*(?:Show more|แสดงเพิ่มเติม|ดูเพิ่มเติม)\s*$/i;
const sameText = (shown, want) => {
  const raw = normText(shown), b = normText(want);
  const clipped = CLIP_RE.test(raw);
  const a = normText(raw.replace(CLIP_RE, '')).replace(/…$/, '').trim();
  if (!a) return false;
  if (a === b) return true;
  if (!b.startsWith(a)) return false;
  return clipped ? a.length >= Math.min(200, b.length) : a.length >= b.length * 0.9;
};
const lastUser = (page) => page.evaluate(() => ({ id: window.__posterLastUserId(), text: window.__posterLastUser() }))
  .catch(() => ({ id: '', text: '' }));

// Type into the visible composer and READ IT BACK. Returns { ok, kind, reason }. A mismatch is a failure, never a send.
async function fillComposer(page, text) {
  // Chrome restarts leave the ChatGPT tabs hidden (visibilityState=hidden); input and send misbehave there.
  await page.bringToFront().catch(() => {});
  await installComposerFinder(page);
  // T2398 S2: a chat can open with an unsent draft already in the composer (designer's S2 held 2382 chars), and the
  // editor clear below left it there: draft + paste = 2x text. So clear first and READ BACK EMPTY; if the editor clear
  // did not take, clear with real keys; if text is still there, refuse (never paste on top of a draft).
  const left = await clearComposer(page);
  if (left === null) return { ok: false, kind: null, reason: 'no visible composer' };
  if (left > 0) return { ok: false, kind: null, reason: `composer not cleared: ${left} chars of an old draft still there` };
  const kind = await page.evaluate((t) => {
    const el = window.__posterComposer();
    if (!el) return null;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (set) set.call(el, t); else el.value = t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'textarea';
    }
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    if (normText(el.innerText).length < 5) document.execCommand('insertText', false, t);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.classList.contains('ProseMirror') ? 'prosemirror' : 'contenteditable';

    function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  }, text);
  if (!kind) return { ok: false, kind: null, reason: 'no visible composer' };
  await sleep(400);
  const got = await page.evaluate(() => window.__posterComposerText());
  const want = normText(text);
  const head = want.slice(0, 60);
  const ok = !!got && got.startsWith(head) && Math.abs(got.length - want.length) <= Math.max(10, want.length * 0.05);
  return ok ? { ok, kind } : { ok, kind, reason: `composer read-back mismatch: want ${want.length} chars "${head.slice(0, 30)}…", got ${got ? got.length : 0} chars "${(got || '').slice(0, 30)}…"` };
}

// Empty the composer and return how many chars are left (0 = empty, null = no composer).
async function clearComposer(page) {
  const len = () => page.evaluate(() => { const t = window.__posterComposerText(); return t === null ? null : t.length; });
  let left = await len();
  if (!left) return left;
  await page.evaluate(() => {
    const el = window.__posterComposer();
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (set) set.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // ProseMirror: clear through the editor (select all + delete), never textContent='' which desyncs its state.
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  });
  await sleep(200);
  left = await len();
  if (!left) return left;
  const handle = await page.evaluateHandle(() => window.__posterComposer());
  await handle.asElement()?.click().catch(() => {});
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await sleep(300);
  left = await len();
  console.error(`[composer] editor clear left an old draft; cleared with keys, ${left} chars left`);
  return left;
}

// Fill → read back → send → prove a NEW user turn appeared (or the chat URL changed, for a brand-new chat).
async function sendAndConfirm(page, text, opts = {}) {
  const label = opts.label || 'send';
  await installComposerFinder(page);
  const before = await lastUser(page); // newest user message BEFORE any attempt: the reload check must see a NEW one
  const first = await sendOnce(page, text, opts);
  if (first === 'confirmed') return true;
  if (first === 'no-composer-text') return false; // read-back refused: nothing was sent, retrying would not help
  // T2398: a tab can be stuck in a local "ChatGPT is still writing" state (send refused, no new turn). Reload, wait
  // until the chat is ready, and only resend if our message is NOT already the newest user turn (never double-send).
  console.error(`[${label}] retrying once after reload (${first})`);
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
  await waitChatReady(page, 45000);
  await installComposerFinder(page);
  const now = await lastUser(page);
  if (now.id && now.id !== before.id && sameText(now.text, text)) {
    console.log(`[${label}] confirmed after reload: newest user message ${now.id.slice(0, 8)} is new since the send and is this text (no resend)`);
    return true;
  }
  console.error(`[${label}] after reload: not proven landed (newest id ${now.id ? (now.id === before.id ? 'unchanged' : 'new but other text') : 'unreadable'}) -> resend`);
  const second = await sendOnce(page, text, opts);
  if (second === 'confirmed') return true;
  console.error(`[${label}] NOT CONFIRMED after reload + resend (${second}) — chat may be locked; open it in Chrome to check`);
  return false;
}

async function waitChatReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await installComposerFinder(page).catch(() => {});
    const ready = await page.evaluate(() => !!window.__posterComposer() && !window.__posterBusy()).catch(() => false);
    if (ready) return true;
    await sleep(1000);
  }
  return false;
}

// One attempt. Returns 'confirmed' | 'no-composer-text' | 'send-disabled' | 'no-send-control' | 'no-new-turn'.
async function sendOnce(page, text, { label = 'send', timeoutMs = 20000, waitEnabledMs = 150000 } = {}) {  // T2406: 150s for send-button wait (was 60s; designer measured 60s stall after chat switch, recovered with reload)
  await installComposerFinder(page);
  const before = await page.evaluate(() => window.__posterTurns());
  const lastBefore = await lastUser(page);
  const urlBefore = page.url();
  const fill = await fillComposer(page, text);
  if (!fill.ok) { console.error(`[${label}] NOT SENT — ${fill.reason}`); return 'no-composer-text'; }
  // gpt#20: with an image attached, Send stays disabled until the upload finishes.
  const enabled = await waitSendEnabled(page, waitEnabledMs);
  if (enabled === 'timeout') { console.error(`[${label}] send button stayed disabled ${waitEnabledMs / 1000}s`); return 'send-disabled'; }
  const via = await clickSend(page);
  console.log(`[${label}] composer=${fill.kind} send via ${via || 'NOTHING — no send control found'}`);
  if (!via) return 'no-send-control';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    await installComposerFinder(page).catch(() => {});
    const now = await page.evaluate(() => window.__posterTurns()).catch(() => before);
    const last = await lastUser(page);
    const byText = !!last.id && last.id !== lastBefore.id && sameText(last.text, text);
    if (now > before || page.url() !== urlBefore || byText) {
      console.log(`[${label}] confirmed: ${now > before ? `new turn (${before} → ${now})` : byText ? 'newest user turn is this message' : 'chat url changed'}`);
      return 'confirmed';
    }
  }
  console.error(`[${label}] no new turn within ${timeoutMs / 1000}s after send (turns stayed ${before})`);
  return 'no-new-turn';
}

async function sendPrompt(page, prompt) {
  // T2397: visible composer only, read back before send, and a new turn must appear after it.
  if (!(await sendAndConfirm(page, prompt, { label: 'send' }))) {
    console.error('ERROR: prompt did not land in ChatGPT (see line above)');
    return false;
  }
  console.log('Prompt sent. Waiting for DALL-E generation...');
  return true;
}

async function waitSendEnabled(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const b = document.querySelector('button[data-testid="send-button"], button[data-testid="composer-send-button"], '
        + 'button[aria-label="Send prompt"], button[aria-label="Send message"], button[aria-label="Send"]');
      return b ? (b.disabled ? 'disabled' : 'enabled') : 'absent';
    });
    if (state !== 'disabled') return state;
    await sleep(500);
  }
  return 'timeout';
}

// ── gpt#20: attach / reply / log (design-by-conversation, T2300 §4.3a) ──
const ATTACH_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

// The CDP browser is แบงค์'s Windows Chrome: a Linux path handed to setFileInputFiles gives a chip that says
// "Upload failed" with no network request, and the message then goes out without the image (probed 27/9).
// Hand Windows Chrome the \\wsl.localhost\... form of the path.
async function browserPath(page, f) {
  const onWindows = await page.evaluate(() => navigator.userAgent.includes('Windows'));
  if (!onWindows) return f;
  try { return execSync(`wslpath -w ${JSON.stringify(f)}`, { encoding: 'utf-8' }).trim(); } catch { return f; }
}

// Success = one 200 from /backend-api/files/process_upload_stream per file (the upload finished server-side).
// The "Remove <file>" button is NOT a success signal: it renders on a failed chip too.
async function attachFiles(page, files) {
  const input = await page.$('form input[type="file"][accept="image/*"]') || await page.$('form input[type="file"]');
  if (!input) { console.error('🚫 attach: no file input in the composer'); return false; }
  let processed = 0;
  const onRes = (r) => { if (r.url().includes('/backend-api/files/process_upload_stream') && r.status() === 200) processed++; };
  page.on('response', onRes);
  try {
    const paths = [];
    for (const f of files) paths.push(await browserPath(page, f));
    await input.uploadFile(...paths);
    const names = files.map((f) => path.basename(f));
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const failed = await page.evaluate(() => {
        const box = document.querySelector('[data-composer-attachments]');
        return !!box && /Upload failed/i.test(box.innerText || '');
      });
      if (failed) { console.error(`🚫 attach: ChatGPT shows "Upload failed" for ${names.join(', ')}`); return false; }
      if (processed >= files.length) break;
      await sleep(500);
    }
    if (processed < files.length) { console.error(`🚫 attach: ${processed}/${files.length} uploads finished after 60s`); return false; }
    for (const n of names) console.log(`[attach] uploaded ${n}`);
    return true;
  } finally { page.off('response', onRes); }
}

async function attachCmd(page, args) {
  const files = [];
  while (args.length && ATTACH_EXT.has(path.extname(args[0]).toLowerCase()) ) files.push(path.resolve(args.shift()));
  const message = args.join(' ').trim();
  if (!files.length) { console.error('Usage: poster.js attach <image> [<image>...] [message] --brand <name>'); process.exitCode = 1; return; }
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`🚫 attach: file not found: ${f}`); process.exitCode = 1; return; }
    const mb = fs.statSync(f).size / 1048576;
    if (mb > 20) { console.error(`🚫 attach: ${path.basename(f)} is ${mb.toFixed(1)} MB (>20 MB)`); process.exitCode = 1; return; }
  }
  // T599: the brand guard covers file names and the message, not only prompts
  const bc = assertBrandMatch(BRAND_FLAG, files.map((f) => path.basename(f)).join(' ') + ' ' + message);
  if (!bc.ok) { console.error(`\n🚫 ABORT (T599): ${bc.reason}`); process.exitCode = 4; return; }
  if (DRY_RUN) { console.log(`[dry-run] would attach ${files.map((f) => path.basename(f)).join(', ')}${message ? ' + send message' : ''}`); return; }

  const before = (await readTurns(page)).length;
  if (!(await attachFiles(page, files))) { process.exitCode = 1; return; }
  if (!message) {
    console.log('[attach] staged only — the next `prompt` sends it with the text');
    return;
  }
  if (!(await sendPrompt(page, message))) { process.exitCode = 1; return; }
  logToFeed(getActiveBrandChatId(), promptHash(message + files.join(',')), 'attach-send');
  // Read back: a new turn whose user side carries the image(s)
  const deadline = Date.now() + 20000;
  let turn = null;
  while (Date.now() < deadline) {
    const turns = await readTurns(page);
    if (turns.length > before) { turn = turns[turns.length - 1]; if (turn.userImages.length >= files.length) break; }
    await sleep(1000);
  }
  if (!turn) { console.error('🚫 attach: sent, but no new turn appeared within 20s'); process.exitCode = 1; return; }
  console.log(`[attach] sent · turn ${before + 1} · user images on turn: ${turn.userImages.length}/${files.length}`);
  if (turn.userImages.length < files.length) { console.error('⚠️  attach: the turn shows fewer images than attached — check the chat'); process.exitCode = 1; }
}

async function replyCmd(page, args) {
  const wait = args.includes('--wait');
  const timeoutMs = 180000;
  const deadline = Date.now() + timeoutMs;
  let last = null; let stable = 0;
  for (;;) {
    const turns = await readTurns(page);
    const t = [...turns].reverse().find((x) => x.hasAssistant) || null;
    const streaming = await isStreaming(page);
    const snapshot = t ? t.assistant + '|' + t.assistantImages.length : '';
    if (!wait) { last = t; break; }
    stable = (!streaming && snapshot === (last && last._snap)) ? stable + 1 : 0;
    last = t && Object.assign(t, { _snap: snapshot });
    if (stable >= 2) break;
    if (Date.now() > deadline) { console.error(`⚠️  reply: still changing after ${timeoutMs / 1000}s — printing what is there`); break; }
    await sleep(2000);
  }
  if (!last) { console.error('reply: no assistant message in this chat'); process.exitCode = 1; return; }
  if (last.assistant) console.log(last.assistant);
  else console.log('(no text in the last reply)');
  if (last.assistantImages.length) console.log(`[reply] + ${last.assistantImages.length} generated image(s) — use \`images\` / \`download\``);
  if (!wait && (await isStreaming(page))) console.error('⚠️  reply: ChatGPT is still writing — rerun with --wait for the full text');
}

async function logCmd(page, outPath) {
  if (!outPath) { console.error('Usage: poster.js log <out.md> --brand <name>'); process.exitCode = 1; return; }
  const turns = await readTurns(page);
  const url = page.url();
  const lines = [
    `# ChatGPT conversation log — ${BRAND_FLAG}`, '',
    `- chat: ${url}`, `- title: ${await page.title()}`, `- saved: ${new Date().toISOString()}`, `- turns: ${turns.length}`, '',
  ];
  const imgLine = (i) => `  - ${i.id}${i.alt ? ` — ${i.alt}` : ''}${i.w ? ` (${i.w}x${i.h})` : ''}`;
  turns.forEach((t, n) => {
    lines.push(`## Turn ${n + 1}`, '', '### User', '', t.user || '_(no text)_', '');
    if (t.userImages.length) lines.push('Attached images:', ...t.userImages.map(imgLine), '');
    lines.push('### ChatGPT', '', t.hasAssistant ? (t.assistant || '_(no text)_') : '_(no reply yet)_', '');
    if (t.assistantImages.length) lines.push('Generated images:', ...t.assistantImages.map(imgLine), '');
  });
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, lines.join('\n'));
  const nImg = turns.reduce((a, t) => a + t.assistantImages.length, 0);
  const nAtt = turns.reduce((a, t) => a + t.userImages.length, 0);
  console.log(`[log] ${turns.length} turns · ${nAtt} attached · ${nImg} generated → ${path.resolve(outPath)}`);
}

// ── T2: Read last assistant message ──
// gpt#20 (2026-09-27): ChatGPT dropped data-message-author-role. A conversation is now a list of
// [data-turn-key] blocks, each holding one exchange: the user text in [data-user-message-bubble], an
// sr-only <h4 data-conversation-role="assistant"> header, then the reply in div[data-markdown-text-style]
// (probed read-only on the live brand chat). Before this, all three selector paths below returned '' so
// checkRefusal() in waitForImage() was reading an empty string. readTurns() is the one DOM reader;
// images are assigned to the user or assistant side by document position relative to that header.
async function readTurns(page) {
  return page.evaluate((imgSel) => {
    const clean = (s) => (s || '').replace(/\n?…\n?Show (more|less)\s*$/, '').trim();
    const imgInfo = (i) => {
      const src = i.currentSrc || i.src || '';
      const m = src.match(/[?&]id=(file[-_][A-Za-z0-9]+)/) || src.match(/(file[-_][A-Za-z0-9]{8,})/);
      return { id: m ? m[1] : (src.startsWith('blob:') ? 'blob' : src.slice(0, 60)), alt: (i.alt || '').slice(0, 60), w: i.naturalWidth || 0, h: i.naturalHeight || 0 };
    };
    const turns = [...document.querySelectorAll('[data-turn-key]')];
    if (turns.length) {
      return turns.map((t) => {
        const u = t.querySelector('[data-user-message-bubble]');
        const hdr = t.querySelector('[data-conversation-role="assistant"]');
        const isAfterHdr = (el) => hdr && (hdr.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
        const md = [...t.querySelectorAll('div[data-markdown-text-style]')]
          .filter((e) => !e.parentElement.closest('div[data-markdown-text-style]'));
        const imgs = [...t.querySelectorAll('img')].filter((i) => (i.naturalWidth || i.width || 0) >= 64 || i.matches(imgSel));
        return {
          key: t.getAttribute('data-turn-key'),
          user: clean(u ? u.innerText : ''),
          userImages: imgs.filter((i) => !isAfterHdr(i)).map(imgInfo),
          hasAssistant: !!hdr,
          assistant: md.map((e) => e.innerText.trim()).join('\n\n'),
          assistantImages: imgs.filter((i) => isAfterHdr(i) && i.matches(imgSel)).map(imgInfo),
        };
      });
    }
    // Legacy DOM: one element per message with data-message-author-role
    const out = [];
    for (const m of document.querySelectorAll('[data-message-author-role]')) {
      const role = m.getAttribute('data-message-author-role');
      const text = (m.innerText || '').trim();
      const images = [...m.querySelectorAll('img')].map(imgInfo);
      if (role === 'user') out.push({ key: null, user: clean(text), userImages: images, hasAssistant: false, assistant: '', assistantImages: [] });
      else if (role === 'assistant') {
        if (!out.length || out[out.length - 1].hasAssistant) out.push({ key: null, user: '', userImages: [], hasAssistant: false, assistant: '', assistantImages: [] });
        const t = out[out.length - 1];
        t.hasAssistant = true;
        t.assistant = [t.assistant, text].filter(Boolean).join('\n\n');
        t.assistantImages.push(...[...m.querySelectorAll(imgSel)].map(imgInfo));
      }
    }
    return out;
  }, POSTER_IMG_SELECTOR);
}

async function isStreaming(page) {
  return page.evaluate(() => !!document.querySelector(
    'button[data-testid="stop-button"], button[aria-label="Stop streaming"], button[aria-label="Stop generating"], button[aria-label^="Stop"]'));
}

async function getLastAssistantMsg(page) {
  const turns = await readTurns(page);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].hasAssistant) return turns[i].assistant.slice(0, 500);
  }
  return '';
}

function checkRefusal(text) {
  for (const pat of REFUSAL_PATTERNS) {
    if (pat.test(text)) {
      return { refused: true, reason: text.slice(0, 200) };
    }
  }
  return { refused: false };
}

// ── T1+T2+T5+T9: Wait with stable baseline, recovery, refusal detection, heartbeat ──
async function waitForImage(page, taskId, timeoutMs, opts) {
  opts = opts || {};
  timeoutMs = timeoutMs || cfg.generation_timeout_ms;
  const startTime = Date.now();
  const stablePolls = cfg.stall_stable_polls || 3;

  // T9: After refresh, wait for stable baseline before counting
  let lastCount;
  if (opts.stabilize) {
    console.log('  Stabilizing baseline...');
    let stableCount = 0;
    let prevCount = -1;
    for (let i = 0; i < stablePolls + 2; i++) {
      await sleep(cfg.poll_interval_ms);
      const c = await getImageCount(page);
      if (c === prevCount) stableCount++;
      else stableCount = 0;
      prevCount = c;
      if (stableCount >= stablePolls) break;
    }
    lastCount = prevCount;
    console.log(`  Baseline stabilized at ${lastCount} images`);
  } else {
    lastCount = await getImageCount(page);
  }

  let stallPolls = 0;
  let lastMsgText = '';
  let pollNum = 0;

  heartbeat(taskId || '#13', 5, 'generation-started');

  while (Date.now() - startTime < timeoutMs) {
    await sleep(cfg.poll_interval_ms);
    pollNum++;
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const pct = Math.min(90, Math.round((elapsed / (timeoutMs / 1000)) * 90));

    // T5: heartbeat every 6 polls (~30s)
    if (pollNum % 6 === 0) {
      heartbeat(taskId || '#13', pct, `waiting ${elapsed}s`);
    }

    const status = await page.evaluate((imgSel) => {
      const imgs = document.querySelectorAll(imgSel);
      // T1203: broaden streaming detection — don't scope to data-message-author-role
      // which ChatGPT may remove. Check global streaming indicators + progress bars.
      const thinking = document.querySelector(
        '[class*="thinking"], [class*="streaming"], [class*="result-streaming"],' +
        '[class*="progress"], [data-testid*="streaming"],' +
        '[data-message-author-role="assistant"] [class*="result-streaming"]'
      );
      return { imgCount: imgs.length, isThinking: !!thinking };
    }, POSTER_IMG_SELECTOR);

    if (status.imgCount > lastCount) {
      console.log(`\nImage generated! (${elapsed}s)`);
      heartbeat(taskId || '#13', 95, 'image-detected');
      return { ok: true };
    }

    // T2: Check for refusal
    const msgText = await getLastAssistantMsg(page);
    if (msgText && msgText !== lastMsgText && !status.isThinking) {
      lastMsgText = msgText;
      const refusal = checkRefusal(msgText);
      if (refusal.refused) {
        console.log(`\nREFUSED: ${refusal.reason}`);
        heartbeat(taskId || '#13', 0, 'refused');
        return { ok: false, refused: true, reason: refusal.reason };
      }
    }

    // T1: Stall detection — flat count for too long
    if (status.imgCount === lastCount && !status.isThinking && elapsed > 30) {
      stallPolls++;
    } else {
      stallPolls = 0;
    }

    if (stallPolls >= cfg.stall_threshold_polls) {
      console.log(`\nSTALL detected (${stallPolls} flat polls, ${elapsed}s). Auto-refreshing...`);
      heartbeat(taskId || '#13', pct, 'stall-refresh');
      return { ok: false, stalled: true };
    }

    if (status.isThinking) {
      process.stdout.write(`\r  Generating... ${elapsed}s`);
    } else if (elapsed > 10) {
      process.stdout.write(`\r  Waiting... ${elapsed}s (${status.imgCount} images, stall:${stallPolls}/${cfg.stall_threshold_polls})`);
    }
  }

  console.log('\nTIMEOUT: No new image after', Math.round(timeoutMs / 1000), 's');
  heartbeat(taskId || '#13', 0, 'timeout');
  return { ok: false, timeout: true };
}

async function listImages(page) {
  // Filter INSIDE the browser context (page.evaluate) using POSTER_IMG_SELECTOR so
  // estuary CDN images are detected here too. globalIdx = index in the FULL img
  // NodeList, which downloadImage() uses to locate the element (document.querySelectorAll('img')[globalIdx]).
  return page.evaluate((sel) => {
    const all = Array.from(document.querySelectorAll('img'));
    return all
      .map((img, i) => ({ img, i }))
      .filter(({ img }) => img.matches(sel))
      .map(({ img, i }) => ({
        globalIdx: i,
        w: img.naturalWidth || img.width,
        h: img.naturalHeight || img.height,
        alt: (img.alt || '').substring(0, 50),
        src: (img.src || '').substring(0, 80),
        hasAlt: !!(img.alt && img.alt.startsWith('Generated'))
      }));
  }, POSTER_IMG_SELECTOR);
}

async function downloadImage(page, prefix, indexArg) {
  const dateStr = new Date().toISOString().slice(0, 10);
  const dalleImgs = await listImages(page);
  if (!dalleImgs.length) {
    console.error('ERROR: No large images found');
    return null;
  }

  const targetIdx = indexArg !== undefined ? parseInt(indexArg) : dalleImgs.length - 1;
  if (targetIdx < 0 || targetIdx >= dalleImgs.length) {
    console.error(`ERROR: index ${targetIdx} out of range (0-${dalleImgs.length - 1})`);
    dalleImgs.forEach((img, i) => console.log(`  [${i}] ${img.w}x${img.h} ${img.alt || img.src}`));
    return null;
  }

  const target = dalleImgs[targetIdx];
  const suffix = dalleImgs.length > 1 ? `-${targetIdx + 1}of${dalleImgs.length}` : '';
  const dest = path.join(cfg.output_dir, `${prefix || 'poster'}-${dateStr}${suffix}.png`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  console.log(`Downloading image [${targetIdx}] ${target.w}x${target.h}...`);
  const globalIdx = target.globalIdx;

  // Method 1: Fetch image src
  try {
    const imgData = await page.evaluate(async (gIdx) => {
      const imgs = document.querySelectorAll('img');
      const img = imgs[gIdx];
      if (!img || !img.src) return null;
      try {
        const resp = await fetch(img.src, { credentials: 'include' });
        if (!resp.ok) return null;
        const blob = await resp.blob();
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.readAsDataURL(blob);
        });
      } catch { return null; }
    }, globalIdx);

    if (imgData) {
      fs.writeFileSync(dest, Buffer.from(imgData, 'base64'));
      const size = Math.round(fs.statSync(dest).size / 1024);
      if (size > 10) {
        console.log(`SAVED: ${dest} (${size}KB) [${targetIdx + 1}/${dalleImgs.length}]`);
        return dest;
      }
      console.log('Fetch returned small file, trying fallback...');
    }
  } catch (e) {
    console.log('Fetch failed:', e.message);
  }

  // Method 2: Screenshot element
  try {
    const allImgs = await page.$$('img');
    if (allImgs[globalIdx]) {
      await allImgs[globalIdx].scrollIntoView();
      await sleep(1000);
      await allImgs[globalIdx].screenshot({ path: dest });
      const size = Math.round(fs.statSync(dest).size / 1024);
      if (size > 10) {
        console.log(`SAVED: ${dest} (${size}KB) [${targetIdx + 1}/${dalleImgs.length}]`);
        return dest;
      }
    }
  } catch (e) {
    console.log('Screenshot failed:', e.message);
  }

  // Method 3: Canvas fallback
  try {
    const imgData = await page.evaluate((gIdx) => {
      const img = document.querySelectorAll('img')[gIdx];
      if (!img) return null;
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      try { return canvas.toDataURL('image/png').split(',')[1]; }
      catch { return null; }
    }, globalIdx);

    if (imgData) {
      fs.writeFileSync(dest, Buffer.from(imgData, 'base64'));
      const size = Math.round(fs.statSync(dest).size / 1024);
      if (size > 10) {
        console.log(`SAVED: ${dest} (${size}KB) [${targetIdx + 1}/${dalleImgs.length}]`);
        return dest;
      }
    }
  } catch (e) {
    console.log('Canvas failed:', e.message);
  }

  console.error('ERROR: Download failed for image', targetIdx);
  return null;
}

async function downloadAll(page, prefix) {
  const dalleImgs = await listImages(page);
  if (!dalleImgs.length) { console.error('No images found'); return; }
  console.log(`Downloading ${dalleImgs.length} images...`);
  for (let i = 0; i < dalleImgs.length; i++) {
    await downloadImage(page, prefix, i);
  }
  console.log(`\nDone: ${dalleImgs.length} images saved to ${cfg.output_dir}`);
}

// ── T1+T6+T8+T9: Generate with rotation, recovery, verification, QA gate ──
async function generate(page, type, brief, taskId) {
  const dateStr = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });

  // ── SAFEGUARD: Brand gate — --brand is mandatory, gen must be in correct brand chat ──
  const currentUrl = page.url();
  const activeChatId = getActiveBrandChatId(); // exits if no --brand
  console.log(`[brand] Resolved: --brand ${BRAND_FLAG} → chat_id ${activeChatId}`);

  const brandCfg = cfg.brands[BRAND_FLAG];
  if (!currentUrl.includes(brandCfg.chat_id)) {
    console.error(`\n🚫 BLOCKED: Current chat is not the ${BRAND_FLAG} brand chat.`);
    console.error(`   Expected: ${brandCfg.chat_id.slice(0, 8)}...`);
    console.error(`   Current: ${currentUrl}\n`);
    process.exitCode = 4;
    return;
  }

  // ── SAFEGUARD: Warning for chats with >20 images ──
  const imgCount = await getImageCount(page);
  if (imgCount > 20 && !FORCE_FLAG) {
    console.error('\n⚠️  WARNING: Chat has ' + imgCount + ' images — this looks like an active chat.');
    console.error('   Use --force to proceed, or fork first.\n');
    process.exitCode = 4;
    return;
  }

  // ── SAFEGUARD: --dry-run ──
  if (DRY_RUN) {
    const chatId = currentUrl.match(/\/c\/([a-f0-9-]+)/)?.[1] || 'unknown';
    console.log('\n🔍 DRY RUN — would generate but not sending:');
    console.log('   Chat ID: ' + chatId);
    console.log('   Image count: ' + imgCount);
    console.log('   Type: ' + type);
    console.log('   Brief: ' + (brief || '(none)').slice(0, 80));
    console.log('   Fork ID: ' + (FORK_CHAT_ID || 'NOT SET — would be blocked'));
    return;
  }

  // T6: Pre-flight rotation check
  await rollBrandChat(page);

  // T10: raw type = TESTING ONLY warning
  if (type === 'raw') {
    console.log('\n⚠️  WARNING: "raw" type is TESTING ONLY — not for deliverables.');
    console.log('   Deliverables must use atw/mb/fund (composed through BRAND_TEMPLATE).');
    console.log('   This image will NOT pass brand-consistency gate.\n');
  }

  let prompt;
  if (type === 'raw') {
    prompt = brief;
  } else {
    const tm = TYPE_MAP[type] || { badge: type.toUpperCase(), name: type, icon: 'star', colorName: 'navy', color: '#1a1a2e' };
    // T599: select brand template by --brand (destination rule)
    const brandTpl = baseBrand(BRAND_FLAG) === 'wealthbanks' ? BRAND_TEMPLATE_WEALTHBANKS : BRAND_TEMPLATE;
    prompt = brandTpl
      .replace('{TYPE}', type)
      .replace('{BADGE_CODE}', tm.badge)
      .replace('{BADGE_NAME}', tm.name)
      .replace('{BADGE_ICON}', tm.icon)
      .replace('{BADGE_COLOR}', `${tm.colorName} ${tm.color} pill`)
      .replace('{BADGE}', `${tm.badge} (${tm.name})`)
      .replace('{DATE}', dateStr)
      .replace('{MOOD}', 'professional')
      .replace('{ACCENT_COLOR}', 'NAVY DARK BLUE #1a1a2e, key words in RED #D31145')
      .replace('{HEADLINE_TEXT}', brief)
      .replace('{HEADLINE}', brief)
      .replace('{HERO_DESCRIPTION}', brief)
      .replace('{HERO}', brief)
      .replace('{DATA_ITEMS}', '')
      .replace('{CARDS}', '')
      .replace('{COLOR_NOTES}', 'Clean white theme')
      .replace('{LIGHT_NOTES}', 'Light Prestige White theme')
      .replace('{SOURCE}', baseBrand(BRAND_FLAG) === 'wealthbanks' ? 'wealthbanks.net' : 'iAgencyAIA');
  }

  for (let attempt = 0; attempt <= cfg.max_retries; attempt++) {
    if (attempt > 0) {
      console.log(`\nRetry ${attempt}/${cfg.max_retries}...`);
    }

    const beforeCount = (await listImages(page)).length;
    console.log(`Generating ${type} poster (attempt ${attempt + 1}, baseline: ${beforeCount} images)...`);
    // chat id first: the T599 abort below logs it (it used to be declared after, so every block crashed with a TDZ
    // ReferenceError, the BLOCKED feed line was never written and exit 4 became 1 — T2406 30/9)
    const chatId = page.url().match(/\/c\/([a-f0-9-]+)/)?.[1] || 'unknown';
    // T599 SAFEGUARD: cross-brand prompt assertion — ABORT if prompt carries another brand's tokens.
    const brandCheck = assertBrandMatch(BRAND_FLAG, prompt);
    if (!brandCheck.ok) {
      console.error(`\n🚫 ABORT (T599): ${brandCheck.reason}`);
      console.error(`   --brand ${BRAND_FLAG} prompt must NOT contain cross-brand content. Fix the prompt or use the correct --brand.`);
      logToFeed(chatId, promptHash(prompt), `gen:${type}:BLOCKED-crossbrand`);
      process.exitCode = 4;
      return null;
    }
    // SAFEGUARD: log chat_id + prompt_hash before every send
    logToFeed(chatId, promptHash(prompt), `gen:${type}`);
    const sent = await sendPrompt(page, prompt);
    if (!sent) return null;

    // T9: after refresh/retry, stabilize baseline
    const stabilize = attempt > 0;
    const result = await waitForImage(page, taskId, null, { stabilize });

    if (result.ok) {
      // T9: Verify image is from THIS prompt's response
      const verification = await verifyImageGeneration(page, prompt, beforeCount);
      if (!verification.valid) {
        console.log(`\nT9 MISMATCH: ${verification.reason}`);
        if (attempt < cfg.max_retries) {
          console.log('Image belongs to previous generation — retrying...');
          heartbeat(taskId || '#13', 50, 'T9-mismatch-retry');
          continue;
        }
        console.error('T9 FAIL: downloaded image is not from this prompt');
        process.exitCode = 3;
        return null;
      }

      const afterImgs = await listImages(page);
      const newIdx = afterImgs.length - 1;
      console.log(`\nAuto-downloading image [${newIdx}] (verified: from this prompt)...`);
      const dest = await downloadImage(page, type, newIdx);

      // Auto-resize to 1080x1920 (IG Story standard)
      if (dest && type !== 'raw') {
        resizeToIG(dest);
      }

      // T8: QA gate (checks exact 1080x1920 + size)
      if (dest) {
        const qa = qaGate(dest);
        if (!qa.pass) {
          console.error(`QA FAIL: ${qa.reason}`);
          heartbeat(taskId || '#13', 90, `QA-fail: ${qa.reason}`);
        } else {
          console.log(`QA PASS: ${qa.sizeKB}KB, ${qa.dimensions || 'dims OK'}`);
        }
      }

      heartbeat(taskId || '#13', 100, 'done');
      return dest;
    }

    // T2: Refusal — reframe and retry once
    if (result.refused && attempt < cfg.max_retries) {
      console.log('Reframing prompt for retry...');
      prompt = `Please create a professional visual: ${brief}. Style: clean, modern, vertical 9:16. Brand: iAgencyAIA. Generate now.`;
      continue;
    }

    // T1: Stall — page.reload and retry
    if (result.stalled && attempt < cfg.max_retries) {
      console.log('Refreshing page for retry...');
      try {
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(3000);
      } catch (e) {
        console.error('Reload failed:', e.message);
      }
      continue;
    }

    // Timeout or final failure
    if (result.refused) {
      console.error('REFUSED after retry:', result.reason);
      process.exitCode = 2;
      return null;
    }
  }

  console.error('FAILED after all retries');
  process.exitCode = 1;
  return null;
}

async function status(page) {
  const info = await page.evaluate((sel) => {
    const imgs = document.querySelectorAll(sel);
    const title = document.title;
    const url = window.location.href;
    return { title, url, imageCount: imgs.length };
  }, POSTER_IMG_SELECTOR);
  const max = cfg.max_chat_images || 40;
  const pct = Math.round((info.imageCount / max) * 100);
  console.log(`Tab: ${info.title}`);
  console.log(`URL: ${info.url}`);
  console.log(`DALL-E images: ${info.imageCount}/${max} (${pct}%)${info.imageCount >= max ? ' ⚠️ ROTATE NEEDED' : ''}`);
}

async function newChat(page, rawBrandName) {
  const brandName = rawBrandName.toLowerCase();
  console.log(`[new-chat] Creating new ChatGPT chat for brand: ${brandName}`);

  // T2406 (แบงค์ '1 tab'): POSTER_ONE_TAB=1 reuses the connected ChatGPT tab (same-tab navigation) instead of
  // opening a second one. Default (flag unset) keeps the old new-tab path until the 3/3 acceptance switch-over.
  // T2406: one-tab is now the DEFAULT (designer verified 3/3 + Dalio live run, bob GO 1 Oct).
  // Set POSTER_ONE_TAB=0 to revert to the old new-tab path.
  const oneTab = process.env.POSTER_ONE_TAB !== '0';
  let newPage;
  if (oneTab) {
    newPage = page;
    console.log('[new-chat] POSTER_ONE_TAB=1: reusing the existing ChatGPT tab (no new tab)');
  } else {
    // Open a NEW tab — bypass connect() which reuses existing ChatGPT tab
    newPage = await page.browser().newPage();
    _createdPages.push(newPage);
  }
  const dropPage = async () => { if (!oneTab) await newPage.close(); };   // never close the one shared tab

  // Navigate to chatgpt.com home (fresh chat state)
  await newPage.goto('https://chatgpt.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Verify we're on a clean home page, not redirected to an existing chat
  let url = newPage.url();
  const existingChatIds = Object.values(cfg.brands || {}).map(b => b.chat_id).filter(Boolean);

  if (existingChatIds.some(id => url.includes(id))) {
    console.log('[new-chat] Redirected to existing chat — forcing new via sidebar button...');
    try {
      await newPage.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const newBtn = links.find(a => a.href && a.href.endsWith('/') && a.textContent?.includes('New'));
        if (newBtn) { newBtn.click(); return; }
        const btn = document.querySelector('[data-testid="create-new-chat-button"]');
        if (btn) { btn.click(); return; }
        window.location.href = 'https://chatgpt.com/';
      });
      await sleep(3000);
    } catch {}
  }

  // Send seed message to create the chat
  const seed = `You are a brand poster designer for ${brandName}. Respond only: "Ready for ${brandName} posters."`;
  console.log('[new-chat] Sending seed message...');

  // T2397: shared visible-composer send; the chat URL changing to /c/<id> counts as the new turn here.
  if (!(await sendAndConfirm(newPage, seed, { label: 'new-chat', timeoutMs: 45000 }))) {
    console.error('[new-chat] FAILED: seed did not land (see line above)');
    await dropPage();
    process.exitCode = 1;
    return;
  }

  // Wait for URL to change to /c/<id>
  console.log('[new-chat] Waiting for chat ID in URL...');
  let chatId = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    url = newPage.url();
    const match = url.match(/\/c\/([a-f0-9-]+)/);
    if (match && !existingChatIds.includes(match[1])) {
      chatId = match[1];
      break;
    }
  }

  if (!chatId) {
    // Last resort: check if URL has a chat ID even if it matches existing (could be coincidence)
    const match = newPage.url().match(/\/c\/([a-f0-9-]+)/);
    if (match && !existingChatIds.includes(match[1])) chatId = match[1];
  }

  if (!chatId) {
    console.error('[new-chat] FAILED: Could not capture NEW chat ID from URL after 45s');
    console.error('[new-chat] Current URL:', newPage.url());
    console.error('[new-chat] Existing chat IDs:', existingChatIds.map(id => id.slice(0, 8)).join(', '));
    await dropPage();
    process.exitCode = 1;
    return;
  }

  console.log(`[new-chat] NEW Chat ID captured: ${chatId}`);

  // T2197 (bob): never write an unsaved id into poster.config. Confirm the server has the chat
  // with a finished assistant reply to the seed before saving; otherwise fail and keep the old id.
  let persisted = null;
  for (let i = 0; i < 30 && !(persisted && persisted.ok); i++) {
    await sleep(1000);
    persisted = await newPage.evaluate(async (id) => {
      try {
        const s = await (await fetch('/api/auth/session')).json();
        const r = await fetch('/backend-api/conversation/' + id, { headers: { Authorization: 'Bearer ' + s.accessToken } });
        if (!r.ok) return { ok: false, status: r.status };
        const j = await r.json();
        const done = Object.values(j.mapping || {}).some(n => n.message && n.message.author.role === 'assistant' && n.message.status === 'finished_successfully');
        return { ok: done, status: r.status, temporary: !!j.is_temporary_chat };
      } catch (e) { return { ok: false, status: 'error: ' + e.message }; }
    }, chatId);
  }
  if (!persisted || !persisted.ok || persisted.temporary) {
    console.error(`[new-chat] FAILED: chat ${chatId} not confirmed saved on the server (${JSON.stringify(persisted)}) — poster.config.json NOT changed`);
    process.exitCode = 1;
    return;
  }
  console.log(`[new-chat] server confirms chat saved (HTTP ${persisted.status}, seed reply finished)`);

  // Save to config
  if (!cfg.brands) cfg.brands = {};
  cfg.brands[brandName] = { chat_id: chatId, created: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  console.log(`[new-chat] Saved to poster.config.json: brands.${brandName}.chat_id = ${chatId}`);
  console.log(`\n✅ Brand "${brandName}" ready. Use: node poster.js generate <type> <brief> --brand ${brandName}`);

  // The tab is closed by cleanupCreatedPages() on exit; connect() opens the chat by id next run (T2197).
  console.log(`[new-chat] Chat saved server-side at: ${newPage.url()} (${oneTab ? 'same tab, stays open' : 'this tab closes on exit'})`);
}

function stripFlags(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--brand' || argv[i] === '--force' || argv[i] === '--dry-run') {
      if (argv[i] === '--brand') i++; // skip the value too
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

async function main() {
  const [,, cmd, ...args] = stripFlags(process.argv);

  if (!cmd || cmd === 'help') {
    console.log(`Poster CLI v3.2 — ChatGPT DALL-E poster generation via CDP

Commands:
  resolve --brand <name>   Show resolved chat_id for brand (acceptance test)
  status              Check ChatGPT tab status + image count
  generate <type> <brief>  Generate poster (--brand required)
  new-chat --brand <name>  Create new ChatGPT chat for brand + save chat_id
  prompt <text>       Send raw prompt to ChatGPT (--brand required)
  wait [taskId]       Wait for current generation (with heartbeat)
  download [prefix] [index]  Download image by index (default: latest)
  download-all [prefix]      Download ALL images in conversation
  images              List all DALL-E images with index numbers
  roll-brand          Force rotate to fresh brand chat
  attach <img>... [msg]  Upload image(s) into the composer; with msg = send together (read-back checks the turn)
  reply [--wait]      Print the last ChatGPT reply TEXT (no images); --wait = until it stops writing
  log <out.md>        Save the whole conversation (user/assistant text + image ids) to a file

Types: atw · mb (MARKET) · holdings · insights · breaking · viral · motivation · aia · education · promo (navy) · fund (= holdings) · raw (custom prompt)

Flags:
  --brand <name>      Target specific brand (multi-brand config)
  --dry-run           Show chat ID + image count without sending
  --force             Override >20 image warning (hard-block cannot be overridden)

Safeguards:
  🚫 HARD BLOCK: --brand is REQUIRED for generate/prompt — no silent fallback
  ⚠️  WARNING: gen warns if chat has >20 images (requires --force)
  📝 LOGGING: every gen logs chat_id + prompt_hash to feed.log

Pipeline: T6 rotate (≥${cfg.max_chat_images} imgs) → generate → T9 verify (DOM adjacency)
          → download (3 fallbacks) → T8 QA gate (size check) → done
Recovery: T1 stall (${cfg.stall_threshold_polls} flat → reload, stable baseline) | T2 refusal → reframe
Exit codes: 0=ok, 2=refused, 3=T9 wrong-image, 4=blocked/warning
Config: ${CONFIG_PATH}

Examples:
  node poster.js generate atw "China sanctions + Thai FDI +73%"
  node poster.js generate atw "brief" --dry-run
  node poster.js status`);
    return;
  }

  // resolve command does not need a browser
  if (cmd === 'resolve') {
    if (!BRAND_FLAG) {
      console.error('🚫 ERROR: --brand is required.');
      console.error('   Available brands: ' + Object.keys(cfg.brands || {}).join(', '));
      process.exitCode = 1;
      return;
    }
    const resolved = resolveBrand(BRAND_FLAG);
    if (!resolved) {
      console.error(`🚫 Brand "${BRAND_FLAG}" not found.`);
      console.error('   Available brands: ' + Object.keys(cfg.brands || {}).join(', '));
      process.exitCode = 1;
      return;
    }
    console.log(`brand: ${resolved.slug}`);
    console.log(`chat_id: ${resolved.chat_id}`);
    return;
  }

  // T1097 step-0: verify ChatGPT session is alive before connecting
  const ensureScript = path.join(process.env.HOME || '/home/curfew',
    'repos/github.com/BankCurfew/Admin-Oracle/scripts/chatgpt-session-ensure.sh');
  if (fs.existsSync(ensureScript)) {
    try {
      execSync(`bash "${ensureScript}"`, { stdio: 'inherit', timeout: 30000 });
    } catch (e) {
      const code = e.status || 1;
      console.error(`🚫 T1097 SESSION GATE FAILED (exit ${code}): ChatGPT session not healthy.`);
      console.error('   Fix: re-login to ChatGPT in แบงค์\'s Chrome, then retry.');
      process.exitCode = code;
      return;
    }
  }

  // T2406: new-chat creates the brand, so it cannot resolve the brand's chat first (connect() exits for an unknown brand).
  // It attaches to the one existing ChatGPT tab instead; newChat() navigates that tab to a fresh chat.
  const { browser, page } = cmd === 'new-chat' ? await connectAnyChatgptTab() : await connect();

  try {
    switch (cmd) {
      case 'status': case 'st':
        await status(page);
        break;
      case 'generate': case 'gen':
        await generate(page, args[0] || 'raw', args.slice(1).join(' '), args[0]);
        break;
      case 'prompt': case 'send': {
        // T599: cross-brand assertion on raw prompts too — ABORT, never send.
        const raw = args.join(' ');
        const bc = assertBrandMatch(BRAND_FLAG, raw);
        if (!bc.ok) {
          console.error(`\n🚫 ABORT (T599): ${bc.reason}`);
          console.error(`   --brand ${BRAND_FLAG} prompt must NOT contain cross-brand content.`);
          process.exitCode = 4;
          break;
        }
        await sendPrompt(page, raw);
        break;
      }
      case 'wait': {
        // T1781: waitForImage() itself only reaches 95% (image-detected) — the 100%
        // done HB otherwise only fires inside generate()'s post-verify/QA pipeline
        // (line ~947), which this standalone wait path never runs. Without this,
        // every prompt+wait custom-prompt gen orphans HB stream #13 at 95% by
        // construction, and hb-checker eventually pages it as false STUCK. Fire the
        // same 100% done stamp generate() uses on success; failure paths already
        // emit their own loud HB from inside waitForImage() (refused/stalled/timeout).
        const waitResult = await waitForImage(page, args[0] || '#13');
        if (waitResult.ok) {
          heartbeat(args[0] || '#13', 100, 'done');
        }
        break;
      }
      case 'download': case 'dl':
        await downloadImage(page, args[0], args[1]);
        break;
      case 'download-all': case 'dl-all':
        await downloadAll(page, args[0]);
        break;
      case 'images': case 'imgs': {
        const dalleImgs = await listImages(page);
        console.log(`${dalleImgs.length} DALL-E images:`);
        dalleImgs.forEach((img, i) => console.log(`  [${i}] ${img.w}x${img.h} ${img.alt || img.src}`));
        break;
      }
      case 'attach':
        await attachCmd(page, [...args]);
        break;
      case 'reply':
        await replyCmd(page, process.argv.slice(3));
        break;
      case 'log':
        await logCmd(page, args[0]);
        break;
      case 'roll-brand': case 'rotate':
        await rollBrandChat(page);
        break;
      case 'new-chat': {
        const brandName = BRAND_FLAG || args[0];
        if (!brandName) {
          console.error('Usage: poster.js new-chat --brand <name>');
          process.exitCode = 1;
          break;
        }
        await newChat(page, brandName);
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}. Run with 'help'.`);
    }
  } finally {
    await cleanupCreatedPages();
    browser.disconnect();
  }
}

// Signal handler: close created tabs even on kill
process.on('SIGINT', async () => { await cleanupCreatedPages(); process.exit(130); });
process.on('SIGTERM', async () => { await cleanupCreatedPages(); process.exit(143); });

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
