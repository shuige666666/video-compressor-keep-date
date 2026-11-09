@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found. Please install Node.js and reopen this launcher.
  pause
  exit /b 1
)

echo Starting video compressor...
title Video Compressor - Close this window to stop
rem Open the browser only after the server is listening.
node "%~dp0server.mjs" --open
if errorlevel 1 (
  echo.
  echo [ERROR] Server failed. See the error above.
  pause
)
