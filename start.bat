@echo off
REM ============================================================
REM  RecruitFlow - one-click launcher (Windows)
REM  Shows each step. Reuses installed Chrome to skip a big
REM  one-time download.
REM ============================================================
cd /d "%~dp0"
title RecruitFlow
cls
echo ============================================================
echo    RecruitFlow - starting up
echo ============================================================

REM ---- [1/4] Node.js ----
echo.
echo [1/4] Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
  echo       Node.js is not installed.
  echo       Please install Node.js 22 ^(LTS^) from https://nodejs.org, then run this again.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do echo       OK Node %%v

REM ---- [2/4] Reuse installed Chrome (skips a ~200MB download) ----
echo.
echo [2/4] Looking for Google Chrome...
set "CHROME_PATH="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "CHROME_PATH=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if defined CHROME_PATH (
  set "PUPPETEER_SKIP_DOWNLOAD=true"
  echo       OK Found Chrome - reusing it ^(skips a big one-time download, much faster^).
) else (
  echo       ! Chrome not found - will download a browser once ^(~200MB; the slow bit^).
  echo         Tip: install Google Chrome first to make this near-instant.
)

REM ---- [3/4] Install components ----
echo.
echo [3/4] Installing app components... ^(first run only; watch the progress below^)
if not exist node_modules (
  call npm install --no-audit --no-fund --prefer-offline --loglevel=error --cache ".\.npm-cache"
  if errorlevel 1 (
    echo.
    echo       Install failed - check your internet and run this again.
    pause
    exit /b 1
  )
  echo       OK Components ready.
) else (
  echo       OK Already installed.
)

REM ---- [4/4] Launch ----
echo.
echo [4/4] Launching dashboard...
start "" "http://localhost:3000"
echo.
echo ============================================================
echo   RecruitFlow is running. Click the WhatsApp status and scan
echo   the QR (WhatsApp - Settings - Linked Devices - Link a Device).
echo   Keep this window OPEN. Close it (or Ctrl+C) to stop.
echo ============================================================
node server.js
pause
