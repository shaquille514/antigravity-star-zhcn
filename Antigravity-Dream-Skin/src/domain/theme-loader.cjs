const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CUSTOM_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};
const MAX_CUSTOM_WALLPAPER_BYTES = 25 * 1024 * 1024;

class DreamSkinThemeLoader {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(__dirname, "../..");
    this.wallpaperPackDir = path.join(this.rootDir, "assets/wallpapers/gemini-character-sheet-v1");
    try {
      this.manifest = JSON.parse(fs.readFileSync(path.join(this.wallpaperPackDir, "manifest.json"), "utf8"));
    } catch {
      this.manifest = null;
    }
  }

  verifyIntegrity() {
    if (!this.manifest) {
      try {
        this.manifest = JSON.parse(fs.readFileSync(path.join(this.wallpaperPackDir, "manifest.json"), "utf8"));
      } catch {
        throw new Error("壁纸清单缺失或损坏，请恢复完整资源包");
      }
    }
    if (!this.manifest || typeof this.manifest.file !== "string") throw new Error("无效壁纸路径");
    const p = path.resolve(this.wallpaperPackDir, this.manifest.file);
    if (!p.startsWith(this.wallpaperPackDir + path.sep) || path.extname(p) !== ".png") {
      throw new Error("无效壁纸路径");
    }
    let b;
    try {
      b = fs.readFileSync(p);
    } catch {
      throw new Error("壁纸图片无法读取，请恢复完整资源包");
    }
    const hash = crypto.createHash("sha256").update(b).digest("hex");
    if (hash !== this.manifest.sha256) throw new Error("壁纸校验失败，原文件可能被更改");
    return { ...this.manifest, file: p, mime: "image/png", custom: false, verified: true };
  }

  verifyCustomWallpaper(customPath) {
    if (typeof customPath !== "string" || !customPath.trim()) {
      throw new Error("自定义壁纸路径为空");
    }
    const resolved = path.resolve(customPath.trim());
    const ext = path.extname(resolved).toLowerCase();
    const mime = CUSTOM_MIME_BY_EXT[ext];
    if (!mime) {
      throw new Error("仅支持 PNG / JPG / WebP 格式壁纸");
    }
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error("自定义壁纸文件不存在或无法读取");
    }
    if (!stat.isFile()) {
      throw new Error("自定义壁纸路径不是有效文件");
    }
    if (stat.size <= 0 || stat.size > MAX_CUSTOM_WALLPAPER_BYTES) {
      throw new Error("自定义壁纸文件大小需在 1B 至 25MB 之间");
    }
    return {
      name: path.basename(resolved),
      file: resolved,
      mime,
      custom: true,
      verified: true
    };
  }

  resolveWallpaper(settings = {}) {
    if (settings && typeof settings.customWallpaperPath === "string" && settings.customWallpaperPath.trim()) {
      return this.verifyCustomWallpaper(settings.customWallpaperPath);
    }
    return this.verifyIntegrity();
  }

  payload(settings) {
    const m = this.resolveWallpaper(settings);
    const mime = m.mime || "image/png";
    return {
      version: 2,
      outputMode: settings.outputMode === "glass" ? "glass" : "transparent",
      positionX: Math.max(0, Math.min(100, settings.positionX ?? 50)),
      positionY: Math.max(0, Math.min(100, settings.positionY ?? 50)),
      zoom: Math.max(1, Math.min(2, settings.zoom ?? 1)),
      opacity: Math.max(0, Math.min(100, settings.opacity ?? 55)) / 100,
      fit: ["cover", "contain", "adaptive"].includes(settings.fit) ? settings.fit : "adaptive",
      scrim: Math.max(0, Math.min(60, settings.scrim ?? 12)) / 100,
      image: "data:" + mime + ";base64," + fs.readFileSync(m.file).toString("base64")
    };
  }
}

module.exports = { DreamSkinThemeLoader };
