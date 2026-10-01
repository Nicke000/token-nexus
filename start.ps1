# TOKEN NEXUS - Global Token Observatory  (PowerShell launcher, optional)
#
# ASCII-only on purpose: Windows PowerShell reads BOM-less .ps1 files using the
# system ANSI code page, so a UTF-8 file containing Chinese gets mangled and can
# fail to parse at all. The Chinese UI lives in the web app, not in the launcher.
#
# Usage:  .\start.ps1
#         .\start.ps1 --port 8899 --no-open

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

Write-Host ''
Write-Host '  ======================================================'
Write-Host '    T O K E N   N E X U S'
Write-Host '    Global Token Observatory'
Write-Host '  ======================================================'
Write-Host ''

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '  [x] Node.js was not found.' -ForegroundColor Red
  Write-Host ''
  Write-Host '      1. Install Node.js 22.15 or newer:  https://nodejs.org/'
  Write-Host '      2. During setup, make sure "Add to PATH" is checked.'
  Write-Host '      3. Run this script again.'
  Write-Host ''
  Read-Host '  Press Enter to exit'
  exit 1
}

$version = node -p "process.versions.node"
$major = [int]($version.Split('.')[0])
$minor = [int]($version.Split('.')[1])
Write-Host "  Node.js v$version"
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 15)) {
  Write-Host '  [!] Version is a bit old: reading zstd session logs needs 22.15+.' -ForegroundColor Yellow
  Write-Host '      Those sources will be skipped, everything else still works.'
}
Write-Host ''
Write-Host '  Starting... first scan takes about 30 seconds.'
Write-Host '  The browser opens automatically at http://127.0.0.1:8787'
Write-Host '  Keep this window open. Close it to stop the server.'
Write-Host ''

node server.mjs @args
$code = $LASTEXITCODE

Write-Host ''
if ($code -ne 0) {
  Write-Host "  Server exited with code $code." -ForegroundColor Red
  Write-Host ''
  Write-Host '  If the port is already in use, try another one:'
  Write-Host '      node server.mjs --port 8899'
  Write-Host '  See all options with:'
  Write-Host '      node server.mjs --help'
  Write-Host ''
}
Read-Host '  Press Enter to exit'
exit $code
