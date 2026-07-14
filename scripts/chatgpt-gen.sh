#!/bin/bash
# chatgpt-gen.sh — Generate image via ChatGPT/DALL-E
# Usage: ./chatgpt-gen.sh "prompt" [--new] [--download prefix] [--tab ID] [--cleanup]
# Default: reuse existing chat (--new only when changing context/project)
# Mirrors gemini-gen.sh but for ChatGPT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/mqtt-log.sh"

TEXT="${1:?Usage: chatgpt-gen.sh \"prompt\" [--new] [--download prefix] [--tab ID] [--cleanup] [--verbose]}"
shift
NEW_CHAT=false
DL_PREFIX=""
TAB_ID=""
CLEANUP_CHAT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW_CHAT=true; shift;;
    --keep) shift;; # deprecated, keep is now the default
    --cleanup) CLEANUP_CHAT=true; shift;;
    --tab) TAB_ID="$2"; shift 2;;
    --download) DL_PREFIX="${2:-chatgpt}"; shift 2;;
    --verbose) MQTT_VERBOSE=true; shift;;
    *) shift;;
  esac
done

ID="cgpt_$(date +%s)"

# Pre-flight: ping extension
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
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  _mqtt_start=$(date +%s%3N)
  INITIAL_COUNT=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null < <(
    sleep 1
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"chatgpt_get_state\",\"tabId\":$TAB_ID,\"id\":\"st_${ID}\",\"ts\":$(date +%s%3N)}"
  ) | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")
  mqtt_log "get_state" "claude/browser/response" "count=$INITIAL_COUNT" "$(( $(date +%s%3N) - _mqtt_start ))"
fi

# FIX 2: Capture existing image set BEFORE sending prompt (new-image guard)
PRE_IMG_COUNT=0
if [ -n "$DL_PREFIX" ] && [ "$NEW_CHAT" != "true" ]; then
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null; sleep 0.3
  PRE_IMG_DATA=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 8 2>/dev/null < <(
    sleep 0.5
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"chatgpt_get_images\",\"tabId\":$TAB_ID,\"id\":\"pre_${ID}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo "{}")
  PRE_IMG_COUNT=$(echo "$PRE_IMG_DATA" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo "0")
  echo "[pre] Existing images in chat: $PRE_IMG_COUNT"
elif [ -n "$DL_PREFIX" ]; then
  echo "[pre] New chat — pre-send image count: 0"
fi

# Send prompt
EXTRA=",\"tabId\":$TAB_ID"
[ "$NEW_CHAT" = "true" ] && EXTRA="$EXTRA,\"newChat\":true"
_mqtt_start=$(date +%s%3N)
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chatgpt_chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\"${EXTRA},\"ts\":$(date +%s%3N)}"
mqtt_log "chatgpt_chat" "claude/browser/command" "sent" "$(( $(date +%s%3N) - _mqtt_start ))"
echo "[>] Sent (initial responses: $INITIAL_COUNT)"

# Poll for response
SECONDS=0
RESULT=""
while [ $SECONDS -lt 120 ]; do
  POLL_ID="poll_$(date +%s%3N)"
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  _mqtt_start=$(date +%s%3N)
  R=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
    sleep 1
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"chatgpt_get_state\",\"tabId\":$TAB_ID,\"id\":\"${POLL_ID}\",\"ts\":$(date +%s%3N)}"
  ) 2>/dev/null || echo "{}")
  mqtt_log "poll" "claude/browser/response" "poll_${SECONDS}s" "$(( $(date +%s%3N) - _mqtt_start ))"
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
    # Check for DALL-E guardrail refusal before polling for images
    RESP_TEXT=$(echo "$R" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
text = d.get('lastResponse','') or d.get('responseText','') or ''
print(text[:500])
" 2>/dev/null || echo "")
    if echo "$RESP_TEXT" | grep -qiE '(violate.*guardrail|content policy|cannot generate|unable to create|I can.t create|not able to generate|against.*policy|image generation.*blocked|declined to generate)'; then
      echo "[!] DALL-E REFUSED — guardrail violation detected"
      echo "[!] Response: ${RESP_TEXT:0:200}"
      exit 1
    fi

    # Gate: re-verify extension is still alive before image polling
    _ping_attempt "gate_${ID}" 1
    if [ "$PING_OK" != "ok" ]; then
      echo "[RESULT:extension_offline]"
      echo "[!] EXTENSION OFFLINE — lost connection after prompt was sent"
      echo "[!] Fix: reload extension at chrome://extensions/ then retry"
      exit 1
    fi

    # FIX 1: Poll for NEW images (300s timeout, placeholder-aware)
    echo "[~] Waiting for DALL-E image to appear..."
    DL_OK=false
    OUTCOME=""
    IMG_WAIT=0
    IMG_TIMEOUT=300
    while [ $IMG_WAIT -lt $IMG_TIMEOUT ]; do
      IMG_CHK_ID="imgchk_${ID}_${IMG_WAIT}"
      mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
      sleep 0.3
      _mqtt_start=$(date +%s%3N)
      IMG_CHK=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
        sleep 0.5
        mosquitto_pub -t 'claude/browser/command' \
          -m "{\"action\":\"chatgpt_get_images\",\"tabId\":$TAB_ID,\"id\":\"${IMG_CHK_ID}\",\"ts\":$(date +%s%3N)}"
      ) 2>/dev/null || echo "{}")
      mqtt_log "get_images" "claude/browser/response" "check_${IMG_WAIT}s" "$(( $(date +%s%3N) - _mqtt_start ))"
      IMG_COUNT=$(echo "$IMG_CHK" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo "0")
      # Debug: log scan stats on first check and every 30s
      if [ $((IMG_WAIT % 30)) -eq 0 ]; then
        SCANNED=$(echo "$IMG_CHK" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'scanned={d.get(\"totalScanned\",\"?\")}')" 2>/dev/null || echo "")
        [ -n "$SCANNED" ] && echo "  [debug] ${SCANNED} count=${IMG_COUNT} pre=${PRE_IMG_COUNT}" >&2
      fi

      # FIX 2: Only trigger on NEW images (count > pre-send count)
      if [ "$IMG_COUNT" -gt "$PRE_IMG_COUNT" ] 2>/dev/null; then
        NEW_IMG_COUNT=$((IMG_COUNT - PRE_IMG_COUNT))
        echo "[~] Found $NEW_IMG_COUNT NEW image(s) (total: $IMG_COUNT, pre-send: $PRE_IMG_COUNT), downloading..."
        sleep 2

        # Download only NEW images — pass startIndex to skip pre-existing
        DL_CMD_ID="dl_${ID}"
        mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
        sleep 0.5
        _mqtt_start=$(date +%s%3N)
        DL_RESULT=$(timeout 20 mosquitto_sub -t 'claude/browser/response' -C 1 -W 18 2>/dev/null < <(
          sleep 0.5
          mosquitto_pub -t 'claude/browser/command' \
            -m "{\"action\":\"chatgpt_download_images\",\"prefix\":\"${DL_PREFIX}\",\"latest\":true,\"startIndex\":${PRE_IMG_COUNT},\"tabId\":$TAB_ID,\"id\":\"${DL_CMD_ID}\",\"ts\":$(date +%s%3N)}"
        ) 2>/dev/null || echo "{}")
        DL_COUNT=$(echo "$DL_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('downloaded',0))" 2>/dev/null || echo "0")
        mqtt_log "download" "claude/browser/response" "dl_count=$DL_COUNT" "$(( $(date +%s%3N) - _mqtt_start ))"
        if [ "$DL_COUNT" -gt 0 ] 2>/dev/null; then
          DL_OK=true
          OUTCOME="image_new"
        fi
        break
      fi

      # FIX 1: Check if DALL-E is still generating (placeholder/loading in DOM)
      IS_GENERATING=false
      if [ $((IMG_WAIT % 15)) -eq 0 ] && [ $IMG_WAIT -gt 0 ]; then
        GEN_CHK_ID="genchk_${ID}_${IMG_WAIT}"
        mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
        sleep 0.3
        GEN_STATE=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
          sleep 0.5
          mosquitto_pub -t 'claude/browser/command' \
            -m "{\"action\":\"chatgpt_get_state\",\"tabId\":$TAB_ID,\"id\":\"${GEN_CHK_ID}\",\"ts\":$(date +%s%3N)}"
        ) 2>/dev/null || echo "{}")
        STILL_LOADING=$(echo "$GEN_STATE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('True' if d.get('loading') else 'False')" 2>/dev/null || echo "False")
        if [ "$STILL_LOADING" = "True" ]; then
          IS_GENERATING=true
          echo "  [~] DALL-E still generating (loading=true at ${IMG_WAIT}s)..." >&2
        fi

        # Check for guardrail refusal (every 30s)
        if [ $((IMG_WAIT % 30)) -eq 0 ]; then
          GR_TEXT=$(echo "$GEN_STATE" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
print(d.get('lastResponse','') or d.get('responseText','') or '')
" 2>/dev/null || echo "")
          if echo "$GR_TEXT" | grep -qiE '(violate.*guardrail|content policy|cannot generate|unable to create|I can.t create|not able to generate|against.*policy|image generation.*blocked|declined to generate|similarity to third-party)'; then
            echo ""
            OUTCOME="refusal"
            echo "[RESULT:refusal]"
            echo "[!] DALL-E REFUSED — guardrail violation detected at ${IMG_WAIT}s"
            echo "[!] Response: ${GR_TEXT:0:200}"
            exit 1
          fi
        fi
      fi

      printf "(%ds · waiting for DALL-E · timeout %ds%s)\r" "$IMG_WAIT" "$IMG_TIMEOUT" "$([ "$IS_GENERATING" = "true" ] && echo ' · generating')" >&2
      sleep 5
      IMG_WAIT=$((IMG_WAIT + 5))
    done

    # FIX 3: Clear return types on failure
    if [ "$DL_OK" != "true" ] && [ -z "$OUTCOME" ]; then
      _ping_attempt "failchk_${ID}" 1
      if [ "$PING_OK" != "ok" ]; then
        OUTCOME="extension_offline"
        echo "[RESULT:extension_offline]"
        echo "[!] EXTENSION OFFLINE — count=0 because extension lost connection, NOT a DALL-E limit"
        echo "[!] Fix: reload extension at chrome://extensions/ then retry"
      else
        # Check if it was still generating when we timed out
        FINAL_STATE=$(timeout 8 mosquitto_sub -t 'claude/browser/response' -C 1 -W 6 2>/dev/null < <(
          sleep 0.5
          mosquitto_pub -t 'claude/browser/command' \
            -m "{\"action\":\"chatgpt_get_state\",\"tabId\":$TAB_ID,\"id\":\"final_${ID}\",\"ts\":$(date +%s%3N)}"
        ) 2>/dev/null || echo "{}")
        FINAL_LOADING=$(echo "$FINAL_STATE" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('True' if d.get('loading') else 'False')" 2>/dev/null || echo "False")
        if [ "$FINAL_LOADING" = "True" ]; then
          OUTCOME="timeout_still_generating"
          echo "[RESULT:timeout_still_generating]"
          echo "[!] DALL-E still generating after ${IMG_TIMEOUT}s — image may appear soon, check the tab"
        else
          OUTCOME="text_reply"
          echo "[RESULT:text_reply]"
          echo "[!] DALL-E responded with text only — no image generated"
          echo "[!] Check the ChatGPT tab to see the response"
        fi
      fi
      exit 1
    fi

    echo "[RESULT:image_new]"

    # Default: keep chat for reuse (--cleanup to delete)
    if [ "$CLEANUP_CHAT" != "true" ]; then
      echo "[~] Chat kept for reuse (use --cleanup to delete)"
    else
      echo "[~] Cleaning up ChatGPT conversation..."
      sleep 1
      DEL_CMD_ID="del_${ID}"
      mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
      sleep 0.3
      _mqtt_start=$(date +%s%3N)
      DEL_RESULT=$(timeout 10 mosquitto_sub -t 'claude/browser/response' -C 1 -W 8 2>/dev/null < <(
        sleep 0.5
        mosquitto_pub -t 'claude/browser/command' \
          -m "{\"action\":\"chatgpt_delete_chat\",\"tabId\":$TAB_ID,\"id\":\"${DEL_CMD_ID}\",\"ts\":$(date +%s%3N)}"
      ) 2>/dev/null || echo "{}")
      DEL_OK=$(echo "$DEL_RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('success') else d.get('error','unknown'))" 2>/dev/null || echo "failed")
      mqtt_log "delete_chat" "claude/browser/response" "$DEL_OK" "$(( $(date +%s%3N) - _mqtt_start ))"
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
