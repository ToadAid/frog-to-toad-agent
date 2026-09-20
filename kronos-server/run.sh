#!/usr/bin/env bash
# Kronos forecast runner — one JSON request on stdin, one JSON response on stdout.
# Self-contained: runs THIS folder's venv python. The desk never imports Python.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x venv/bin/python ]; then
  echo '{"ok":false,"error":"kronos venv missing — run: cd kronos-server && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt (CPU torch: ./venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu)"}' >&2
  exit 1
fi

exec ./venv/bin/python forecast.py