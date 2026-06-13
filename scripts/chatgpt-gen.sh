#!/bin/bash
# chatgpt-gen.sh — Generate image via ChatGPT/DALL-E
# Usage: ./chatgpt-gen.sh "prompt" [--new] [--download prefix] [--tab ID] [--keep]
# Mirrors gemini-gen.sh but for ChatGPT

set -euo pipefail

TEXT="${1:?Usage: chatgpt-gen.sh \"prompt\" [--new] [--download prefix] [--tab ID] [--keep]}"
shift
NEW_CHAT=false
DL_PREFIX=""
TAB_ID=""
KEEP_CHAT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW_CHAT=true; shift;;
    --keep) KEEP_CHAT=true; shift;;
    --tab) TAB_ID="$2"; shift 2;;
    --download) DL_PREFIX="${2:-chatgpt}"; shift 2;;
    *) shift;;
  esac
done

ID="cgpt_$(date +%s)"

# Pre-flight: ping extension
mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
sleep 0.3
PING=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
  sleep 0.5
  mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"ping_${ID}\",\"ts\":$(date +%s%3N)}"
) 2>/dev/null || echo '{}')
PING_OK=$(echo "$PING" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('success') else 'fail')" 2>/dev/null || echo "fail")
if [ "$PING_OK" != "ok" ]; then
  echo "[!] Extension offline — reload at chrome://extensions/ then retry"
  exit 1
fi
echo "[ext:online]"

# Find ChatGPT tab
if [ -z "$TAB_ID" ]; then
  TAB_ID=$(echo "$PING" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
cgpt = [t for t in tabs if t.get('platform') == 'chatgpt' or 'chatgpt.com' in t.get('url','') or 'chat.openai.com' in t.get('url','')]
print(cgpt[0]['id'] if cgpt else '')
" 2>/dev/null || echo "")
  if [ -z "$TAB_ID" ]; then
    echo "[!] No ChatGPT tab found — open chatgpt.com first"
    exit 1
  fi
fi
echo "[tab:$TAB_ID]"

# Get initial state
if [ "$NEW_CHAT" = "true" ]; then
  INITIAL_COUNT=0
else
  mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  INITIAL_COUNT=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"chatgpt_get_state\",\"tabId\":$TAB_ID,\"id\":\"st_${ID}\",\"ts\":$(date +%s%3N)}"
  ) | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")
fi

# Send prompt
EXTRA=",\"tabId\":$TAB_ID"
[ "$NEW_CHAT" = "true" ] && EXTRA="$EXTRA,\"newChat\":true"
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chatgpt_chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\"${EXTRA},\"ts\":$(date +%s%3N)}"
echo "[>] Sent (initial responses: $INITIAL_COUNT)"

# Poll for response
SECONDS=0
RESULT=""
while [ $SECONDS -lt 120 ]; do
  POLL_ID="poll_$(date +%s%3N)"
  mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  R=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"chatgpt_get_state\",\"tabId\":$TAB_ID,\"id\":\"${POLL_ID}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo "{}")
  COUNT=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo 0)
  LOADING=$(echo "$R" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('loading',False))" 2>/dev/null || echo False)
  if [ "$COUNT" -gt "$INITIAL_COUNT" ] && [ "$LOADING" = "False" ]; then
    RESULT="OK count:${COUNT}"
    break
  fi
  printf "(%ds · timeout 120s)\r" "$SECONDS" >&2
  sleep 3
done

if [ -n "$RESULT" ]; then
  echo ""
  echo "[OK] $RESULT"

  if [ -n "$DL_PREFIX" ]; then
    # DALL-E images take longer — poll for images (up to 90s)
    echo "[~] Waiting for DALL-E image to appear..."
    DL_OK=false
    IMG_WAIT=0
    while [ $IMG_WAIT -lt 90 ]; do
      # Check if images exist yet
      IMG_CHK_ID="imgchk_${ID}_${IMG_WAIT}"
      mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
      sleep 0.3
      IMG_CHK=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
        sleep 0.5
        mosquitto_pub -t 'claude/browser/command' \
          -m "{\"action\":\"chatgpt_get_images\",\"tabId\":$TAB_ID,\"id\":\"${IMG_CHK_ID}\",\"ts\":$(date +%s%3N)}"
      ) 2>/dev/null || echo "{}")
      IMG_COUNT=$(echo "$IMG_CHK" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo "0")

      if [ "$IMG_COUNT" -gt 0 ] 2>/dev/null; then
        echo "[~] Found $IMG_COUNT image(s), downloading..."
        sleep 2
        # Download
        DL_CMD_ID="dl_${ID}"
        mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
        sleep 0.5
        DL_RESULT=$(timeout 20 mosquitto_sub -t 'claude/browser/response' -C 1 -W 18 2>/dev/null < <(
          sleep 0.5
          mosquitto_pub -t 'claude/browser/command' \
            -m "{\"action\":\"chatgpt_download_images\",\"prefix\":\"${DL_PREFIX}\",\"tabId\":$TAB_ID,\"id\":\"${DL_CMD_ID}\",\"ts\":$(date +%s%3N)}"
        ) 2>/dev/null || echo "{}")
        DL_COUNT=$(echo "$DL_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('downloaded',0))" 2>/dev/null || echo "0")
        if [ "$DL_COUNT" -gt 0 ] 2>/dev/null; then
          echo "[OK] Downloaded $DL_COUNT image(s) to Windows Downloads"
          echo "[!] Files land in /mnt/c/Users/\$USER/Downloads/"
          DL_OK=true
        fi
        break
      fi

      printf "(%ds · waiting for DALL-E · timeout 90s)\r" "$IMG_WAIT" >&2
      sleep 5
      IMG_WAIT=$((IMG_WAIT + 5))
    done

    if [ "$DL_OK" != "true" ]; then
      echo "[!] No images found — ChatGPT may have responded with text only"
      exit 1
    fi

    # Auto-delete conversation (unless --keep)
    if [ "$KEEP_CHAT" = "true" ]; then
      echo "[~] Keeping conversation (--keep)"
    else
      echo "[~] Cleaning up ChatGPT conversation..."
      sleep 1
      DEL_CMD_ID="del_${ID}"
      mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
      sleep 0.3
      DEL_RESULT=$(timeout 10 mosquitto_sub -t 'claude/browser/response' -C 1 -W 8 2>/dev/null < <(
        sleep 0.5
        mosquitto_pub -t 'claude/browser/command' \
          -m "{\"action\":\"chatgpt_delete_chat\",\"tabId\":$TAB_ID,\"id\":\"${DEL_CMD_ID}\",\"ts\":$(date +%s%3N)}"
      ) 2>/dev/null || echo "{}")
      DEL_OK=$(echo "$DEL_RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('success') else d.get('error','unknown'))" 2>/dev/null || echo "failed")
      if [ "$DEL_OK" = "ok" ]; then
        echo "[OK] Conversation deleted"
      else
        echo "[~] Auto-delete skipped ($DEL_OK)"
      fi
    fi
  fi
  exit 0
else
  echo ""
  echo "[!] Timeout (120s)"
  exit 1
fi
