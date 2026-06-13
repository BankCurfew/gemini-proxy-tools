#!/bin/bash
# chatgpt-chat.sh — Send message to ChatGPT via MQTT
# Usage: ./chatgpt-chat.sh "message" [--new] [--tab ID]

set -euo pipefail

TEXT="${1:?Usage: chatgpt-chat.sh \"message\" [--new] [--tab ID]}"
shift
NEW_CHAT=false
TAB_ID=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW_CHAT=true; shift;;
    --tab) TAB_ID="$2"; shift 2;;
    *) shift;;
  esac
done

ID="chat_$(date +%s)"

# Find ChatGPT tab
if [ -z "$TAB_ID" ]; then
  mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  TABS=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"t_${ID}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo '{}')
  TAB_ID=$(echo "$TABS" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
cgpt = [t for t in tabs if 'chatgpt.com' in t.get('url','') or 'chat.openai.com' in t.get('url','')]
print(cgpt[0]['id'] if cgpt else '')
" 2>/dev/null || echo "")
  if [ -z "$TAB_ID" ]; then
    echo "[!] No ChatGPT tab found"
    exit 1
  fi
fi

EXTRA=",\"tabId\":$TAB_ID"
[ "$NEW_CHAT" = "true" ] && EXTRA="$EXTRA,\"newChat\":true"

mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chatgpt_chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\"${EXTRA},\"ts\":$(date +%s%3N)}"
echo "[OK] Sent to ChatGPT (tab:$TAB_ID)"
