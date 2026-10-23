# SOP: Image Generation v3.0 — Unified Pipeline

> **Version**: 3.0 | **Date**: 2026-07-05  
> **Owner**: DocCon-Oracle (canonical) · BotDev-Oracle (implementation)  
> **Ref**: gemini-proxy-tools#13, BoB-Oracle#158  
> **Status**: ACTIVE — supersedes all prior image-gen SOPs  
> **Enforced by**: DocCon + QA

---

## Decision Matrix — Which Tool When

> **14 Oct 2026 (แบงค์, T3030): Gemini is dropped. AI image gen = `poster.js` / skill `/poster` (CDP → ChatGPT DALL-E) ONLY.**
> `gemini-gen.sh` and `chatgpt-gen.sh` are **not** fallbacks: both ride the MQTT browser-proxy extension, which stalls every command
> (`chrome.storage.local.set` hangs, claude-browser-proxy `background.js:165`). The struck-through cells below are history.

| Use Case | PRIMARY | FALLBACK | Notes |
|----------|---------|----------|-------|
| **Brand posters** (iAgencyAIA marketing, social media) | `poster.js` (CDP/ChatGPT DALL-E) | none · ~~MQTT gemini-gen.sh~~ | poster.js has brand template, logo memory, 9:16 format |
| **News hero images** (daily news, concepts) | HTML template + Chrome headless | `poster.js` · ~~Gemini via gemini-gen.sh~~ | Real photos preferred for real events per Designer conduct |
| **General AI images** (one-off, non-branded) | `poster.js` / `/poster` · ~~`gemini-gen.sh` (MQTT)~~ | OpenAI API (Tier 3, แบงค์ approval) | For quick gen without brand requirements |
| **Bulk/automated** (scheduled, pipeline) | API (gpt-image-1/Gemini) | poster.js CDP | Tier 3 — requires แบงค์ API key approval |

---

## Pipeline 1: CDP poster.js (PRIMARY for brand posters)

**What**: Puppeteer connects to Chrome via CDP (localhost:9222), controls ChatGPT brand chat directly.

**Advantages over MQTT**:
- Brand context preserved (logo, colors, style in chat history)
- No extension dependency (works even if Gemini extension is offline)
- Faster iteration (no MQTT pub/sub overhead)
- Structured error handling possible (refusal detection)

### Flow

```
1. Connect CDP → Chrome (localhost:9222)
2. Take its own slot window (`~/.oracle/tools/cdp-window.mjs` slot L4, pinned; `POSTER_SLOT` to change; T3014 bob DECISION A) and open the brand chat (BRAND_CHAT_ID) in it. Never attaches or opens tabs in แบงค์'s window; released at exit
   - T3014: everything (incl. `new-chat`) runs in that ONE slot tab. `POSTER_ONE_TAB=0` (old new-tab path) is **ignored** with a log line: a 2nd tab could open in แบงค์'s window. Sends and attach wait up to 45 s (`POSTER_COMPOSER_WAIT_MS`) for ChatGPT's late-mounting composer
3. Compose prompt from BRAND_TEMPLATE + input
4. Send → poll for generation complete
5. Detect: success / refusal / stall
6. On success → download image → QA gate
7. On refusal → reframe neutral + retry once
8. On stall (2 timeouts) → page.reload → retry
9. Save to OUTPUT_DIR → deliver
```

### Usage

```bash
# /poster skill (RECOMMENDED — wraps full pipeline with recovery + QA)
/poster promo "ประกันชีวิต CI ครอบคลุม 50 โรค"
/poster story "ข่าวดี ลูกค้า AIA ต่ออายุได้"

# Direct node (when skill unavailable)
node scripts/poster.js generate "ประกันชีวิต CI" --type promo --badge "สาระประกัน"
```

### Config (poster.config.json — after T4 de-hardcode)

```json
{
  "BRAND_CHAT_ID": "6a2e2fee-f228-83ec-a55a-e85f221d620f",
  "OUTPUT_DIR": "/mnt/c/Users/mbank/OneDrive/AIA/Posters",
  "DOWNLOADS_DIR": "/mnt/c/Users/mbank/Downloads",
  "CDP_PORT": 9222,
  "MAX_RETRIES": 2,
  "GENERATION_TIMEOUT_MS": 180000,
  "HEARTBEAT_INTERVAL_MS": 30000
}
```

---

## Pipeline 2: MQTT gemini-gen.sh (HISTORY: dropped 14 Oct 2026, T3030; do not use)

**What**: Chrome Extension + MQTT broker controls Gemini browser tab.

**When to use**:
- poster.js CDP connection fails (Chrome not running, port blocked)
- Non-branded image generation (general AI art, concepts)
- Gemini-specific features (e.g., Gemini handles certain styles better)

### Flow

```bash
GEN=~/repos/github.com/BankCurfew/gemini-proxy-tools/scripts/gemini-gen.sh

# Standard generation + download
$GEN "prompt" --download "filename-prefix"

# New chat (fresh context)
$GEN "prompt" --new --download "prefix"

# Pin specific tab
$GEN "prompt" --tab $TAB_ID --download "prefix"
```

### Prerequisites
- Mosquitto broker running (ports 1883 + 9001)
- Chrome extension loaded + green badge
- Gemini tab open

### Known Limitations
- Chrome may save as `unnamed (N).jpg` ignoring prefix
- Shadow DOM issues on older extension versions
- No refusal detection (stalls silently on blocked prompts)
- No auto-refresh recovery

---

## Pipeline 3: OpenAI gpt-image-1 API (Tier 3 — NOT YET APPROVED)

**Status**: Awaiting แบงค์ cost approval. Do NOT implement until approved.

**When approved, use for**:
- Bulk automated generation (daily news pipeline)
- Cases where 10-30s response time matters (vs 60-180s browser)
- Structured error handling needed

**Ref**: DocCon-Oracle/CLAUDE_openai_image_gen_conduct.md for prompt standards.

---

## Failure Recovery (T1 + T2 — BotDev implementing)

### Auto-Refresh Recovery (poster.js)
```
Generation attempt
  ├─ Success → proceed to download
  ├─ Timeout (180s) → retry count++
  │   ├─ retry < 2 → page.reload() → retry same prompt
  │   └─ retry >= 2 → FAIL → report the blocker (no MQTT fallback since 14 Oct 2026, T3030)
  └─ Flat response count (no change 2 polls) → same as timeout
```

### Refusal Detection (poster.js)
```
After send, poll last assistant message:
  ├─ Matches EN refusal: "I can't generate|unable to create|violates policy"
  ├─ Matches TH refusal: "ไม่สามารถสร้าง|ขัดต่อนโยบาย"
  ├─ OR: response count unchanged after 60s
  └─ Action: return {refused: true, reason: "..."} with distinct exit code
      → Caller reframes prompt neutral + retries ONCE
      → Second refusal → FAIL with reason logged
```

---

## Heartbeat (Rule #9 compliance)

Any generation taking >30s MUST emit heartbeat:

```bash
echo "$(date '+%Y-%m-%d %H:%M:%S') | Designer-Oracle | $(hostname) | Notification | Designer-Oracle | heartbeat » HB: #poster-gen 50% waiting for DALL-E response" >> ~/.oracle/feed.log
```

poster.js emits heartbeat every tick during the 180s wait loop automatically (after T5).
Every run that ends without an image (refused, timeout, last stall, failed send, T9 fail, Ctrl-C) closes its own stream at exit with `HB: <id> 100% done ended without image (exit N, last: <status>)` (T3264, gemini-proxy-tools#57), so no stream is left open for hb-checker. `wait T####` carries the ticket id as the stream id; `generate <type>` uses the poster type as its id.

---

## QA Gate (T8 — post-download verification)

Before delivering any brand poster:

| Check | Method | FAIL action |
|-------|--------|-------------|
| Aspect ratio 9:16 | `identify -format "%wx%h"` | Reject + regenerate |
| File size > 100KB | `stat --printf="%s"` | Reject (blank/corrupt) |
| Logo present (optional) | Vision check or manual | Flag for review |
| Thai text readable | Visual inspection | Flag for review |

---

## Superseded Documents

This SOP v3.0 **supersedes** the following. Do NOT follow them for poster generation:

| Document | Status | Action Needed |
|----------|--------|---------------|
| Designer-Oracle CLAUDE.md §"Image Generation — Gemini MQTT Proxy (Primary)" | ❌ STALE | Must be updated to reference this SOP |
| Raw MQTT examples in Designer CLAUDE.md lines 191-215 | ❌ STALE | Replace with poster.js reference |
| Any standalone "MQTT image gen SOP" | ❌ DELETED | This document is canonical |

**What remains valid**:
- ~~Global CLAUDE.md Rule #4 (gemini-gen.sh for general Gemini use) — still valid for NON-poster use~~ superseded 14 Oct 2026: GR#4 = `/poster` (DALL-E) only
- Designer CLAUDE_poster_conduct.md (layout/typography/QA rules) — still valid for design standards
- DocCon CLAUDE_openai_image_gen_conduct.md — still valid for OpenAI API when approved

---

## Change Log

| Version | Date | Author | Change |
|---------|------|--------|--------|
| 3.1 | 2026-10-14 | Admin (bob T3030) | Gemini dropped (แบงค์): poster.js/`/poster` only; MQTT gemini-gen/chatgpt-gen marked history (extension stalls, background.js:165) |
| 3.0 | 2026-07-05 | DocCon | Unified SOP: CDP primary, MQTT fallback, recovery specs |
| 2.x | 2026-06 | Various | Multiple conflicting SOPs across repos |
| 1.0 | 2026-05 | Designer | Original MQTT-only approach |
