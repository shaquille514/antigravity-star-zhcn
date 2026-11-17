const { app, BrowserWindow, screen, Tray, Menu, ipcMain, nativeImage, globalShortcut, powerMonitor } = require("electron");
const path = require("node:path");
const os = require("node:os");
const { SettingsManager } = require("../domain/settings.cjs");
const { UsageLedger } = require("../domain/ledger.cjs");
const { WidgetStateMachine } = require("../domain/state-machine.cjs");
const { TranscriptAdapter } = require("../adapters/transcript-adapter.cjs");
const { AudioManager } = require("../domain/audio-manager.cjs");
const { HostQuotaAdapter } = require("../adapters/host-quota.cjs");
const { GeminiChatClient, maskApiKey, normalizeBaseUrl } = require("../adapters/gemini-chat.cjs");
const { ForegroundMonitor, hostPlacement, characterPlacement, snapToEdges } = require("../domain/host-visibility.cjs");

const dataDir = process.argv.find(a => a.startsWith("--data-dir="))?.slice(11) || path.join(os.homedir(), ".antigravity-cat-widget");
app.setPath("userData", path.join(dataDir, "runtime"));
app.setName("喵言喵语桌宠");
// Transparent Chromium surfaces can stop presenting after GPU/desktop transitions.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes("--quit")) {
  app.quit();
} else {
  let quitting = false;
  let recoveryTimer;
  let visualTimer;
  let visualChecking = false;
  let blankFrames = 0;
  let visualCheckInterval = 15000;
  let lastVisualCheck = 0;
  let uptimeCheckTimer;
  let chatSeq = 0;
  let chatStreaming = false;

  const recoveryLog = reason => {
    try {
      require("node:fs").appendFileSync(path.join(dataDir, "recovery.log"), new Date().toISOString() + " " + reason + "\n");
    } catch {}
  };

  let win;
  let tray;
  let panel;
  let drag = null;
  let source = { online: false, source: "正在读取本机日志", files: 0 };
  let saveTimer;
  let displayScale = null;
  let hostArea = null;
  let hostLayout = null;
  let dragTimer = null;
  let facing = "right";
  let dockSide = "";
  let artShift = 0;

  const foreground = new ForegroundMonitor();
  const quotaAdapter = new HostQuotaAdapter();
  const chatClient = new GeminiChatClient();
  const dialogue = require("../../assets/dialogue/zh-CN.json");
  const running = new Set();
  const settings = new SettingsManager(path.join(dataDir, "settings.json"));
  const ledger = new UsageLedger({ storagePath: path.join(dataDir, "usage-v2.json") });
  const sm = new WidgetStateMachine("offline");
  const adapter = new TranscriptAdapter({
    extraAppDataDirs: settings.get("extraBrainDirs"),
    discoverWsl: settings.get("discoverWsl")
  });
  const audio = new AudioManager();

  const snapshot = () => {
    ledger.quotaRemainingPercent = settings.get("manualQuota") === true ? settings.get("manualPercent") : null;
    const safeSettings = settings.getAll();
    const rawSavedKey = safeSettings.geminiApiKey;
    const resolvedKey = chatClient.resolveApiKey(rawSavedKey);
    safeSettings.geminiApiKey = "";
    return {
      artShift,
      dockSide,
      quotaWindows: quotaAdapter.snapshot,
      facing,
      state: sm.currentState,
      persistentState: sm.persistentState,
      dialogue: dialogue.lines,
      settings: safeSettings,
      displayScale: displayScale || safeSettings.scale,
      visibility: {
        supported: process.platform === "win32",
        foreground: foreground.state.kind,
        nativeAttached: foreground.state.attached === true,
        withinHost: !!hostArea
      },
      ledger: ledger.getSnapshot(),
      source,
      presets: audio.getPresetList(),
      chat: {
        busy: chatStreaming,
        hasApiKey: Boolean(resolvedKey),
        usingEnvKey: Boolean(!rawSavedKey && resolvedKey),
        keyMask: maskApiKey(rawSavedKey),
        model: safeSettings.geminiModel,
        hasContext: Boolean(chatClient.previousInteractionId)
      }
    };
  };

  const send = (channel, data) => {
    for (const w of [win, panel]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, data);
    }
  };
  const publish = () => send("widget:snapshot", snapshot());

  function syncQuotaState() {
    if (chatStreaming) {
      sm.setPersistentState("thinking");
      return;
    }
    if (["idle", "warning", "thinking"].includes(sm.persistentState)) {
      if (running.size > 0) {
        sm.setPersistentState("thinking");
        return;
      }
      const values = settings.get("manualQuota")
        ? [settings.get("manualPercent"), settings.get("manualWeeklyPercent")]
        : [quotaAdapter.snapshot.fiveHour, quotaAdapter.snapshot.weekly];
      sm.setPersistentState(values.some(v => typeof v === "number" && v <= 20) ? "warning" : (source.online ? "idle" : "offline"));
    }
  }

  function bounds(size = settings.get("scale")) {
    return { width: Math.max(360, size + 80), height: Math.round(size * 1146 / 1372 + 340) };
  }

  function safePosition(x, y, w, h) {
    const area = screen.getDisplayNearestPoint({
      x: Number.isFinite(x) ? x : screen.getPrimaryDisplay().workArea.x,
      y: Number.isFinite(y) ? y : 0
    }).workArea;
    return {
      x: Math.round(Number.isFinite(x) ? Math.max(area.x, Math.min(area.x + area.width - w, x)) : area.x + area.width - w - 18),
      y: Math.round(Number.isFinite(y) ? Math.max(area.y, Math.min(area.y + area.height - h, y)) : area.y + area.height - h - 18)
    };
  }

  function syncVisibility() {
    if (!win || win.isDestroyed()) return;
    if (!settings.get("hostWindowOnly")) {
      hostArea = null;
      hostLayout = null;
      displayScale = settings.get("scale");
      if (!win.isVisible()) win.showInactive();
      return;
    }
    if (drag) return;
    const previousArea = hostArea;
    let state = foreground.state;
    if (state.bounds) state = { ...state, bounds: screen.screenToDipRect(null, state.bounds) };
    const placement = hostPlacement(state, settings.get("scale"), settings.get("hostOffsetX"), settings.get("hostOffsetY"), settings.get("hostDock"));

    if (!placement) {
      hostArea = null;
      hostLayout = null;
      if (drag) {
        drag = null;
        sm.handlePointerUp();
      }
      if (win.isVisible()) win.hide();
      return;
    }

    hostArea = state.bounds;
    displayScale = placement.scale;
    artShift = placement.artShift;
    dockSide = Math.abs(placement.visualX - hostArea.x) < 2
      ? "left"
      : Math.abs(placement.visualX + displayScale - hostArea.x - hostArea.width) < 2
        ? "right"
        : "";
    facing = placement.visualX + displayScale / 2 < hostArea.x + hostArea.width / 2 ? "left" : "right";
    const nextLayout = JSON.stringify([state.hostId, state.restoreGeneration, displayScale, hostArea.width, hostArea.height, settings.get("hostOffsetX"), settings.get("hostOffsetY"), settings.get("hostDock")]);
    const nativeTranslation = state.nativeFollowing && previousArea && hostLayout === nextLayout;
    const layoutChanged = hostLayout !== nextLayout;
    hostLayout = nextLayout;
    if (!nativeTranslation) {
      const old = win.getBounds();
      if (Object.keys(placement.bounds).some(key => Math.abs(old[key] - placement.bounds[key]) > 2)) {
        win.setBounds(placement.bounds);
      }
    }

    if (!win.isVisible()) {
      win.showInactive();
      if (layoutChanged) {
        setTimeout(() => {
          if (win && !win.isDestroyed()) {
            win.webContents.send("widget:preload-frames");
            win.webContents.invalidate();
          }
        }, 50);
      }
    }
    return !nativeTranslation;
  }

  function show() {
    if (!win || win.isDestroyed()) createWindow();
    if (settings.get("hostWindowOnly")) foreground.start(win.getNativeWindowHandle());
    if (!settings.get("hostWindowOnly") && !win.isVisible()) win.showInactive();
    syncVisibility();
    win.setIgnoreMouseEvents(settings.get("clickThrough"), { forward: true });
  }

  function focusWidgetForInput() {
    show();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      win.setIgnoreMouseEvents(false);
      win.focus();
    }
  }

  function apply(partial) {
    const allowed = [
      "scale", "alwaysOnTop", "reducedMotion", "sound", "volume", "soundSet",
      "bubbleOn", "turnCostOn", "turnCostDurationMs", "clickThrough", "snap",
      "bubblePage", "manualQuota", "manualPercent", "manualWeeklyPercent",
      "hostWindowOnly", "easterEggs", "discoverWsl", "extraBrainDirs",
      "geminiApiKey", "geminiBaseUrl", "geminiModel", "geminiSystemPrompt"
    ];
    const cleanPartial = Object.fromEntries(Object.entries(partial || {}).filter(([k]) => allowed.includes(k)));
    if (Object.hasOwn(cleanPartial, "geminiBaseUrl")) {
      cleanPartial.geminiBaseUrl = normalizeBaseUrl(cleanPartial.geminiBaseUrl);
    }
    const oldScale = settings.get("scale");
    const oldHostOnly = settings.get("hostWindowOnly");
    if (!oldHostOnly && cleanPartial.hostWindowOnly === true && win) {
      const pos = win.getBounds();
      settings.update({ x: pos.x, y: pos.y });
    }
    settings.update(cleanPartial);
    if (Object.hasOwn(cleanPartial, "discoverWsl") || Object.hasOwn(cleanPartial, "extraBrainDirs")) {
      adapter.setDiscoverWsl(settings.get("discoverWsl"));
      adapter.setExtraAppDataDirs(settings.get("extraBrainDirs"));
      adapter.scan();
    }
    syncQuotaState();
    if (settings.get("hostWindowOnly")) foreground.start(win?.getNativeWindowHandle());
    else foreground.stop();
    if (win) {
      if (!settings.get("hostWindowOnly") && (settings.get("scale") !== oldScale || oldHostOnly)) {
        const old = win.getBounds();
        const dim = bounds();
        const pos = oldHostOnly
          ? safePosition(settings.get("x"), settings.get("y"), dim.width, dim.height)
          : safePosition(old.x + old.width - dim.width, old.y + old.height - dim.height, dim.width, dim.height);
        win.setBounds({ ...pos, ...dim });
      }
      win.setAlwaysOnTop(!settings.get("hostWindowOnly") && settings.get("alwaysOnTop"));
      win.setIgnoreMouseEvents(settings.get("clickThrough"), { forward: true });
      syncVisibility();
    }
    audio.setEnabled(settings.get("sound"));
    audio.setVolume(settings.get("volume"));
    audio.setPreset(settings.get("soundSet"));
    publish();
    updateMenu();
    return snapshot();
  }

  function openSettings() {
    if (panel && !panel.isDestroyed()) {
      panel.show();
      panel.focus();
      return;
    }
    panel = new BrowserWindow({
      width: 560,
      height: 780,
      minWidth: 480,
      minHeight: 620,
      autoHideMenuBar: true,
      title: "喵言喵语 · 设置",
      backgroundColor: "#f6f4fb",
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    panel.loadFile(path.join(__dirname, "../renderer/settings.html"));
    panel.on("closed", () => { panel = null; });
  }

  function reset() {
    if (settings.get("hostWindowOnly")) {
      settings.update({ hostOffsetX: 18, hostOffsetY: 18, hostDock: "" });
      syncVisibility();
      publish();
      return;
    }
    const dim = bounds();
    const pos = safePosition(null, null, dim.width, dim.height);
    win.setBounds({ ...pos, ...dim });
    settings.update(pos);
    show();
  }

  function recall() {
    show();
    if (settings.get("hostWindowOnly") && !win.isVisible()) openSettings();
  }

  function updateMenu() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "喵言喵语 · Gemini 桌宠", enabled: false },
      { label: "打开对话输入框 (双击右键)", click: () => { focusWidgetForInput(); win?.webContents.send("widget:open-chat"); } },
      { label: "显示 / 唤回挂件", click: recall },
      { label: "重启挂件", click: () => { app.relaunch(); app.quit(); } },
      { label: "设置与 Gemini 对话配置", click: openSettings },
      { type: "separator" },
      { label: "仅在 Antigravity 窗口内显示", type: "checkbox", checked: settings.get("hostWindowOnly"), click: () => apply({ hostWindowOnly: !settings.get("hostWindowOnly") }) },
      { label: "显示气泡", type: "checkbox", checked: settings.get("bubbleOn"), click: () => apply({ bubbleOn: !settings.get("bubbleOn") }) },
      { label: "桌面模式始终置顶", type: "checkbox", enabled: !settings.get("hostWindowOnly"), checked: !settings.get("hostWindowOnly") && settings.get("alwaysOnTop"), click: () => apply({ alwaysOnTop: !settings.get("alwaysOnTop") }) },
      { label: "鼠标穿透 · Ctrl+Alt+Shift+G 恢复", type: "checkbox", checked: settings.get("clickThrough"), click: () => apply({ clickThrough: !settings.get("clickThrough") }) },
      { label: "停靠左下角", click: () => dock("left") },
      { label: "停靠右下角", click: () => dock("right") },
      { label: "重置位置", click: reset },
      { type: "separator" },
      { label: "退出喵言喵语", click: () => app.quit() }
    ]));
  }

  function createWindow() {
    const dim = bounds();
    const pos = safePosition(settings.get("x"), settings.get("y"), dim.width, dim.height);
    win = new BrowserWindow({
      ...dim,
      ...pos,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: !settings.get("hostWindowOnly") && settings.get("alwaysOnTop"),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false
      }
    });
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
    win.once("ready-to-show", show);
    win.on("closed", () => {
      foreground.stop();
      win = null;
      if (!quitting) setTimeout(show, 250);
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", e => e.preventDefault());
    win.webContents.on("render-process-gone", () => {
      if (!quitting && win && !win.isDestroyed()) win.destroy();
    });
    win.webContents.on("did-finish-load", () => {
      blankFrames = 0;
      publish();
    });
    let unresponsiveTimer;
    win.on("unresponsive", () => {
      const stuck = win;
      clearTimeout(unresponsiveTimer);
      unresponsiveTimer = setTimeout(() => {
        if (!quitting && win === stuck && !stuck.isDestroyed()) stuck.destroy();
      }, 10000);
    });
    win.on("responsive", () => clearTimeout(unresponsiveTimer));
    win.on("closed", () => clearTimeout(unresponsiveTimer));
  }

  function trusted(e) {
    return [win, panel].some(w => w && !w.isDestroyed() && e.sender === w.webContents);
  }

  ipcMain.handle("widget:get", e => (trusted(e) ? snapshot() : null));
  ipcMain.handle("widget:settings", (e, v) => (trusted(e) ? apply(v) : null));
  ipcMain.on("widget:command", (e, command) => {
    if (!trusted(e)) return;
    if (command === "settings") openSettings();
    else if (command === "menu") tray?.popUpContextMenu();
    else if (command === "focus") focusWidgetForInput();
    else if (command === "open-chat") { focusWidgetForInput(); win?.webContents.send("widget:open-chat"); }
    else if (command === "quit") app.quit();
    else if (command === "reset") reset();
    else if (command === "dock-left") dock("left");
    else if (command === "dock-right") dock("right");
    else if (command === "show-bubble") apply({ bubbleOn: true });
    else if (command === "preview-reaction") send("widget:reaction", {});
    else if (command === "quota-refresh") quotaAdapter.openNativeQuota().catch(() => {});
    else if (command === "refresh") {
      adapter.scan();
      quotaAdapter.tick();
      publish();
    }
  });

  ipcMain.handle("widget:chat-send", async (e, prompt) => {
    if (!trusted(e)) return null;
    const requestId = ++chatSeq;
    const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
    chatStreaming = true;
    sm.setPersistentState("thinking");
    send("widget:chat-event", {
      type: "start",
      requestId,
      prompt: cleanPrompt,
      model: settings.get("geminiModel")
    });
    publish();

    try {
      const result = await chatClient.sendMessage(
        cleanPrompt,
        {
          apiKey: settings.get("geminiApiKey"),
          baseUrl: settings.get("geminiBaseUrl"),
          model: settings.get("geminiModel"),
          systemInstruction: settings.get("geminiSystemPrompt")
        },
        {
          onDelta: (delta, fullText) => {
            if (requestId === chatSeq) {
              send("widget:chat-event", { type: "delta", requestId, delta, fullText });
            }
          }
        }
      );

      if (requestId === chatSeq) {
        chatStreaming = false;
        syncQuotaState();
        if (result.aborted) {
          send("widget:chat-event", { type: "aborted", requestId, text: result.text });
        } else {
          sm.handleTurnSuccess();
          send("widget:chat-event", {
            type: "done",
            requestId,
            text: result.text,
            usage: result.usage,
            model: result.model,
            hasContext: Boolean(chatClient.previousInteractionId)
          });
        }
        publish();
      }
      return { ok: true, aborted: result.aborted };
    } catch (err) {
      if (requestId === chatSeq) {
        chatStreaming = false;
        syncQuotaState();
        send("widget:chat-event", {
          type: "error",
          requestId,
          code: err?.code || "API_ERROR",
          message: err?.message || "Gemini 调用失败"
        });
        publish();
      }
      return { ok: false, code: err?.code || "API_ERROR", message: err?.message || "Gemini 调用失败" };
    }
  });

  ipcMain.handle("widget:chat-stop", e => {
    if (!trusted(e)) return null;
    chatClient.abort();
    chatStreaming = false;
    syncQuotaState();
    publish();
    return { ok: true };
  });

  ipcMain.handle("widget:chat-reset", e => {
    if (!trusted(e)) return null;
    chatSeq++;
    chatClient.resetConversation();
    chatStreaming = false;
    syncQuotaState();
    send("widget:chat-event", { type: "reset" });
    publish();
    return { ok: true };
  });

  function dragMove(point) {
    if (!drag || !win) return;
    const p = point || drag.last;
    const dx = p.x - drag.point.x;
    const dy = p.y - drag.point.y;
    drag.last = p;
    if (!drag.moved && Math.hypot(dx, dy) <= 8) return;
    if (!drag.moved) {
      drag.moved = true;
      sm.handleDragStart();
    }
    const a = hostArea || screen.getDisplayNearestPoint(p).workArea;
    const size = displayScale || settings.get("scale");
    const placement = characterPlacement(a, size, drag.bounds, drag.visualX + dx, drag.bounds.y + dy);
    win.setBounds(placement.bounds);
    artShift = placement.artShift;
    dockSide = "";
    facing = placement.visualX + size / 2 < a.x + a.width / 2 ? "left" : "right";
    publish();
  }

  function dock(side) {
    if (!win) return;
    if (settings.get("hostWindowOnly")) syncVisibility();
    const size = displayScale || settings.get("scale");
    const b = { ...win.getBounds(), ...bounds(size) };
    const a = hostArea || screen.getDisplayMatching(b).workArea;
    const placement = characterPlacement(a, size, b, side === "left" ? a.x : a.x + a.width - size, a.y + a.height - b.height);
    win.setBounds(placement.bounds);
    artShift = placement.artShift;
    dockSide = side;
    facing = side;
    if (hostArea) {
      settings.update({ hostOffsetX: side === "left" ? a.width - size : 0, hostOffsetY: 0, hostDock: side });
    } else {
      settings.update({ x: placement.bounds.x, y: placement.bounds.y });
    }
    publish();
  }

  ipcMain.handle("widget:pointer", (e, payload) => {
    const action = typeof payload === "string" ? payload : payload?.action;
    const raw = payload?.point;
    const point = raw && Number.isFinite(raw.x) && Number.isFinite(raw.y) && Math.abs(raw.x) < 100000 && Math.abs(raw.y) < 100000
      ? { x: raw.x, y: raw.y }
      : null;
    if (!trusted(e) || !win) return { moved: false };
    if (action === "down") {
      clearInterval(dragTimer);
      win.setIgnoreMouseEvents(false);
      const start = point || screen.getCursorScreenPoint();
      drag = {
        point: start,
        last: start,
        bounds: { ...win.getBounds(), ...bounds(displayScale || settings.get("scale")) },
        visualX: win.getBounds().x + (bounds(displayScale || settings.get("scale")).width - (displayScale || settings.get("scale"))) / 2 + artShift,
        moved: false
      };
      sm.handlePointerDown();
    } else if (action === "move" && point) {
      dragMove(point);
    } else if (action === "up" || action === "cancel") {
      clearInterval(dragTimer);
      dragTimer = null;
      if (!drag) return { moved: false };
      dragMove();
      const moved = drag.moved;
      drag = null;
      if (moved) {
        const size = displayScale || settings.get("scale");
        const old = { ...win.getBounds(), ...bounds(size) };
        const area = hostArea || screen.getDisplayMatching(old).workArea;
        let visualX = old.x + (old.width - size) / 2 + artShift;
        let y = old.y;
        if (settings.get("snap")) ({ visualX, y } = snapToEdges(area, size, old.height, visualX, y));
        const placement = characterPlacement(area, size, old, visualX, y);
        win.setBounds(placement.bounds);
        artShift = placement.artShift;
        dockSide = Math.abs(visualX - area.x) < 2 ? "left" : Math.abs(visualX + size - area.x - area.width) < 2 ? "right" : "";
        facing = visualX + size / 2 < area.x + area.width / 2 ? "left" : "right";
        if (hostArea) {
          settings.update({
            hostDock: dockSide,
            hostOffsetX: Math.max(0, hostArea.x + hostArea.width - placement.visualX - size),
            hostOffsetY: Math.max(0, hostArea.y + hostArea.height - placement.bounds.y - old.height)
          });
        } else {
          settings.update({ x: placement.bounds.x, y: placement.bounds.y });
        }
      }
      sm.handlePointerUp();
      return { moved };
    } else if (action === "pet") {
      sm.handlePetting();
    }
    return { moved: !!drag?.moved };
  });

  ipcMain.on("widget:hit", (e, interactive) => {
    if (trusted(e) && win && !drag) {
      win.setIgnoreMouseEvents(settings.get("clickThrough") || interactive !== true, { forward: true });
    }
  });

  ipcMain.handle("widget:audio", (e, type) => (trusted(e) && ["press", "release"].includes(type) ? audio.getAudioFile(type) : null));

  quotaAdapter.on("change", () => {
    syncQuotaState();
    publish();
  });
  sm.subscribe(publish);
  foreground.on("change", () => {
    if (syncVisibility() !== false) publish();
  });

  adapter.on("turnDone", step => {
    const recorded = ledger.recordStep(step);
    running.delete(step.sessionId + ":" + step.step_index);
    if (!step.historical) {
      syncQuotaState();
    }
    if (recorded) {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => ledger.save(), 1000);
      if (!step.historical && !recorded.updated && !chatStreaming) {
        sm.handleTurnSuccess();
        send("widget:step", recorded);
      }
    }
  });
  adapter.on("turnRunning", s => {
    if (!s.historical) {
      running.add(s.sessionId + ":" + s.stepIndex);
      sm.setPersistentState("thinking");
    }
  });
  adapter.on("turnError", s => {
    running.delete(s.sessionId + ":" + s.stepIndex);
    if (!s.historical && !chatStreaming) sm.setPersistentState("error");
  });
  adapter.on("status", status => {
    source = status;
    if (!chatStreaming) {
      if (!status.online) sm.setPersistentState("offline");
      else if (sm.persistentState === "offline") sm.setPersistentState(running.size ? "thinking" : "idle");
    }
    syncQuotaState();
    publish();
  });

  app.on("second-instance", (_event, args) => {
    if (args.includes("--quit")) app.quit();
    else if (!args.includes("--background")) recall();
  });

  app.whenReady().then(() => {
    createWindow();
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "../../assets/character-packs/gemini-star-v1/frames/idle.png")).resize({ width: 24, height: 24 }));
    tray.setToolTip("喵言喵语 · Antigravity");
    tray.on("double-click", recall);
    updateMenu();
    globalShortcut.register("CommandOrControl+Alt+G", recall);
    globalShortcut.register("CommandOrControl+Alt+Shift+G", () => {
      apply({ clickThrough: false });
      recall();
    });
    if (settings.get("hostWindowOnly")) foreground.start(win?.getNativeWindowHandle());
    audio.setEnabled(settings.get("sound"));
    audio.setVolume(settings.get("volume"));
    audio.setPreset(settings.get("soundSet"));
    adapter.start();
    quotaAdapter.start();

    recoveryTimer = setInterval(() => {
      if (!win || win.isDestroyed()) {
        show();
        return;
      }
      if (settings.get("hostWindowOnly")) foreground.start(win.getNativeWindowHandle());
    }, 2000);

    uptimeCheckTimer = setInterval(() => {
      const uptime = process.uptime();
      if (uptime > 7200) visualCheckInterval = 120000;
      else if (uptime > 3600) visualCheckInterval = 60000;
    }, 300000);

    visualTimer = setInterval(async () => {
      if (visualChecking || drag || !win || win.isDestroyed() || !win.isVisible() || (settings.get("hostWindowOnly") && !hostArea)) return;
      if (Date.now() - lastVisualCheck < visualCheckInterval) return;
      lastVisualCheck = Date.now();
      visualChecking = true;
      const checked = win;
      try {
        const healthy = await Promise.race([
          checked.webContents.executeJavaScript(`(()=>{const face=document.querySelector('.agy-face');if(!face)return false;const r=face.getBoundingClientRect();if(r.width<20||r.height<20)return false;let node=face;while(node){const s=getComputedStyle(node);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;node=node.parentElement;}return [...face.querySelectorAll('img')].some(img=>img.complete&&img.naturalWidth>0&&Number(getComputedStyle(img).opacity)>0);})()`),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(Error("renderer-check-timeout")), 4000);
            timer.unref();
          })
        ]);
        if (!healthy) {
          recoveryLog("invalid-character-layout-recreate");
          checked.destroy();
          return;
        }
        const frame = await Promise.race([
          checked.webContents.capturePage(),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(Error("capture-timeout")), 4000);
            timer.unref();
          })
        ]);
        const pixels = frame.toBitmap();
        let opaque = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 32) opaque++;
        blankFrames = opaque < 500 ? blankFrames + 1 : 0;
        if (blankFrames >= 2 && win === checked && !checked.isDestroyed()) {
          recoveryLog("blank-surface-recreate opaque=" + opaque);
          checked.destroy();
        }
      } catch (error) {
        if (win === checked && !checked.isDestroyed()) {
          recoveryLog("surface-check-recreate " + error.message);
          checked.destroy();
        }
      } finally {
        visualChecking = false;
      }
    }, 15000);

    const resume = () => {
      drag = null;
      hostLayout = null;
      foreground.stop();
      show();
      publish();
      if (win && !win.isDestroyed()) {
        win.webContents.send("widget:force-repaint");
        win.webContents.invalidate();
      }
    };
    powerMonitor.on("resume", resume);
    powerMonitor.on("unlock-screen", resume);
    screen.on("display-removed", reset);
    screen.on("display-metrics-changed", () => {
      if (settings.get("hostWindowOnly")) {
        syncVisibility();
        publish();
      }
    });
  });

  app.on("before-quit", () => {
    quitting = true;
    chatClient.abort();
    clearInterval(visualTimer);
    clearInterval(uptimeCheckTimer);
    clearInterval(recoveryTimer);
    clearInterval(dragTimer);
    foreground.stop();
    adapter.stop();
    quotaAdapter.stop();
    sm.destroy();
    clearTimeout(saveTimer);
    ledger.save();
    globalShortcut.unregisterAll();
    tray?.destroy();
  });

  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
}
