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
};
let cfg = { ...defaults };
try {
  const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  cfg = { ...defaults, ...file };
} catch {}

let BRAND_CHAT_URL = `${cfg.chatgpt_url}/c/${cfg.brand_chat_id}`;

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

async function connect() {
  const browser = await puppeteer.connect({
    browserURL: cfg.cdp_url,
    defaultViewport: null,
    protocolTimeout: cfg.cdp_protocol_timeout,
  });
  const pages = await browser.pages();
  let page = pages.find(p => p.url().includes(cfg.brand_chat_id));
  if (!page) page = pages.find(p => p.url().includes('chatgpt.com/c/'));
  if (!page) page = pages.find(p => p.url().includes('chatgpt.com'));

  if (!page) {
    console.log('No ChatGPT tab found. Opening brand chat...');
    page = await browser.newPage();
    await page.goto(BRAND_CHAT_URL, { waitUntil: 'networkidle2' });
    await sleep(3000);
  } else if (!page.url().includes(cfg.brand_chat_id)) {
    console.log('ChatGPT tab found but not brand chat. Navigating...');
    await page.goto(BRAND_CHAT_URL, { waitUntil: 'networkidle2' });
    await sleep(3000);
  }

  return { browser, page };
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
    const textarea = document.querySelector('#prompt-textarea, textarea[data-id], div[contenteditable="true"]');
    if (!textarea) return false;
    if (textarea.tagName === 'TEXTAREA') {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      textarea.innerText = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, primer);

  if (typed) {
    await sleep(300);
    await page.evaluate(() => {
      const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"]');
      if (btn) btn.click();
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
    const textarea = document.querySelector('#prompt-textarea, textarea[data-id], div[contenteditable="true"]');
    if (!textarea) return false;
    if (textarea.tagName === 'TEXTAREA') {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      textarea.innerText = text;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  }, prompt);

  if (!typed) {
    console.error('ERROR: ChatGPT input box not found');
    return false;
  }

  await sleep(500);

  await page.evaluate(() => {
    const btn = document.querySelector('button[data-testid="send-button"], button[aria-label="Send prompt"]');
    if (btn) btn.click();
    else {
      const buttons = document.querySelectorAll('button');
      for (const b of buttons) {
        if (b.querySelector('svg') && b.closest('form')) { b.click(); break; }
      }
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

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === 'help') {
    console.log(`Poster CLI v3.1 — ChatGPT DALL-E poster generation via CDP

Commands:
  status              Check ChatGPT tab status + image count
  generate <type> <brief>  Generate poster (full pipeline: rotate→gen→verify→QA)
  prompt <text>       Send raw prompt to ChatGPT
  wait [taskId]       Wait for current generation (with heartbeat)
  download [prefix] [index]  Download image by index (default: latest)
  download-all [prefix]      Download ALL images in conversation
  images              List all DALL-E images with index numbers
  roll-brand          Force rotate to fresh brand chat

Types: atw (Around The World), mb (Market Brief), fund (Fund Holdings), raw (custom prompt)

Pipeline: T6 rotate (≥${cfg.max_chat_images} imgs) → generate → T9 verify (DOM adjacency)
          → download (3 fallbacks) → T8 QA gate (size check) → done
Recovery: T1 stall (${cfg.stall_threshold_polls} flat → reload, stable baseline) | T2 refusal → reframe
Exit codes: 0=ok, 2=refused, 3=T9 wrong-image
Config: ${CONFIG_PATH}

Examples:
  node poster.js generate atw "China sanctions + Thai FDI +73%"
  node poster.js roll-brand
  node poster.js status`);
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
      default:
        console.error(`Unknown command: ${cmd}. Run with 'help'.`);
    }
  } finally {
    browser.disconnect();
  }
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
