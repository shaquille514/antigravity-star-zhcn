(async () => {
  const api = window.widgetApi;
  const $ = id => document.getElementById(id);
  let data = await api.get();
  let active = null;
  let generation = 0;

  for (const p of data.presets) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    $("soundSet").append(o);
  }

  const keys = [
    "hostWindowOnly", "easterEggs", "scale", "alwaysOnTop", "snap", "reducedMotion",
    "clickThrough", "bubbleOn", "turnCostOn", "discoverWsl", "turnCostDurationMs",
    "sound", "soundSet", "volume", "manualQuota", "manualPercent", "manualWeeklyPercent",
    "geminiModel", "geminiBaseUrl", "geminiSystemPrompt"
  ];
  const original = Object.fromEntries(keys.map(key => [key, data.settings[key]]));
  let pending = Promise.resolve();

  function save(partial, message = "已保存") {
    pending = pending.then(async () => {
      try {
        data = await api.save(partial);
        stop();
        render();
        $("saved").textContent = message;
      } catch (err) {
        const msg = String(err?.message || "").replace(/^Error invoking remote method [^:]+:\s*(?:Error:\s*)?/i, "");
        $("saved").textContent = msg || "保存失败，请重试";
      }
    });
    return pending;
  }

  function render() {
    const q = data.quotaWindows || {};
    const labels = {
      ready: "后台额度已读取",
      querying: "正在后台读取额度",
      "waiting-host": "等待宿主连接，将自动重试",
      "unsupported-or-initializing": "宿主初始化中或接口不兼容，将自动重试",
      "quota-unavailable": "宿主未返回额度",
      "query-failed": "额度查询失败，将自动重试"
    };
    $("quota-status").textContent = (labels[q.status] || "等待后台额度") + (q.stale ? " · 旧值待更新" : "");

    for (const key of keys) {
      const el = $(key);
      if (document.activeElement !== el) {
        if (el.type === "checkbox") el.checked = data.settings[key];
        else el.value = key === "volume" ? Math.round(data.settings.volume * 100) : (data.settings[key] ?? "");
      }
    }

    const chatInfo = data.chat || {};
    if (document.activeElement !== $("geminiApiKey")) {
      $("geminiApiKey").value = "";
      $("geminiApiKey").placeholder = chatInfo.keyMask
        ? `已保存 (${chatInfo.keyMask})，输入新 Key 可覆盖`
        : chatInfo.usingEnvKey
          ? "已从环境变量 GEMINI_API_KEY 读取"
          : "粘贴 Gemini API Key";
    }
    $("gemini-key-hint").textContent = chatInfo.hasApiKey
      ? "Gemini 实时对话已就绪：在桌宠上双击右键即可弹出输入框。"
      : "尚未配置 API Key：填入后在桌宠上双击右键即可唤起 Gemini 实时对话。";

    $("scale-value").textContent = data.settings.scale + " px";
    $("volume-value").textContent = Math.round(data.settings.volume * 100) + "%";
    $("source").textContent = (data.source.online ? "已找到 " + data.source.files + " 份日志" : "未检测到会话日志") + " · 本机只读";
    $("audio-note").textContent = data.settings.sound ? "已启用" : "已静音";
  }

  function stop() {
    generation++;
    active?.pause();
    active = null;
  }

  for (const key of keys) {
    const el = $(key);
    el.addEventListener(el.type === "range" ? "input" : "change", () => {
      const v = el.type === "checkbox"
        ? el.checked
        : (el.type === "range" || el.type === "number" || key === "turnCostDurationMs")
          ? (el.value === "" ? null : Number(el.value))
          : el.value;
      save({ [key]: key === "volume" ? v / 100 : v });
    });
  }

  function saveApiKeyInput() {
    const val = $("geminiApiKey").value.trim();
    if (!val) {
      $("saved").textContent = "请先输入有效的 API Key";
      return;
    }
    save({ geminiApiKey: val }, "API Key 已保存").then(() => {
      $("geminiApiKey").value = "";
    });
  }

  $("geminiApiKey").addEventListener("change", () => {
    if ($("geminiApiKey").value.trim()) saveApiKeyInput();
  });
  $("saveApiKey").onclick = saveApiKeyInput;

  $("clearApiKey").onclick = () => {
    $("geminiApiKey").value = "";
    save({ geminiApiKey: "" }, "已清除本地 API Key");
  };

  $("preview-reaction").onclick = () => api.command("preview-reaction");
  $("undo").onclick = () => save(original, "已恢复到打开设置时");
  $("dock-left").onclick = () => api.command("dock-left");
  $("dock-right").onclick = () => api.command("dock-right");
  $("reset").onclick = () => api.command("reset");
  $("quota-refresh").onclick = () => api.command("quota-refresh");
  $("refresh").onclick = () => api.command("refresh");

  $("audition").onclick = async () => {
    stop();
    if (!data.settings.sound || !data.settings.volume) {
      $("audio-note").textContent = "请先启用音效并提高音量";
      return;
    }
    const token = generation;
    const first = await api.audio("press");
    if (!first || token !== generation) return;
    active = new Audio(first.url);
    active.volume = first.effectiveVolume;
    active.onended = async () => {
      const p = await api.audio("release");
      if (p && token === generation) {
        active = new Audio(p.url);
        active.volume = p.effectiveVolume;
        active.play().catch(() => {});
      }
    };
    active.play().catch(() => ($("audio-note").textContent = "播放未成功"));
  };

  api.subscribe(next => {
    if (next.settings.sound !== data.settings.sound || next.settings.volume !== data.settings.volume || next.settings.soundSet !== data.settings.soundSet) {
      stop();
    }
    data = next;
    render();
  });

  window.addEventListener("beforeunload", stop);
  render();
})();
