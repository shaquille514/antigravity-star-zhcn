@echo off
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
where node >nul 2>nul && (node tools\launch.cjs hagemi & exit /b 0)
runtime\electron-45.1.0\electron.exe hagemi-pet\desktop\main.cjs
if errorlevel 1 pause
