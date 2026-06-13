#!/bin/bash
# gemini-status.sh — Check Gemini Proxy connection status
# Usage: ./gemini-status.sh

echo "=== Gemini Proxy Status ==="
echo ""

# Broker
if ss -tlnp 2>/dev/null | grep -q ':9001'; then
  echo "[OK] MQTT Broker: port 9001 open"
else
  echo "[!!] MQTT Broker: port 9001 NOT listening"
  echo "     Fix: sudo systemctl restart mosquitto"
fi

if ss -tlnp 2>/dev/null | grep -q ':1883'; then
  echo "[OK] MQTT Broker: port 1883 open"
else
  echo "[!!] MQTT Broker: port 1883 NOT listening"
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

# Gemini tab — use list_tabs (live) instead of retained state topic (stale)
mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
sleep 0.3
TABS_RESULT=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
  sleep 0.5
  mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"status_$(date +%s)\",\"ts\":$(date +%s%3N)}"
) 2>/dev/null || echo '{}')
TAB_COUNT=$(echo "$TABS_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo "0")
TAB_INFO=$(echo "$TABS_RESULT" | python3 -c "
import sys,json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
for t in tabs:
    print(f\"  tab:{t.get('id','?')} — {t.get('title','?')[:50]}\")
" 2>/dev/null || echo "")

if [ "$TAB_COUNT" -gt 0 ] 2>/dev/null; then
  echo "[OK] Gemini Tab: $TAB_COUNT tab(s) detected"
  echo "$TAB_INFO"
else
  echo "[!!] Gemini Tab: not detected"
  echo "     Fix: Open gemini.google.com in Chrome"
fi

echo ""
echo "=== Topics ==="
echo "Monitor: mosquitto_sub -t 'claude/browser/#' -v"
