#!/bin/bash
# chatgpt-status.sh — Check ChatGPT proxy connection status
# Usage: ./chatgpt-status.sh

echo "=== ChatGPT Proxy Status ==="
echo ""

# Broker
if ss -tlnp 2>/dev/null | grep -q ':9001'; then
  echo "[OK] MQTT Broker: port 9001 open"
else
  echo "[!!] MQTT Broker: port 9001 NOT listening"
  echo "     Fix: sudo systemctl restart mosquitto"
fi

echo ""

# Extension status
STATUS=$(mosquitto_sub -t 'claude/browser/status' -C 1 -W 3 2>/dev/null || echo '{"status":"timeout"}')
ONLINE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('status','unknown'))" 2>/dev/null || echo "unknown")
VERSION=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('version','?'))" 2>/dev/null || echo "?")

if [ "$ONLINE" = "online" ]; then
  echo "[OK] Extension: online (v$VERSION)"
else
  echo "[!!] Extension: $ONLINE"
  echo "     Fix: Reload extension in chrome://extensions/"
fi

echo ""

# ChatGPT tab — use list_tabs (live)
# Race-condition fix (#7): increased sub→pub delay + retry
_status_ping() {
  local sid="$1" delay="$2"
  mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  TABS_RESULT=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
    sleep "$delay"
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"${sid}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo '{}')
}
_status_ping "status_$(date +%s)" 1
# Retry once if empty (race condition: sub not ready before pub)
_tab_ok=$(echo "$TABS_RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('tabs') else 'empty')" 2>/dev/null || echo "empty")
if [ "$_tab_ok" != "ok" ]; then
  echo "[~] Tab check missed — retrying..."
  sleep 1
  _status_ping "status_$(date +%s)_retry" 1.5
fi

echo "$TABS_RESULT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
cgpt = [t for t in tabs if t.get('platform') == 'chatgpt' or 'chatgpt.com' in t.get('url','') or 'chat.openai.com' in t.get('url','')]
gemini = [t for t in tabs if t.get('platform') == 'gemini' or 'gemini.google.com' in t.get('url','')]
if cgpt:
    print(f'[OK] ChatGPT Tab: {len(cgpt)} tab(s) detected')
    for t in cgpt:
        print(f\"  tab:{t.get('id','?')} — {t.get('title','?')[:50]}\")
else:
    print('[!!] ChatGPT Tab: not detected')
    print('     Fix: Open chatgpt.com in Chrome')
print()
if gemini:
    print(f'[OK] Gemini Tab: {len(gemini)} tab(s) detected')
    for t in gemini:
        print(f\"  tab:{t.get('id','?')} — {t.get('title','?')[:50]}\")
" 2>/dev/null

echo ""
echo "=== Topics ==="
echo "Monitor: mosquitto_sub -t 'claude/browser/#' -v"
