#!/usr/bin/env bash
# ig-post.sh — CLI for the IG bridge (ig-agent.mjs over MQTT). Like gemini-gen.sh: build the command, publish, wait for the reply.
#
#   ig-post.sh carousel <dir-or-files...> --user U --caption-file F [--ratio 4:5|1:1|original]   → PREPARE only (READY + screenshot)
#   ig-post.sh reel <video> --user U --caption-file F                                          → PREPARE only
#   ig-post.sh share <prepare-id>                                                               → posts the prepared job, reads it back
#   ig-post.sh abort                                                                            → closes the prepared tab, nothing posted
#   ig-post.sh edit <permalink> --user U --caption-file F                                       → edit caption + readback
#   ig-post.sh state
#
# Files: the browser can't read WSL paths → files are copied to a Windows staging dir and removed after share/abort/fail.
set -euo pipefail
HOST=localhost; TP="${IG_BRIDGE_TOPIC:-claude/browser/ig}"; CMD_T=$TP/command; RES_T=$TP/response
STAGE_ROOT="${IG_BRIDGE_STAGE:-/mnt/c/Users/mbank/AppData/Local/Temp/ig-bridge}"
die() { echo "ig-post: $*" >&2; exit 2; }

ACTION="${1:-}"; shift || true
USER_="" CAPFILE="" RATIO="4:5" POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --user) USER_="$2"; shift 2;;
    --caption-file) CAPFILE="$2"; shift 2;;
    --ratio) RATIO="$2"; shift 2;;
    -h|--help) sed -n 2,12p "$0"; exit 0;;
    *) POS+=("$1"); shift;;
  esac
done

ID="ig-$(date +%Y%m%d-%H%M%S)-$$"
stage_files() {  # copy inputs (files or one dir) into the staging dir, print Windows paths one per line, sorted
  local dir="$STAGE_ROOT/$ID"; mkdir -p "$dir"
  local list=()
  if [ ${#POS[@]} -eq 1 ] && [ -d "${POS[0]}" ]; then
    while IFS= read -r f; do list+=("$f"); done < <(find "${POS[0]}" -maxdepth 1 -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.mp4' -o -iname '*.mov' \) | sort)
  else list=("${POS[@]}"); fi
  [ ${#list[@]} -gt 0 ] || die "no input files"
  local i=0
  for f in "${list[@]}"; do
    [ -f "$f" ] || die "not a file: $f"
    i=$((i+1)); local dst; dst="$dir/$(printf '%02d' $i)-$(basename "$f")"
    cp "$f" "$dst"; wslpath -w "$dst"
  done
}
cleanup_stage() { [ -n "${1:-}" ] && rm -rf "${STAGE_ROOT:?}/$1"; }

send() {  # $1 = json payload, $2 = timeout seconds; prints the matching response
  local payload="$1" to="$2" id; id=$(jq -r .id <<<"$payload")
  local out; out=$(mktemp)
  timeout "$to" mosquitto_sub -h "$HOST" -t "$RES_T" -R > "$out" & local sp=$!
  sleep 0.5
  mosquitto_pub -h "$HOST" -t "$CMD_T" -m "$payload"
  local res=""
  while kill -0 $sp 2>/dev/null; do
    res=$(jq -c --arg id "$id" 'select(.id==$id)' "$out" 2>/dev/null | head -1)
    [ -n "$res" ] && break; sleep 1
  done
  kill $sp 2>/dev/null || true
  [ -n "$res" ] || res=$(jq -c --arg id "$id" 'select(.id==$id)' "$out" 2>/dev/null | head -1)
  rm -f "$out"
  [ -n "$res" ] || die "no response for $id within ${to}s (is pm2 ig-bridge running?)"
  echo "$res"
}

caption_json() { [ -f "$CAPFILE" ] || die "--caption-file required"; jq -Rs . < "$CAPFILE"; }

case "$ACTION" in
  carousel|reel)
    [ -n "$USER_" ] || die "--user required"
    CAP=$(caption_json)
    KEEP=0; trap '[ "$KEEP" = 1 ] || cleanup_stage "$ID"' EXIT   # any exit short of READY (incl. Ctrl-C/timeout) removes the staged copies
    trap 'exit 130' INT TERM
    mapfile -t WIN < <(stage_files)
    if [ "$ACTION" = carousel ]; then
      [ ${#WIN[@]} -le 20 ] || { die "${#WIN[@]} files > 20 (IG cap) — refused before upload"; }
      P=$(jq -nc --arg id "$ID" --arg u "$USER_" --arg r "$RATIO" --argjson c "$CAP" '$ARGS.positional as $f | {id:$id,action:"post_carousel",files:$f,ratio:$r,caption:$c,expectUser:$u}' --args "${WIN[@]}")
    else
      P=$(jq -nc --arg id "$ID" --arg u "$USER_" --arg f "${WIN[0]}" --argjson c "$CAP" '{id:$id,action:"post_reel",file:$f,ratio:"9:16",caption:$c,expectUser:$u}')
    fi
    R=$(send "$P" 240)
    echo "$R" | jq .
    [ "$(jq -r .state <<<"$R")" = READY ] || exit 1
    KEEP=1
    echo "READY — check the screenshot, then: $0 share $ID"
    ;;
  share)
    [ ${#POS[@]} -eq 1 ] || die "usage: share <prepare-id>"
    R=$(send "$(jq -nc --arg id "share-$$" --arg c "${POS[0]}" '{id:$id,action:"share",confirm:$c}')" 600)
    echo "$R" | jq .
    cleanup_stage "${POS[0]}"
    [ "$(jq -r .state <<<"$R")" = SHARED ] || exit 1
    ;;
  abort)
    R=$(send "$(jq -nc --arg id "abort-$$" '{id:$id,action:"abort"}')" 60)
    echo "$R" | jq .
    PREP=$(mosquitto_sub -h "$HOST" -t "$TP/state" -C 1 -W 3 2>/dev/null | jq -r '.id // empty' || true)
    [ -n "$PREP" ] && cleanup_stage "$PREP"
    ;;
  edit)
    [ ${#POS[@]} -eq 1 ] && [ -n "$USER_" ] || die "usage: edit <permalink> --user U --caption-file F"
    R=$(send "$(jq -nc --arg id "$ID" --arg p "${POS[0]}" --arg u "$USER_" --argjson c "$(caption_json)" '{id:$id,action:"edit_caption",permalink:$p,caption:$c,expectUser:$u}')" 180)
    echo "$R" | jq .
    [ "$(jq -r .ok <<<"$R")" = true ] || exit 1
    ;;
  state) send "$(jq -nc --arg id "state-$$" '{id:$id,action:"state"}')" 15 | jq . ;;
  *) sed -n 2,12p "$0"; exit 2;;
esac
