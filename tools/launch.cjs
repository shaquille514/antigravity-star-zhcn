const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const target = process.argv[2] || "suite";

const TARGET_MAP = {
  hagemi: ["hagemi"],
  widget: ["widget"],
  skin: ["skin"],
  suite: ["hagemi", "skin"],
  both: ["widget", "skin"],
  all: ["hagemi", "widget", "skin"]
};
const targets = TARGET_MAP[target] || TARGET_MAP.suite;

let exe = path.join(root, "runtime/electron-45.1.0/electron.exe");
if (!fs.existsSync(exe)) {
  try {
    exe = require(require.resolve("electron", { paths: [root] }));
  } catch {}
}
if (!fs.existsSync(exe)) {
  throw new Error("未找到 Electron 运行时，请先执行「一键安装与配置.bat」或 npm ci。");
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const flags = process.argv.slice(3).filter(f => ["--enable", "--disable", "--quit", "--background", "--chat"].includes(f));

const ENTRY_CONFIG = {
  hagemi: {
    entry: path.join(root, "hagemi-pet", "desktop", "main.cjs"),
    logDir: path.join(os.homedir(), ".antigravity-hagemi-desktop")
  },
  widget: {
    entry: path.join(root, "Antigravity-Cat-Widget", "src", "main", "index.cjs"),
    logDir: path.join(os.homedir(), ".antigravity-cat-widget")
  },
  skin: {
    entry: path.join(root, "Antigravity-Dream-Skin", "src", "main", "index.cjs"),
    logDir: path.join(os.homedir(), ".antigravity-dream-skin")
  }
};

for (const kind of targets) {
  const cfg = ENTRY_CONFIG[kind];
  if (!cfg || !fs.existsSync(cfg.entry)) continue;
  fs.mkdirSync(cfg.logDir, { recursive: true });
  const log = fs.openSync(path.join(cfg.logDir, "startup.log"), "a");
  const child = spawn(exe, [cfg.entry, ...flags], {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", log, log],
    windowsHide: false
  });
  fs.closeSync(log);
  child.unref();
}
