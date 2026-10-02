@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Creates a desktop shortcut "TOKEN NEXUS" -> start.vbs (via wscript.exe),
rem  using icon.ico. Run this once; after that just double-click the desktop icon.
rem
rem  The shortcut deliberately does NOT point at start.bat: that one keeps a
rem  console window around, and closing it by accident kills the server. The
rem  .vbs launcher starts the server hidden, so the dashboard window is the only
rem  thing on screen - close it and the server exits by itself.
rem
rem  Pure ASCII on purpose: cmd.exe parses .bat files with the *console* code
rem  page, so UTF-8 Chinese in here breaks on a GBK console. See start.bat.
rem ---------------------------------------------------------------------------

title TOKEN NEXUS - create desktop shortcut

if not exist "%~dp0start.vbs" goto MISSING
if not exist "%~dp0icon.ico" goto MISSING

echo.
echo   T O K E N   N E X U S
echo   Creating desktop shortcut...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$d = Split-Path -Parent '%~f0';" ^
 "$lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'TOKEN NEXUS.lnk';" ^
 "$w = New-Object -ComObject WScript.Shell;" ^
 "$s = $w.CreateShortcut($lnk);" ^
 "$s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe';" ^
 "$s.Arguments = [char]34 + (Join-Path $d 'start.vbs') + [char]34;" ^
 "$s.WorkingDirectory = $d;" ^
 "$s.IconLocation = (Join-Path $d 'icon.ico') + ',0';" ^
 "$s.Description = 'TOKEN NEXUS - Global Token Observatory';" ^
 "$s.Save();" ^
 "Write-Host ('  [OK] ' + $lnk)"

if errorlevel 1 goto FAILED

echo.
echo   Done. Double-click "TOKEN NEXUS" on your desktop to open the dashboard.
echo   No console window this time - closing the dashboard window stops it.
echo.
pause
exit /b 0

:MISSING
echo.
echo   [X] start.vbs or icon.ico is missing next to this file.
echo       Run this from the folder you cloned the project into.
echo.
pause
exit /b 1

:FAILED
echo.
echo   [X] Could not create the shortcut automatically. Do it by hand:
echo       right-click start.vbs  -^>  Send to  -^>  Desktop (create shortcut)
echo       then right-click the shortcut -^> Properties -^> Change Icon
echo       and pick icon.ico from this folder.
echo.
pause
exit /b 1
