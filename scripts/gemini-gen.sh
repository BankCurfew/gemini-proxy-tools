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
  # T2890: -C counts EVERY message on the topic; an old proxy copy (no instance, leaks a client per ~30 s) sends
  # one empty reply per connection, so 5 of them could fill -C 5 before the instance with the tab answers (~3 s).
  timeout 12 mosquitto_sub -t 'claude/browser/response' -C 20 -W 10 2>/dev/null < <(
    sleep "$delay"
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"${attempt_id}\",\"ts\":$(date +%s%3N)}"
  ) > "$_ptmp" 2>/dev/null || true
  PING=$(python3 -c "
import json
got = []
for line in open('${_ptmp}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${attempt_id}': got.append(d)
    except: pass
# T2406: several proxy instances reply; prefer the one holding a Gemini tab, else any live reply (-> 'No Gemini tab found',
# not 'Extension offline': an online extension with no Gemini tab is a different state)
g = [d for d in got if any(t.get('platform')=='gemini' for t in d.get('tabs', []))]
live = [d for d in got if d.get('success')]
if g or live: print(json.dumps((g or live)[0]))
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
tabs = [t for t in d.get('tabs', []) if t.get('platform') == 'gemini']   # T2406: never a ChatGPT tab
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
  # T2890: mqtt-call.py waits for THIS id's ok reply; error replies from copies without the tab no longer end the wait
  python3 "$SCRIPT_DIR/mqtt-call.py" --timeout 30 --need answer "{\"action\":\"get_response\",\"tabId\":$TAB_ID,\"id\":\"${gid}\"}" > "$_gtmp" 2>/dev/null || true
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
# a 90s poll that could never succeed. Check for an error. T2406: several proxy
# instances share the broker and the ones that do not hold the tab used to answer
# "No tab with id" first; the reply without an error wins now, and a truly gone
# tab is a clear failure (one-tab rule: no new_tab self-heal).
_send_chat() {
  local cid="$1" tid="$2" new_chat="$3"
  local extra=",\"tabId\":$tid"
  [ "$new_chat" = "true" ] && extra="$extra,\"newChat\":true"
  local _ctmp=$(mktemp)
  # T2890: was -C 6 -W 6. The tab-holding instance answers a tab command in ~4-26 s (live 11 Oct: get_response 4.2 s,
  # navigate 25.7 s); an old proxy copy's "No tab with id" errors (one per leaked client) filled the 6 slots
  python3 "$SCRIPT_DIR/mqtt-call.py" --timeout 60 \
    "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${cid}\"${extra}}" > "$_ctmp" 2>/dev/null || true
  python3 -c "
import json
# T2406: other proxy instances answer 'No tab with id' for a tab they do not hold; prefer the reply without an error
got = []
for line in open('${_ctmp}'):
    try:
        d=json.loads(line.strip())
        if d.get('id')=='${cid}': got.append(d)
    except: pass
ok = [d for d in got if not d.get('error')]
print(json.dumps(ok[0] if ok else got[0] if got else {}))
" 2>/dev/null || echo '{}'
  rm -f "$_ctmp"
}

CHAT_RESP=$(_send_chat "$ID" "$TAB_ID" "$NEW_CHAT")
CHAT_ERR=$(echo "$CHAT_RESP" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('error',''))" 2>/dev/null || echo "")

if [ -n "$CHAT_ERR" ]; then
  echo "[!] chat failed: $CHAT_ERR" >&2
  if echo "$CHAT_ERR" | grep -qi "no tab with id"; then
    # T2406 one-tab rule: no self-heal by opening a new tab (that used to leave extra tabs, once per proxy instance)
    echo "[!] the Gemini tab is gone. Open ONE gemini.google.com tab in bank's Chrome, then retry (no new tab is opened here)"
    exit 1
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
    # T2890: Windows PATH is no longer appended in this WSL, so a bare cmd.exe = exit 127 and set -e/pipefail ended the
    # script silently right here (designer 09:05). Absolute fallback; a real failure says so and how to fix it.
    CMD_EXE=$(command -v cmd.exe || echo /mnt/c/Windows/System32/cmd.exe)
    WIN_PROFILE=$(cd /tmp && "$CMD_EXE" /c "echo %USERPROFILE%" 2>/dev/null | tr -d '\r\n' || true)
    if [ -z "$WIN_PROFILE" ]; then
      echo "[!] cannot read the Windows profile path via $CMD_EXE — image was generated but not downloaded" >&2
      echo "fix: ls -la /mnt/c/Windows/System32/cmd.exe   (WSL interop must be on), then retry with --keep to re-fetch" >&2
      exit 1
    fi
    DL_DIR="$(wslpath "$WIN_PROFILE")/Downloads"
    DL_OK=false
    DL_FILENAME=""
    DL_START=$(date +%s)   # T2890: for the newest-file fallback below
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
    # T2890: 3 instant error replies from copies without the tab used to end this 122 s wait (-C 3)
    python3 "$SCRIPT_DIR/mqtt-call.py" --timeout 122 "{\"action\":\"download_images\",\"tabId\":$TAB_ID,\"id\":\"dl_${ID}\"}" > "$_dtmp" 2>/dev/null &
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
    # T2890 (11 Oct): Chrome :9222 saved the image as "download (N).jpg", not the name the extension reported
    # (its onDeterminingFilename hint is registered only after downloads.download() returns), so the exact-name
    # wait never matched while the image sat in Downloads. Fallback: the newest image there written since this
    # download started. Listed with cmd.exe dir: WSL's own listing of that folder hits an I/O error.
    # T2890 (11 Oct 09:24): one scan right after the 5 s wait missed a save that landed 2 s later
    # (designer r10-2, "download (22).jpg"); rescan every 3 s for up to LATE_SAVE_WAIT s.
    LATE_SAVE_WAIT=${LATE_SAVE_WAIT:-45}
    if [ -n "$DL_FILENAME" ] && [ ! -f "$NEWEST" ]; then
      NEWEST=""
      _late_end=$(( $(date +%s) + LATE_SAVE_WAIT ))
      while :; do
      [ -f "${DL_DIR}/${DL_FILENAME}" ] && { NEWEST="${DL_DIR}/${DL_FILENAME}"; break; }
      while IFS= read -r cand; do
        case "${cand,,}" in *.png|*.jpg|*.jpeg|*.webp) ;; *) continue;; esac
        f="${DL_DIR}/${cand}"
        if [ -f "$f" ] && [ "$(stat -c %Y "$f" 2>/dev/null || echo 0)" -ge "$DL_START" ]; then
          NEWEST="$f"; echo "[~] saved as '${cand}' (reported '${DL_FILENAME}')"; break
        fi
      done < <(cd /tmp && "$CMD_EXE" /c dir /b /a-d /o-d "$WIN_PROFILE\\Downloads" 2>/dev/null | tr -d '\r' | head -15)   # separate args: quotes inside one /c string reach cmd mangled
      [ -n "$NEWEST" ] && break
      [ "$(date +%s)" -ge "$_late_end" ] && break
      printf "  (waiting for the saved file...)\r" >&2
      sleep 3
      done
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
