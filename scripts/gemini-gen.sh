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

# Poll get_response until content changes (Option B detection).
# T1124/#18: a bare "content changed" check fires on Gemini's OWN transient
# "Creating your image..." loading text — that's the START of generation,
# not the end, and download_images then finds nothing ready for a long
# while after. Keep polling through that specific loading phrase. Real
# image generation was observed taking 90-150s+ end to end, not <90s.
echo "[~] Waiting for response (150s)..."
RESULT=""
SECONDS=0
while [ $SECONDS -lt 150 ]; do
  sleep 3
  CURRENT=$(_get_response "poll_${SECONDS}_$(date +%s%3N)")
  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$INIT_ANSWER" ] && ! echo "$CURRENT" | grep -qi "creating your image"; then
    RESULT="OK"
    break
  fi
  printf "(%ds)\r" "$SECONDS" >&2
done

if [ -n "$RESULT" ]; then
  echo ""
  echo "[OK] Response detected"

  if [ -n "$DL_PREFIX" ]; then
    # gemini-proxy-tools#18: nothing auto-downloads on its own — get_response's
    # "answer" text (used above just as a completion signal) settles to the
    # response bubble's leftover toolbar icon glyphs for image generations,
    # since images aren't text. Passively polling the Downloads folder for a
    # file that nothing ever triggers a save of always failed. Must actively
    # call `download_images` (already extracts real <img>/canvas/blob content
    # correctly) and wait on the exact filename it reports back.
    echo "[~] Fetching generated image(s)..."
    WIN_PROFILE=$(cmd.exe /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r\n')
    DL_DIR="$(wslpath "$WIN_PROFILE")/Downloads"
    DL_OK=false
    DL_FILENAME=""
    # "response detected" above fires on ANY text change, including Gemini's
    # own transient "Creating your image..." loading text — so the image can
    # still be mid-render here. download_images's blob_to_data conversion is
    # also independently slow and highly variable (observed 5s-90s+, at
    # least once >70s for a single call). Firing overlapping retries just
    # adds MORE concurrent conversion work on the same tab, competing for
    # its main thread — measured worse, not better. ONE call, one genuinely
    # long wait, no retry (a real failure here means try the whole script
    # again, not hammer this same call).
    _dtmp=$(mktemp)
    timeout 125 mosquitto_sub -t 'claude/browser/response' -C 3 -W 122 2>/dev/null < <(
      sleep 1
      mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"download_images\",\"tabId\":$TAB_ID,\"id\":\"dl_${ID}\",\"ts\":$(date +%s%3N)}"
    ) > "$_dtmp" 2>/dev/null &
    DL_BGPID=$!
    while kill -0 "$DL_BGPID" 2>/dev/null; do
      sleep 3
      printf "  (waiting for image conversion...)\r" >&2
    done
    wait "$DL_BGPID" 2>/dev/null || true
    DL_JSON=$(python3 -c "
import json
for line in open('${_dtmp}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='dl_${ID}':
            print(json.dumps(d)); break
    except: pass
" 2>/dev/null || echo '{}')
    rm -f "$_dtmp"
    DL_FILENAME=$(echo "$DL_JSON" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); dls=d.get('downloads') or []; print(dls[0]['filename'] if dls else '')" 2>/dev/null || echo "")

    if [ -n "$DL_FILENAME" ]; then
      # File write to disk lags slightly behind the extension's downloads API call
      for wait_attempt in 1 2 3 4 5; do
        [ -f "${DL_DIR}/${DL_FILENAME}" ] && break
        sleep 1
      done
      NEWEST="${DL_DIR}/${DL_FILENAME}"
    else
      NEWEST=""
    fi
    if [ -n "$NEWEST" ] && [ -f "$NEWEST" ]; then
      EXT="${NEWEST##*.}"
      TARGET="${DL_DIR}/${DL_PREFIX}.${EXT}"
      if [ "$NEWEST" != "$TARGET" ]; then
        mv "$NEWEST" "$TARGET" 2>/dev/null && echo "[OK] Renamed to ${DL_PREFIX}.${EXT}" || TARGET="$NEWEST"
      fi
      echo "[OK] Image: $TARGET"
      DL_OK=true
    fi

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
