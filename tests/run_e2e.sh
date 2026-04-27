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
npx playwright test || exit 2
