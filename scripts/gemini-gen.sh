#!/bin/bash
# gemini-gen.sh — Generate image via Gemini
# Usage: ./gemini-gen.sh "image description" [--new] [--download prefix]

set -euo pipefail

TEXT="${1:?Usage: gemini-gen.sh \"image description\" [--new] [--download prefix]}"
shift
NEW_CHAT=false
DL_PREFIX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW_CHAT=true; shift;;
    --download) DL_PREFIX="${2:-gemini}"; shift 2;;
    *) shift;;
  esac
done

ID="gen_$(date +%s)"

# Get initial response count (skip status check — trust state poll)
STATE=$(mosquitto_sub -t 'claude/browser/state' -C 1 -W 3 2>/dev/null || echo '{}')
INITIAL_COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")

# Build chat command
if [ "$NEW_CHAT" = "true" ]; then
  CHAT_CMD="{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"newChat\":true,\"id\":\"${ID}\",\"ts\":$(date +%s%3N)}"
else
  CHAT_CMD="{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\",\"ts\":$(date +%s%3N)}"
fi

echo "[>] Sending prompt (responses: $INITIAL_COUNT)..."
mosquitto_pub -t 'claude/browser/command' -m "$CHAT_CMD"

# Poll every 1s — image gen usually takes 5-15s
for i in $(seq 1 45); do
  sleep 1
  STATE=$(mosquitto_sub -t 'claude/browser/state' -C 1 -W 2 2>/dev/null || echo '{}')
  COUNT=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")
  LOADING=$(echo "$STATE" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('loading',False))" 2>/dev/null || echo "False")

  if [ "$COUNT" -gt "$INITIAL_COUNT" ] && [ "$LOADING" = "False" ]; then
    echo " OK ($((i))s, responses: $INITIAL_COUNT -> $COUNT)"

    # Auto-download if requested
    if [ -n "$DL_PREFIX" ]; then
      echo "[>] Downloading..."
      mosquitto_pub -t 'claude/browser/command' \
        -m "{\"action\":\"download_images\",\"prefix\":\"${DL_PREFIX}\",\"responseIndex\":-1,\"id\":\"dl_${ID}\",\"ts\":$(date +%s%3N)}"
      sleep 2
      DL_RESULT=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null || echo '{}')
      DL_COUNT=$(echo "$DL_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('downloaded',0))" 2>/dev/null || echo "0")
      echo "[OK] Downloaded $DL_COUNT image(s)"
    fi
    exit 0
  fi
  printf "."
done

echo ""
echo "[!] Timeout (45s) — check Gemini tab"
exit 1
