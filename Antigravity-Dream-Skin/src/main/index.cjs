const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const { DreamSkinSettings, DEFAULT_SETTINGS } = require("../domain/settings.cjs");
const { DreamSkinThemeLoader } = require("../domain/theme-loader.cjs");
const { HostController } = require("../domain/host-controller.cjs");
const { SuiteBridge } = require("../domain/suite-bridge.cjs");

const dataDir = process.argv.find(a => a.startsWith("--data-dir="))?.slice(11) || path.join(os.homedir(), ".antigravity-dream-skin");
app.setPath("userData", path.join(dataDir, "runtime"));
app.setName("Gemini · Dream Skin");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes("--quit")) {
  app.quit();
} else {
  let win;
  let tray;
  let quitting = false;
  const settings = new DreamSkinSettings(path.join(dataDir, "settings.json"));
  const loader = new DreamSkinThemeLoader();
  const bridge = new SuiteBridge();

  if (process.argv.includes("--enable")) settings.update({ enabled: true });
  if (process.argv.includes("--disable")) settings.update({ enabled: false });

  const controller = new HostController(loader, () => {
    if (win && !win.isDestroyed()) win.webContents.send("dream:state", snapshot());
  });

  const snapshot = () => {
    let wallpaper = null;
    let wallpaperError = null;
    let customWallpaper = false;
    let previewImageUrl = "../../assets/wallpapers/gemini-character-sheet-v1/wallpaper.png";
    try {
      const info = loader.resolveWallpaper(settings.getAll());
      wallpaper = info.name;
      customWallpaper = Boolean(info.custom);
      if (info.custom && info.file) {
        previewImageUrl = pathToFileURL(info.file).href;
      }
    } catch (error) {
      wallpaperError = error.message;
    }
    return {
      settings: settings.getAll(),
      defaults: DEFAULT_SETTINGS,
      status: controller.status,
      wallpaper,
      wallpaperError,
      customWallpaper,
      previewImageUrl
    };
  };

  function show() {
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    win = new BrowserWindow({
      width: 1260,
      height: 880,
      minWidth: 880,
      minHeight: 650,
      autoHideMenuBar: true,
      title: "Gemini · 星语汉化与织梦皮肤",
      backgroundColor: "#f6f3fb",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", e => e.preventDefault());
    win.on("close", e => {
      if (!quitting && settings.get("enabled")) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on("closed", () => {
      win = null;
      if (!settings.get("enabled")) app.quit();
    });
  }

  const trusted = e => win && !win.isDestroyed() && e.sender === win.webContents;

  ipcMain.handle("dream:get", e => (trusted(e) ? snapshot() : null));
  ipcMain.handle("dream:save", async (e, partial) => {
    if (!trusted(e)) return null;
    const allowed = Object.fromEntries(
      Object.entries(partial || {}).filter(([k]) =>
        ["outputMode", "enabled", "fit", "scrim", "opacity", "positionX", "positionY", "zoom", "customWallpaperPath"].includes(k)
      )
    );
    settings.update(allowed);
    await controller.update(settings.getAll());
    return snapshot();
  });
  ipcMain.handle("dream:refresh", async e => {
    if (!trusted(e)) return null;
    await controller.tick();
    return snapshot();
  });
  ipcMain.handle("dream:pick-wallpaper", async e => {
    if (!trusted(e)) return null;
    const result = await dialog.showOpenDialog(win, {
      title: "选择自定义壁纸图片",
      filters: [{ name: "图片文件 (PNG/JPG/WebP)", extensions: ["png", "jpg", "jpeg", "webp"] }],
      properties: ["openFile"]
    });
    if (result.canceled || !result.filePaths?.[0]) {
      return { canceled: true, snapshot: snapshot() };
    }
    const filePath = result.filePaths[0];
    try {
      loader.verifyCustomWallpaper(filePath);
      settings.update({ customWallpaperPath: filePath });
      await controller.update(settings.getAll());
      return { ok: true, snapshot: snapshot() };
    } catch (error) {
      return { ok: false, message: error.message, snapshot: snapshot() };
    }
  });
  ipcMain.handle("dream:reset-wallpaper", async e => {
    if (!trusted(e)) return null;
    settings.update({ customWallpaperPath: "" });
    await controller.update(settings.getAll());
    return { ok: true, snapshot: snapshot() };
  });
  ipcMain.handle("suite:status", e => (trusted(e) ? bridge.getStatus() : null));
  ipcMain.handle("suite:localize", (e, action) => (trusted(e) ? bridge.runLocalization(action) : null));
  ipcMain.handle("suite:hagemi", (e, action) => (trusted(e) ? bridge.runHagemi(action) : null));
  ipcMain.handle("suite:launch-hagemi", e => (trusted(e) ? bridge.launchHagemiDesktop() : null));
  ipcMain.handle("suite:launch-widget", e => (trusted(e) ? bridge.launchCatWidget() : null));
  ipcMain.handle("suite:connect-host", e => (trusted(e) ? bridge.configureHostCdp() : null));
  ipcMain.on("dream:quit", e => {
    if (trusted(e)) app.quit();
  });

  app.on("second-instance", (_event, args) => {
    if (args.includes("--quit")) {
      app.quit();
      return;
    }
    if (args.includes("--enable") || args.includes("--disable")) {
      settings.update({ enabled: args.includes("--enable") });
      controller.update(settings.getAll());
    }
    if (!args.includes("--background")) show();
  });

  app.whenReady().then(() => {
    if (!process.argv.includes("--background")) show();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "../../assets/app-icon.ico")));
    tray.setToolTip("Dream Skin · 星语汉化套件");
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "打开皮肤与套件控制面板", click: show },
      { label: "启动 / 唤回桌面漂浮哈基米", click: () => bridge.launchHagemiDesktop() },
      { label: "启动 / 唤回备用猫娘挂件", click: () => bridge.launchCatWidget() },
      {
        label: "关闭皮肤并恢复原样",
        click: async () => {
          settings.update({ enabled: false });
          await controller.update(settings.getAll());
        }
      },
      { type: "separator" },
      { label: "退出并恢复原样", click: () => app.quit() }
    ]));
    tray.on("double-click", show);
    controller.start(settings.getAll());
  });

  app.on("before-quit", e => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    controller.stop().finally(() => {
      tray?.destroy();
      app.quit();
    });
  });

  app.on("window-all-closed", () => {
    if (!settings.get("enabled")) app.quit();
  });
}
