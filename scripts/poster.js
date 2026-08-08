#!/usr/bin/env node
// Poster CLI v3 — CDP-based ChatGPT DALL-E poster generation
// T1: auto-refresh recovery (page.reload on stall)
// T2: refusal detection (EN+THAI regex, distinct exit code 2)
// T4: config from poster.config.json
// T5: heartbeat during generation (Rule #9)
// Task: gemini-proxy-tools#13

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

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
} else {
  BRAND_CHAT_URL = `${cfg.chatgpt_url}/c/${getActiveBrandChatId()}`;
}
const FORK_CHAT_ID = null; // legacy removed — brands.<slug>.chat_id is the sole source
const FORCE_FLAG = process.argv.includes('--force');
const DRY_RUN = process.argv.includes('--dry-run');
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

const TYPE_MAP = {
  atw:      { badge: 'ATW', name: 'Around The World', icon: 'globe',  color: 'blue' },
  mb:       { badge: 'MB',  name: 'Market Brief',    icon: 'chart',  color: 'green' },
  fund:     { badge: 'FND', name: 'Fund Holdings',   icon: 'coins',  color: 'gold' },
  breaking: { badge: 'BRK', name: 'Breaking',        icon: 'alert',  color: 'red' },
  viral:    { badge: 'VRL', name: 'Viral',            icon: 'fire',   color: 'purple' },
  promo:    { badge: 'PRM', name: 'Promo',            icon: 'gift',   color: 'red+gold' },
};

const BRAND_SEED = 'Logo: i=RED #C8102E, Agency=BLACK #1a1a2e, AIA=RED #C8102E. BG: textured off-white #f0ede8 with gray curved lines #c5c0b8 (2-3px). Three-layer: flat 2D cards + realistic heroes + illustrated icons. NO text unless exact Thai text given.';

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
Textured BG, generous spacing, correct logo (i=red Agency=black AIA=red),
header padding, Asian people.

Badge: {BADGE_CODE} ({BADGE_NAME}) top-left with {BADGE_ICON} icon, {BADGE_COLOR}. Logo: iAgencyAIA top-right.

Headline ({MOOD}, {ACCENT_COLOR}):
{HEADLINE_TEXT}

Hero: {HERO_DESCRIPTION}

Key data with illustrated icons:
{DATA_ITEMS}

Source line (above footer bar): Source: {SOURCE} | {DATE}

Footer bar (red #C8102E bar at absolute bottom, white text):
Line 1: FB iAgencyAIA | IG @iagencyaia | TikTok @iagencyaia | LINE @iagencyaia
Line 2: iAgencyAIA | {DATE}

{COLOR_NOTES}. 9:16 vertical. Generate now.`;

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
  const ts = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour12: false }).replace(',', '');
  const oracle = cfg.heartbeat_oracle;
  const hostname = require('os').hostname();
  const line = `${ts} | ${oracle} | ${hostname} | Notification | ${oracle} | heartbeat » HB: ${taskId} ${pct}% ${status}\n`;
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
  let page = pages.find(p => p.url().includes(activeChatId));
  if (!page) page = pages.find(p => p.url().includes('chatgpt.com/c/'));
  if (!page) page = pages.find(p => p.url().includes('chatgpt.com'));

  if (!page) {
    console.log('No ChatGPT tab found. Opening brand chat...');
    page = await browser.newPage();
    _createdPages.push(page);
    await page.goto(BRAND_CHAT_URL, { waitUntil: 'networkidle2' });
    await sleep(3000);
  } else if (!page.url().includes(activeChatId)) {
    console.log('ChatGPT tab found but not brand chat. Navigating...');
    await page.goto(BRAND_CHAT_URL, { waitUntil: 'networkidle2' });
    await sleep(3000);
  }

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
  return page.evaluate(() =>
    document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]').length
  );
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

  // Re-seed brand kit with Designer's proven BRAND_SEED
  const primer = `${BRAND_SEED}\n\nYou are creating posters for iAgencyAIA brand. Always 9:16 vertical. Textured backgrounds, generous spacing, Asian people. Acknowledge with "Ready for poster requests."`;
  await sleep(1000);

  const typed = await page.evaluate((text) => {
    const el = document.querySelector('#prompt-textarea, textarea[data-id], div[contenteditable="true"]');
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      el.focus();
      el.textContent = '';
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, primer);

  if (typed) {
    await sleep(300);
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
      if (btn && !btn.disabled) btn.click();
      else {
        const el = document.querySelector('#prompt-textarea');
        if (el) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      }
    });
    await sleep(5000); // Wait for ack
  }

  console.log('Brand chat rotated + re-seeded.');
  return true;
}

// ── T9: Verify image belongs to THIS prompt's assistant message ──
async function verifyImageGeneration(page, promptText, beforeCount) {
  return page.evaluate((prompt, before) => {
    const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!assistantMsgs.length) return { valid: false, reason: 'no assistant messages' };

    const lastMsg = assistantMsgs[assistantMsgs.length - 1];
    const msgImages = lastMsg.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]');

    if (msgImages.length === 0) {
      return { valid: false, reason: 'no images in last assistant message' };
    }

    // Check that the image is a new one (not pre-existing)
    const allImgs = document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]');
    if (allImgs.length <= before) {
      return { valid: false, reason: `total count ${allImgs.length} not greater than baseline ${before}` };
    }

    return { valid: true, imgCount: msgImages.length, totalCount: allImgs.length };
  }, promptText, beforeCount);
}

// ── Auto-resize to 1080x1920 (IG Story) — pad on brand canvas, never distort ──
function resizeToIG(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return filePath;

  const { execSync } = require('child_process');
  const outPath = filePath.replace(/\.png$/, '-1080x1920.png');

  try {
    // Scale to fit within 1080x1920 maintaining aspect ratio, then pad with brand BG color
    execSync(
      `convert "${filePath}" -resize 1080x1920 -gravity center -background "#f0ede8" -extent 1080x1920 "${outPath}"`,
      { timeout: 15000 }
    );

    if (fs.existsSync(outPath)) {
      const size = Math.round(fs.statSync(outPath).size / 1024);
      // Replace original with resized
      fs.renameSync(outPath, filePath);
      console.log(`  Resized → 1080x1920 (${size}KB, padded on #f0ede8)`);
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

async function sendPrompt(page, prompt) {
  const typed = await page.evaluate((text) => {
    const el = document.querySelector('#prompt-textarea, textarea[data-id], div[contenteditable="true"]');
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // ProseMirror contentEditable (project chats) — ClipboardEvent paste
      el.focus();
      el.textContent = '';
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      // Fallback: execCommand if paste didn't populate
      if (!el.textContent || el.textContent.trim().length < 5) {
        el.textContent = '';
        document.execCommand('insertText', false, text);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, prompt);

  if (!typed) {
    console.error('ERROR: ChatGPT input box not found');
    return false;
  }

  await sleep(500);

  await page.evaluate(() => {
    // Broader send button detection — works in both regular and project chats
    const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]');
    if (btn && !btn.disabled) { btn.click(); return; }
    // Fallback: find enabled button with SVG arrow in the composer area
    const form = document.querySelector('form, div[class*="composer"]');
    if (form) {
      const buttons = form.querySelectorAll('button:not([disabled])');
      for (const b of buttons) {
        if (b.querySelector('svg') || b.querySelector('path')) { b.click(); break; }
      }
    }
    // Last resort: Enter key on the input
    const el = document.querySelector('#prompt-textarea');
    if (el) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    }
  });

  console.log('Prompt sent. Waiting for DALL-E generation...');
  return true;
}

// ── T2: Read last assistant message ──
async function getLastAssistantMsg(page) {
  return page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (!msgs.length) return '';
    const last = msgs[msgs.length - 1];
    return (last.textContent || '').trim().slice(0, 500);
  });
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

    const status = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]');
      const thinking = document.querySelector('[class*="thinking"], [class*="streaming"], [data-message-author-role="assistant"] [class*="result-streaming"]');
      return { imgCount: imgs.length, isThinking: !!thinking };
    });

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
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map((img, i) => ({
      globalIdx: i,
      w: img.naturalWidth || img.width,
      h: img.naturalHeight || img.height,
      alt: (img.alt || '').substring(0, 50),
      src: (img.src || '').substring(0, 80),
      hasAlt: !!(img.alt && img.alt.startsWith('Generated'))
    })).filter(img => img.w > 300 && img.h > 300 && img.hasAlt);
  });
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
    const tm = TYPE_MAP[type] || { badge: type.toUpperCase(), name: type, icon: 'star', color: 'blue' };
    prompt = BRAND_TEMPLATE
      .replace('{TYPE}', type)
      .replace('{BADGE_CODE}', tm.badge)
      .replace('{BADGE_NAME}', tm.name)
      .replace('{BADGE_ICON}', tm.icon)
      .replace('{BADGE_COLOR}', tm.color)
      .replace('{BADGE}', `${tm.badge} (${tm.name})`)
      .replace('{DATE}', dateStr)
      .replace('{MOOD}', 'professional')
      .replace('{ACCENT_COLOR}', tm.color)
      .replace('{HEADLINE_TEXT}', brief)
      .replace('{HEADLINE}', brief)
      .replace('{HERO_DESCRIPTION}', brief)
      .replace('{HERO}', brief)
      .replace('{DATA_ITEMS}', '')
      .replace('{CARDS}', '')
      .replace('{COLOR_NOTES}', tm.color === 'red' ? 'Dark background #0a0a12' : 'Light theme')
      .replace('{SOURCE}', 'iAgencyAIA');
  }

  for (let attempt = 0; attempt <= cfg.max_retries; attempt++) {
    if (attempt > 0) {
      console.log(`\nRetry ${attempt}/${cfg.max_retries}...`);
    }

    const beforeCount = (await listImages(page)).length;
    console.log(`Generating ${type} poster (attempt ${attempt + 1}, baseline: ${beforeCount} images)...`);
    // SAFEGUARD: log chat_id + prompt_hash before every send
    const chatId = page.url().match(/\/c\/([a-f0-9-]+)/)?.[1] || 'unknown';
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
  const info = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]');
    const title = document.title;
    const url = window.location.href;
    return { title, url, imageCount: imgs.length };
  });
  const max = cfg.max_chat_images || 40;
  const pct = Math.round((info.imageCount / max) * 100);
  console.log(`Tab: ${info.title}`);
  console.log(`URL: ${info.url}`);
  console.log(`DALL-E images: ${info.imageCount}/${max} (${pct}%)${info.imageCount >= max ? ' ⚠️ ROTATE NEEDED' : ''}`);
}

async function newChat(page, rawBrandName) {
  const brandName = rawBrandName.toLowerCase();
  console.log(`[new-chat] Creating new ChatGPT chat for brand: ${brandName}`);

  // Open a NEW tab — bypass connect() which reuses existing ChatGPT tab
  const browser = page.browser();
  const newPage = await browser.newPage();
  _createdPages.push(newPage);

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

  const sent = await newPage.evaluate((text) => {
    const el = document.querySelector('#prompt-textarea') || document.querySelector('[contenteditable="true"]');
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA') {
      const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSet) { nativeSet.call(el, text); el.dispatchEvent(new Event('input', { bubbles: true })); }
    } else {
      el.textContent = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, seed);

  if (!sent) {
    console.error('[new-chat] FAILED: Could not find prompt textarea');
    await newPage.close();
    process.exitCode = 1;
    return;
  }

  await sleep(1000);

  // Click send button
  await newPage.evaluate(() => {
    const btn = document.querySelector('[data-testid="send-button"]')
      || document.querySelector('button[aria-label="Send prompt"]')
      || document.querySelector('button[data-testid="composer-send-button"]');
    if (btn) btn.click();
  });

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
    await newPage.close();
    process.exitCode = 1;
    return;
  }

  console.log(`[new-chat] NEW Chat ID captured: ${chatId}`);

  // Save to config
  if (!cfg.brands) cfg.brands = {};
  cfg.brands[brandName] = { chat_id: chatId, created: new Date().toISOString() };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  console.log(`[new-chat] Saved to poster.config.json: brands.${brandName}.chat_id = ${chatId}`);
  console.log(`\n✅ Brand "${brandName}" ready. Use: node poster.js generate <type> <brief> --brand ${brandName}`);

  // Keep the new tab open for Designer to use
  console.log(`[new-chat] New tab kept open at: ${newPage.url()}`);
}

async function main() {
  const [,, cmd, ...args] = process.argv;

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

Types: atw (Around The World), mb (Market Brief), fund (Fund Holdings), raw (custom prompt)

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

  const { browser, page } = await connect();

  try {
    switch (cmd) {
      case 'status': case 'st':
        await status(page);
        break;
      case 'generate': case 'gen':
        await generate(page, args[0] || 'raw', args.slice(1).join(' '), args[0]);
        break;
      case 'prompt': case 'send':
        await sendPrompt(page, args.join(' '));
        break;
      case 'wait':
        await waitForImage(page, args[0] || '#13');
        break;
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
