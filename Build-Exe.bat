@echo off
cd /d "%~dp0"
if not exist "node_modules\electron" call npm install --no-audit --no-fund
call npm run dist
echo.
echo Done. Your exe is in the "dist" folder: Switchboard.exe
pause
