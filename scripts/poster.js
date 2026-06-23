#!/usr/bin/env node
// Poster CLI — CDP-based ChatGPT DALL-E poster generation
// No browser extension needed — direct Chrome automation
// Usage: node poster.js <command> [args...]

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHATGPT_URL = 'https://chatgpt.com';
const BRAND_CHAT_ID = '6a2e2fee-f228-83ec-a55a-e85f221d620f';
const BRAND_CHAT_URL = `https://chatgpt.com/c/${BRAND_CHAT_ID}`;
const OUTPUT_DIR = '/mnt/c/Users/mbank/OneDrive/AIA/Posters';
const DOWNLOADS_DIR = '/mnt/c/Users/mbank/Downloads';

const BRAND_TEMPLATE = `Generate an image: {TYPE} poster, 9:16 vertical.
Textured BG, generous spacing, correct logo (i=red Agency=black AIA=red),
header padding, Asian people.

Badge: {BADGE} top-left. Logo: iAgencyAIA top-right.

Headline (bold, {MOOD}):
{HEADLINE}

Hero: {HERO}

Data cards (flat 2D, illustrated colorful icons):
{CARDS}

Footer: FB IG TikTok LINE iAgencyAIA. {SOURCE} | {DATE}.

Light theme. 9:16 vertical. Generate now.`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function connect() {
  const browser = await puppeteer.connect({ browserURL: 'http://localhost:9222', defaultViewport: null, protocolTimeout: 120000 });
  const pages = await browser.pages();
  // Find brand chat tab, or any ChatGPT tab, or open brand chat
  let page = pages.find(p => p.url().includes(BRAND_CHAT_ID));
  if (!page) page = pages.find(p => p.url().includes('chatgpt.com/c/'));
  if (!page) page = pages.find(p => p.url().includes('chatgpt.com'));

  if (!page) {
    console.log('No ChatGPT tab found. Opening brand chat...');
    page = await browser.newPage();
    await page.goto(BRAND_CHAT_URL, { waitUntil: 'networkidle2' });
    await sleep(3000);
  } else if (!page.url().includes(BRAND_CHAT_ID)) {
    console.log('ChatGPT tab found but not brand chat. Navigating...');
    await page.goto(BRAND_CHAT_URL, { waitUntil: 'networkidle2' });
    await sleep(3000);
  }

  return { browser, page };
}

async function sendPrompt(page, prompt) {
  // Find ChatGPT input box and type
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

  // Click send button
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

async function waitForImage(page, timeoutMs = 180000) {
  const startTime = Date.now();
  let lastCount = await page.evaluate(() => document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]').length);

  while (Date.now() - startTime < timeoutMs) {
    await sleep(5000);
    const elapsed = Math.round((Date.now() - startTime) / 1000);

    const status = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]');
      const thinking = document.querySelector('[class*="thinking"], [class*="streaming"], [data-message-author-role="assistant"] [class*="result-streaming"]');
      return { imgCount: imgs.length, isThinking: !!thinking };
    });

    if (status.imgCount > lastCount) {
      console.log(`Image generated! (${elapsed}s)`);
      return true;
    }

    if (status.isThinking) {
      process.stdout.write(`\r  Generating... ${elapsed}s`);
    } else if (elapsed > 10) {
      process.stdout.write(`\r  Waiting... ${elapsed}s (${status.imgCount} images)`);
    }
  }

  console.log('\nTIMEOUT: No new image after', Math.round(timeoutMs / 1000), 's');
  return false;
}

async function listImages(page) {
  const imgs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img')).map((img, i) => ({
      globalIdx: i,
      w: img.naturalWidth || img.width,
      h: img.naturalHeight || img.height,
      alt: (img.alt || '').substring(0, 50),
      src: (img.src || '').substring(0, 80),
      hasAlt: !!(img.alt && img.alt.startsWith('Generated'))
    })).filter(img => img.w > 300 && img.h > 300 && img.hasAlt);
  });
  return imgs;
}

async function downloadImage(page, prefix, indexArg) {
  const dateStr = new Date().toISOString().slice(0, 10);

  // List all DALL-E images
  const dalleImgs = await listImages(page);
  if (!dalleImgs.length) {
    console.error('ERROR: No large images found');
    return null;
  }

  // If no index specified, show list and download latest
  const targetIdx = indexArg !== undefined ? parseInt(indexArg) : dalleImgs.length - 1;

  if (targetIdx < 0 || targetIdx >= dalleImgs.length) {
    console.error(`ERROR: index ${targetIdx} out of range (0-${dalleImgs.length - 1})`);
    dalleImgs.forEach((img, i) => console.log(`  [${i}] ${img.w}x${img.h} ${img.alt || img.src}`));
    return null;
  }

  const target = dalleImgs[targetIdx];
  const suffix = dalleImgs.length > 1 ? `-${targetIdx + 1}of${dalleImgs.length}` : '';
  const dest = path.join(OUTPUT_DIR, `${prefix || 'poster'}-${dateStr}${suffix}.png`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  console.log(`Downloading image [${targetIdx}] ${target.w}x${target.h}...`);

  const globalIdx = target.globalIdx;

  // Method 1: Scroll to image + screenshot element (most reliable for cross-origin)
  try {
    const allImgs = await page.$$('img');
    if (allImgs[globalIdx]) {
      await allImgs[globalIdx].scrollIntoView();
      await sleep(500);
      await allImgs[globalIdx].screenshot({ path: dest });
      const size = Math.round(fs.statSync(dest).size / 1024);
      console.log(`SAVED: ${dest} (${size}KB) [${targetIdx + 1}/${dalleImgs.length}]`);
      return dest;
    }
  } catch (e) {
    console.log('Screenshot failed:', e.message);
  }

  // Method 2: Canvas fallback (may fail on cross-origin)
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
      console.log(`SAVED: ${dest} (${Math.round(fs.statSync(dest).size / 1024)}KB) [${targetIdx + 1}/${dalleImgs.length}]`);
      return dest;
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
  console.log(`\nDone: ${dalleImgs.length} images saved to ${OUTPUT_DIR}`);
}

async function generate(page, type, brief) {
  const dateStr = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });

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

  // Count images before generation
  const beforeCount = (await listImages(page)).length;

  console.log(`Generating ${type} poster...`);
  const sent = await sendPrompt(page, prompt);
  if (!sent) return null;

  const found = await waitForImage(page);
  if (found) {
    // Auto-download the new image
    const afterImgs = await listImages(page);
    const newIdx = afterImgs.length - 1;
    console.log(`\nAuto-downloading image [${newIdx}]...`);
    const dest = await downloadImage(page, type, newIdx);
    return dest;
  }
  return null;
}

async function status(page) {
  const info = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img[alt*="Generated"], img[src*="blob:"], img[src*="oaidalleapi"]');
    const title = document.title;
    const url = window.location.href;
    return { title, url, imageCount: imgs.length };
  });
  console.log(`Tab: ${info.title}`);
  console.log(`URL: ${info.url}`);
  console.log(`DALL-E images: ${info.imageCount}`);
}

async function main() {
  const [,, cmd, ...args] = process.argv;

  if (!cmd || cmd === 'help') {
    console.log(`Poster CLI — ChatGPT DALL-E poster generation via CDP

Commands:
  status              Check ChatGPT tab status
  generate <type> <brief>  Generate poster (type: atw/mb/fund/raw)
  prompt <text>       Send raw prompt to ChatGPT
  wait                Wait for current DALL-E generation to finish
  download [prefix] [index]  Download image by index (default: latest)
  download-all [prefix]      Download ALL images in conversation
  images              List all DALL-E images with index numbers

Types: atw (Around The World), mb (Market Brief), fund (Fund Holdings), raw (custom prompt)

Examples:
  node poster.js generate atw "China sanctions + Thai FDI +73% + Iran roadmap"
  node poster.js prompt "Generate a poster about..."
  node poster.js download atw-23jun
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
        await generate(page, args[0] || 'raw', args.slice(1).join(' '));
        break;
      case 'prompt': case 'send':
        await sendPrompt(page, args.join(' '));
        break;
      case 'wait':
        await waitForImage(page);
        break;
      case 'download': case 'dl':
        await downloadImage(page, args[0], args[1]);
        break;
      case 'download-all': case 'dl-all':
        await downloadAll(page, args[0]);
        break;
      case 'images': case 'imgs':
        const dalleImgs = await listImages(page);
        console.log(`${dalleImgs.length} DALL-E images:`);
        dalleImgs.forEach((img, i) => console.log(`  [${i}] ${img.w}x${img.h} ${img.alt || img.src}`));
        break;
      default:
        console.error(`Unknown command: ${cmd}. Run with 'help'.`);
    }
  } finally {
    browser.disconnect();
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
