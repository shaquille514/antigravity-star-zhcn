(async () => {
  const api = window.dreamApi;
  const $ = id => document.getElementById(id);
  let data = await api.get();
  let timer;
  let panTimer;
  let drag = null;
  let draft = null;
  const original = { ...data.settings };
  let pending = Promise.resolve();
  let lastPreviewSrc = "";

  function renderAsset() {
    const error = data.wallpaperError;
    $("wallpaper").hidden = !!error;
    $("enabled").disabled = !!error && !data.settings.enabled;
    $("asset-status").textContent = error || "轻一点，工作更舒服。";
    const nextSrc = data.previewImageUrl || "../../assets/wallpapers/gemini-character-sheet-v1/wallpaper.png";
    if (nextSrc && lastPreviewSrc !== nextSrc) {
      lastPreviewSrc = nextSrc;
      $("wallpaper").src = nextSrc;
    }
    if (data.customWallpaper && data.wallpaper) {
      $("wallpaper-title").textContent = "自定义壁纸 · " + data.wallpaper;
      $("wallpaper-meta").textContent = "本地图片 · 已应用透明与阅读保护";
      $("wallpaper-tags").textContent = "可随时恢复星语默认壁纸";
    } else {
      $("wallpaper-title").textContent = "Gemini Character Sheet";
      $("wallpaper-meta").textContent = "1672 × 941 · 原图完整保留";
      $("wallpaper-tags").textContent = "三视图 / 表情 / 饰品 / 色板";
    }
  }

  function render() {
    const s = { ...data.settings, ...draft };
    document.querySelectorAll("[data-output-mode]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.outputMode === s.outputMode)));
    for (const key of ["positionX", "positionY"]) {
      if (document.activeElement !== $(key)) $(key).value = s[key];
    }
    $("zoom").value = s.zoom * 100;
    $("zoom-value").textContent = Math.round(s.zoom * 100) + "%";
    renderPosition(s);
    $("opacity").value = s.opacity;
    $("opacity-value").textContent = s.opacity + "%";
    $("wallpaper").style.opacity = s.opacity / 100;
    $("enabled").checked = s.enabled;
    if (document.activeElement !== $("scrim")) $("scrim").value = s.scrim;
    $("scrim-value").textContent = s.scrim + "%";
    $("shade").style.opacity = s.scrim / 100;
    $("wallpaper").style.objectFit = s.fit === "contain" ? "contain" : "cover";
    document.querySelectorAll("[data-fit]").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.fit === s.fit)));
    $("fit-note").textContent = s.fit === "adaptive"
      ? "随窗口铺满，不留上下空带；原图不拉伸，边缘适度裁切。"
      : s.fit === "contain"
        ? "完整保留设定集，不拉伸。"
        : "填满视区，边缘内容可能被裁切。";
    $("status").textContent = data.status.message;
    $("connection-title").textContent = data.status.applied ? "皮肤已应用" : data.status.connected ? "宿主已连接" : "等待宿主";
    $("dot").classList.toggle("active", data.status.connected);
  }

  function renderSuiteStatus(st) {
    if (!st) return;
    const i18nBadge = $("i18n-badge");
    const hagemiBadge = $("hagemi-badge");
    const cdpBadge = $("cdp-badge");
    i18nBadge.className = "";
    hagemiBadge.className = "";
    cdpBadge.className = "";
    if (!st.asarFound) {
      i18nBadge.textContent = "未检测到客户端";
    } else if (st.staged) {
      i18nBadge.textContent = st.patched ? "中文更新待退出后生效" : "预注入待重启生效";
      i18nBadge.classList.add("warn");
    } else if (st.patched) {
      i18nBadge.textContent = "已安装中文 (2.32.2)";
      i18nBadge.classList.add("ok");
    } else {
      i18nBadge.textContent = "英文原版";
    }

    if (st.hagemiDesktopRunning) {
      hagemiBadge.textContent = "桌面漂浮运行中";
      hagemiBadge.classList.add("ok");
    } else if (st.hagemiDesktopAvailable) {
      hagemiBadge.textContent = st.hagemiInstalled && st.hagemiEnabled ? "桌面已就绪 (含插件)" : "桌面模式已就绪";
      hagemiBadge.classList.add("ok");
    } else if (st.hagemiInstalled && st.hagemiEnabled) {
      hagemiBadge.textContent = "已安装 CDP 插件";
      hagemiBadge.classList.add("ok");
    } else {
      hagemiBadge.textContent = "模块缺失";
      hagemiBadge.classList.add("warn");
    }

    if (st.cdpReady) {
      cdpBadge.textContent = "已连接 :" + st.cdpPort;
      cdpBadge.classList.add("ok");
    } else {
      cdpBadge.textContent = st.hostRunning ? "未开启调试端口" : "宿主未启动";
      cdpBadge.classList.add("warn");
    }
  }

  async function refreshSuiteStatus() {
    try {
      const st = await api.getSuiteStatus();
      renderSuiteStatus(st);
    } catch {}
  }

  function save(partial, message = "已保存") {
    pending = pending.then(async () => {
      try {
        data = await api.save(partial);
        $("saved").textContent = message;
        renderAsset();
        render();
      } catch (e) {
        $("saved").textContent = e.message;
      }
    });
    return pending;
  }

  $("undo").onclick = () => {
    clearTimeout(timer);
    clearTimeout(panTimer);
    panTimer = null;
    draft = null;
    save(original, "已恢复到打开面板时");
  };

  $("defaults").onclick = () => {
    clearTimeout(timer);
    clearTimeout(panTimer);
    panTimer = null;
    draft = null;
    save(data.defaults, "已恢复默认，皮肤已关闭");
  };

  $("opacity").oninput = () => {
    const opacity = Number($("opacity").value);
    $("opacity-value").textContent = opacity + "%";
    $("wallpaper").style.opacity = opacity / 100;
    save({ opacity });
  };

  document.querySelectorAll("[data-output-mode]").forEach(b => b.onclick = () => save({ outputMode: b.dataset.outputMode }));
  $("enabled").onchange = () => save({ enabled: $("enabled").checked });
  document.querySelectorAll("[data-fit]").forEach(b => b.onclick = () => save({ fit: b.dataset.fit }));

  $("scrim").oninput = () => {
    const scrim = Number($("scrim").value);
    $("scrim-value").textContent = scrim + "%";
    $("shade").style.opacity = scrim / 100;
    clearTimeout(timer);
    timer = setTimeout(() => save({ scrim }), 200);
  };
  $("scrim").onchange = () => {
    clearTimeout(timer);
    save({ scrim: Number($("scrim").value) });
  };

  $("restore").onclick = () => {
    clearTimeout(timer);
    save({ enabled: false });
  };

  $("refresh").onclick = async () => {
    data = await api.refresh();
    renderAsset();
    render();
    await refreshSuiteStatus();
  };

  $("pick-wallpaper").onclick = async () => {
    const res = await api.pickWallpaper();
    if (!res || res.canceled) return;
    if (res.snapshot) {
      data = res.snapshot;
      renderAsset();
      render();
    }
    $("saved").textContent = res.ok ? "已更换自定义壁纸" : (res.message || "更换壁纸失败");
  };

  $("reset-wallpaper").onclick = async () => {
    const res = await api.resetWallpaper();
    if (res?.snapshot) {
      data = res.snapshot;
      renderAsset();
      render();
    }
    $("saved").textContent = "已恢复星语默认壁纸";
  };

  async function handleLocalize(action, btn) {
    const other = action === "install" ? $("suite-restore-i18n") : $("suite-install-i18n");
    btn.disabled = true;
    other.disabled = true;
    $("suite-feedback").textContent = action === "install" ? "正在注入中文补丁，请稍候…" : "正在恢复官方英文原版…";
    try {
      const res = await api.runLocalization(action);
      if (res?.status) renderSuiteStatus(res.status);
      $("suite-feedback").textContent = res?.message || "操作完成";
    } catch (err) {
      $("suite-feedback").textContent = err.message;
    } finally {
      btn.disabled = false;
      other.disabled = false;
    }
  }

  async function handleHagemi(action, btn) {
    const other = action === "install" ? $("suite-uninstall-hagemi") : $("suite-install-hagemi");
    btn.disabled = true;
    other.disabled = true;
    $("suite-feedback").textContent = action === "install"
      ? "正在安装并启用哈基米桌宠插件，请稍候…"
      : "正在卸载哈基米桌宠插件…";
    try {
      const res = await api.runHagemi(action);
      if (res?.status) renderSuiteStatus(res.status);
      $("suite-feedback").textContent = res?.message || "操作完成";
    } catch (err) {
      $("suite-feedback").textContent = err.message;
    } finally {
      btn.disabled = false;
      other.disabled = false;
    }
  }

  $("suite-install-i18n").onclick = () => handleLocalize("install", $("suite-install-i18n"));
  $("suite-restore-i18n").onclick = () => handleLocalize("restore", $("suite-restore-i18n"));
  $("suite-launch-hagemi").onclick = async () => {
    const res = await api.launchHagemi();
    $("suite-feedback").textContent = res?.message || "已尝试启动桌面漂浮哈基米";
    setTimeout(refreshSuiteStatus, 1000);
  };
  $("suite-install-hagemi").onclick = () => handleHagemi("install", $("suite-install-hagemi"));
  $("suite-uninstall-hagemi").onclick = () => handleHagemi("uninstall", $("suite-uninstall-hagemi"));
  $("suite-launch-widget").onclick = async () => {
    const res = await api.launchWidget();
    $("suite-feedback").textContent = res?.message || "已尝试启动备用猫娘挂件";
  };
  $("suite-connect-cdp").onclick = async () => {
    const res = await api.connectHost();
    $("suite-feedback").textContent = res?.message || "已打开连接向导";
    setTimeout(refreshSuiteStatus, 1500);
  };

  document.querySelectorAll("[data-mode]").forEach(b => b.onclick = () => {
    $("stage").dataset.mode = b.dataset.mode;
    document.querySelectorAll("[data-mode]").forEach(e => e.setAttribute("aria-pressed", String(e === b)));
  });

  function renderPosition(s = { ...data.settings, ...draft }) {
    const stage = $("stage");
    const img = $("wallpaper");
    if (!img.naturalWidth) return;
    const factor = (s.fit === "contain"
      ? Math.min(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight)
      : Math.max(stage.clientWidth / img.naturalWidth, stage.clientHeight / img.naturalHeight)) * s.zoom;
    const w = img.naturalWidth * factor;
    const h = img.naturalHeight * factor;
    Object.assign(img.style, {
      width: w + "px",
      height: h + "px",
      left: (stage.clientWidth - w) * s.positionX / 100 + "px",
      top: (stage.clientHeight - h) * s.positionY / 100 + "px"
    });
  }

  for (const key of ["positionX", "positionY", "zoom"]) {
    $(key).oninput = () => save({ [key]: Number($(key).value) / (key === "zoom" ? 100 : 1) });
  }

  $("center").onclick = () => {
    clearTimeout(panTimer);
    panTimer = null;
    draft = null;
    save({ positionX: 50, positionY: 50, zoom: 1 });
  };

  const stage = $("stage");
  stage.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    clearTimeout(panTimer);
    panTimer = null;
    draft = { positionX: data.settings.positionX, positionY: data.settings.positionY };
    const img = $("wallpaper");
    drag = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      ...draft,
      extraX: img.offsetWidth - stage.clientWidth,
      extraY: img.offsetHeight - stage.clientHeight
    };
    stage.setPointerCapture(e.pointerId);
    stage.dataset.dragging = "true";
  });

  stage.addEventListener("pointermove", e => {
    if (!drag) return;
    draft = {
      positionX: Math.max(0, Math.min(100, drag.positionX - (Math.abs(drag.extraX) > 1 ? (e.clientX - drag.x) / drag.extraX * 100 : 0))),
      positionY: Math.max(0, Math.min(100, drag.positionY - (Math.abs(drag.extraY) > 1 ? (e.clientY - drag.y) / drag.extraY * 100 : 0)))
    };
    render();
    if (!panTimer) {
      panTimer = setTimeout(() => {
        panTimer = null;
        if (draft) save({ ...draft });
      }, 48);
    }
  });

  function finishPan() {
    if (!drag) return;
    drag = null;
    stage.dataset.dragging = "false";
    clearTimeout(panTimer);
    panTimer = null;
    const final = { ...draft };
    save(final).then(() => {
      draft = null;
      render();
    });
  }

  stage.addEventListener("pointerup", finishPan);
  stage.addEventListener("pointercancel", finishPan);
  stage.addEventListener("lostpointercapture", finishPan);
  $("wallpaper").addEventListener("load", () => renderPosition());
  new ResizeObserver(() => renderPosition()).observe(stage);

  api.subscribe(next => {
    data = next;
    renderAsset();
    render();
  });

  renderAsset();
  render();
  refreshSuiteStatus();
})();
