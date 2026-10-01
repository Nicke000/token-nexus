@echo off
setlocal
cd /d "%~dp0"

title TOKEN NEXUS

rem ---------------------------------------------------------------------------
rem  This launcher is deliberately 100%% ASCII.
rem  Batch files are parsed by cmd.exe using the *console* code page, so a UTF-8
rem  .bat full of Chinese text breaks on a GBK (936) console - and calling chcp
rem  mid-file makes cmd mis-read the remaining bytes. ASCII works everywhere.
rem ---------------------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 goto NO_NODE

for /f "delims=" %%v in ('node -p "process.versions.node"') do set "NODE_VER=%%v"

echo.
echo   ======================================================
echo     T O K E N   N E X U S
echo     Global Token Observatory
echo   ======================================================
echo.
echo   Node.js v%NODE_VER%
echo   Starting local server...
echo.
echo   - First scan reads all your logs and takes ~30 seconds.
echo   - The browser opens automatically at http://127.0.0.1:8787
echo   - Keep this window open. Close it to stop the server.
echo.

node server.mjs %*
set "EXITCODE=%ERRORLEVEL%"

echo.
if not "%EXITCODE%"=="0" (
  echo   Server exited with code %EXITCODE%.
  echo.
  echo   If it says the port is already in use, either close the other
  echo   instance or pick another port:
  echo.
  echo       node server.mjs --port 8899
  echo.
  echo   See all options with:
  echo.
  echo       node server.mjs --help
  echo.
) else (
  echo   Server stopped.
  echo.
)

pause
exit /b %EXITCODE%

:NO_NODE
echo.
echo   ======================================================
echo     T O K E N   N E X U S
echo   ======================================================
echo.
echo   [X] Node.js was not found.
echo.
echo       1. Install Node.js 22.15 or newer:  https://nodejs.org/
echo       2. During setup, make sure "Add to PATH" is checked.
echo       3. Run this file again.
echo.
echo   Already installed but still not found? Open a terminal in this
echo   folder and run:
echo.
echo       node server.mjs
echo.
pause
exit /b 1
