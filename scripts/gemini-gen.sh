#!/bin/bash
# gemini-gen.sh — Generate image via Gemini
# Usage: ./gemini-gen.sh "image description" [--new] [--download prefix]
# Default: sends to current conversation in same tab. Use --new to start fresh conversation.

set -euo pipefail

TEXT="${1:?Usage: gemini-gen.sh \"image description\" [--new] [--download prefix]}"
shift
NEW_CHAT=false
DL_PREFIX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --new) NEW_CHAT=true; shift;;
    --download) DL_PREFIX="${2:-gemini}"; shift 2;;
    *) shift;;
  esac
done

ID="gen_$(date +%s)"

# Get initial response count from state stream
INITIAL_COUNT=$(mosquitto_sub -t 'claude/browser/state' -C 1 -W 3 2>/dev/null \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('responseCount',0))" 2>/dev/null || echo "0")

# Build and send chat command
EXTRA=""
[ "$NEW_CHAT" = "true" ] && EXTRA=",\"newChat\":true"
mosquitto_pub -t 'claude/browser/command' \
  -m "{\"action\":\"chat\",\"text\":$(printf '%s' "$TEXT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))'),\"id\":\"${ID}\"${EXTRA},\"ts\":$(date +%s%3N)}"
echo "[>] Sent (responses: $INITIAL_COUNT)"

# Single subscribe — stream state messages until responseCount increases
# No per-iteration process spawn, detects within ~2s of completion
RESULT=$(timeout 45 mosquitto_sub -t 'claude/browser/state' 2>/dev/null \
  | python3 -u -c "
import sys, json, time
start = time.time()
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        c = d.get('responseCount', 0)
        l = d.get('loading', False)
        elapsed = int(time.time() - start)
        if c > $INITIAL_COUNT and not l:
            print(f'OK {elapsed}s responses:{$INITIAL_COUNT}->{c}')
            sys.exit(0)
        print(f'\r[~] {elapsed}s loading={l} count={c}', end='', file=sys.stderr, flush=True)
    except: pass
" 2>&1)

if echo "$RESULT" | grep -q "^OK"; then
  echo ""
  echo "[OK] $RESULT"

  if [ -n "$DL_PREFIX" ]; then
    mosquitto_pub -t 'claude/browser/command' \
      -m "{\"action\":\"download_images\",\"prefix\":\"${DL_PREFIX}\",\"id\":\"dl_${ID}\",\"ts\":$(date +%s%3N)}"
    sleep 1
    DL=$(mosquitto_sub -t 'claude/browser/response' -C 1 -W 5 2>/dev/null \
      | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(f'Downloaded {d.get(\"downloaded\",0)} image(s)')" 2>/dev/null || echo "download sent")
    echo "[OK] $DL"
  fi
  exit 0
else
  echo ""
  echo "[!] Timeout (45s)"
  exit 1
fi
