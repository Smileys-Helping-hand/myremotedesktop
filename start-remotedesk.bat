@echo off
title RemoteDesk - Standalone Signaling Relay
cd /d "%~dp0"

echo ========================================================
echo   RemoteDesk - Standalone Signaling Relay
echo ========================================================
echo.
echo   The installed RemoteDesk app does NOT need this.
echo   It embeds its own signaling server.
echo.
echo   Run this only to host a rendezvous point for peers
echo   that cannot reach each other directly, or to let
echo   someone join from a browser with nothing installed.
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is required but was not found on PATH.
    echo Install it from https://nodejs.org/
    pause
    exit /b 1
)

if not exist "dist\index.html" (
    echo [INFO] Building the web client...
    call npm run build
)

echo [INFO] Starting the relay on port 4000...
start "" http://localhost:4000
call npx tsx server/index.ts

pause
