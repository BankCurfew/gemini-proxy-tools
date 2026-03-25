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

# Gemini tab
STATE=$(mosquitto_sub -t 'claude/browser/state' -C 1 -W 3 2>/dev/null || echo '{}')
RESP_COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount','N/A'))" 2>/dev/null || echo "N/A")
LOADING=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('loading','N/A'))" 2>/dev/null || echo "N/A")

if [ "$RESP_COUNT" != "N/A" ]; then
  echo "[OK] Gemini Tab: detected (responses: $RESP_COUNT, loading: $LOADING)"
else
  echo "[!!] Gemini Tab: not detected"
  echo "     Fix: Open gemini.google.com in Chrome"
fi

echo ""
echo "=== Topics ==="
echo "Monitor: mosquitto_sub -t 'claude/browser/#' -v"
