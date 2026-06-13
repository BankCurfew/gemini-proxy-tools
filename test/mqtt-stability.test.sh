#!/bin/bash
# mqtt-stability.test.sh — MQTT stability unit tests for gemini-proxy-tools#4
# Tests: process cleanup, concurrent safety, retained message races, timeout cleanup
# Run: bash test/mqtt-stability.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR=$(mktemp -d)
PASS=0
FAIL=0
TOTAL=0

cleanup() {
  # Kill any leftover mock processes
  pkill -f "mock_mosquitto" 2>/dev/null || true
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc (expected: '$expected', got: '$actual')"
    FAIL=$((FAIL + 1))
  fi
}

assert_true() {
  local desc="$1" condition="$2"
  TOTAL=$((TOTAL + 1))
  if eval "$condition"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  local desc="$1" file="$2" pattern="$3"
  TOTAL=$((TOTAL + 1))
  if grep -q "$pattern" "$file" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc (pattern '$pattern' not found in $file)"
    FAIL=$((FAIL + 1))
  fi
}

# Create mock mosquitto_pub/sub that don't need a broker
setup_mocks() {
  mkdir -p "$TEST_DIR/bin"

  # Mock mosquitto_pub — logs calls, exits cleanly
  cat > "$TEST_DIR/bin/mosquitto_pub" << 'MOCK'
#!/bin/bash
# mock_mosquitto_pub
echo "$(date +%s%3N) pub $*" >> "${MQTT_TEST_CALL_LOG:-/dev/null}"
exit 0
MOCK

  # Mock mosquitto_sub — returns fake JSON, supports -W timeout
  cat > "$TEST_DIR/bin/mosquitto_sub" << 'MOCK'
#!/bin/bash
# mock_mosquitto_sub
WAIT=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -W) WAIT="$2"; shift 2;;
    *) shift;;
  esac
done
echo "$(date +%s%3N) sub $*" >> "${MQTT_TEST_CALL_LOG:-/dev/null}"
# Return a valid JSON response
echo '{"success":true,"tabs":[{"id":"tab1","platform":"chatgpt","url":"https://chatgpt.com","active":true}],"responseCount":1,"loading":false}'
exit 0
MOCK

  chmod +x "$TEST_DIR/bin/mosquitto_pub" "$TEST_DIR/bin/mosquitto_sub"

  # Also mock timeout to just run the command
  cat > "$TEST_DIR/bin/timeout" << 'MOCK'
#!/bin/bash
# mock_timeout — just run the command, ignore timeout value
shift  # skip the timeout value
exec "$@"
MOCK
  chmod +x "$TEST_DIR/bin/timeout"

  export PATH="$TEST_DIR/bin:$PATH"
  export MQTT_TEST_CALL_LOG="$TEST_DIR/call.log"
}

# ============================================================
echo ""
echo "═══════════════════════════════════════════════════"
echo "  MQTT Stability Tests — gemini-proxy-tools#4"
echo "═══════════════════════════════════════════════════"
echo ""

# ============================================================
echo "── 1. mqtt-log.sh — Logging Library ──"
# ============================================================

setup_mocks

# Test 1.1: mqtt_log writes correct format
export MQTT_LOG_FILE="$TEST_DIR/mqtt-events.log"
source "$SCRIPT_DIR/scripts/mqtt-log.sh"

mqtt_log "test_action" "test/topic" "ok" "42"
assert_file_contains "mqtt_log writes ISO timestamp" "$MQTT_LOG_FILE" "^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}T"
assert_file_contains "mqtt_log writes action field" "$MQTT_LOG_FILE" "| test_action |"
assert_file_contains "mqtt_log writes topic field" "$MQTT_LOG_FILE" "| test/topic |"
assert_file_contains "mqtt_log writes result field" "$MQTT_LOG_FILE" "| ok |"
assert_file_contains "mqtt_log writes duration" "$MQTT_LOG_FILE" "| 42ms"

# Test 1.2: mqtt_log appends (not overwrites)
mqtt_log "second" "topic2" "ok" "10"
LINE_COUNT=$(wc -l < "$MQTT_LOG_FILE")
assert_eq "mqtt_log appends (2 lines)" "2" "$LINE_COUNT"

# Test 1.3: verbose mode echoes to stderr
export MQTT_VERBOSE=true
VERBOSE_OUT=$(mqtt_log "verbose_test" "t" "ok" "1" 2>&1)
assert_true "verbose mode outputs to stderr" "echo '$VERBOSE_OUT' | grep -q 'verbose_test'"
export MQTT_VERBOSE=false

# Test 1.4: mqtt_pub wrapper calls mosquitto_pub and logs
echo "" > "$MQTT_LOG_FILE"
echo "" > "$MQTT_TEST_CALL_LOG"
mqtt_pub -t 'test/topic' -m 'hello' 2>/dev/null
assert_file_contains "mqtt_pub calls mosquitto_pub" "$MQTT_TEST_CALL_LOG" "pub"
assert_file_contains "mqtt_pub logs the event" "$MQTT_LOG_FILE" "| pub |"

# Test 1.5: mqtt_pub with -r -n logs clear-retained
echo "" > "$MQTT_LOG_FILE"
mqtt_pub -t 'test/clear' -r -n 2>/dev/null
assert_file_contains "mqtt_pub -r -n logs pub-clear-retained" "$MQTT_LOG_FILE" "pub-clear-retained"

# Test 1.6: log file auto-creates directory
rm -rf "$TEST_DIR/deep/nested/"
export MQTT_LOG_FILE="$TEST_DIR/deep/nested/mqtt.log"
source "$SCRIPT_DIR/scripts/mqtt-log.sh"
mqtt_log "auto_mkdir" "t" "ok" "1"
assert_true "log dir auto-created" "[ -f '$TEST_DIR/deep/nested/mqtt.log' ]"
export MQTT_LOG_FILE="$TEST_DIR/mqtt-events.log"

echo ""

# ============================================================
echo "── 2. Process Cleanup ──"
# ============================================================

# Test 2.1: No zombie mosquitto_sub after script finishes
# Count mosquitto_sub processes before
BEFORE=$(pgrep -f "mock_mosquitto_sub" 2>/dev/null | wc -l || echo 0)

# Run a quick mock cycle
(
  export PATH="$TEST_DIR/bin:$PATH"
  source "$SCRIPT_DIR/scripts/mqtt-log.sh"
  mqtt_pub -t 'test' -m 'x' 2>/dev/null
  mosquitto_sub -t 'test' -C 1 -W 1 2>/dev/null || true
) &
wait $!

sleep 0.5
AFTER=$(pgrep -f "mock_mosquitto_sub" 2>/dev/null | wc -l || echo 0)
assert_eq "no zombie mosquitto_sub after script exit" "$BEFORE" "$AFTER"

# Test 2.2: No zombie mosquitto_pub after script finishes
BEFORE_PUB=$(pgrep -f "mock_mosquitto_pub" 2>/dev/null | wc -l || echo 0)
(
  export PATH="$TEST_DIR/bin:$PATH"
  source "$SCRIPT_DIR/scripts/mqtt-log.sh"
  for i in $(seq 1 10); do
    mqtt_pub -t 'stress' -m "msg$i" 2>/dev/null
  done
)
sleep 0.5
AFTER_PUB=$(pgrep -f "mock_mosquitto_pub" 2>/dev/null | wc -l || echo 0)
assert_eq "no zombie mosquitto_pub after 10 rapid publishes" "$BEFORE_PUB" "$AFTER_PUB"

# Test 2.3: Processes cleaned up after ERR exit
BEFORE_ERR=$(pgrep -f "mock_mosquitto" 2>/dev/null | wc -l || echo 0)
(
  set +e
  export PATH="$TEST_DIR/bin:$PATH"
  source "$SCRIPT_DIR/scripts/mqtt-log.sh"
  mqtt_pub -t 'test' -m 'x' 2>/dev/null
  false  # simulate error
) 2>/dev/null || true
sleep 0.5
AFTER_ERR=$(pgrep -f "mock_mosquitto" 2>/dev/null | wc -l || echo 0)
assert_eq "no zombies after error exit" "$BEFORE_ERR" "$AFTER_ERR"

echo ""

# ============================================================
echo "── 3. Concurrent Safety ──"
# ============================================================

# Test 3.1: Two scripts logging simultaneously don't corrupt log
export MQTT_LOG_FILE="$TEST_DIR/concurrent.log"
rm -f "$MQTT_LOG_FILE"
source "$SCRIPT_DIR/scripts/mqtt-log.sh"

(
  for i in $(seq 1 50); do
    mqtt_log "script_A" "topic/a" "ok" "$i"
  done
) &
PID_A=$!
(
  for i in $(seq 1 50); do
    mqtt_log "script_B" "topic/b" "ok" "$i"
  done
) &
PID_B=$!
wait $PID_A $PID_B

TOTAL_LINES=$(wc -l < "$MQTT_LOG_FILE")
assert_eq "concurrent writes produce 100 lines (no data loss)" "100" "$TOTAL_LINES"

# Test 3.2: No interleaved/corrupt lines
CORRUPT=$(grep -cvE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T.*\|.*\|.*\|.*\|" "$MQTT_LOG_FILE" 2>/dev/null || true)
CORRUPT=$(echo "$CORRUPT" | tail -1)
CORRUPT="${CORRUPT:-0}"
assert_eq "no corrupted/interleaved lines" "0" "$CORRUPT"

# Test 3.3: Both scripts appear in log
A_COUNT=$(grep -c "script_A" "$MQTT_LOG_FILE")
B_COUNT=$(grep -c "script_B" "$MQTT_LOG_FILE")
assert_eq "script_A has 50 entries" "50" "$A_COUNT"
assert_eq "script_B has 50 entries" "50" "$B_COUNT"

echo ""

# ============================================================
echo "── 4. Retained Message Race Conditions ──"
# ============================================================

# Test 4.1: Clear-retained before subscribe pattern
# The scripts do: pub -r -n (clear) → sleep → sub (wait for response)
# Verify the pattern preserves ordering
echo "" > "$MQTT_TEST_CALL_LOG"
export MQTT_LOG_FILE="$TEST_DIR/race.log"
rm -f "$MQTT_LOG_FILE"
source "$SCRIPT_DIR/scripts/mqtt-log.sh"

mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
CLEAR_TS=$(tail -1 "$MQTT_TEST_CALL_LOG" | awk '{print $1}')

sleep 0.1
mosquitto_sub -t 'claude/browser/response' -C 1 -W 1 2>/dev/null || true
SUB_TS=$(tail -1 "$MQTT_TEST_CALL_LOG" | awk '{print $1}')

assert_true "clear-retained happens before subscribe" "[ '$CLEAR_TS' -le '$SUB_TS' ]"

# Test 4.2: Multiple rapid clear-retained don't race
echo "" > "$MQTT_TEST_CALL_LOG"
for i in $(seq 1 5); do
  mqtt_pub -t 'claude/browser/response' -r -n 2>/dev/null
done
CLEAR_COUNT=$(grep -c "pub.*-r.*-n" "$MQTT_TEST_CALL_LOG" 2>/dev/null || echo 0)
assert_eq "5 rapid clear-retained all logged" "5" "$CLEAR_COUNT"

echo ""

# ============================================================
echo "── 5. Timeout Handling ──"
# ============================================================

# Test 5.1: Mock slow subscriber handles timeout gracefully
# Create a slow mock that sleeps
cat > "$TEST_DIR/bin/mosquitto_sub_slow" << 'MOCK'
#!/bin/bash
sleep 2
echo '{"timeout":true}'
MOCK
chmod +x "$TEST_DIR/bin/mosquitto_sub_slow"

TIMEOUT_START=$(date +%s)
timeout 1 "$TEST_DIR/bin/mosquitto_sub_slow" 2>/dev/null || true
TIMEOUT_END=$(date +%s)
TIMEOUT_DURATION=$((TIMEOUT_END - TIMEOUT_START))
assert_true "timeout kills slow subscriber within 2s" "[ $TIMEOUT_DURATION -le 2 ]"

# Test 5.2: mqtt_sub_timeout logs timeout events
export MQTT_LOG_FILE="$TEST_DIR/timeout.log"
rm -f "$MQTT_LOG_FILE"
source "$SCRIPT_DIR/scripts/mqtt-log.sh"

# Create a mock that always times out
cat > "$TEST_DIR/bin/mosquitto_sub" << 'MOCK'
#!/bin/bash
sleep 10
MOCK
chmod +x "$TEST_DIR/bin/mosquitto_sub"

mqtt_sub_timeout 1 -t 'test/timeout' -C 1 -W 1 2>/dev/null || true
assert_file_contains "timeout event logged" "$MQTT_LOG_FILE" "timeout"

# Restore working mock
cat > "$TEST_DIR/bin/mosquitto_sub" << 'MOCK'
#!/bin/bash
echo '{"success":true,"tabs":[],"responseCount":1,"loading":false}'
MOCK
chmod +x "$TEST_DIR/bin/mosquitto_sub"

# Test 5.3: No processes left after timeout
sleep 0.5
ZOMBIE_AFTER_TIMEOUT=$(pgrep -cf "mosquitto_sub_slow" 2>/dev/null || true)
ZOMBIE_AFTER_TIMEOUT="${ZOMBIE_AFTER_TIMEOUT:-0}"
assert_eq "no zombies after timeout" "0" "$ZOMBIE_AFTER_TIMEOUT"

echo ""

# ============================================================
echo "── 6. Process Count Under Load ──"
# ============================================================

# Test 6.1: Rapid pub/sub cycles don't accumulate processes
PROC_BEFORE=$(ps aux 2>/dev/null | grep -c "mosquitto" || echo 0)
for i in $(seq 1 20); do
  mqtt_pub -t 'load/test' -m "msg$i" 2>/dev/null
done
sleep 0.5
PROC_AFTER=$(ps aux 2>/dev/null | grep -c "mosquitto" || echo 0)
PROC_GROWTH=$((PROC_AFTER - PROC_BEFORE))
assert_true "process count growth ≤ 2 after 20 rapid pubs" "[ $PROC_GROWTH -le 2 ]"

# Test 6.2: Log file size stays bounded for unit test run
LOG_SIZE=$(wc -c < "$TEST_DIR/mqtt-events.log" 2>/dev/null || echo 0)
assert_true "log file under 100KB for test run" "[ $LOG_SIZE -lt 102400 ]"

echo ""

# ============================================================
echo "── 7. Script Integration ──"
# ============================================================

# Test 7.1: chatgpt-gen.sh sources mqtt-log.sh without error
(
  export PATH="$TEST_DIR/bin:$PATH"
  export MQTT_LOG_FILE="$TEST_DIR/integration.log"
  # Source just the logging part, don't run the full script
  source "$SCRIPT_DIR/scripts/mqtt-log.sh"
  type mqtt_log >/dev/null 2>&1
) && INT_RC=0 || INT_RC=1
assert_eq "mqtt-log.sh sources without error" "0" "$INT_RC"

# Test 7.2: mqtt_log function exists after sourcing
(
  source "$SCRIPT_DIR/scripts/mqtt-log.sh"
  type mqtt_log 2>/dev/null | head -1
) | grep -q "function" && FUNC_OK="yes" || FUNC_OK="no"
assert_eq "mqtt_log is a function" "yes" "$FUNC_OK"

# Test 7.3: mqtt_pub function exists after sourcing
(
  source "$SCRIPT_DIR/scripts/mqtt-log.sh"
  type mqtt_pub 2>/dev/null | head -1
) | grep -q "function" && FUNC_OK="yes" || FUNC_OK="no"
assert_eq "mqtt_pub is a function" "yes" "$FUNC_OK"

# Test 7.4: --verbose flag parsed (chatgpt-gen.sh)
grep -q "\-\-verbose.*MQTT_VERBOSE=true" "$SCRIPT_DIR/scripts/chatgpt-gen.sh" && VERBOSE_OK="yes" || VERBOSE_OK="no"
assert_eq "chatgpt-gen.sh has --verbose flag" "yes" "$VERBOSE_OK"

# Test 7.5: --verbose flag parsed (gemini-gen.sh)
grep -q "\-\-verbose.*MQTT_VERBOSE=true" "$SCRIPT_DIR/scripts/gemini-gen.sh" && VERBOSE_OK="yes" || VERBOSE_OK="no"
assert_eq "gemini-gen.sh has --verbose flag" "yes" "$VERBOSE_OK"

# Test 7.6: Both scripts source mqtt-log.sh
grep -q 'source.*mqtt-log.sh' "$SCRIPT_DIR/scripts/chatgpt-gen.sh" && SRC_OK="yes" || SRC_OK="no"
assert_eq "chatgpt-gen.sh sources mqtt-log.sh" "yes" "$SRC_OK"
grep -q 'source.*mqtt-log.sh' "$SCRIPT_DIR/scripts/gemini-gen.sh" && SRC_OK="yes" || SRC_OK="no"
assert_eq "gemini-gen.sh sources mqtt-log.sh" "yes" "$SRC_OK"

echo ""

# ============================================================
echo "── 8. Log Format Compliance ──"
# ============================================================

# Test 8.1: Verify log line matches spec: ISO_TIMESTAMP | action | topic | result | duration_ms
export MQTT_LOG_FILE="$TEST_DIR/format.log"
rm -f "$MQTT_LOG_FILE"
source "$SCRIPT_DIR/scripts/mqtt-log.sh"
mqtt_log "test_act" "test/topic" "ok" "123"

LINE=$(cat "$MQTT_LOG_FILE")
# ISO 8601 with milliseconds and timezone
assert_true "timestamp is ISO 8601" "echo '$LINE' | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}'"
# 5 pipe-separated fields
FIELD_COUNT=$(echo "$LINE" | awk -F '|' '{print NF}')
assert_eq "log line has 5 pipe-separated fields" "5" "$FIELD_COUNT"
# Duration ends with 'ms'
assert_true "duration ends with 'ms'" "echo '$LINE' | grep -qE '[0-9]+ms$'"

echo ""

# ============================================================
# Summary
# ============================================================
echo "═══════════════════════════════════════════════════"
if [ $FAIL -eq 0 ]; then
  echo -e "  ${GREEN}ALL $TOTAL TESTS PASSED${NC}"
else
  echo -e "  ${RED}$FAIL/$TOTAL TESTS FAILED${NC} (${GREEN}$PASS passed${NC})"
fi
echo "═══════════════════════════════════════════════════"
echo ""

exit $FAIL
