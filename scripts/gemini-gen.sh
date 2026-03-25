#!/bin/bash
# gemini-gen.sh — Generate image via Gemini
# Usage: ./gemini-gen.sh "image description"

set -euo pipefail

TEXT="${1:?Usage: gemini-gen.sh \"image description\"}"
ID="gen_$(date +%s)"

# Check connection
STATUS=$(mosquitto_sub -t 'claude/browser/status' -C 1 -W 3 2>/dev/null || echo '{}')
ONLINE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('status','offline'))" 2>/dev/null || echo "offline")

if [ "$ONLINE" != "online" ]; then
  echo "[!] Gemini Proxy is offline. Check extension."
  exit 1
fi

# Get initial response count
STATE=$(mosquitto_sub -t 'claude/browser/state' -C 1 -W 5 2>/dev/null || echo '{}')
INITIAL_COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")

echo "[>] Sending image prompt (current responses: $INITIAL_COUNT)..."
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\",\"ts\":$(date +%s%3N)}"

# Poll state until responseCount increases
echo "[~] Waiting for Gemini to generate..."
for i in $(seq 1 30); do
  sleep 2
  STATE=$(mosquitto_sub -t 'claude/browser/state' -C 1 -W 3 2>/dev/null || echo '{}')
  COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")
  LOADING=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('loading',False))" 2>/dev/null || echo "False")

  if [ "$COUNT" -gt "$INITIAL_COUNT" ] && [ "$LOADING" = "False" ]; then
    echo "[OK] Image generated! (responses: $INITIAL_COUNT -> $COUNT)"
    exit 0
  fi
  printf "."
done

echo ""
echo "[!] Timeout — check Gemini tab manually"
exit 1
