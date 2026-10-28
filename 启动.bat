@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [x] 没找到 node，请先安装 Node.js 后重试
  pause
  exit /b 1
)

echo 正在启动视频压缩器…
start "视频压缩器 - 服务窗口（关掉它就停止）" cmd /k node server.mjs
timeout /t 2 >nul
start "" http://localhost:4319
exit
