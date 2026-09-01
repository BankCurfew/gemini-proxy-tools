#!/bin/bash
# gemini-gen.sh — Generate image via Gemini (pinned to one tab)
# Usage: ./gemini-gen.sh "prompt" [--tab ID] [--new] [--download prefix] [--keep]
# Option B: polls chat + get_response (no new extension code needed)

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

# Pre-flight: ping extension with ID-filtered list_tabs
_ping_attempt() {
  local attempt_id="$1" delay="$2"
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  _mqtt_start=$(date +%s%3N)
  local _ptmp=$(mktemp)
  timeout 8 mosquitto_sub -t 'claude/browser/response' -C 5 -W 6 2>/dev/null < <(
    sleep "$delay"
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"${attempt_id}\",\"ts\":$(date +%s%3N)}"
  ) > "$_ptmp" 2>/dev/null || true
  PING=$(python3 -c "
import json
for line in open('${_ptmp}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${attempt_id}' and d.get('tabs'):
            print(json.dumps(d)); break
    except: pass
" 2>/dev/null || echo '{}')
  rm -f "$_ptmp"
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

# Resolve tab
if [ -z "$TAB_ID" ]; then
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

echo "[tab:$TAB_ID]"

# T032: capture gen-start timestamp for stale-download detection
GEN_START=$(date +%s)

# Get initial response text (before sending)
_get_response() {
  local gid="$1"
  local _gtmp=$(mktemp)
  timeout 8 mosquitto_sub -t 'claude/browser/response' -C 3 -W 6 2>/dev/null < <(
    sleep 1
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"get_response\",\"tabId\":$TAB_ID,\"id\":\"${gid}\",\"ts\":$(date +%s%3N)}"
  ) > "$_gtmp" 2>/dev/null || true
  python3 -c "
import json
for line in open('${_gtmp}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${gid}' and d.get('answer'):
            print(d['answer'][:200]); break
    except: pass
" 2>/dev/null || true
  rm -f "$_gtmp"
}

INIT_ANSWER=$(_get_response "init_${ID}")

# T1124: send chat and READ ITS OWN RESPONSE — a stale/phantom tab (Chrome's
# tabs.query and tabs.get can disagree during teardown) errors back in <1s
# ("No tab with id"), but the old code fired-and-forgot and fell through to
# a 90s poll that could never succeed. Check for an error, and self-heal by
# creating a genuinely fresh tab (chrome.tabs.create via `new_tab`) — --new
# alone only navigates the existing tab in place, it doesn't recreate a dead
# one.
_send_chat() {
  local cid="$1" tid="$2" new_chat="$3"
  local extra=",\"tabId\":$tid"
  [ "$new_chat" = "true" ] && extra="$extra,\"newChat\":true"
  local _ctmp=$(mktemp)
  timeout 8 mosquitto_sub -t 'claude/browser/response' -C 3 -W 6 2>/dev/null < <(
    sleep 1
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${cid}\"${extra},\"ts\":$(date +%s%3N)}"
  ) > "$_ctmp" 2>/dev/null || true
  python3 -c "
import json
for line in open('${_ctmp}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${cid}':
            print(json.dumps(d)); break
    except: pass
" 2>/dev/null || echo '{}'
  rm -f "$_ctmp"
}

CHAT_RESP=$(_send_chat "$ID" "$TAB_ID" "$NEW_CHAT")
CHAT_ERR=$(echo "$CHAT_RESP" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('error',''))" 2>/dev/null || echo "")

if [ -n "$CHAT_ERR" ]; then
  echo "[!] chat failed: $CHAT_ERR" >&2
  if echo "$CHAT_ERR" | grep -qi "no tab with id"; then
    echo "[~] Stale tab — creating a fresh one..." >&2
    NT_TMP=$(mktemp)
    timeout 8 mosquitto_sub -t 'claude/browser/response' -C 3 -W 6 2>/dev/null < <(
      sleep 1
      mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"new_tab\",\"id\":\"newtab_${ID}\",\"ts\":$(date +%s%3N)}"
    ) > "$NT_TMP" 2>/dev/null || true
    NEW_TAB_ID=$(python3 -c "
import json
for line in open('${NT_TMP}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='newtab_${ID}' and d.get('tabId'):
            print(d['tabId']); break
    except: pass
" 2>/dev/null || echo "")
    rm -f "$NT_TMP"
    if [ -z "$NEW_TAB_ID" ]; then
      echo "[!] Could not create a new tab — giving up"
      exit 1
    fi
    TAB_ID="$NEW_TAB_ID"
    echo "[tab:$TAB_ID] (recreated)"
    sleep 2 # let gemini.google.com finish loading before we type into it
    CHAT_RESP=$(_send_chat "$ID" "$TAB_ID" "false") # tab is already fresh, no newChat needed
    CHAT_ERR=$(echo "$CHAT_RESP" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('error',''))" 2>/dev/null || echo "")
    if [ -n "$CHAT_ERR" ]; then
      echo "[!] chat failed again on fresh tab: $CHAT_ERR"
      exit 1
    fi
  else
    exit 1
  fi
fi
echo "[>] Sent"

# Poll get_response until content changes (Option B detection)
echo "[~] Waiting for response (90s)..."
RESULT=""
SECONDS=0
while [ $SECONDS -lt 90 ]; do
  sleep 3
  CURRENT=$(_get_response "poll_${SECONDS}_$(date +%s%3N)")
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$INIT_ANSWER" ]; then
    RESULT="OK"
    break
  fi
  printf "(%ds)\r" "$SECONDS" >&2
done

if [ -n "$RESULT" ]; then
  echo ""
  echo "[OK] Response detected"

  if [ -n "$DL_PREFIX" ]; then
    echo "[~] Waiting for auto-download..."
    WIN_PROFILE=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r\n')
    DL_DIR="$(wslpath "$WIN_PROFILE")/Downloads"
    DL_OK=false
    for attempt in 1 2 3 4 5 6; do
      sleep 3
      NEWEST=$(find "$DL_DIR" -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.png' -o -name '*.webp' \) -newer "/proc/$$" 2>/dev/null | head -1)
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
        DL_OK=true
        break
      fi
      printf "  (%ds · waiting for download...)\r" "$((attempt * 3))" >&2
    done

    if [ "$DL_OK" != "true" ]; then
      echo "[!] No fresh image found — Gemini may have responded with text only"
      exit 1
    fi

    # Auto-delete conversation (unless --keep)
    if [ "$KEEP_CHAT" = "true" ]; then
      echo "[~] Keeping conversation (--keep)"
    else
      echo "[~] Cleaning up Gemini conversation..."
      sleep 1
      mosquitto_pub -t 'claude/browser/command' \
        -m "{\"action\":\"delete_chat\",\"tabId\":$TAB_ID,\"id\":\"del_${ID}\",\"ts\":$(date +%s%3N)}"
    fi
  fi
  exit 0
else
  echo ""
  echo "[!] Timeout (90s)"
  exit 1
fi
