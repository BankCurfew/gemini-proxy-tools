#!/usr/bin/env bash
# Real-ESRGAN x2 on the local RTX GPU (T2902). Usage: upscale.sh IN [IN ...] [--fit 1080x1920] [--out DIR]
# Example (Gemini 9:16 plate → reel size): upscale.sh plate.png --fit 1080x1920
set -eu
PY=~/.oracle/tools/realesrgan/venv/bin/python
[ -x "$PY" ] || { echo "no venv at ~/.oracle/tools/realesrgan · fix: ask dev (T2902) to reinstall"; exit 1; }
exec "$PY" -I "$(dirname "$(readlink -f "$0")")/upscale.py" "$@"
