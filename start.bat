@echo off
REM ============================================================
REM  RecruitFlow - one-click launcher (Windows)
REM  Double-click this file to start RecruitFlow on your laptop.
REM  It installs what it needs the first time (one-time, ~2 min).
REM ============================================================
cd /d "%~dp0"
title RecruitFlow
echo Starting RecruitFlow...
echo.

REM ---- 1. Make sure Node.js is available ----
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo.
  echo Please install Node.js 22 from https://nodejs.org
  echo  - Download the "LTS" Windows Installer ^(.msi^), run it, then double-click this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo Using Node: %%v

REM ---- 2. Install dependencies the first time ----
if not exist node_modules (
  echo Installing app components ^(one-time, downloads a headless browser - a few min^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Install failed - check your internet connection and try again.
    pause
    exit /b 1
  )
)

REM ---- 3. Start the app and open the dashboard ----
echo.
echo Launching dashboard... a browser tab will open at http://localhost:3000
start "" "http://localhost:3000"
echo.
echo ============================================================
echo  RecruitFlow is running. Keep this window OPEN while you use it.
echo  Close this window (or press Ctrl+C) to stop RecruitFlow.
echo ============================================================
node server.js
pause
