@echo off
title Switchboard
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Opening the download page - install the LTS version, then run this file again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
if not exist "node_modules\electron" (
  echo Installing Switchboard - first run only, takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
exit /b 0
