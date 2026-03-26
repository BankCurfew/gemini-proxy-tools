#!/bin/bash
# gemini-gen.sh — Generate image via Gemini (pinned to one tab)
# Usage: ./gemini-gen.sh "prompt" [--tab ID] [--new] [--download prefix]
# Default: pins to active Gemini tab and reuses it for all requests.

set -euo pipefail

TEXT="${1:?Usage: gemini-gen.sh \"prompt\" [--tab ID] [--new] [--download prefix]}"
shift
NEW_CHAT=false
DL_PREFIX=""
TAB_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW_CHAT=true; shift;;
    --tab) TAB_ID="$2"; shift 2;;
    --download) DL_PREFIX="${2:-gemini}"; shift 2;;
    *) shift;;
  esac
done

ID="gen_$(date +%s)"

# Pre-flight: check extension is online
STATUS=$(mosquitto_sub -t 'claude/browser/status' -C 1 -W 5 2>/dev/null || echo '{}')
EXT_STATUS=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('status','offline'))" 2>/dev/null || echo "offline")
if [ "$EXT_STATUS" != "online" ]; then
  echo "[!] Extension offline — reload at chrome://extensions/ then retry"
  exit 1
fi
EXT_VER=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('version','?'))" 2>/dev/null || echo "?")
echo "[ext:v${EXT_VER}]"

# Resolve tab — pin to specific tab or find active one
if [ -z "$TAB_ID" ]; then
  TAB_ID=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"lt_${ID}\",\"ts\":$(date +%s%3N)}"
  ) | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
# Prefer active tab, else first gemini tab
active = [t for t in tabs if t.get('active')]
print(active[0]['id'] if active else tabs[0]['id'] if tabs else '')
" 2>/dev/null || echo "")
  if [ -z "$TAB_ID" ]; then
    echo "[!] No Gemini tab found"
    exit 1
  fi
fi

echo "[tab:$TAB_ID]"

# Get initial response count from THIS specific tab
INITIAL_COUNT=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
  sleep 0.5
  mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"get_state\",\"tabId\":$TAB_ID,\"id\":\"st_${ID}\",\"ts\":$(date +%s%3N)}"
) | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")

# Build and send chat to PINNED tab
EXTRA=",\"tabId\":$TAB_ID"
[ "$NEW_CHAT" = "true" ] && EXTRA="$EXTRA,\"newChat\":true"
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\"${EXTRA},\"ts\":$(date +%s%3N)}"
echo "[>] Sent (responses: $INITIAL_COUNT)"

# Poll state on PINNED tab until responseCount increases
RESULT=$(timeout 30 bash -c '
TAB_ID='"$TAB_ID"'
INITIAL_COUNT='"$INITIAL_COUNT"'
while true; do
  TS=$(date +%s%3N)
  R=$(mosquitto_sub -t "claude/browser/response" -C 1 -W 5 2>/dev/null < <(
    sleep 0.3
    mosquitto_pub -t "claude/browser/command" -m "{\"action\":\"get_state\",\"tabId\":${TAB_ID},\"id\":\"poll_${TS}\",\"ts\":${TS}}"
  ) 2>/dev/null || echo "{}")
  COUNT=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('"'"'responseCount'"'"',0))" 2>/dev/null || echo 0)
  LOADING=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('"'"'loading'"'"',False))" 2>/dev/null || echo False)
  if [ "$COUNT" -gt "$INITIAL_COUNT" ] && [ "$LOADING" = "False" ]; then
    echo "OK count:${COUNT}"
    exit 0
  fi
  printf "(%ds · timeout 2m)\r" "$SECONDS" >&2
  sleep 1
done
' 2>&1)

if echo "$RESULT" | grep -q "^OK"; then
  echo ""
  echo "[OK] $RESULT"

  if [ -n "$DL_PREFIX" ]; then
    DL_CMD_ID="dl_${ID}"
    # Clear retained response to avoid stale reads
    mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"download_images\",\"prefix\":\"${DL_PREFIX}\",\"tabId\":$TAB_ID,\"id\":\"${DL_CMD_ID}\",\"ts\":$(date +%s%3N)}"
    # Filter responses by id to avoid get_state pollution
    DL=$(timeout 10 mosquitto_sub -t 'claude/browser/response' -C 10 2>/dev/null \
      | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        if d.get('id') == '${DL_CMD_ID}':
            print(f'Downloaded {d.get(\"downloaded\",0)} image(s) to Windows Downloads')
            break
    except: pass
else:
    print('download sent (no matching response)')
" 2>/dev/null || echo "download sent")
    echo "[OK] $DL"
    echo "[!] Files land in /mnt/c/Users/\$USER/Downloads/ (may be named 'unnamed (N).jpg')"
  fi
  exit 0
else
  echo ""
  echo "[!] Timeout (30s)"
  exit 1
fi
