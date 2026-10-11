#!/bin/bash
# gemini-status.sh — Check Gemini Proxy connection status
# Usage: ./gemini-status.sh

echo "=== Gemini Proxy Status ==="
echo ""

# Broker
if ss -tlnp 2>/dev/null | grep -q ':9001'; then
  echo "[OK] MQTT Broker: port 9001 open"
else
  echo "[!!] MQTT Broker: port 9001 NOT listening"
  echo "     Fix: sudo systemctl restart mosquitto"
fi

if ss -tlnp 2>/dev/null | grep -q ':1883'; then
  echo "[OK] MQTT Broker: port 1883 open"
else
  echo "[!!] MQTT Broker: port 1883 NOT listening"
fi

echo ""

# Extension status
STATUS=$(mosquitto_sub -t 'claude/browser/status' -C 1 -W 3 2>/dev/null || echo '{"status":"timeout"}')
ONLINE=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('status','unknown'))" 2>/dev/null || echo "unknown")
VERSION=$(echo "$STATUS" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('version','?'))" 2>/dev/null || echo "?")

if [ "$ONLINE" = "online" ]; then
  echo "[OK] Extension: online (v$VERSION)"
else
  echo "[!!] Extension: $ONLINE"
  echo "     Fix: Reload extension in chrome://extensions/"
fi

echo ""

# Gemini tab — use list_tabs (live) instead of retained state topic (stale)
# Race-condition fix (#7): increased sub→pub delay + retry
DIAG=$(mktemp)
_status_ping() {
  local sid="$1" delay="$2"
  mosquitto_pub -t 'claude/browser/response' -r -n 2>/dev/null
  sleep 0.3
  # T2890: several proxy instances answer list_tabs (T2406). Taking the FIRST message (-C 1, no id filter) reported
  # "not detected" while the instance holding the Gemini tab answered later. Same rule as gemini-gen.sh: collect up
  # to 5 replies for THIS id within 12 s, prefer one holding a gemini tab, else any live reply.
  local tmp; tmp=$(mktemp)
  timeout 14 mosquitto_sub -t 'claude/browser/response' -C 5 -W 12 2>/dev/null < <(
    sleep "$delay"
    mosquitto_pub -t 'claude/browser/command' -m "{\"action\":\"list_tabs\",\"id\":\"${sid}\",\"ts\":$(date +%s%3N)}"
  ) > "$tmp" 2>/dev/null || true
  TABS_RESULT=$(python3 -c "
import json, sys
got = []
for line in open(sys.argv[1]):
    try:
        d = json.loads(line)
        if d.get('id') == sys.argv[2]: got.append(d)
    except Exception: pass
g = [d for d in got if any(t.get('platform') == 'gemini' for t in d.get('tabs', []))]
if g:
    d = dict(g[0]); d['tabs'] = [t for t in d['tabs'] if t.get('platform') == 'gemini']; d['count'] = len(d['tabs'])
    print(json.dumps(d))
elif got: print(json.dumps(dict(got[0], count=0, tabs=[])))
else: print('{}')
print(f'replies={len(got)} with_gemini={len(g)}', file=sys.stderr)
" "$tmp" "$sid" 2>>"$DIAG")
  rm -f "$tmp"
}
_status_ping "status_$(date +%s)" 1
TAB_COUNT=$(echo "$TABS_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo "0")
if ! [ "$TAB_COUNT" -gt 0 ] 2>/dev/null; then
  echo "[~] Tab check missed — retrying..."
  sleep 1
  _status_ping "status_$(date +%s)_retry" 1.5
fi
TAB_COUNT=$(echo "$TABS_RESULT" | python3 -c "import sys,json; print(json.loads(sys.stdin.read()).get('count',0))" 2>/dev/null || echo "0")
[ -s "$DIAG" ] && echo "     ($(tr '\n' ' ' < "$DIAG"))"; rm -f "$DIAG"
TAB_INFO=$(echo "$TABS_RESULT" | python3 -c "
import sys,json
d = json.loads(sys.stdin.read())
tabs = d.get('tabs', [])
for t in tabs:
    print(f\"  tab:{t.get('id','?')} — {t.get('title','?')[:50]}\")
" 2>/dev/null || echo "")

if [ "$TAB_COUNT" -gt 0 ] 2>/dev/null; then
  echo "[OK] Gemini Tab: $TAB_COUNT tab(s) detected"
  echo "$TAB_INFO"
else
  echo "[!!] Gemini Tab: not detected"
  echo "     Fix: Open gemini.google.com in Chrome"
fi

echo ""
echo "=== Topics ==="
echo "Monitor: mosquitto_sub -t 'claude/browser/#' -v"
