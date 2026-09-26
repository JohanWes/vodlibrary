#!/bin/bash
# VODlibrary startup script for KDE autostart (non-interactive).
set -euo pipefail

# Run from the repo root, wherever the repo lives (resolves symlinks).
cd "$(dirname "$(readlink -f "$0")")/.." || exit 1

# Keep one previous log instead of appending to an ever-growing file.
if [ -f server.log ]; then mv -f server.log server.log.1; fi
echo "Starting VODlibrary at $(date)" > server.log

exec npm start >> server.log 2>&1
