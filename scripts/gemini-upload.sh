#!/bin/bash
# gemini-upload.sh — Upload image/file to Gemini conversation
# Usage: ./gemini-upload.sh /path/to/image.png [--tab ID] [--chat "message after upload"]
# Attaches file to Gemini input, optionally sends a follow-up message.

set -euo pipefail

FILE="${1:?Usage: gemini-upload.sh /path/to/image.png [--tab ID] [--chat \"message\"]}"
shift
TAB_ID=""
CHAT_MSG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tab) TAB_ID="$2"; shift 2;;
    --chat) CHAT_MSG="$2"; shift 2;;
    *) shift;;
  esac
done

if [ ! -f "$FILE" ]; then
  echo "[!] File not found: $FILE"
  exit 1
fi

ID="upload_$(date +%s)"
FILENAME=$(basename "$FILE")
FILESIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE" 2>/dev/null || echo "0")

# Detect MIME type
case "${FILENAME,,}" in
  *.png) MIME="image/png";;
  *.jpg|*.jpeg) MIME="image/jpeg";;
  *.gif) MIME="image/gif";;
  *.webp) MIME="image/webp";;
  *.svg) MIME="image/svg+xml";;
  *.pdf) MIME="application/pdf";;
  *) MIME="application/octet-stream";;
esac

echo "[file] $FILENAME ($FILESIZE bytes, $MIME)"

# Base64 encode
B64=$(base64 -w0 "$FILE" 2>/dev/null || base64 "$FILE" 2>/dev/null)
B64_LEN=${#B64}
echo "[b64] $B64_LEN chars"

# Check MQTT message size (mosquitto default max is 256MB, but practical limit ~1MB for responsiveness)
if [ "$B64_LEN" -gt 5000000 ]; then
  echo "[!] File too large for MQTT (>~3.7MB raw). Consider resizing."
  exit 1
fi

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
cgpt = [t for t in tabs if 'gemini.google.com' in t.get('url','')]
print(cgpt[0]['id'] if cgpt else '')
" 2>/dev/null || echo "")
  if [ -z "$TAB_ID" ]; then
    echo "[!] No Gemini tab found"
    exit 1
  fi
fi
echo "[tab:$TAB_ID]"

# Send upload command
echo "[>] Uploading..."
mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
sleep 0.3

# Build JSON payload with base64 data
PAYLOAD=$(python3 -c "
import json, sys
data = sys.stdin.read()
print(json.dumps({
    'action': 'gemini_upload',
    'data': data,
    'filename': '$FILENAME',
    'mimeType': '$MIME',
    'tabId': $TAB_ID,
    'id': '${ID}',
    'ts': $(date +%s%3N)
}))
" <<< "$B64")

UPLOAD_RESULT=$(timeout 15 mosquitto_sub -t 'claude/browser/response' -C 1 -W 12 2>/dev/null < <(
  sleep 0.5
  echo "$PAYLOAD" | mosquitto_pub -t 'claude/browser/command' -s
) 2>/dev/null || echo "{}")

UPLOAD_OK=$(echo "$UPLOAD_RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print('ok' if d.get('success') else d.get('error','unknown'))" 2>/dev/null || echo "failed")

if [ "$UPLOAD_OK" = "ok" ]; then
  echo "[OK] File attached to Gemini input"

  # Send follow-up chat message if provided
  if [ -n "$CHAT_MSG" ]; then
    echo "[>] Sending message: ${CHAT_MSG:0:50}..."
    sleep 1
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$CHAT_MSG" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"tabId\":$TAB_ID,\"id\":\"chat_${ID}\",\"ts\":$(date +%s%3N)}"
    echo "[OK] Message sent with attached file"
  else
    echo "[~] File attached — type your message in Gemini to send with the image"
  fi
else
  echo "[!] Upload failed: $UPLOAD_OK"
  exit 1
fi
