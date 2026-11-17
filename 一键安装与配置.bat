@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=

echo ==================================================
echo   星语汉化集成套件 · 一键安装与配置 (Antigravity 2.32.2)
echo ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装 Node.js 22+ 后重试。
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo [1/4] 正在安装根工程依赖 (Electron 运行时)...
  call npm ci
  if errorlevel 1 (
    echo [警告] npm ci 失败，尝试使用 npm install...
    call npm install
    if errorlevel 1 (
      pause
      exit /b 1
    )
  )
) else (
  echo [1/4] 根工程 Electron 依赖已就绪。
)

if not exist "localization\node_modules\@electron\asar" (
  echo [2/4] 正在安装汉化引擎依赖 (@electron/asar)...
  pushd localization
  call npm install
  popd
) else (
  echo [2/4] 汉化引擎依赖已就绪。
)

echo [3/4] 正在编译 Windows 原生窗口跟随与连接辅助程序...
powershell -NoProfile -ExecutionPolicy Bypass -File tools\build-native.ps1
if errorlevel 1 (
  echo [错误] 原生辅助程序编译失败，请确认 Windows .NET Framework 4.x 可用。
  pause
  exit /b 1
)

echo [4/4] 正在安装 Antigravity 2.32.2 中文补丁、哈基米原生桌宠、WSL 插件并配置本机 CDP...
node suite-cli.js install
echo.
echo 安装配置流程结束！之后可直接双击「一键启动套件.bat」启动全部功能（桌宠右键双击即可弹出 Gemini 输入框）。
pause
