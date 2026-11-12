#!/bin/bash
set -e

cd "$(dirname "$0")"

command -v node > /dev/null || { echo "Node.js is not installed"; exit 1; }
command -v ffmpeg > /dev/null || echo "Warning: ffmpeg is not installed, no duration, no cut, no conversion"

[ -d node_modules ] || npm install --omit=dev

exec node src/server.js
