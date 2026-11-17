const path = require("node:path");
const os = require("node:os");
const { readJson, writeJson, finite, bool } = require("../../../shared/storage.cjs");
const { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT } = require("../adapters/gemini-chat.cjs");

const DEFAULT_SETTINGS = {
  x: null,
  y: null,
  scale: 220,
  alwaysOnTop: true,
  reducedMotion: false,
  sound: false,
  volume: 0.35,
  soundSet: "bubble-pop",
  bubbleOn: true,
  turnCostOn: true,
  turnCostDurationMs: 5000,
  clickThrough: false,
  snap: true,
  hostWindowOnly: false,
  hostOffsetX: 18,
  hostOffsetY: 18,
  hostDock: "",
  easterEggs: true,
  characterPack: "gemini-star-v1",
  currency: "CNY",
  bubblePage: "quota",
  manualQuota: false,
  manualPercent: null,
  manualWeeklyPercent: null,
  discoverWsl: true,
  extraBrainDirs: [],
  geminiApiKey: "",
  geminiBaseUrl: DEFAULT_BASE_URL,
  geminiModel: DEFAULT_MODEL,
  geminiSystemPrompt: DEFAULT_SYSTEM_PROMPT
};

const ALLOWED_SCALES = [140, 180, 220, 260, 300];
const ALLOWED_SOUND_SETS = ["original", "wood-tap", "bubble-pop", "soft-spring"];
const ALLOWED_BUBBLE_PAGES = ["quota", "talk", "today", "latest", "chat"];

class SettingsManager {
  constructor(file = path.join(os.homedir(), ".antigravity-cat-widget/settings.json")) {
    this.filePath = file;
    this.data = this.sanitize(readJson(file, DEFAULT_SETTINGS));
  }

  sanitize(input) {
    const s = { ...DEFAULT_SETTINGS, ...input };
    for (const k of ["alwaysOnTop", "reducedMotion", "sound", "bubbleOn", "turnCostOn", "clickThrough", "snap", "hostWindowOnly", "easterEggs", "discoverWsl"]) {
      s[k] = bool(s[k], DEFAULT_SETTINGS[k]);
    }
    for (const k of ["hostOffsetX", "hostOffsetY"]) {
      s[k] = finite(s[k], 18, 0, 100000);
    }
    s.hostDock = ["left", "right", ""].includes(s.hostDock) ? s.hostDock : "";
    s.scale = finite(s.scale, 220, 140, 360);
    s.volume = finite(s.volume, 0.35, 0, 1);
    for (const k of ["x", "y"]) {
      s[k] = typeof s[k] === "number" && Number.isFinite(s[k]) ? Math.round(s[k]) : null;
    }
    s.soundSet = ALLOWED_SOUND_SETS.includes(s.soundSet) ? s.soundSet : "bubble-pop";
    s.turnCostDurationMs = finite(s.turnCostDurationMs, 5000, 0, 60000);
    s.bubblePage = ALLOWED_BUBBLE_PAGES.includes(s.bubblePage) ? s.bubblePage : "quota";
    s.manualWeeklyPercent = finite(s.manualWeeklyPercent, null, 0, 100);
    s.manualQuota = bool(s.manualQuota, false);
    s.manualPercent = finite(s.manualPercent, null, 0, 100);
    s.extraBrainDirs = Array.isArray(s.extraBrainDirs)
      ? s.extraBrainDirs.filter(v => typeof v === "string" && v.trim()).map(v => v.trim()).slice(0, 16)
      : [];
    s.geminiApiKey = typeof s.geminiApiKey === "string" ? s.geminiApiKey.trim().slice(0, 512) : "";
    s.geminiBaseUrl = typeof s.geminiBaseUrl === "string" && s.geminiBaseUrl.trim()
      ? s.geminiBaseUrl.trim().slice(0, 512)
      : DEFAULT_BASE_URL;
    s.geminiModel = typeof s.geminiModel === "string" && /^[a-zA-Z0-9._:-]{2,100}$/.test(s.geminiModel.trim())
      ? s.geminiModel.trim()
      : DEFAULT_MODEL;
    s.geminiSystemPrompt = typeof s.geminiSystemPrompt === "string"
      ? s.geminiSystemPrompt.trim().slice(0, 2000)
      : DEFAULT_SYSTEM_PROMPT;
    return s;
  }

  save() {
    writeJson(this.filePath, this.data);
    return true;
  }

  update(partial) {
    this.data = this.sanitize({ ...this.data, ...partial });
    this.data.manualQuota = bool(this.data.manualQuota, false);
    this.data.manualPercent = finite(this.data.manualPercent, null, 0, 100);
    this.save();
    return this.getAll();
  }

  get(k) {
    return this.data[k];
  }

  getAll() {
    return { ...this.data };
  }
}

module.exports = { SettingsManager, DEFAULT_SETTINGS, ALLOWED_SCALES, ALLOWED_SOUND_SETS, ALLOWED_BUBBLE_PAGES };
