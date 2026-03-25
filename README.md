# Gemini Proxy Tools

> MQTT-powered bridge between CLI agents and Google Gemini browser — control Gemini from terminal, automate image generation, extract responses, and more.

**For**: Humans & AI Agents | **Stack**: Chrome Extension + MQTT (Mosquitto) + WebSocket | **Repo**: [claude-browser-proxy](https://github.com/Soul-Brews-Studio/claude-browser-proxy)

---

## Architecture

```
┌─────────────────┐     MQTT (ws://9001)     ┌──────────────────────┐
│  CLI / Agent     │ ◄──────────────────────► │  Chrome Extension    │
│  (Claude Code)   │                          │  (Gemini Proxy)      │
│                  │  command ──────────────►  │                      │
│  mosquitto_pub   │                          │  background.js       │
│  mosquitto_sub   │  ◄────────────── response│  (Service Worker)    │
│                  │  ◄────────────── answer  │                      │
│  maw-js /gemini  │  ◄────────────── state   │  content.js          │
└─────────────────┘                           │  (DOM Interaction)   │
        │                                     └──────────┬───────────┘
        │                                                │
        │                                     ┌──────────▼───────────┐
        │                                     │  Google Gemini       │
        └─────────────────────────────────────│  gemini.google.com   │
                                              └──────────────────────┘
```

## MQTT Topics

| Topic | Direction | Retain | Description |
|-------|-----------|--------|-------------|
| `claude/browser/command` | CLI → Extension | No | Send commands |
| `claude/browser/response` | Extension → CLI | Yes | Command results |
| `claude/browser/answer` | Extension → CLI | Yes | Gemini AI answers |
| `claude/browser/state` | Extension → CLI | No | Loading state, response count |
| `claude/browser/status` | Extension → CLI | Yes | Online/offline status |

## Quick Start

### 1. Prerequisites

```bash
# Install Mosquitto MQTT broker
sudo apt install mosquitto mosquitto-clients

# Configure /etc/mosquitto/conf.d/websocket.conf
cat <<'EOF' | sudo tee /etc/mosquitto/conf.d/websocket.conf
allow_anonymous true
listener 1883 localhost
listener 9001
protocol websockets
EOF

sudo systemctl restart mosquitto
```

### 2. Install Chrome Extension

1. Clone [claude-browser-proxy](https://github.com/Soul-Brews-Studio/claude-browser-proxy)
2. Open `chrome://extensions/` → Enable Developer mode
3. Click "Load unpacked" → Select the repo folder
4. Open Gemini (`gemini.google.com`) in a tab
5. Extension badge should show green version number

### 3. Verify Connection

```bash
# Check extension is online
mosquitto_sub -t 'claude/browser/status' -C 1
# Expected: {"status":"online","timestamp":...,"version":"2.9.39"}

# Check Gemini tab detected
mosquitto_sub -t 'claude/browser/state' -C 1
# Expected: {"loading":false,"responseCount":N,...}
```

---

## CRITICAL: Always Use `tabId`

Without `tabId`, the extension picks the "most recently active" Gemini tab — which **changes unpredictably** when you have multiple tabs or Gemini opens new conversations. This causes commands to hit the wrong tab every time.

**Always pin to a specific tab:**

```bash
# Step 1: Find your tab
mosquitto_pub -t 'claude/browser/command' -m '{"action":"list_tabs","id":"t1"}'
# Response: {"tabs":[{"id":192573296,"title":"Google Gemini","url":"...","active":true},...]}

# Step 2: Use tabId in EVERY command
TAB_ID=192573296
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"chat","text":"Hello","tabId":'$TAB_ID',"id":"c1","ts":'$(date +%s%3N)'}'
```

The `gemini-gen.sh` script handles this automatically — it pins to the active tab on first run.

---

## Command Reference

### Tab Management (no Gemini tab required)

```bash
# List all Gemini tabs
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"list_tabs","id":"t1"}'

# Create new Gemini tab
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"create_tab","id":"t2"}'

# Focus specific tab
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"focus_tab","tabId":123456,"id":"t3"}'
```

### Chat & Response

```bash
TAB_ID=192573296  # Always set this first via list_tabs!

# Send message to Gemini (same conversation)
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"chat","text":"Explain quantum computing","tabId":'$TAB_ID',"id":"c1","ts":'$(date +%s%3N)'}'

# Send message + start NEW conversation in same tab (no new tab!)
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"chat","text":"Generate a cat","tabId":'$TAB_ID',"newChat":true,"id":"c2","ts":'$(date +%s%3N)'}'

# Wait for Gemini to finish responding (timeout in ms)
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"wait_response","timeout":30000,"tabId":'$TAB_ID',"id":"w1","ts":'$(date +%s%3N)'}'

# Get latest response text
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"get_response","tabId":'$TAB_ID',"id":"r1","ts":'$(date +%s%3N)'}'

# Get all page text
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"get_text","tabId":'$TAB_ID',"id":"gt1","ts":'$(date +%s%3N)'}'
```

### Image Extraction & Download

```bash
# Get image URLs + metadata from Gemini responses
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"get_images","tabId":'$TAB_ID',"id":"gi1","ts":'$(date +%s%3N)'}'

# Download all generated images from responses
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"download_images","tabId":'$TAB_ID',"prefix":"my_image","id":"dl1","ts":'$(date +%s%3N)'}'
# Options: prefix (filename), responseIndex (-1=all, 0=first, etc.)
```

### Page Interaction

```bash
# Click element by CSS selector
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"click","selector":"button.send-button","id":"k1","ts":'$(date +%s%3N)'}'

# Type text into focused element
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"type","text":"hello world","id":"k2","ts":'$(date +%s%3N)'}'

# Get current URL
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"get_url","id":"u1","ts":'$(date +%s%3N)'}'
```

### Model Selection

```bash
# Switch to Fast/Pro/Thinking
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"select_model","model":"pro","id":"m1","ts":'$(date +%s%3N)'}'

# Switch to Deep Research mode
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"select_mode","mode":"Deep Research","id":"m2","ts":'$(date +%s%3N)'}'
```

### YouTube Transcription

```bash
# Transcribe YouTube video (creates new tab + sends prompt)
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"transcribe","url":"https://youtube.com/watch?v=xxx","id":"yt1","ts":'$(date +%s%3N)'}'
```

### State Monitoring

```bash
# Get current state (loading, tool, response count)
mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"get_state","id":"s1","ts":'$(date +%s%3N)'}'

# Monitor state continuously
mosquitto_sub -t 'claude/browser/state' -v
```

---

## Listening for Responses

```bash
# Listen to all proxy traffic
mosquitto_sub -t 'claude/browser/#' -v

# Listen for command responses only
mosquitto_sub -t 'claude/browser/response' -v

# Listen for Gemini AI answers
mosquitto_sub -t 'claude/browser/answer' -v

# One-shot: send command and get response
(mosquitto_sub -t 'claude/browser/response' -C 2 -W 10) &
sleep 1 && mosquitto_pub -t 'claude/browser/command' \
  -m '{"action":"get_response","id":"r1","ts":'$(date +%s%3N)'}'
wait
```

---

## Full Workflow Examples

### Example 1: Generate Image

```bash
#!/bin/bash
# generate-image.sh — Send prompt to Gemini and wait for result

PROMPT="$1"
ID="img_$(date +%s)"

echo "Sending prompt..."
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":\"$PROMPT\",\"id\":\"${ID}_chat\",\"ts\":$(date +%s%3N)}"

echo "Waiting for response..."
sleep 2

mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"wait_response\",\"timeout\":60000,\"id\":\"${ID}_wait\",\"ts\":$(date +%s%3N)}"

# Listen for the answer
mosquitto_sub -t 'claude/browser/answer' -C 1 -W 65
```

### Example 2: Chat and Extract Answer

```bash
#!/bin/bash
# ask-gemini.sh — Ask Gemini a question, get text answer

QUESTION="$1"
ID="ask_$(date +%s)"

# Subscribe in background
(mosquitto_sub -t 'claude/browser/answer' -C 1 -W 60 > /tmp/gemini_answer.json) &
SUB_PID=$!

# Send question
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":\"$QUESTION\",\"id\":\"${ID}\",\"ts\":$(date +%s%3N)}"

# Wait for response to complete
sleep 3
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"wait_response\",\"timeout\":30000,\"id\":\"${ID}_wait\",\"ts\":$(date +%s%3N)}"

wait $SUB_PID
cat /tmp/gemini_answer.json | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('answer','No answer'))"
```

### Example 3: Monitor Gemini State

```bash
#!/bin/bash
# monitor.sh — Watch Gemini state in real-time

echo "Monitoring Gemini state (Ctrl+C to stop)..."
mosquitto_sub -t 'claude/browser/state' -v | while read -r topic msg; do
  loading=$(echo "$msg" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('loading',False))")
  count=$(echo "$msg" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))")
  tool=$(echo "$msg" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('tool','none'))")
  echo "[$(date +%H:%M:%S)] loading=$loading responses=$count tool=$tool"
done
```

---

## For AI Agents (Claude Code / Oracle)

### Using via maw-js /gemini skill

```bash
# The /gemini skill wraps MQTT commands for Oracle agents
/gemini chat "What is the capital of Thailand?"
/gemini wait
/gemini get
```

### Programmatic Usage (TypeScript/Bun)

```typescript
import mqtt from "mqtt";

const client = mqtt.connect("mqtt://localhost:1883");
const TOPICS = {
  command: "claude/browser/command",
  response: "claude/browser/response",
  answer: "claude/browser/answer",
};

// Send command
function send(action: string, params: Record<string, any> = {}) {
  const id = `${action}_${Date.now()}`;
  client.publish(
    TOPICS.command,
    JSON.stringify({ action, id, ts: Date.now(), ...params })
  );
  return id;
}

// Listen for response
function onResponse(id: string, timeout = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout")), timeout);
    const handler = (topic: string, msg: Buffer) => {
      const data = JSON.parse(msg.toString());
      if (data.id === id) {
        clearTimeout(timer);
        client.removeListener("message", handler);
        resolve(data);
      }
    };
    client.on("message", handler);
  });
}

// Usage
client.on("connect", async () => {
  client.subscribe(TOPICS.response);
  client.subscribe(TOPICS.answer);

  const id = send("chat", { text: "Hello Gemini!" });
  const result = await onResponse(id);
  console.log("Result:", result);

  // Wait for AI to finish
  const waitId = send("wait_response", { timeout: 30000 });
  const answer = await onResponse(waitId, 35000);
  console.log("Answer:", answer);
});
```

### Key Rules for AI Agents

1. **ALWAYS use `tabId`** — Without it, the extension picks a random active tab. Get tabId from `list_tabs` first, then include it in EVERY command
2. **Always include `ts` field** — Messages without `ts` newer than extension's `connectedAt` are ignored as stale
3. **Use unique `id`** — Match responses to commands by `id`
4. **Poll `get_state` with tabId** — Check `loading: false` before sending new commands
5. **Image responses have no text** — `get_response` returns error for image-only outputs, use `get_text` instead
6. **Use `newChat: true` carefully** — It navigates to `/app` (new conversation) in the same tab. Only use when you want a fresh conversation, NOT for continuing the same one
7. **Timeout `wait_response` for images** — Image generation returns minimal text, so `wait_response` may timeout; monitor `responseCount` change via `get_state` instead

---

## Debugging & Troubleshooting

### Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| Badge is red | MQTT not connected | Check broker: `ss -tlnp \| grep 9001` |
| "tab is not defined" | Extension reloaded, no Gemini tab | Open gemini.google.com |
| "Not on Gemini page" | Active tab is not Gemini | Use `tabId` parameter |
| "Response is empty" | Response is image/non-text | Use `get_text` for full page content |
| Commands hit wrong tab | No `tabId` specified | **Always use `tabId`** — get it from `list_tabs` |
| New conversation each gen | `newChat:true` or no `tabId` | Remove `newChat`, pin `tabId` |
| No response on MQTT | `let` scoping bug (pre-fix) | Update extension — [see bug case study](#bug-case-study-let-scoping-kills-mqtt-response) |
| "stale message" in logs | Command `ts` < extension `connectedAt` | Always set `ts: Date.now()` |
| CORS blocked download | Canvas tainted by cross-origin img | Extension uses direct URL download (auto-fallback) |

### Debug Commands

```bash
# Check broker is running
systemctl status mosquitto

# Check ports are open
ss -tlnp | grep -E '1883|9001'

# Monitor ALL traffic
mosquitto_sub -t 'claude/browser/#' -v

# Check extension version
mosquitto_sub -t 'claude/browser/status' -C 1

# Clear all retained messages
for t in response answer status state page; do
  mosquitto_pub -t "claude/browser/$t" -r -n
done
```

### Extension Service Worker Lifecycle (MV3)

Chrome Manifest V3 service workers can be terminated after 5 minutes of inactivity. The extension handles this via:
- MQTT keepalive (15s) keeps the worker alive
- LWT (Last Will & Testament) publishes offline status if worker dies
- Auto-reconnect every 5 seconds

If the worker dies unexpectedly, check `chrome://extensions/` → Inspect service worker.

---

## Bug Case Study: `let` Scoping Kills MQTT Response

> Date: 2026-03-26 | Discovered by: แบงค์ + Dev-Oracle

### The Bug

All commands handled by the **second switch** in `handleCommand()` (get_response, get_url, get_state, chat, etc.) never published to `claude/browser/response`. Only **first switch** commands (list_tabs, create_tab) worked.

### Root Cause

```javascript
async function handleCommand(topic, command) {
  let result;

  try {
    // First switch — tab management (returns early with publish)
    switch (command.action) {
      case 'list_tabs':
        // ... publish() + return  ← WORKS
    }

    // Tab resolution
    let tab;  // ← SCOPED TO try BLOCK
    // ... find tab ...

    // Second switch — Gemini actions
    switch (command.action) {
      case 'get_response':
        // ... uses tab ... break
    }
  } catch (err) {
    result = { error: err.message };
  }

  // OUTSIDE try block — tab is OUT OF SCOPE!
  const response = {
    ...result,
    tabId: tab?.id,  // ← ReferenceError: tab is not defined
  };
  publish(TOPICS.response, response, true);  // ← NEVER REACHED
}
```

**`let tab`** inside the `try` block is **block-scoped** — it doesn't exist outside the `try/catch`. The `tab?.id` at the bottom throws a `ReferenceError`, and since it's outside the `try/catch`, the error is an **unhandled promise rejection** that silently kills the publish.

### Why It Was Hard to Find

1. **First switch worked fine** — `list_tabs`, `create_tab` publish and return INSIDE the try block
2. **`get_state` appeared to work** — it has its own `publish(TOPICS.state, ...)` inside the switch case, masking the final publish failure
3. **No visible errors** — `handleCommand` is async but called without `await`, so the ReferenceError becomes a silent unhandled rejection
4. **Chrome DevTools needed** — error only visible in service worker console, not in terminal

### Fix

Move `let tab;` to function scope:

```javascript
async function handleCommand(topic, command) {
  let result;
  let tab;  // ← MOVED HERE — accessible everywhere in the function

  try {
    // ... first switch ...
    // let tab;  ← REMOVED from here
    // ... tab resolution (now assigns to outer tab) ...
    // ... second switch ...
  } catch (err) {
    result = { error: err.message };
  }

  const response = {
    ...result,
    tabId: tab?.id,  // ← NOW WORKS — tab is in scope
  };
  publish(TOPICS.response, response, true);  // ← NOW EXECUTES
}
```

### Lesson

> **`let` and `const` are block-scoped** — a variable declared inside `try {}` does NOT exist in `catch {}` or after it. If you need a variable across try/catch boundaries, declare it BEFORE the try block. This is especially dangerous in async functions where the ReferenceError becomes a silent unhandled rejection.

### Debugging Methodology (for AI agents)

1. **Observe**: Which topics publish? Which don't? → `mosquitto_sub -t 'claude/browser/#' -v`
2. **Isolate**: Test commands from different code paths → first switch vs second switch
3. **Narrow**: The working path (list_tabs) vs broken path (get_response) — what's different?
4. **Identify**: The final publish is shared code → if it fails for ALL second-switch commands, the bug is in the shared path
5. **Verify**: Add try/catch around the suspect code → error reveals "tab is not defined"
6. **Fix**: Move declaration to correct scope
7. **Confirm**: Test all command types after fix

---

## Configuration

### MQTT Broker URL

The extension connects to `ws://<WSL_IP>:9001`. Update in `background.js`:

```javascript
const MQTT_URL = 'ws://172.20.28.47:9001';  // Change to your WSL IP
```

Find your WSL IP:
```bash
# From WSL
hostname -I | awk '{print $1}'

# From Windows
wsl hostname -I
```

### Extension Permissions

Required in `manifest.json`:
- `tabs` — Tab management
- `scripting` — Execute scripts in Gemini page
- `storage` — State persistence
- `sidePanel` — Side panel UI
- Host permission: `https://gemini.google.com/*`

---

## File Structure

```
claude-browser-proxy/
├── manifest.json       # Extension config (MV3)
├── background.js       # MQTT connection + command handler (Service Worker)
├── content.js          # DOM interaction on Gemini page
├── sidepanel.html/js   # Side panel UI with buttons
├── popup.html/js       # Popup with MQTT status
├── mqtt.min.js         # MQTT.js library for WebSocket
├── icons/              # Extension icons
└── debug.html          # Debug interface
```

---

## Contributing

This is part of the [Oracle](https://github.com/BankCurfew) ecosystem. All Oracles can use this as a shared tool for Gemini integration.

**Extension repo**: [Soul-Brews-Studio/claude-browser-proxy](https://github.com/Soul-Brews-Studio/claude-browser-proxy)
**Tools & guide**: [BankCurfew/gemini-proxy-tools](https://github.com/BankCurfew/gemini-proxy-tools)
