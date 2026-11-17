const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DreamSkinSettings } = require("../src/domain/settings.cjs");
const { DreamSkinThemeLoader } = require("../src/domain/theme-loader.cjs");
const { SuiteBridge } = require("../src/domain/suite-bridge.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dream-suite-test-"));

test("an already translated client still reports a pending localization update", async () => {
  const dir = tmp();
  const asarPath = path.join(dir, "app.asar");
  fs.writeFileSync(asarPath, "current");
  fs.writeFileSync(path.join(dir, "app.asar.staged"), "pending");
  const bridge = new SuiteBridge({ rootDir: dir, geminiConfigDir: path.join(dir, "config"), discover: async () => null });
  bridge._loadCli = () => ({ isAsarPatched: () => true, isProcessRunning: () => true });
  bridge._findAsarQuiet = () => asarPath;
  const status = await bridge.getStatus();
  assert.equal(status.patched, true);
  assert.equal(status.staged, true);
});

test("customWallpaperPath persists, validates image format, and falls back to default when cleared", () => {
  const dir = tmp();
  const settingsFile = path.join(dir, "settings.json");
  const imgFile = path.join(dir, "custom.jpg");
  fs.writeFileSync(imgFile, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));

  const settings = new DreamSkinSettings(settingsFile);
  assert.equal(settings.get("customWallpaperPath"), "");
  settings.update({ customWallpaperPath: imgFile });

  const reloaded = new DreamSkinSettings(settingsFile);
  assert.equal(reloaded.get("customWallpaperPath"), imgFile);

  const loader = new DreamSkinThemeLoader();
  const payload = loader.payload(reloaded.getAll());
  assert(payload.image.startsWith("data:image/jpeg;base64,"));

  assert.throws(() => loader.verifyCustomWallpaper(path.join(dir, "bad.txt")), /仅支持 PNG/);
  assert.throws(() => loader.verifyCustomWallpaper(path.join(dir, "missing.png")), /不存在/);

  settings.update({ customWallpaperPath: "" });
  const defaultPayload = loader.payload(settings.getAll());
  assert(defaultPayload.image.startsWith("data:image/png;base64,"));
});

test("SuiteBridge reports status cleanly and rejects unknown actions", async () => {
  const dir = tmp();
  const geminiConfigDir = path.join(dir, ".gemini", "config");
  const pluginDir = path.join(geminiConfigDir, "plugins", "hagemi-pet-agy");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ id: "hagemi-pet-agy" }));
  fs.writeFileSync(
    path.join(geminiConfigDir, "config.json"),
    JSON.stringify({ plugins: { "hagemi-pet-agy": { enabled: true } }, sidecars: { "hagemi-pet-agy/pet": { enabled: true } } })
  );

  const calls = [];
  const bridge = new SuiteBridge({
    geminiConfigDir,
    discover: async () => ({ port: 9333, target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/1" } }),
    execFile: (bin, args, opts, cb) => {
      calls.push({ bin, args, env: opts.env });
      cb(null, "Installed", "");
    }
  });
  const status = await bridge.getStatus();
  assert.equal(status.cdpReady, true);
  assert.equal(status.cdpPort, 9333);
  assert.equal(status.catWidgetAvailable, true);
  assert.equal(status.hagemiAvailable, true);
  assert.equal(status.hagemiInstalled, true);
  assert.equal(status.hagemiEnabled, true);

  const bad = await bridge.runLocalization("unknown-action");
  assert.equal(bad.ok, false);
  assert.match(bad.message, /不支持的操作类型/);

  const badHagemi = await bridge.runHagemi("unknown-action");
  assert.equal(badHagemi.ok, false);
  assert.match(badHagemi.message, /不支持的操作类型/);

  const installHagemi = await bridge.runHagemi("install");
  assert.equal(installHagemi.ok, true);
  assert.match(installHagemi.message, /已安装并启用哈基米/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.ELECTRON_RUN_AS_NODE, "1");
});

test("SuiteBridge reports desktop floating Hagemi state and launches desktop mode cleanly", async () => {
  const dir = tmp();
  const geminiDir = path.join(dir, ".gemini");
  const geminiConfigDir = path.join(geminiDir, "config");
  const pluginDir = path.join(geminiConfigDir, "plugins", "hagemi-pet-agy");
  const lockFile = path.join(geminiDir, "antigravity", "sidecar_data", "hagemi-pet-agy", "pet", "data", "desktop.lock.json");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ id: "hagemi-pet-agy" }));
  fs.writeFileSync(
    path.join(geminiConfigDir, "config.json"),
    JSON.stringify({ plugins: { "hagemi-pet-agy": { enabled: true } }, sidecars: { "hagemi-pet-agy/pet": { enabled: true } } })
  );
  // 写入当前测试进程 PID 模拟桌面漂浮进程正在运行
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

  const spawned = [];
  const bridge = new SuiteBridge({
    geminiDir,
    geminiConfigDir,
    hagemiDesktopLockFile: lockFile,
    discover: async () => ({ port: 9333, target: { webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/1" } }),
    execFile: (_bin, _args, opts, cb) => cb(null, "Installed", ""),
    spawn: (bin, args, opts) => {
      spawned.push({ bin, args, opts });
      return { unref() {} };
    }
  });
  const status = await bridge.getStatus();
  assert.equal(status.hagemiDesktopAvailable, true);
  assert.equal(status.hagemiDesktopRunning, true);
  assert.equal(status.hagemiInstalled, true);
  assert.equal(status.hagemiEnabled, true);

  const launchRes = bridge.launchHagemiDesktop();
  assert.equal(launchRes.ok, true);
  assert.match(launchRes.message, /桌面漂浮哈基米/);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].args.at(-1), "hagemi");
});
