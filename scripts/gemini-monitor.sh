#!/bin/bash
# gemini-monitor.sh — Real-time monitor of all Gemini Proxy MQTT traffic
# Usage: ./gemini-monitor.sh [topic_filter]
# Examples:
#   ./gemini-monitor.sh          # All traffic
#   ./gemini-monitor.sh response # Only responses
#   ./gemini-monitor.sh answer   # Only AI answers

FILTER="${1:-#}"

if [ "$FILTER" != "#" ]; then
  TOPIC="claude/browser/$FILTER"
else
  TOPIC="claude/browser/#"
fi

echo "=== Gemini Proxy Monitor ==="
echo "Topic: $TOPIC"
echo "Press Ctrl+C to stop"
echo "---"

mosquitto_sub -t "$TOPIC" -v | while IFS= read -r line; do
  TOPIC_NAME=$(echo "$line" | cut -d' ' -f1 | sed 's|claude/browser/||')
  PAYLOAD=$(echo "$line" | cut -d' ' -f2-)

  # Color by topic
  case "$TOPIC_NAME" in
    command)  COLOR="\033[36m";; # cyan
    response) COLOR="\033[32m";; # green
    answer)   COLOR="\033[33m";; # yellow
    state)    COLOR="\033[90m";; # gray
    status)   COLOR="\033[35m";; # magenta
    *)        COLOR="\033[0m";;
  esac

  TIMESTAMP=$(date +%H:%M:%S)
  printf "${COLOR}[%s] %-10s\033[0m %s\n" "$TIMESTAMP" "$TOPIC_NAME" "$PAYLOAD"
done
