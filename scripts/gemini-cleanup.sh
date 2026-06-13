#!/bin/bash
# gemini-cleanup.sh — Bulk delete old Gemini conversations
# Usage: ./gemini-cleanup.sh [--keep N] [--count N] [--tab ID]
# Default: keep 1 most recent, delete up to 50

set -euo pipefail

KEEP=1
COUNT=50
TAB_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="$2"; shift 2;;
    --count) COUNT="$2"; shift 2;;
    --tab) TAB_ID="$2"; shift 2;;
    *) shift;;
  esac
done

ID="cleanup_$(date +%s)"

# Find Gemini tab if not specified
if [ -z "$TAB_ID" ]; then
  mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  PING=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"ping_${ID}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo '{}')
  TAB_ID=$(echo "$PING" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
active = [t for t in tabs if t.get('active')]
print(active[0]['id'] if active else tabs[0]['id'] if tabs else '')
" 2>/dev/null || echo "")
  if [ -z "$TAB_ID" ]; then
    echo "[!] No Gemini tab found"
    exit 1
  fi
fi

echo "[tab:$TAB_ID] Deleting up to $COUNT chats (keeping $KEEP most recent)..."

mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
sleep 0.3
RESULT=$(timeout 120 mosquitto_sub -t 'claude/browser/response' -C 1 -W 110 2>/dev/null < <(
  sleep 0.5
  mosquitto_pub -t 'claude/browser/command' \
    -m "{\"action\":\"delete_chats_bulk\",\"keepRecent\":$KEEP,\"count\":$COUNT,\"tabId\":$TAB_ID,\"id\":\"${ID}\",\"ts\":$(date +%s%3N)}"
) 2>/dev/null || echo "{}")

DELETED=$(echo "$RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('deleted',0))" 2>/dev/null || echo "0")
ERRORS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); e=d.get('errors',[]); print('; '.join(e) if e else 'none')" 2>/dev/null || echo "unknown")
SUCCESS=$(echo "$RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('success',False))" 2>/dev/null || echo "False")

if [ "$SUCCESS" = "True" ]; then
  echo "[OK] Deleted $DELETED conversation(s)"
  [ "$ERRORS" != "none" ] && echo "[~] Warnings: $ERRORS"
else
  echo "[!] Bulk delete failed: $ERRORS"
  exit 1
fi
