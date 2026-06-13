#!/bin/bash
# mqtt-log.sh — MQTT event logging wrapper
# Sources into chatgpt-gen.sh / gemini-gen.sh
# Log format: ISO_TIMESTAMP | action | topic | result | duration_ms
# Log file: ~/.oracle/logs/mqtt-events.log

MQTT_LOG_FILE="${MQTT_LOG_FILE:-$HOME/.oracle/logs/mqtt-events.log}"
MQTT_VERBOSE="${MQTT_VERBOSE:-false}"

# Ensure log directory exists
mkdir -p "$(dirname "$MQTT_LOG_FILE")" 2>/dev/null

# Log an MQTT event
# Usage: mqtt_log <action> <topic> <result> <duration_ms>
mqtt_log() {
  local action="$1" topic="$2" result="$3" duration_ms="$4"
  local ts
  ts=$(date '+%Y-%m-%dT%H:%M:%S.%3N%z')
  local line="${ts} | ${action} | ${topic} | ${result} | ${duration_ms}ms"
  echo "$line" >> "$MQTT_LOG_FILE" 2>/dev/null
  if [ "$MQTT_VERBOSE" = "true" ]; then
    echo "[mqtt] $line" >&2
  fi
}

# Wrapper: mosquitto_pub with logging
# Usage: mqtt_pub [mosquitto_pub args...]
# Returns: mosquitto_pub exit code
mqtt_pub() {
  local topic="" action="pub" retained=false
  local args=("$@")

  # Parse topic and flags from args
  local i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      -t) topic="${args[$((i+1))]}"; i=$((i+2));;
      -r) retained=true; i=$((i+1));;
      -n) action="pub-clear"; i=$((i+1));;
      *) i=$((i+1));;
    esac
  done

  [ "$retained" = "true" ] && [ "$action" = "pub-clear" ] && action="pub-clear-retained"

  local start_ms
  start_ms=$(date +%s%3N)
  mosquitto_pub "$@"
  local rc=$?
  local end_ms
  end_ms=$(date +%s%3N)
  local duration=$(( end_ms - start_ms ))

  local result="ok"
  [ $rc -ne 0 ] && result="error:rc=$rc"

  mqtt_log "$action" "$topic" "$result" "$duration"
  return $rc
}

# Wrapper: mosquitto_sub with logging
# Usage: mqtt_sub [mosquitto_sub args...]
# Returns: mosquitto_sub exit code, stdout passes through
mqtt_sub() {
  local topic="" wait_secs="" count=""
  local args=("$@")

  # Parse topic, -W, -C from args
  local i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      -t) topic="${args[$((i+1))]}"; i=$((i+2));;
      -W) wait_secs="${args[$((i+1))]}"; i=$((i+2));;
      -C) count="${args[$((i+1))]}"; i=$((i+2));;
      *) i=$((i+1));;
    esac
  done

  local start_ms
  start_ms=$(date +%s%3N)
  local output
  output=$(mosquitto_sub "$@")
  local rc=$?
  local end_ms
  end_ms=$(date +%s%3N)
  local duration=$(( end_ms - start_ms ))

  local result="ok"
  [ $rc -ne 0 ] && result="error:rc=$rc"
  [ -z "$output" ] && [ $rc -eq 0 ] && result="empty"

  local detail="sub"
  [ -n "$wait_secs" ] && detail="sub:W=${wait_secs}"
  [ -n "$count" ] && detail="${detail}:C=${count}"

  mqtt_log "$detail" "$topic" "$result" "$duration"

  # Pass output through
  [ -n "$output" ] && echo "$output"
  return $rc
}

# Wrapper: timeout + mosquitto_sub with logging
# Usage: mqtt_sub_timeout <timeout_secs> [mosquitto_sub args...]
mqtt_sub_timeout() {
  local timeout_secs="$1"
  shift
  local topic="" wait_secs="" count=""
  local args=("$@")

  local i=0
  while [ $i -lt ${#args[@]} ]; do
    case "${args[$i]}" in
      -t) topic="${args[$((i+1))]}"; i=$((i+2));;
      -W) wait_secs="${args[$((i+1))]}"; i=$((i+2));;
      -C) count="${args[$((i+1))]}"; i=$((i+2));;
      *) i=$((i+1));;
    esac
  done

  local start_ms
  start_ms=$(date +%s%3N)
  local output
  output=$(timeout "$timeout_secs" mosquitto_sub "$@")
  local rc=$?
  local end_ms
  end_ms=$(date +%s%3N)
  local duration=$(( end_ms - start_ms ))

  local result="ok"
  [ $rc -eq 124 ] && result="timeout:${timeout_secs}s"
  [ $rc -ne 0 ] && [ $rc -ne 124 ] && result="error:rc=$rc"
  [ -z "$output" ] && [ $rc -eq 0 ] && result="empty"

  mqtt_log "sub:timeout=${timeout_secs}" "$topic" "$result" "$duration"

  [ -n "$output" ] && echo "$output"
  return $rc
}
