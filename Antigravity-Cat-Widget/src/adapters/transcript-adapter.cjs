const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { EventEmitter } = require("node:events");

/**
 * 解析 wsl.exe -l -q 输出（Windows 上常为 UTF-16LE 编码，含 \0 与 BOM）。
 * @param {Buffer|string} raw
 * @returns {string[]}
 */
function parseWslDistroList(raw) {
  if (!raw) return [];
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  const hasNull = buf.includes(0);
  const text = hasNull ? buf.toString("utf16le") : buf.toString("utf8");
  return text
    .replace(/^\uFEFF/, "")
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

/**
 * 扫描单个应用数据目录下的 brain 会话日志路径。
 * @param {string} rootDir
 * @returns {{p: string, mtime: number}[]}
 */
function scanBrainRoot(rootDir) {
  const results = [];
  if (!rootDir || typeof rootDir !== "string") return results;
  const brain = path.join(rootDir, "brain");
  try {
    for (const d of fs.readdirSync(brain, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const p = path.join(brain, d.name, ".system_generated/logs/transcript_full.jsonl");
      try {
        const st = fs.statSync(p);
        if (st.isFile()) results.push({ p, mtime: st.mtimeMs });
      } catch {}
    }
  } catch {}
  return results;
}

class TranscriptAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.appDataDir = options.appDataDir || path.join(os.homedir(), ".gemini/antigravity");
    this.extraAppDataDirs = Array.isArray(options.extraAppDataDirs) ? options.extraAppDataDirs.filter(Boolean) : [];
    this.discoverWsl = options.discoverWsl !== false && !options.appDataDir && !options.filePath;
    this.filePath = options.filePath || null;
    this.cursors = new Map();
    this.timer = null;
    this.pollMs = options.pollMs || 2000;
    this.discoveredWslDirs = [];
    this.lastWslRefresh = 0;
    this.wslRefreshing = false;
    this.stopped = false;
  }

  setExtraAppDataDirs(dirs) {
    this.extraAppDataDirs = Array.isArray(dirs) ? dirs.filter(Boolean) : [];
  }

  setDiscoverWsl(enabled) {
    this.discoverWsl = Boolean(enabled) && !this.filePath;
    if (!this.discoverWsl) this.discoveredWslDirs = [];
  }

  _envExtraDirs() {
    const raw = process.env.AGY_EXTRA_BRAIN_DIRS;
    if (!raw) return [];
    return raw.split(path.delimiter).map(s => s.trim()).filter(Boolean);
  }

  _refreshWslDirsAsync() {
    if (!this.discoverWsl || process.platform !== "win32" || this.wslRefreshing || this.stopped) return;
    if (Date.now() - this.lastWslRefresh < 60000) return;
    this.wslRefreshing = true;
    this.lastWslRefresh = Date.now();
    execFile("wsl.exe", ["-l", "-q"], { encoding: "buffer", timeout: 1500, windowsHide: true }, (err, stdout) => {
      this.wslRefreshing = false;
      if (this.stopped || err || !stdout) return;
      const distros = parseWslDistroList(stdout);
      const found = [];
      for (const distro of distros) {
        for (const prefix of [`\\\\wsl.localhost\\${distro}\\home`, `\\\\wsl$\\${distro}\\home`]) {
          try {
            if (!fs.existsSync(prefix)) continue;
            for (const userEntry of fs.readdirSync(prefix, { withFileTypes: true })) {
              if (!userEntry.isDirectory()) continue;
              const candidate = path.join(prefix, userEntry.name, ".gemini", "antigravity");
              if (fs.existsSync(path.join(candidate, "brain"))) {
                found.push(candidate);
              }
            }
            break;
          } catch {}
        }
      }
      this.discoveredWslDirs = [...new Set(found)];
    });
  }

  files() {
    if (this.filePath) return fs.existsSync(this.filePath) ? [this.filePath] : [];
    const seenRoots = new Set();
    const roots = [];
    for (const dir of [this.appDataDir, ...this.extraAppDataDirs, ...this.discoveredWslDirs, ...this._envExtraDirs()]) {
      if (!dir || typeof dir !== "string") continue;
      const resolved = path.resolve(dir);
      if (seenRoots.has(resolved)) continue;
      seenRoots.add(resolved);
      roots.push(resolved);
    }
    const seenFiles = new Set();
    const collected = [];
    for (const root of roots) {
      for (const item of scanBrainRoot(root)) {
        const key = path.resolve(item.p);
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        collected.push(item);
      }
    }
    return collected.sort((a, b) => b.mtime - a.mtime).slice(0, 64).map(f => f.p);
  }

  resolveTranscriptPath() {
    return this.files()[0] || null;
  }

  scan() {
    this._refreshWslDirsAsync();
    const files = this.files();
    let newest = 0;
    let readable = 0;
    let hasWslSource = false;
    const active = new Set(files);
    for (const file of this.cursors.keys()) if (!active.has(file)) this.cursors.delete(file);
    for (const file of files) {
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        if (/^\\\\wsl(?:\.localhost|\$)\\/i.test(file)) hasWslSource = true;
        let c = this.cursors.get(file);
        if (!c || stat.size < c.offset) c = { offset: 0, pending: Buffer.alloc(0), seen: new Map(), baselineSize: stat.size };
        const fd = fs.openSync(file, "r");
        try {
          let budget = 8 * 1024 * 1024;
          while (c.offset < stat.size && budget > 0) {
            const b = Buffer.alloc(Math.min(262144, stat.size - c.offset, budget));
            const n = fs.readSync(fd, b, 0, b.length, c.offset);
            if (!n) break;
            c.offset += n;
            budget -= n;
            c.pending = Buffer.concat([c.pending, b.subarray(0, n)]);
            let end;
            while ((end = c.pending.indexOf(10)) >= 0) {
              const line = c.pending.subarray(0, end);
              c.pending = c.pending.subarray(end + 1);
              if (c.discarding) {
                c.discarding = false;
                continue;
              }
              if (line.length > 4194304) continue;
              let s;
              try {
                s = JSON.parse(line.toString("utf8"));
              } catch {
                continue;
              }
              if (!Number.isSafeInteger(s.step_index) || s.source !== "MODEL" || s.type !== "PLANNER_RESPONSE") continue;
              const signature = [s.status, s.input_tokens, s.cache_read_tokens, s.output_tokens].join("|");
              if (c.seen.get(s.step_index) === signature) continue;
              c.seen.set(s.step_index, signature);
              const sessionId = path.basename(path.resolve(file, "../../.."));
              if (c.seen.size > 10000) c.seen.delete(c.seen.keys().next().value);
              const event = {
                sessionId,
                step_index: s.step_index,
                created_at: s.created_at,
                status: s.status,
                source: s.source,
                type: s.type,
                input_tokens: s.input_tokens ?? null,
                cache_read_tokens: s.cache_read_tokens ?? null,
                output_tokens: s.output_tokens ?? null,
                historical: c.offset - c.pending.length <= c.baselineSize
              };
              if (s.source === "MODEL" && s.type === "PLANNER_RESPONSE") {
                this.emit("step", event);
                if (s.status === "DONE") this.emit("turnDone", event);
                else if (s.status === "ERROR") this.emit("turnError", { sessionId, stepIndex: s.step_index, historical: event.historical });
                else if (s.status === "RUNNING") this.emit("turnRunning", { sessionId, stepIndex: s.step_index, historical: event.historical });
              }
            }
            if (c.pending.length > 4194304) {
              c.pending = Buffer.alloc(0);
              c.discarding = true;
            }
          }
        } finally {
          fs.closeSync(fd);
        }
        this.cursors.set(file, c);
        readable++;
        newest = Math.max(newest, stat.mtimeMs);
      } catch {}
    }
    this.emit("status", {
      online: readable > 0,
      source: hasWslSource ? "本机及 WSL Antigravity 日志" : "本机 Antigravity 日志",
      coverage: "最近 64 份会话 · 模型步骤",
      files: readable,
      lastUpdated: newest ? new Date(newest).toISOString() : null
    });
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { TranscriptAdapter, parseWslDistroList, scanBrainRoot };
