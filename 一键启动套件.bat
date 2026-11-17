@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

rem 方案 A 默认启动：2.32.2 汉化自愈 + 桌面独立漂浮哈基米 + Dream Skin 织梦皮肤
rem 若只想单独启动桌面漂浮哈基米，请直接双击「启动桌面哈基米.cmd」
node suite-cli.js launch
if errorlevel 1 pause
