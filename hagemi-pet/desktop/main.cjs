// 独立桌面漂浮版哈基米入口：全工作区透明置顶窗口 + 精确鼠标穿透 + 无需 Antigravity 窗口即可常驻桌面。
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require("electron");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

if (!process.env.ANTIGRAVITY_GEMINI_DIR) {
  try {
    const { activeHostContext } = require("../../shared/active-host.cjs");
    process.env.ANTIGRAVITY_GEMINI_DIR = path.dirname(activeHostContext().configDir);
  } catch (error) { console.warn("[hagemi-desktop] 使用本机数据目录:", error.message); }
}

const dataDir = path.join(os.homedir(), ".antigravity-hagemi-desktop");
app.setPath("userData", path.join(dataDir, "runtime"));
app.setName("Hagemi Desktop Pet");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock || process.argv.includes("--quit")) {
  app.quit();
} else {
  let win = null;
  let tray = null;
  let runtime = null;
  let runtimeMod = null;
  let quitting = false;

  const log = msg => console.log(`[hagemi-desktop] ${msg}`);

  function createElectronBridge(targetWin) {
    let onMessage = () => {};
    const send = msg => {
      if (targetWin && !targetWin.isDestroyed()) {
        targetWin.webContents.send("hagemi:to-pet", msg);
      }
    };
    const bridge = {
      start() {},
      async stop() {},
      post(_session, msg) { send(msg); },
      broadcast(msg) { send(msg); },
      async remount() {
        if (!targetWin || targetWin.isDestroyed()) return;
        const { rendererSource } = await import(pathToFileURL(path.join(__dirname, "../sidecars/pet/lib/renderer-source.mjs")).href);
        const { source } = rendererSource({ standalone: true, desktop: true });
        await targetWin.webContents.executeJavaScript(source);
        await targetWin.webContents.executeJavaScript("window.__hagemiFlushQueue?.()");
      }
    };
    return {
      assignHandler(fn) { onMessage = fn; },
      handleIpc(rawJson) {
        try {
          const parsed = JSON.parse(rawJson);
          onMessage(parsed, "desktop");
        } catch {}
      },
      bridge
    };
  }

  function syncBounds() {
    if (!win || win.isDestroyed()) return;
    const area = screen.getPrimaryDisplay().workArea;
    win.setBounds(area);
  }

  function handleDesktopControl(msg) {
    if (!win || win.isDestroyed()) return;
    if (msg.type === "desktop_hit") {
      win.setIgnoreMouseEvents(!msg.hit, { forward: true });
      return;
    }
    if (msg.type === "desktop_focus") {
      if (msg.focused) {
        win.setFocusable(true);
        win.show();
        win.focus();
      } else {
        if (win.isFocused()) win.blur();
        win.setFocusable(false);
      }
    }
  }

  async function boot() {
    runtimeMod = await import(pathToFileURL(path.join(__dirname, "../sidecars/pet/lib/runtime.mjs")).href);
    const { rendererSource } = await import(pathToFileURL(path.join(__dirname, "../sidecars/pet/lib/renderer-source.mjs")).href);
    const { dataDir: petDataDir } = runtimeMod.resolvePetDirs();
    runtimeMod.writeDesktopLock(petDataDir, process.pid);

    const area = screen.getPrimaryDisplay().workArea;
    win = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    win.setIgnoreMouseEvents(true, { forward: true });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });

    const bridgeHolder = createElectronBridge(win);
    ipcMain.on("hagemi:from-pet", (event, json) => {
      if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
      bridgeHolder.handleIpc(json);
    });

    runtime = runtimeMod.startPetRuntime({
      isDesktop: true,
      enableUpdater: false,
      log,
      createBridge: ({ onMessage }) => {
        bridgeHolder.assignHandler(onMessage);
        return bridgeHolder.bridge;
      },
      onDesktopControl: handleDesktopControl,
      onQuit: () => app.quit()
    });

    win.on("blur", () => {
      if (win && !win.isDestroyed()) {
        win.setFocusable(false);
        win.webContents.send("hagemi:to-pet", { t: "desktop_blur" });
      }
    });

    win.on("closed", () => {
      win = null;
      app.quit();
    });

    await win.loadFile(path.join(__dirname, "index.html"));
    const { source } = rendererSource({ standalone: true, desktop: true });
    await win.webContents.executeJavaScript(source);
    await win.webContents.executeJavaScript("window.__hagemiFlushQueue?.()");
    win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");

    if (process.argv.includes("--chat")) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        runtime.unhide();
        win.setFocusable(true);
        win.focus();
        runtime.showDesktopChat();
      }, 400);
    }

    screen.on("display-metrics-changed", syncBounds);
    screen.on("display-added", syncBounds);
    screen.on("display-removed", syncBounds);

    const iconFile = path.join(__dirname, "../assets/logo.png");
    const trayIcon = nativeImage.createFromPath(iconFile).resize({ width: 32, height: 32 });
    tray = new Tray(trayIcon);
    tray.setToolTip("哈基米桌面桌宠 · Hagemi Pet");
    const showPet = () => {
      if (!win || win.isDestroyed()) return;
      runtime?.unhide();
      win.showInactive();
      win.setAlwaysOnTop(true, "screen-saver");
    };
    const openChatWindow = () => {
      if (!win || win.isDestroyed()) return;
      runtime?.unhide();
      win.setFocusable(true);
      win.show();
      win.focus();
      runtime?.showDesktopChat();
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示 / 唤回桌面哈基米", click: showPet },
      { label: "打开 Gemini 对话框 (双击右键)", click: openChatWindow },
      { label: "重置位置到右下角", click: () => runtime?.resetDesktopPosition() },
      { type: "separator" },
      { label: "退出桌面哈基米", click: () => app.quit() }
    ]));
    tray.on("double-click", showPet);
  }

  app.on("second-instance", (_event, args) => {
    if (args.includes("--quit")) {
      app.quit();
      return;
    }
    if (!win || win.isDestroyed()) return;
    runtime?.unhide();
    win.setAlwaysOnTop(true, "screen-saver");
    if (args.includes("--chat")) {
      win.setFocusable(true);
      win.show();
      win.focus();
      runtime?.showDesktopChat();
    } else {
      win.showInactive();
    }
  });

  app.whenReady().then(() => {
    boot().catch(error => {
      console.error("[hagemi-desktop] 启动失败:", error);
      app.quit();
    });
  });

  app.on("before-quit", event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    const cleanup = async () => {
      try {
        if (runtimeMod) {
          const { dataDir: petDataDir } = runtimeMod.resolvePetDirs();
          runtimeMod.clearDesktopLock(petDataDir, process.pid);
        }
        if (runtime) await runtime.shutdown();
      } catch {}
      tray?.destroy();
      app.quit();
    };
    cleanup();
  });
}
