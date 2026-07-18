#!/bin/bash
# gemini-gen.sh — Generate image via Gemini (pinned to one tab)
# Usage: ./gemini-gen.sh "prompt" [--tab ID] [--new] [--download prefix] [--keep]
# Default: pins to active Gemini tab and reuses it for all requests.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/mqtt-log.sh"

TEXT="${1:?Usage: gemini-gen.sh \"prompt\" [--tab ID] [--new] [--download prefix] [--keep] [--verbose]}"
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
    --download) DL_PREFIX="${2:-gemini}"; shift 2;;
    --verbose) MQTT_VERBOSE=true; shift;;
    *) shift;;
  esac
done

ID="gen_$(date +%s)"

# Pre-flight: ping extension with list_tabs (status topic is unreliable)
# Race-condition fix (#7): retry once if sub isn't established before pub fires
_ping_attempt() {
  local attempt_id="$1" delay="$2"
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  _mqtt_start=$(date +%s%3N)
  PING=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
    sleep "$delay"
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"${attempt_id}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo '{}')
  mqtt_log "ping" "claude/browser/response" "$([ -n "$PING" ] && echo ok || echo empty)" "$(( $(date +%s%3N) - _mqtt_start ))"
  PING_OK=$(echo "$PING" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('success') else 'fail')" 2>/dev/null || echo "fail")
}
_ping_attempt "ping_${ID}" 1
if [ "$PING_OK" != "ok" ]; then
  echo "[~] Ping missed — retrying..." >&2
  sleep 1
  _ping_attempt "ping_${ID}_retry" 1.5
  if [ "$PING_OK" != "ok" ]; then
    echo "[!] Extension offline — reload at chrome://extensions/ then retry"
    exit 1
  fi
fi
echo "[ext:online]"

# Resolve tab — pin to specific tab or find active one
if [ -z "$TAB_ID" ]; then
  TAB_ID=$(echo "$PING" | python3 -c "
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

# For --new chat, set initial count to 0 since newChat resets the page
if [ "$NEW_CHAT" = "true" ]; then
  INITIAL_COUNT=0
else
  # Get initial response count from THIS specific tab
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  _mqtt_start=$(date +%s%3N)
  ST_ID="st_${ID}"
  INITIAL_COUNT=$(mosquitto_sub -t 'claude/browser/response' -W 5 2>/dev/null < <(
    sleep 1
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"get_state\",\"tabId\":$TAB_ID,\"id\":\"${ST_ID}\",\"ts\":$(date +%s%3N)}"
  ) | python3 -c "
import sys,json
for line in sys.stdin:
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${ST_ID}' and 'responseCount' in d:
            print(d['responseCount']); break
    except: pass
" 2>/dev/null || echo "0")
  mqtt_log "get_state" "claude/browser/response" "count=$INITIAL_COUNT" "$(( $(date +%s%3N) - _mqtt_start ))"
fi

# T032: capture gen-start timestamp for stale-download detection
GEN_START=$(date +%s)

# Build and send chat to PINNED tab
EXTRA=",\"tabId\":$TAB_ID"
[ "$NEW_CHAT" = "true" ] && EXTRA="$EXTRA,\"newChat\":true"
_mqtt_start=$(date +%s%3N)
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\"${EXTRA},\"ts\":$(date +%s%3N)}"
mqtt_log "chat" "claude/browser/command" "sent" "$(( $(date +%s%3N) - _mqtt_start ))"
echo "[>] Sent (initial responses: $INITIAL_COUNT)"

# Poll state on PINNED tab until responseCount increases
SECONDS=0
RESULT=""
while [ $SECONDS -lt 90 ]; do
  POLL_ID="poll_$(date +%s%3N)"
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  _mqtt_start=$(date +%s%3N)
  # Subscribe, then publish — filter by poll ID, extract count+loading
  POLL_RESULT=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -W 6 2>/dev/null < <(
    sleep 1
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"get_state\",\"tabId\":$TAB_ID,\"id\":\"${POLL_ID}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null | python3 -c "
import sys,json
for line in sys.stdin:
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${POLL_ID}' and 'responseCount' in d:
            print(d.get('responseCount',0),d.get('loading',False)); break
    except: pass
" 2>/dev/null || echo "0 False")
  mqtt_log "poll" "claude/browser/response" "poll_${SECONDS}s" "$(( $(date +%s%3N) - _mqtt_start ))"
  COUNT=$(echo "$POLL_RESULT" | head -1 | awk '{print $1}')
  LOADING=$(echo "$POLL_RESULT" | head -1 | awk '{print $2}')
  if [ "$COUNT" -gt "$INITIAL_COUNT" ] && [ "$LOADING" = "False" ]; then
    RESULT="OK count:${COUNT}"
    break
  fi
  printf "(%ds · timeout 90s)\r" "$SECONDS" >&2
  sleep 2
done

if [ -n "$RESULT" ]; then
  echo ""
  echo "[OK] $RESULT"

  if [ -n "$DL_PREFIX" ]; then
    # T032 option A: Chrome auto-downloads generated images — find + rename
    # Wait for auto-download to land (Chrome saves blob → Downloads)
    echo "[~] Waiting for auto-download..."
    WIN_PROFILE=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r\n')
    DL_DIR="$(wslpath "$WIN_PROFILE")/Downloads"
    DL_OK=false
    for attempt in 1 2 3 4 5 6; do
      sleep 3
      # Find newest image file (any common format) with mtime > GEN_START
      NEWEST=$(find "$DL_DIR" -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' \) -newer "/proc/$$" 2>/dev/null | head -1)
      # Fallback: check by mtime comparison
      if [ -z "$NEWEST" ]; then
        NEWEST=$(ls -t "$DL_DIR"/*.{jpg,jpeg,png,webp} 2>/dev/null | head -1)
        if [ -n "$NEWEST" ]; then
          FILE_MTIME=$(stat -c %Y "$NEWEST" 2>/dev/null || echo 0)
          [ "$FILE_MTIME" -lt "$GEN_START" ] && NEWEST=""
        fi
      fi
      if [ -n "$NEWEST" ]; then
        EXT="${NEWEST##*.}"
        TARGET="${DL_DIR}/${DL_PREFIX}.${EXT}"
        if [ "$NEWEST" != "$TARGET" ]; then
          mv "$NEWEST" "$TARGET" 2>/dev/null && echo "[OK] Renamed to ${DL_PREFIX}.${EXT}" || TARGET="$NEWEST"
        fi
        echo "[OK] Image: $TARGET"
        echo "[!] Files in /mnt/c/Users/\$USER/Downloads/"
        DL_OK=true
        break
      fi
      printf "  (%ds · waiting for download...)\r" "$((attempt * 3))" >&2
    done

    if [ "$DL_OK" != "true" ]; then
      echo "[!] No fresh image found — Gemini may have responded with text only"
      exit 1
    fi

    # Auto-delete the conversation to keep sidebar clean (unless --keep)
    if [ "$KEEP_CHAT" = "true" ]; then
      echo "[~] Keeping conversation (--keep)"
    else
      echo "[~] Cleaning up Gemini conversation..."
      sleep 1
      DEL_CMD_ID="del_${ID}"
      mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
      sleep 0.3
      _mqtt_start=$(date +%s%3N)
      DEL_RESULT=$(timeout 10 mosquitto_sub -t 'claude/browser/response' -C 1 -W 8 2>/dev/null < <(
        sleep 0.5
        mosquitto_pub -t 'claude/browser/command' \
          -m "{\"action\":\"delete_chat\",\"tabId\":$TAB_ID,\"id\":\"${DEL_CMD_ID}\",\"ts\":$(date +%s%3N)}"
      ) 2>/dev/null || echo "{}")
      mqtt_log "delete_chat" "claude/browser/response" "$DEL_OK" "$(( $(date +%s%3N) - _mqtt_start ))"
      DEL_OK=$(echo "$DEL_RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('success') else d.get('error','unknown'))" 2>/dev/null || echo "failed")
      if [ "$DEL_OK" = "ok" ]; then
        echo "[OK] Conversation deleted"
      else
        echo "[~] Auto-delete skipped ($DEL_OK) — manual cleanup may be needed"
      fi
    fi
  fi
  exit 0
else
  echo ""
  echo "[!] Timeout (90s)"
  exit 1
fi
