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

function loadBrandRules() {
  try {
    const ci = fs.readFileSync(BRAND_CI_PATH, 'utf-8');
    // Extract key rules from brand CI
    const logoMatch = ci.match(/\| \*\*i\*\* \| .* \| `(#[A-F0-9]+)`/);
    const logoRed = logoMatch ? logoMatch[1] : '#C8102E';
    const placementMatch = ci.match(/Default \| ([^|]+) \|/);
    const placement = placementMatch ? placementMatch[1].trim() : 'Top-right, 80px from top';
    const fontMatch = ci.match(/\*\*Thai\*\* \| \*\*([^*]+)\*\*/);
    const thaiFont = fontMatch ? fontMatch[1] : 'LINESeedSansTH';
    return { logoRed, placement, thaiFont, loaded: true };
  } catch {
    return { logoRed: '#C8102E', placement: 'top-right', thaiFont: 'LINESeedSansTH', loaded: false };
  }
}

const BRAND = loadBrandRules();
if (BRAND.loaded) {
  console.log(`[T7] Brand CI loaded: logo ${BRAND.logoRed}, font ${BRAND.thaiFont}`);
}

const BRAND_TEMPLATE = `Generate an image: {TYPE} poster, 9:16 vertical.
Textured BG, generous spacing, correct logo (i=${BRAND.logoRed} red, Agency=black, AIA=${BRAND.logoRed} red).
Logo placement: ${BRAND.placement}. Thai font style: ${BRAND.thaiFont} (clean, modern).
Header padding, Asian people.

Badge: {BADGE} top-left. Logo: iAgencyAIA ${BRAND.placement}.

Headline (bold, {MOOD}):
{HEADLINE}

Hero: {HERO}

Data cards (flat 2D, illustrated colorful icons):
{CARDS}

Footer: FB IG TikTok LINE iAgencyAIA. {SOURCE} | {DATE}.

Light theme. 9:16 vertical. Generate now.`;

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
  const count = await getImageCount(page);
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

  // Re-seed brand kit with a short primer
  const primer = `You are creating posters for iAgencyAIA brand. Logo: "i" (red) "Agency" (black) "AIA" (red). Always 9:16 vertical. Textured backgrounds, generous spacing, Asian people. Acknowledge with "Ready for poster requests."`;
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

// ── T8: QA gate — verify dimensions + file size ──
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

  // Note: dimension check requires reading PNG header — simplified check via file size
  // A 768x1024 PNG at reasonable quality is typically >100KB
  console.log(`QA PASS: ${sizeKB}KB`);
  return { pass: true, sizeKB };
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

  let prompt;
  if (type === 'raw') {
    prompt = brief;
  } else {
    prompt = BRAND_TEMPLATE
      .replace('{TYPE}', type)
      .replace('{BADGE}', type.toUpperCase())
      .replace('{DATE}', dateStr)
      .replace('{MOOD}', 'professional')
      .replace('{HEADLINE}', brief)
      .replace('{HERO}', brief)
      .replace('{CARDS}', '')
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

      // T8: QA gate
      if (dest) {
        const qa = qaGate(dest);
        if (!qa.pass) {
          console.error(`QA FAIL: ${qa.reason}`);
          heartbeat(taskId || '#13', 90, `QA-fail: ${qa.reason}`);
          // Don't delete — let caller inspect, but warn
        } else {
          console.log(`QA PASS: ${qa.sizeKB}KB`);
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

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
