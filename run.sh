#!/usr/bin/env bash
# MuGo launcher for macOS / Linux. Double-click (macOS: rename to run.command) or run ./run.sh
set -e
cd "$(dirname "$0")"
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "Python 3 is required: https://www.python.org/downloads/"; exit 1; fi
if [ ! -d .venv ]; then
  echo "First run: setting up MuGo…"
  "$PY" -m venv .venv
fi
. .venv/bin/activate
# keep yt-dlp fresh (YouTube changes often); skipped silently when offline
pip install -q --disable-pip-version-check -U -r requirements.txt 2>/dev/null || echo "(offline — skipping updates)"
command -v ffmpeg >/dev/null || echo "⚠  ffmpeg not found. Install it: macOS 'brew install ffmpeg' · Ubuntu 'sudo apt install ffmpeg'"
exec python -m mugo.server "$@"
