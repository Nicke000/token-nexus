@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Creates a desktop shortcut "TOKEN NEXUS" -> start.bat, using icon.ico and a
rem  minimized console window. Run this once; after that just double-click the
rem  desktop icon.
rem
rem  Pure ASCII on purpose: cmd.exe parses .bat files with the *console* code
rem  page, so UTF-8 Chinese in here breaks on a GBK console. See start.bat.
rem ---------------------------------------------------------------------------

title TOKEN NEXUS - create desktop shortcut

if not exist "%~dp0start.bat" goto MISSING
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
 "$s.TargetPath = Join-Path $d 'start.bat';" ^
 "$s.WorkingDirectory = $d;" ^
 "$s.IconLocation = (Join-Path $d 'icon.ico') + ',0';" ^
 "$s.Description = 'TOKEN NEXUS - Global Token Observatory';" ^
 "$s.WindowStyle = 7;" ^
 "$s.Save();" ^
 "Write-Host ('  [OK] ' + $lnk)"

if errorlevel 1 goto FAILED

echo.
echo   Done. Double-click "TOKEN NEXUS" on your desktop to open the dashboard.
echo   A console window stays minimized while it runs - closing that window
echo   stops the server.
echo.
pause
exit /b 0

:MISSING
echo.
echo   [X] start.bat or icon.ico is missing next to this file.
echo       Run this from the folder you cloned the project into.
echo.
pause
exit /b 1

:FAILED
echo.
echo   [X] Could not create the shortcut automatically. Do it by hand:
echo       right-click start.bat  -^>  Send to  -^>  Desktop (create shortcut)
echo       then right-click the shortcut -^> Properties -^> Change Icon
echo       and pick icon.ico from this folder.
echo.
pause
exit /b 1
