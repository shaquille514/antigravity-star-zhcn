#!/usr/bin/env node
/**
 * 星语汉化集成套件统一 CLI (Antigravity Star ZhCN Suite)
 * 方案 A：整合 Antigravity 2.32.2 中文汉化 + 哈基米原生桌宠（含双击右键 Gemini 对话）+ 织梦玻璃壁纸皮肤 + 本机 CDP 一键连接（保留星语桌面挂件备用）。
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { discover } = require("./shared/host.cjs");
const { activeHostContext, hagemiInstallCommand } = require("./shared/active-host.cjs");

const ROOT_DIR = __dirname;
const LOCALIZATION_DIR = path.join(ROOT_DIR, "localization");
const LOCALIZATION_CLI = path.join(LOCALIZATION_DIR, "cli.js");
const HAGEMI_DIR = path.join(ROOT_DIR, "hagemi-pet");
const HAGEMI_DESKTOP_MAIN = path.join(HAGEMI_DIR, "desktop", "main.cjs");
const HAGEMI_INSTALL_SCRIPT = path.join(HAGEMI_DIR, "tools", "install-local.mjs");
const HAGEMI_PREVIEW_SCRIPT = path.join(HAGEMI_DIR, "tools", "preview.mjs");
const LAUNCH_SCRIPT = path.join(ROOT_DIR, "tools", "launch.cjs");
const FOREGROUND_EXE = path.join(ROOT_DIR, "Antigravity-Cat-Widget", "src", "native", "ForegroundHost.exe");
const HOST_CONNECT_EXE = path.join(ROOT_DIR, "tools", "native", "HostConnect.exe");

/**
 * 读取本地桌面漂浮版与 Sidecar 插件状态。
 */
function getHagemiStatus() {
  const configDir = activeHostContext().configDir;
  const geminiDir = path.dirname(configDir);
  const lockFile = path.join(geminiDir, "antigravity", "sidecar_data", "hagemi-pet-agy", "pet", "data", "desktop.lock.json");
  let desktopRunning = false;
  let desktopPid = null;
  try {
    if (fs.existsSync(lockFile)) {
      const lock = JSON.parse(fs.readFileSync(lockFile, "utf8").replace(/^\uFEFF/, ""));
      const pid = Number(lock?.pid);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          desktopRunning = true;
          desktopPid = pid;
        } catch (err) {
          if (err?.code === "EPERM") {
            desktopRunning = true;
            desktopPid = pid;
          }
        }
      }
    }
  } catch {}

  const pluginDir = path.join(configDir, "plugins", "hagemi-pet-agy");
  const installed = fs.existsSync(path.join(pluginDir, "plugin.json"));
  let enabled = installed;
  if (installed) {
    try {
      const cfgPath = path.join(configDir, "config.json");
      if (fs.existsSync(cfgPath)) {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, ""));
        if (cfg?.plugins?.["hagemi-pet-agy"]?.enabled === false || cfg?.sidecars?.["hagemi-pet-agy/pet"]?.enabled === false) {
          enabled = false;
        }
      }
    } catch {}
  }
  return {
    available: fs.existsSync(HAGEMI_INSTALL_SCRIPT),
    desktopAvailable: fs.existsSync(HAGEMI_DESKTOP_MAIN),
    desktopRunning,
    desktopPid,
    installed,
    enabled,
    pluginDir
  };
}

/**
 * 执行哈基米桌宠管理子命令 (desktop / quit / install / uninstall / status / preview)。
 */
function manageHagemi(action = "desktop") {
  if (action === "status") {
    const st = getHagemiStatus();
    const deskLabel = !st.desktopAvailable
      ? "⚠️ 模块缺失"
      : st.desktopRunning
        ? `🟢 桌面漂浮运行中 (PID ${st.desktopPid})`
        : "✅ 桌面独立版已就绪 (不依赖宿主窗口)";
    console.log(`• 桌面漂浮哈基米:    ${deskLabel}`);
    const label = !st.available
      ? "⚠️ 模块缺失"
      : st.installed && st.enabled
        ? "🟢 已安装并启用"
        : st.installed
          ? "🟡 已安装但未启用"
          : "⚪ 未安装 (桌面版运行中无需此项)";
    console.log(`• CDP Sidecar 插件:  ${label} (${st.pluginDir})`);
    return 0;
  }
  if (action === "desktop" || action === "start" || action === "quit") {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = action === "quit" ? [LAUNCH_SCRIPT, "hagemi", "--quit"] : [LAUNCH_SCRIPT, "hagemi"];
    const res = spawnSync(process.execPath, args, { cwd: ROOT_DIR, stdio: "inherit", env });
    return res.status ?? 1;
  }
  if (action === "preview") {
    if (!fs.existsSync(HAGEMI_PREVIEW_SCRIPT)) {
      console.error("❌ 未找到 hagemi-pet/tools/preview.mjs");
      return 1;
    }
    const res = spawnSync(process.execPath, [HAGEMI_PREVIEW_SCRIPT], { cwd: HAGEMI_DIR, stdio: "inherit" });
    return res.status ?? 1;
  }
  if (!fs.existsSync(HAGEMI_INSTALL_SCRIPT)) {
    console.error("❌ 未找到 hagemi-pet/tools/install-local.mjs");
    return 1;
  }
  const invocation = hagemiInstallCommand(ROOT_DIR, activeHostContext(), action);
  const res = spawnSync(invocation.command, invocation.args, { cwd: HAGEMI_DIR, stdio: "inherit", env: process.env, windowsHide: true });
  return res.status ?? 1;
}

function loadLocalizationCli() {
  if (!fs.existsSync(LOCALIZATION_CLI)) {
    throw new Error("未找到 localization/cli.js，请确认项目目录完整。");
  }
  return require(LOCALIZATION_CLI);
}

function getWslDistrosOnWindows() {
  if (process.platform !== "win32") return [];
  try {
    const out = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 2500, windowsHide: true });
    const text = out.includes(0) ? out.toString("utf16le") : out.toString("utf8");
    return text.replace(/^\uFEFF/, "").replace(/\0/g, "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function syncWslPlugin(action = "install") {
  const srcPlugin = path.join(LOCALIZATION_DIR, "plugins", "chinese-toolkit");
  if (process.platform !== "win32") {
    const cli = loadLocalizationCli();
    if (action === "uninstall") {
      cli.uninstallPlugin();
    } else if (action === "status") {
      const target = cli.getGlobalPluginTargetDir();
      const installed = fs.existsSync(path.join(target, "plugin.json"));
      console.log(`• WSL/Linux 中文规则插件: ${installed ? "🟢 已安装" : "⚪ 未安装"} (${target})`);
    } else {
      cli.installPlugin();
    }
    return;
  }

  const distros = getWslDistrosOnWindows();
  if (!distros.length) {
    console.log("ℹ️ 未检测到可用的 WSL 发行版，跳过 WSL 插件同步。");
    return;
  }

  for (const distro of distros) {
    try {
      const homeRes = spawnSync("wsl.exe", ["-d", distro, "-e", "sh", "-c", "printf '%s' \"$HOME\""], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true
      });
      const wslHome = (homeRes.stdout || "").trim();
      if (!wslHome || homeRes.status !== 0) continue;
      const targetWslUnc = `\\\\wsl.localhost\\${distro}${wslHome.replace(/\//g, "\\")}\\.gemini\\config\\plugins\\chinese-toolkit`;
      if (action === "status") {
        const ok = fs.existsSync(path.join(targetWslUnc, "plugin.json"));
        console.log(`• WSL (${distro}) 中文规则插件: ${ok ? "🟢 已安装" : "⚪ 未安装"} (${targetWslUnc})`);
      } else if (action === "uninstall") {
        if (fs.existsSync(targetWslUnc)) {
          fs.rmSync(targetWslUnc, { recursive: true, force: true });
          console.log(`✅ 已移除 WSL (${distro}) 中文规则插件`);
        }
      } else {
        fs.mkdirSync(path.dirname(targetWslUnc), { recursive: true });
        if (fs.existsSync(targetWslUnc)) fs.rmSync(targetWslUnc, { recursive: true, force: true });
        fs.cpSync(srcPlugin, targetWslUnc, { recursive: true });
        console.log(`✅ 已同步安装 WSL (${distro}) 中文规则插件 -> ${targetWslUnc}`);
      }
    } catch (err) {
      console.warn(`⚠️ WSL (${distro}) 插件同步跳过: ${err.message}`);
    }
  }
}

function runLocalizationCli(args) {
  const res = spawnSync(process.execPath, [LOCALIZATION_CLI, ...args], {
    cwd: LOCALIZATION_DIR,
    stdio: "inherit",
    env: process.env
  });
  return res.status ?? 1;
}

async function showStatus(customPath) {
  console.log("=== 星语汉化集成套件 · 状态总览 ===\n");
  const cli = loadLocalizationCli();
  const asarPath = cli.findAsarPath(customPath);
  const running = cli.isProcessRunning();

  console.log(`• 运行平台:          ${os.platform()} (${os.arch()}) · Node ${process.version}`);
  console.log(`• Antigravity 进程:  ${running ? "🟢 运行中" : "⚪ 未运行"}`);
  if (asarPath) {
    const resDir = path.dirname(asarPath);
    const patched = cli.isAsarPatched(asarPath);
    const staged = fs.existsSync(path.join(resDir, "app.asar.staged"));
    const hasBackup = fs.existsSync(path.join(resDir, "app.asar.bak"));
    console.log(`• 客户端资源路径:    ${asarPath}`);
    console.log(`• 界面汉化状态:      ${staged ? (patched ? "🟡 当前已汉化，更新待退出后生效" : "🟡 预注入待重启生效") : patched ? "🟢 已安装中文补丁" : "⚪ 官方英文原版"}`);
    console.log(`• 原版安全备份:      ${hasBackup ? "✅ 存在" : "⚠️ 尚未建立（首次安装自动备份）"}`);
  } else {
    console.log("• 客户端资源路径:    ⚪ 当前系统未检测到桌面端 app.asar（若在 WSL 内运行，请在 Windows 端执行安装）");
  }

  let cdp = null;
  try {
    cdp = await discover();
  } catch {}
  console.log(`• 本机 CDP 端口:     ${cdp ? `🟢 已就绪 (127.0.0.1:${cdp.port})` : "⚪ 未检测到活跃调试端口"}`);

  const pluginDir = cli.getGlobalPluginTargetDir();
  const pluginOk = fs.existsSync(path.join(pluginDir, "plugin.json"));
  console.log(`• 本机中文规则插件:  ${pluginOk ? "🟢 已安装" : "⚪ 未安装"} (${pluginDir})`);
  manageHagemi("status");
  if (process.platform === "win32") syncWslPlugin("status");

  const vsExtDir = cli.findVsCodeExtensionDir(customPath);
  if (vsExtDir) {
    console.log(`• VS Code 扩展:      ${cli.isVsCodeExtensionPatched(vsExtDir) ? "🟢 已汉化" : "⚪ 未汉化"} (${vsExtDir})`);
  }

  const electronOk = fs.existsSync(path.join(ROOT_DIR, "node_modules", "electron")) ||
    fs.existsSync(path.join(ROOT_DIR, "runtime", "electron-45.1.0", "electron.exe"));
  const locModulesOk = fs.existsSync(path.join(LOCALIZATION_DIR, "node_modules", "@electron", "asar"));
  console.log(`• Electron 运行时:   ${electronOk ? "✅ 已就绪" : "⚠️ 未安装（请运行 npm install / npm ci）"}`);
  console.log(`• ASAR 工具依赖:     ${locModulesOk ? "✅ 已就绪" : "ℹ️ 未本地安装（运行将回退 npx）"}`);
  if (process.platform === "win32") {
    console.log(`• 窗口跟随辅助程序:  ${fs.existsSync(FOREGROUND_EXE) ? "✅ ForegroundHost.exe 已编译" : "⚠️ 未编译（需运行 build:native）"}`);
    console.log(`• 宿主连接辅助程序:  ${fs.existsSync(HOST_CONNECT_EXE) ? "✅ HostConnect.exe 已编译" : "⚠️ 未编译（需运行 build:native）"}`);
  }
  console.log("");
}

function installSuite(args, customPath) {
  const skipPlugin = args.includes("--no-plugin");
  const skipHagemi = args.includes("--no-hagemi");
  const withWsl = args.includes("--wsl") || process.platform === "win32";
  const withCdp = !args.includes("--no-cdp");

  const cliArgs = ["install"];
  if (!skipPlugin) cliArgs.push("--with-plugin");
  if (customPath) cliArgs.push("--path", customPath);

  console.log("📦 [1/4] 正在安装 Antigravity 2.32.2 中文汉化补丁...");
  const cli = loadLocalizationCli();
  const asarPath = cli.findAsarPath(customPath);
  if (asarPath) {
    const code = runLocalizationCli(cliArgs);
    if (code !== 0) process.exitCode = code;
  } else {
    console.log("ℹ️ 当前环境未探测到桌面端 app.asar，跳过桌面端 ASAR 补丁。");
    if (!skipPlugin) cli.installPlugin();
  }

  if (!skipHagemi) {
    console.log("\n🐾 [2/4] 正在预置哈基米插件资源（桌面悬浮模式会自动优先并避免双宠重影）...");
    const code = manageHagemi("install");
    if (code !== 0) console.warn("⚠️ 哈基米 CDP 插件安装返回非零状态（不影响桌面独立漂浮模式运行）。");
  }

  if (!skipPlugin && withWsl) {
    console.log("\n🐧 [3/4] 正在同步安装中文智能体规则插件 (WSL / 本机)...");
    syncWslPlugin("install");
  }

  if (withCdp && process.platform === "win32") {
    console.log("\n🔌 [4/4] 正在配置本机 CDP 连接入口...");
    if (fs.existsSync(HOST_CONNECT_EXE)) {
      spawn(HOST_CONNECT_EXE, ["--connect"], { cwd: ROOT_DIR, detached: true, stdio: "ignore" }).unref();
      console.log("✅ 已打开 Windows 一键连接向导（可创建“Antigravity（星语连接）”桌面入口）。");
    } else {
      console.log("ℹ️ 尚未编译 HostConnect.exe，请先运行 npm run build:native 后再配置一键连接。");
    }
  }
}

async function launchSuite(args, customPath) {
  const onlyIdx = args.indexOf("--only");
  const hasExplicitOnly = onlyIdx !== -1 && args[onlyIdx + 1];
  const withCatWidget = args.includes("--with-cat-widget");
  const noHost = args.includes("--no-host");
  const skipHagemi = args.includes("--no-hagemi");

  const cli = loadLocalizationCli();
  const asarPath = cli.findAsarPath(customPath);
  const hostRunning = cli.isProcessRunning();

  if (asarPath && !hostRunning && fs.existsSync(path.join(path.dirname(asarPath), "app.asar.staged"))) {
    const code = runLocalizationCli(["apply-staged", "--path", asarPath]);
    if (code !== 0) throw new Error("预生成汉化补丁应用失败");
  }

  if (asarPath && !cli.isAsarPatched(asarPath)) {
    if (!hostRunning) {
      console.log("⚡ 检测到客户端尚未汉化（或官方更新覆盖），正在自动注入中文补丁...");
      const code = runLocalizationCli(customPath ? ["install", "--path", customPath] : ["install"]);
      if (code !== 0) console.warn("⚠️ 自动汉化步骤返回非零状态，将继续启动其余组件。");
    } else {
      console.log("ℹ️ Antigravity 正在运行中，跳过即时 ASAR 写入；如需热更新请先退出客户端或使用控制面板预注入。");
    }
  }

  if (!skipHagemi && !getHagemiStatus().installed) {
    console.log("🐾 桌面独立漂浮模式已就绪（如需备选 CDP Sidecar 插件可单独运行 node suite-cli.js hagemi install）。");
  }

  if (!noHost && asarPath && !hostRunning) {
    console.log("🚀 正在以本机 CDP 调试模式启动 Antigravity...");
    cli.launch(customPath, { withCdp: true });
  } else if (hostRunning) {
    let cdp = null;
    try { cdp = await discover(); } catch {}
    if (!cdp) {
      console.log("⚠️ 检测到 Antigravity 已在运行，但未启用本机 CDP 调试端口（桌面哈基米与 Agent 状态仍可正常运行，仅皮肤需要 CDP）。");
    }
  }

  let target = skipHagemi ? "skin" : "suite";
  if (hasExplicitOnly && ["hagemi", "widget", "skin", "suite", "both", "all"].includes(args[onlyIdx + 1])) {
    target = args[onlyIdx + 1];
  } else if (withCatWidget) {
    target = skipHagemi ? "both" : "all";
  }

  console.log(`✨ 正在启动星语组件 (${target === "suite" ? "方案 A: 独立桌面漂浮哈基米 + 织梦皮肤" : target})...`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [LAUNCH_SCRIPT, target], {
    cwd: ROOT_DIR,
    env,
    stdio: "inherit"
  });
  child.on("exit", code => {
    if (code) process.exitCode = code;
  });
}

function restoreSuite(args, customPath) {
  const cliArgs = ["restore"];
  if (customPath) cliArgs.push("--path", customPath);
  const code = runLocalizationCli(cliArgs);
  if (code !== 0) process.exitCode = code;

  if (args.includes("--with-hagemi") || args.includes("--all")) {
    manageHagemi("uninstall");
  }

  if (process.platform === "win32") {
    syncWslPlugin("uninstall");
    if (args.includes("--restore-connection") && fs.existsSync(HOST_CONNECT_EXE)) {
      spawn(HOST_CONNECT_EXE, ["--restore"], { cwd: ROOT_DIR, detached: true, stdio: "ignore" }).unref();
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "help";

  let customPath = null;
  const pathIdx = args.indexOf("--path");
  if (pathIdx !== -1 && args[pathIdx + 1] && !args[pathIdx + 1].startsWith("-")) {
    customPath = args[pathIdx + 1];
  }

  switch (command) {
    case "status":
      await showStatus(customPath);
      break;
    case "install":
      installSuite(args, customPath);
      break;
    case "launch":
      await launchSuite(args, customPath);
      break;
    case "restore":
      restoreSuite(args, customPath);
      break;
    case "hagemi": {
      const sub = args[1] || "desktop";
      const allowed = ["desktop", "start", "quit", "install", "uninstall", "status", "preview"];
      const code = manageHagemi(allowed.includes(sub) ? sub : "desktop");
      if (code !== 0) process.exitCode = code;
      break;
    }
    case "wsl-plugin": {
      const sub = args[1] || "install";
      syncWslPlugin(["install", "uninstall", "status"].includes(sub) ? sub : "install");
      break;
    }
    case "connect":
      if (process.platform === "win32" && fs.existsSync(HOST_CONNECT_EXE)) {
        spawn(HOST_CONNECT_EXE, ["--connect"], { cwd: ROOT_DIR, detached: true, stdio: "ignore" }).unref();
      } else {
        console.log("请确保已运行 npm run build:native，并使用 --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 启动 Antigravity。");
      }
      break;
    case "disconnect":
      if (process.platform === "win32" && fs.existsSync(HOST_CONNECT_EXE)) {
        spawn(HOST_CONNECT_EXE, ["--restore"], { cwd: ROOT_DIR, detached: true, stdio: "ignore" }).unref();
      }
      break;
    case "help":
    default:
      console.log(`
星语汉化集成套件 (Antigravity Star ZhCN Suite · 方案 A)
整合: Antigravity 2.32.2 中文汉化 + 桌面漂浮哈基米（不依赖宿主窗口 / 双击右键 Gemini 对话 / Claude·Codex 吃醋）+ 织梦皮肤

用法:
  node suite-cli.js status                          # 查看汉化、桌面哈基米、CDP、皮肤与 WSL 插件状态
  node suite-cli.js install [--no-hagemi] [--no-cdp] # 安装 2.32.2 汉化、同步 WSL 插件并配置 CDP 连接
  node suite-cli.js launch [--no-host] [--with-cat-widget] # 启动桌面漂浮哈基米 + 织梦皮肤（可选同时拉起 Antigravity）
  node suite-cli.js launch --only hagemi|skin|suite|widget|both|all # 单独或组合启动组件
  node suite-cli.js hagemi [desktop|quit|install|uninstall|status|preview] # 启动/退出桌面哈基米或管理 CDP 插件
  node suite-cli.js restore [--with-hagemi] [--restore-connection] # 恢复官方英文原版（可选卸载 CDP 插件/恢复快捷方式）
  node suite-cli.js wsl-plugin [install|uninstall|status] # 单独管理 WSL/本机中文规则插件
  node suite-cli.js connect / disconnect            # 打开或恢复 Windows 一键 CDP 连接入口
`);
      break;
  }
}

main().catch(err => {
  console.error("❌ 执行失败:", err.message);
  process.exit(1);
});
