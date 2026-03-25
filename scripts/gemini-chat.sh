#!/bin/bash
# gemini-chat.sh — Send a message to Gemini and get the response
# Usage: ./gemini-chat.sh "Your question here" [timeout_seconds]

set -euo pipefail

TEXT="${1:?Usage: gemini-chat.sh \"Your message\" [timeout_seconds]}"
TIMEOUT="${2:-30}"
ID="chat_$(date +%s)"

# Send chat
echo "[>] Sending to Gemini..."
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\",\"ts\":$(date +%s%3N)}"

# Wait for response
echo "[~] Waiting for Gemini (${TIMEOUT}s)..."
sleep 2

WAIT_ID="wait_${ID}"
TIMEOUT_MS=$((TIMEOUT * 1000))

# Subscribe for answer in background
ANSWER_FILE=$(mktemp)
(mosquitto_sub -t 'claude/browser/answer' -C 1 -W "$((TIMEOUT + 5))" > "$ANSWER_FILE" 2>/dev/null) &
SUB_PID=$!

# Send wait command
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"wait_response\",\"timeout\":${TIMEOUT_MS},\"id\":\"${WAIT_ID}\",\"ts\":$(date +%s%3N)}"

wait $SUB_PID 2>/dev/null || true

if [ -s "$ANSWER_FILE" ]; then
  echo ""
  echo "[<] Gemini says:"
  echo "---"
  python3 -c "
import sys, json
data = json.loads(open('$ANSWER_FILE').read())
print(data.get('answer', json.dumps(data, indent=2)))
"
  echo "---"
else
  echo "[!] No answer received. Check if Gemini tab is active."
fi

rm -f "$ANSWER_FILE"
