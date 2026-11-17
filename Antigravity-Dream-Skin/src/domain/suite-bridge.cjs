const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { discover } = require("../../../shared/host.cjs");
const { activeHostContext, hagemiInstallCommand } = require("../../../shared/active-host.cjs");

class SuiteBridge {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, "../../..");
    this.localizationDir = path.join(this.rootDir, "localization");
    this.localizationCliPath = path.join(this.localizationDir, "cli.js");
    this.launchScriptPath = path.join(this.rootDir, "tools", "launch.cjs");
    this.hagemiDir = options.hagemiDir || path.join(this.rootDir, "hagemi-pet");
    this.hagemiInstallScript = path.join(this.hagemiDir, "tools", "install-local.mjs");
    this.hagemiDesktopMainPath = options.hagemiDesktopMainPath || path.join(this.hagemiDir, "desktop", "main.cjs");
    this.geminiConfigDir = options.geminiConfigDir || null;
    this.geminiDir = options.geminiDir || null;
    this.hagemiDesktopLockFile = options.hagemiDesktopLockFile || null;
    this.widgetMainPath = path.join(this.rootDir, "Antigravity-Cat-Widget", "src", "main", "index.cjs");
    this.foregroundExePath = path.join(this.rootDir, "Antigravity-Cat-Widget", "src", "native", "ForegroundHost.exe");
    this.hostConnectExePath = path.join(this.rootDir, "tools", "native", "HostConnect.exe");
    this.discover = options.discover || discover;
    this.execFile = options.execFile || execFile;
    this.spawn = options.spawn || spawn;
  }

  /**
   * 检测哈基米桌面漂浮版与原生 Sidecar 插件状态。
   */
  getHagemiStatus() {
    const configDir = activeHostContext(this.geminiConfigDir).configDir;
    const geminiDir = this.geminiDir || path.dirname(configDir);
    const desktopLockFile = this.hagemiDesktopLockFile || path.join(geminiDir, "antigravity", "sidecar_data", "hagemi-pet-agy", "pet", "data", "desktop.lock.json");
    const hagemiAvailable = fs.existsSync(this.hagemiInstallScript);
    const hagemiDesktopAvailable = fs.existsSync(this.hagemiDesktopMainPath);
    let hagemiDesktopRunning = false;
    try {
      if (fs.existsSync(desktopLockFile)) {
        const lock = JSON.parse(fs.readFileSync(desktopLockFile, "utf8").replace(/^\uFEFF/, ""));
        const pid = Number(lock?.pid);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            hagemiDesktopRunning = true;
          } catch (error) {
            if (error?.code === "EPERM") hagemiDesktopRunning = true;
          }
        }
      }
    } catch {}

    const pluginManifest = path.join(configDir, "plugins", "hagemi-pet-agy", "plugin.json");
    const hagemiInstalled = fs.existsSync(pluginManifest);
    let hagemiEnabled = hagemiInstalled;
    if (hagemiInstalled) {
      try {
        const configPath = path.join(configDir, "config.json");
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
          const pluginEnabled = config?.plugins?.["hagemi-pet-agy"]?.enabled;
          const sidecarEnabled = config?.sidecars?.["hagemi-pet-agy/pet"]?.enabled;
          if (pluginEnabled === false || sidecarEnabled === false) {
            hagemiEnabled = false;
          }
        }
      } catch {
        // 配置文件不可读时保守保留安装检测结果
      }
    }
    return { hagemiAvailable, hagemiDesktopAvailable, hagemiDesktopRunning, hagemiInstalled, hagemiEnabled };
  }

  _loadCli() {
    if (!fs.existsSync(this.localizationCliPath)) return null;
    try {
      return require(this.localizationCliPath);
    } catch {
      return null;
    }
  }

  _findAsarQuiet(cli) {
    if (!cli) return null;
    try {
      const candidates = cli.getCandidateAsarPaths();
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
    } catch {}
    return null;
  }

  async getStatus() {
    const cli = this._loadCli();
    const asarPath = this._findAsarQuiet(cli);
    const resourcesDir = asarPath ? path.dirname(asarPath) : null;
    const patched = Boolean(asarPath && cli?.isAsarPatched(asarPath));
    const staged = Boolean(resourcesDir && fs.existsSync(path.join(resourcesDir, "app.asar.staged")));
    const hasBackup = Boolean(resourcesDir && fs.existsSync(path.join(resourcesDir, "app.asar.bak")));
    const hostRunning = Boolean(cli?.isProcessRunning?.());

    let pluginInstalled = false;
    try {
      const pluginDir = cli?.getGlobalPluginTargetDir?.();
      pluginInstalled = Boolean(pluginDir && fs.existsSync(path.join(pluginDir, "plugin.json")));
    } catch {}

    let cdp = null;
    try {
      cdp = await this.discover();
    } catch {}

    const hagemi = this.getHagemiStatus();

    return {
      platform: process.platform,
      asarFound: Boolean(asarPath),
      asarPath,
      patched,
      staged,
      hasBackup,
      hostRunning,
      pluginInstalled,
      ...hagemi,
      cdpReady: Boolean(cdp),
      cdpPort: cdp ? cdp.port : null,
      catWidgetAvailable: fs.existsSync(this.widgetMainPath),
      nativeForegroundBuilt: fs.existsSync(this.foregroundExePath),
      hostConnectBuilt: fs.existsSync(this.hostConnectExePath)
    };
  }

  /**
   * 安装或卸载哈基米原生 Sidecar 桌宠插件（方案 A 默认桌宠）。
   */
  runHagemi(action = "install") {
    if (action !== "install" && action !== "uninstall") {
      return Promise.resolve({ ok: false, message: "不支持的操作类型: " + action, output: "" });
    }
    if (!fs.existsSync(this.hagemiInstallScript)) {
      return Promise.resolve({ ok: false, message: "未找到 hagemi-pet/tools/install-local.mjs 模块", output: "" });
    }
    const invocation = hagemiInstallCommand(this.rootDir, activeHostContext(this.geminiConfigDir), action);
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    };
    return new Promise(resolve => {
      this.execFile(
        invocation.command,
        invocation.args,
        { cwd: this.hagemiDir, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
        async (error, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          const status = await this.getStatus();
          if (error) {
            const msg = output.split(/\r?\n/).filter(Boolean).pop() || error.message;
            resolve({ ok: false, message: "哈基米插件操作失败: " + msg, output, status });
            return;
          }
          const message = action === "uninstall"
            ? "已卸载哈基米桌宠插件（她将在约 1 分钟内挥手告别）"
            : "已安装并启用哈基米桌宠插件（右键双击桌宠可呼出 Gemini 对话框）";
          resolve({ ok: true, message, output, status });
        }
      );
    });
  }

  runLocalization(action) {
    const allowed = {
      install: ["install", "--with-plugin"],
      restore: ["restore"],
      "install-plugin": ["install-plugin"]
    };
    const cliArgs = allowed[action];
    if (!cliArgs) {
      return Promise.resolve({ ok: false, message: "不支持的操作类型: " + action, output: "" });
    }
    if (!fs.existsSync(this.localizationCliPath)) {
      return Promise.resolve({ ok: false, message: "未找到 localization/cli.js 模块", output: "" });
    }
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      AGY_NO_KILL: "1"
    };
    return new Promise(resolve => {
      this.execFile(
        process.execPath,
        [this.localizationCliPath, ...cliArgs],
        { cwd: this.localizationDir, env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
        async (error, stdout, stderr) => {
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          const status = await this.getStatus();
          if (error) {
            const msg = status.hostRunning && action === "restore"
              ? "Antigravity 正在运行，请先保存工作并完全退出客户端后再恢复英文原版。"
              : (output.split(/\r?\n/).filter(Boolean).pop() || error.message);
            resolve({ ok: false, message: msg, output, status });
            return;
          }
          let message = "操作完成";
          if (action === "install") {
            message = status.staged
              ? "已预生成中文补丁（app.asar.staged），退出并重启 Antigravity 后自动生效"
              : status.patched
                ? "Antigravity 中文补丁已安装就绪"
                : "安装脚本执行完成，请查看状态";
          } else if (action === "restore") {
            message = "已恢复 Antigravity 官方英文原版";
          } else if (action === "install-plugin") {
            message = "已安装中文智能体规则插件";
          }
          resolve({ ok: true, message, output, status });
        }
      );
    });
  }

  _launchElectronApp(electronMain, launchTarget, label) {
    if (!fs.existsSync(electronMain)) {
      return { ok: false, message: `未找到 ${label} 入口文件` };
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      if (process.versions.electron) {
        const child = this.spawn(process.execPath, [electronMain], {
          cwd: this.rootDir,
          env,
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.unref();
      } else {
        const child = this.spawn(process.execPath, [this.launchScriptPath, launchTarget], {
          cwd: this.rootDir,
          env,
          detached: true,
          stdio: "ignore",
          windowsHide: false
        });
        child.unref();
      }
      return { ok: true, message: `已启动 / 唤回${label}` };
    } catch (error) {
      return { ok: false, message: `启动${label}失败: ` + error.message };
    }
  }

  launchHagemiDesktop() {
    return this._launchElectronApp(this.hagemiDesktopMainPath, "hagemi", "桌面漂浮哈基米");
  }

  launchCatWidget() {
    return this._launchElectronApp(this.widgetMainPath, "widget", "备用星语猫娘挂件");
  }

  configureHostCdp() {
    if (process.platform !== "win32") {
      return {
        ok: false,
        message: "当前非 Windows 桌面环境，请使用 --remote-debugging-address=127.0.0.1 --remote-debugging-port=0 启动 Antigravity"
      };
    }
    if (!fs.existsSync(this.hostConnectExePath)) {
      return {
        ok: false,
        message: "尚未编译 HostConnect.exe，请先在根目录运行一次「一键安装与配置.bat」或 npm run build:native"
      };
    }
    try {
      const child = this.spawn(this.hostConnectExePath, ["--connect"], {
        cwd: this.rootDir,
        detached: true,
        stdio: "ignore",
        windowsHide: false
      });
      child.unref();
      return { ok: true, message: "已打开 Windows 一键连接引导，请按提示完成宿主配置" };
    } catch (error) {
      return { ok: false, message: "打开连接向导失败: " + error.message };
    }
  }
}

module.exports = { SuiteBridge };
