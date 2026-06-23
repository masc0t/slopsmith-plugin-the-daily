#!/usr/bin/env pwsh
# Windows PowerShell script to run e2e tests for The Daily plugin
# Usage: ./tests/run_e2e.ps1

$ErrorActionPreference = "Stop"
$Dir = Split-Path -Parent $PSScriptRoot
Write-Host "[e2e] Running Playwright tests in $Dir" -ForegroundColor Cyan

Set-Location $Dir

# Check if npm is available
try {
    $npmVersion = npm --version 2>$null
    if (-not $?) { throw "npm not found" }
    Write-Host "npm version: $npmVersion" -ForegroundColor Green
} catch {
    Write-Host "npm not found. Please install Node.js first." -ForegroundColor Red
    exit 1
}

# Install dependencies if needed
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    npm install --silent
}

# Check if Playwright browsers are installed
$browserPath = "node_modules\playwright\browser-cache"
if (-not (Test-Path $browserPath)) {
    Write-Host "Installing Playwright browsers..." -ForegroundColor Yellow
    npx playwright install chromium
}

# Start a simple HTTP server for test pages
$serverScript = @"
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const ROOT = path.resolve(__dirname);

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
    let filePath = path.join(ROOT, req.url === '/' ? 'tests/test-pages/e2e_test.html' : req.url);
    
    // Security: prevent directory traversal
    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not found');
            } else {
                res.writeHead(500);
                res.end('Server error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(\`Dev server running at http://localhost:\${PORT}/\`);
});
"@

$serverScriptPath = Join-Path $Dir "tests\dev_server.js"
if (-not (Test-Path $serverScriptPath)) {
    Set-Content -Path $serverScriptPath -Value $serverScript -Encoding UTF8
}

# Start the dev server in background
Write-Host "Starting dev server..." -ForegroundColor Yellow
$serverJob = Start-Job -ScriptBlock {
    Set-Location $Using:Dir
    node "tests/dev_server.js"
}
Start-Sleep -Seconds 2

# Run the tests
Write-Host "Starting Playwright tests..." -ForegroundColor Cyan
try {
    npx playwright test
    $testResult = $LASTEXITCODE
} catch {
    Write-Host "Test execution failed: $_" -ForegroundColor Red
    $testResult = 1
}

# Clean up
Write-Host "Stopping dev server..." -ForegroundColor Yellow
Stop-Job $serverJob -ErrorAction SilentlyContinue
Remove-Job $serverJob -ErrorAction SilentlyContinue

# Report results
if ($testResult -eq 0) {
    Write-Host "[e2e] All tests passed! ✓" -ForegroundColor Green
} else {
    Write-Host "[e2e] Tests failed with exit code $testResult" -ForegroundColor Red
}

exit $testResult
