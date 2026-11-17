@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

node suite-cli.js restore --restore-connection
echo.
pause
