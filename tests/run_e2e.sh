#!/usr/bin/env bash
set -euo pipefail
DIR=$(cd "$(dirname "$0")"/.. && pwd)
echo "[e2e] Running Playwright tests in $DIR" 
cd "$DIR" || exit 1

# Install dependencies if needed (safe guard)
npm --version >/dev/null 2>&1 || { echo "npm not found in container"; exit 1; }
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

echo "Starting Playwright tests..."
npm run build-static || true
if command -v node >/dev/null 2>&1; then
  # Start a lightweight dev server on port 3000 for tests that need a running UI
  if ! pgrep -f "dev_server.js" > /dev/null; then
    node dev_server.js 3000 &
    SERVER_PID=$!
    echo "Dev server started with PID $SERVER_PID"
    sleep 1
  fi
fi
 npx playwright test || exit 2
 if [ -n "${SERVER_PID:-}" ]; then
  kill "$SERVER_PID" || true
 fi
