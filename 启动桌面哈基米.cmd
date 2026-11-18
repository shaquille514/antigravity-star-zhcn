@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

where node >nul 2>nul
if errorlevel 1 goto check_runtime

node tools\launch.cjs hagemi
if errorlevel 1 (
  echo [错误] 启动桌面哈基米失败，请检查 Node.js 与 Electron 运行时是否完整。
  pause
  exit /b 1
)
exit /b 0

:check_runtime
if not exist "runtime\electron-45.1.0\electron.exe" (
  echo [错误] 未检测到 Node.js 或本地 Electron 运行时，请先执行「一键安装与配置.bat」。
  pause
  exit /b 1
)

runtime\electron-45.1.0\electron.exe hagemi-pet\desktop\main.cjs
if errorlevel 1 (
  echo [错误] 启动桌面哈基米失败，请检查依赖或重新运行「一键安装与配置.bat」。
  pause
  exit /b 1
)
exit /b 0

