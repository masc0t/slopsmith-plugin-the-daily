<#
Windows PowerShell launcher for Playwright e2e tests (The Daily)
This mirrors the CI flow: install dependencies, install browsers, run tests.
Requires Node.js and npm to be installed and accessible from PATH.
#>
$ErrorActionPreference = 'Stop'

Write-Host '== The Daily E2E (PowerShell) =='

Write-Host '1) Installing dependencies...'
npm install

Write-Host '2) Installing Playwright browsers (with dependencies if available)...'
npx playwright install --with-deps

Write-Host '3) Running Playwright tests...'
npm run test:e2e

Write-Host 'Done.'
