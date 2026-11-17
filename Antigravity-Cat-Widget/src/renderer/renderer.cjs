(async () => {
  const api = window.widgetApi;
  const $ = id => document.getElementById(id);
  const mascot = $("mascot");
  let snapshot;
  let selected = "quota";
  let closed = true;
  let temporary = null;
  let timeout;
  let pointer = null;
  let gesture = 0;
  let currentSound = null;
  let petAt = 0;
  let hoverCount = 0;
  let hoverTime = 0;
  let hit = null;
  let personality;
  let talkState;
  let talkLine;
  let eggTimer;
  let autoHide;
  let hideAnimation;
  let lastBubbleOpen = null;
  let rightClickTimer = null;
  let lastRightClickAt = 0;

  const chatState = {
    prompt: "",
    reply: "",
    error: "",
    missingKey: false,
    streaming: false,
    requestId: 0
  };

  function isChatPinned() {
    if (selected !== "chat" || closed) return false;
    const input = $("chat-input");
    return chatState.streaming || document.activeElement === input || Boolean(input?.value.trim()) || Boolean(chatState.prompt);
  }

  function armBubble() {
    clearTimeout(autoHide);
    if (!closed && !isChatPinned()) {
      autoHide = setTimeout(() => {
        if (!isChatPinned()) {
          closed = true;
          render();
        }
      }, 6500);
    }
  }

  function bubbleVisibility(open) {
    const bubble = $("bubble");
    if (lastBubbleOpen === open) return;
    lastBubbleOpen = open;
    clearTimeout(hideAnimation);
    bubble.inert = !open;
    bubble.setAttribute("aria-hidden", String(!open));
    if (open) {
      bubble.hidden = false;
      void bubble.offsetWidth;
      requestAnimationFrame(() => {
        if (lastBubbleOpen) bubble.dataset.open = "true";
      });
    } else {
      bubble.dataset.open = "false";
      hideAnimation = setTimeout(() => {
        if (!lastBubbleOpen) bubble.hidden = true;
      }, snapshot?.settings.reducedMotion ? 0 : 180);
    }
  }

  function stopReaction() {
    clearTimeout(eggTimer);
    if (mascot.dataset.expression) {
      delete mascot.dataset.expression;
      talkState = null;
    }
  }

  const pages = ["quota", "talk", "today", "latest", "chat"];
  const format = v => (typeof v === "number" ? v.toLocaleString() : "—");

  function stopSound() {
    gesture++;
    if (currentSound) {
      currentSound.pause();
      currentSound.currentTime = 0;
      currentSound = null;
    }
  }

  async function play(kind) {
    const token = ++gesture;
    if (currentSound) currentSound.pause();
    if (!snapshot?.settings.sound || snapshot.settings.volume === 0) return;
    const payload = await api.audio(kind);
    if (token !== gesture || !payload || !snapshot.settings.sound) return;
    currentSound = new Audio(payload.url);
    currentSound.volume = payload.effectiveVolume;
    currentSound.play().catch(() => {});
  }

  function renderChatLog() {
    const log = $("chat-log");
    log.textContent = "";
    const missing = chatState.missingKey || (!snapshot?.chat?.hasApiKey && !chatState.prompt && !chatState.reply);
    $("chat-missing-key").hidden = !missing;

    if (!chatState.prompt && !chatState.reply && !chatState.error) {
      const p = document.createElement("p");
      p.className = "agy-chat__empty";
      p.textContent = snapshot?.chat?.hasApiKey
        ? "双击右键呼出本输入框，直接和 Gemini 实时对话~"
        : "配置好 Gemini API Key 后，就能在这里实时对话啦~";
      log.append(p);
      return;
    }

    if (chatState.prompt) {
      const userTurn = document.createElement("p");
      userTurn.className = "agy-chat__turn";
      const role = document.createElement("span");
      role.className = "agy-chat__role";
      role.textContent = "你：";
      userTurn.append(role, document.createTextNode(chatState.prompt));
      log.append(userTurn);
    }

    if (chatState.reply || chatState.streaming) {
      const botTurn = document.createElement("p");
      botTurn.className = "agy-chat__turn";
      const role = document.createElement("span");
      role.className = "agy-chat__role";
      role.textContent = "星语：";
      botTurn.append(role, document.createTextNode(chatState.reply || "正在思考…"));
      log.append(botTurn);
    }

    if (chatState.error) {
      const errTurn = document.createElement("p");
      errTurn.className = "agy-chat__turn agy-chat__turn--error";
      errTurn.textContent = chatState.error;
      log.append(errTurn);
    }

    log.scrollTop = log.scrollHeight;
  }

  function render() {
    if (!snapshot) return;
    const s = snapshot.settings;
    const l = snapshot.ledger;
    mascot.style.setProperty("--agy-width", (snapshot.displayScale || s.scale) + "px");
    mascot.style.setProperty("--agy-shift", (snapshot.artShift || 0) + "px");
    mascot.dataset.state = snapshot.state;
    mascot.dataset.dock = snapshot.dockSide || "";
    mascot.dataset.facing = snapshot.facing || "left";
    mascot.dataset.reducedMotion = String(s.reducedMotion);
    bubbleVisibility(!closed && s.bubbleOn);

    for (const id of ["quota", "value", "detail", "chat-panel"]) $(id).hidden = true;
    $("title").textContent = "Gemini Models";
    $("meta").textContent = "";
    const pageIdx = Math.max(0, pages.indexOf(selected));
    $("page").textContent = (pageIdx + 1) + " / " + pages.length;

    if (temporary) {
      $("title").textContent = temporary.title;
      $("value").hidden = false;
      $("value").textContent = temporary.body;
      $("detail").hidden = !temporary.detail;
      $("detail").textContent = temporary.detail || "";
      $("meta").textContent = temporary.meta || "";
      return;
    }

    if (selected === "quota") {
      $("quota").hidden = false;
      for (const [suffix, value] of [
        ["", s.manualQuota ? s.manualPercent : snapshot.quotaWindows?.fiveHour],
        ["-week", s.manualQuota ? s.manualWeeklyPercent : snapshot.quotaWindows?.weekly]
      ]) {
        const known = typeof value === "number";
        $("percent" + suffix).textContent = known ? Math.round(value) + "%" : "—";
        $("fill" + suffix).style.width = known ? value + "%" : "100%";
        $("track" + suffix).dataset.known = String(known);
        $("track" + suffix).dataset.level = !known ? "unknown" : value <= 10 ? "critical" : value <= 30 ? "low" : "normal";
        $("percent" + suffix).dataset.level = $("track" + suffix).dataset.level;
        if (known) $("track" + suffix).setAttribute("aria-valuenow", value);
        else $("track" + suffix).removeAttribute("aria-valuenow");
      }
      $("caption").textContent = s.manualQuota
        ? "手动记录"
        : snapshot.quotaWindows?.stale
          ? "上次读取 · 待更新"
          : snapshot.quotaWindows?.cached
            ? "上次读取"
            : "";
      $("meta").textContent = "";
    } else if (selected === "today") {
      $("title").textContent = "今日用量 · 本机";
      $("value").hidden = false;
      $("value").textContent = format(l.todayTokens.total);
      $("detail").hidden = false;
      $("detail").textContent = "输入 " + format(l.todayTokens.prompt) + " · 缓存 " + format(l.todayTokens.cache) + " · 输出 " + format(l.todayTokens.output);
      $("meta").textContent = l.todaySteps + " 个模型步骤 · " + (l.partial ? "部分字段缺失" : snapshot.source.coverage || "只读日志");
    } else if (selected === "latest") {
      const r = l.latest;
      $("title").textContent = "最近模型步骤";
      $("value").hidden = false;
      $("value").textContent = format(r?.tokens.total);
      $("detail").hidden = false;
      $("detail").textContent = r ? "输入 " + format(r.tokens.input) + " · 输出 " + format(r.tokens.output) : "尚无数值记录";
      $("meta").textContent = r ? "本机记录 · 费用 —（无价格来源）" : "等待真实会话记录";
    } else if (selected === "chat") {
      $("title").textContent = "Gemini 对话";
      $("chat-panel").hidden = false;
      $("chat-send").disabled = chatState.streaming;
      $("chat-stop").hidden = !chatState.streaming;
      renderChatLog();
      const modelLabel = snapshot.chat?.model || "gemini-4-hydrogen";
      $("meta").textContent = chatState.streaming
        ? modelLabel + " · 实时输出中…"
        : modelLabel + (snapshot.chat?.hasContext ? " · 多轮连续上下文" : " · 双击右键快速唤起");
    } else {
      $("title").textContent = "喵言喵语";
      $("value").hidden = false;
      $("value").classList.add("agy-phrase");
      if (talkState !== (snapshot.persistentState || snapshot.state)) {
        talkState = snapshot.persistentState || snapshot.state;
        talkLine = personality.say(talkState === "offline" ? "idle" : talkState);
      }
      $("value").textContent = talkLine;
      $("meta").textContent = "点点本喵，再聊一句";
    }
    if (selected !== "talk") $("value").classList.remove("agy-phrase");
  }

  function message(title, body, detail = "", ms = 4500, meta = "") {
    clearTimeout(timeout);
    temporary = { title, body, detail, meta };
    closed = false;
    render();
    if (ms > 0) {
      timeout = setTimeout(() => {
        temporary = null;
        render();
      }, ms);
    }
  }

  function select(delta) {
    clearTimeout(timeout);
    temporary = null;
    closed = false;
    selected = pages[(pages.indexOf(selected) + delta + pages.length) % pages.length];
    api.save({ bubblePage: selected });
    armBubble();
    render();
  }

  function openChatInput() {
    clearTimeout(autoHide);
    clearTimeout(timeout);
    temporary = null;
    closed = false;
    selected = "chat";
    api.save({ bubblePage: "chat", bubbleOn: true });
    render();
    api.command("focus");
    requestAnimationFrame(() => {
      setTimeout(() => {
        const input = $("chat-input");
        if (input && !closed) input.focus();
      }, 45);
    });
  }

  async function submitChat() {
    const input = $("chat-input");
    const prompt = input.value.trim();
    if (!prompt || chatState.streaming) return;
    input.value = "";
    chatState.prompt = prompt;
    chatState.reply = "";
    chatState.error = "";
    chatState.missingKey = false;
    chatState.streaming = true;
    clearTimeout(autoHide);
    selected = "chat";
    closed = false;
    render();
    await api.chatSend(prompt);
  }

  $("prev").onclick = () => select(-1);
  $("next").onclick = () => select(1);
  $("close").onclick = () => {
    clearTimeout(autoHide);
    closed = true;
    render();
  };
  $("toggle").onclick = () => {
    closed = !closed;
    if (!snapshot.settings.bubbleOn) api.save({ bubbleOn: true });
    armBubble();
    render();
  };
  $("chat-trigger").onclick = () => openChatInput();
  $("settings").onclick = () => api.command("settings");
  $("chat-open-settings").onclick = () => api.command("settings");

  $("chat-form").addEventListener("submit", e => {
    e.preventDefault();
    submitChat();
  });

  $("chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submitChat();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearTimeout(autoHide);
      closed = true;
      render();
    }
  });

  $("chat-stop").onclick = () => api.chatStop();
  $("chat-reset").onclick = () => api.chatReset();

  window.addEventListener("contextmenu", e => {
    if (e.target.closest("#chat-input, #chat-log")) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastRightClickAt <= 360) {
      clearTimeout(rightClickTimer);
      rightClickTimer = null;
      lastRightClickAt = 0;
      openChatInput();
      return;
    }
    lastRightClickAt = now;
    clearTimeout(rightClickTimer);
    rightClickTimer = setTimeout(() => {
      rightClickTimer = null;
      lastRightClickAt = 0;
      api.command("menu");
    }, 360);
  });

  $("bubble").addEventListener("pointerenter", () => clearTimeout(autoHide));
  $("bubble").addEventListener("pointerleave", armBubble);

  const motion = $("motion");
  function animatePress(pressed) {
    motion.dataset.pressed = String(pressed);
  }

  function activate() {
    if (selected === "chat") return;
    if (selected !== "talk") {
      showQuota();
      return;
    }
    if (temporary) return;
    closed = false;
    armBubble();
    talkState = snapshot.persistentState || snapshot.state;
    talkLine = personality.say(talkState === "offline" ? "idle" : talkState);
    render();
  }

  function showQuota() {
    clearTimeout(timeout);
    temporary = null;
    closed = false;
    armBubble();
    selected = "quota";
    api.save({ bubblePage: "quota", bubbleOn: true });
    render();
  }

  motion.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    pointer = { id: e.pointerId, x: e.screenX, y: e.screenY, moved: false };
    motion.setPointerCapture(e.pointerId);
    animatePress(true);
    api.pointer({ action: "down", point: { x: e.screenX, y: e.screenY } });
    play("press");
  });

  motion.addEventListener("pointermove", e => {
    if (pointer) {
      if (Math.hypot(e.screenX - pointer.x, e.screenY - pointer.y) > 8) pointer.moved = true;
      api.pointer({ action: "move", point: { x: e.screenX, y: e.screenY } });
      return;
    }
    const now = Date.now();
    hoverCount = now - hoverTime < 250 ? hoverCount + 1 : 1;
    hoverTime = now;
    if (hoverCount > 16 && now - petAt > 12000) {
      hoverCount = 0;
      petAt = now;
      api.pointer("pet");
    }
  });

  async function release(cancel = false) {
    if (!pointer) return;
    pointer = null;
    const result = await api.pointer(cancel ? "cancel" : "up");
    animatePress(false);
    play("release");
    if (!result?.moved && !cancel) {
      activate();
      reaction(false, true);
    }
  }

  motion.addEventListener("pointerup", () => release());
  motion.addEventListener("pointercancel", () => release(true));
  motion.addEventListener("lostpointercapture", () => release(true));
  window.addEventListener("blur", () => release(true));

  motion.addEventListener("keydown", e => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      activate();
      reaction(false, true);
    }
  });

  window.addEventListener("mousemove", e => {
    const active = !!e.target.closest(".interactive");
    if (hit !== active) {
      hit = active;
      api.hit(active);
    }
  });
  window.addEventListener("mouseleave", () => {
    hit = false;
    api.hit(false);
  });

  api.subscribe(data => {
    if (snapshot && (!data.settings.sound || data.settings.soundSet !== snapshot.settings.soundSet || data.settings.volume !== snapshot.settings.volume)) {
      stopSound();
    }
    snapshot = data;
    if (!data.settings.easterEggs || !["idle", "offline", "pressed", "release"].includes(data.state)) {
      stopReaction();
    }
    render();
  });

  api.onStep(step => {
    if (!closed && selected !== "chat" && snapshot?.settings.turnCostOn) {
      message(
        "模型步骤完成",
        format(step.tokens.total) + " tokens",
        "输入 " + format(step.tokens.input) + " · 输出 " + format(step.tokens.output),
        snapshot.settings.turnCostDurationMs,
        "真实本机记录 · 非整轮计费"
      );
      play("release");
    }
  });

  api.onOpenChat(() => openChatInput());

  api.onChatEvent(evt => {
    if (!evt) return;
    if (evt.type === "start") {
      chatState.requestId = evt.requestId;
      chatState.prompt = evt.prompt;
      chatState.reply = "";
      chatState.error = "";
      chatState.missingKey = false;
      chatState.streaming = true;
      selected = "chat";
      closed = false;
      render();
    } else if (evt.type === "delta") {
      if (evt.requestId === chatState.requestId) {
        chatState.reply = evt.fullText;
        render();
      }
    } else if (evt.type === "done") {
      if (evt.requestId === chatState.requestId) {
        chatState.streaming = false;
        chatState.reply = evt.text || "（空回复）";
        play("release");
        render();
      }
    } else if (evt.type === "aborted") {
      if (evt.requestId === chatState.requestId) {
        chatState.streaming = false;
        if (!chatState.reply) chatState.reply = "（已停止生成）";
        render();
      }
    } else if (evt.type === "error") {
      if (evt.requestId === chatState.requestId) {
        chatState.streaming = false;
        chatState.error = evt.message || "生成失败";
        chatState.missingKey = evt.code === "MISSING_API_KEY";
        render();
      }
    } else if (evt.type === "reset") {
      chatState.prompt = "";
      chatState.reply = "";
      chatState.error = "";
      chatState.missingKey = false;
      chatState.streaming = false;
      render();
    }
  });

  function reaction(manual = false, clicked = false) {
    if (!snapshot || !personality) return;
    const kind = personality.reaction(
      {
        enabled: snapshot.settings.easterEggs,
        hidden: document.hidden || closed || !snapshot.settings.bubbleOn,
        busy: !!temporary || !!pointer || chatState.streaming || (clicked && !!mascot.dataset.expression),
        state: clicked ? snapshot.persistentState : snapshot.state
      },
      manual,
      clicked
    );
    if (!kind) return;
    mascot.dataset.expression = kind;
    if (selected === "talk") {
      talkLine = personality.say(kind);
      render();
    }
    clearTimeout(eggTimer);
    eggTimer = setTimeout(() => {
      delete mascot.dataset.expression;
      talkState = null;
      render();
    }, 3200);
  }

  api.onReaction(() => reaction(true));
  const ambient = setInterval(() => reaction(), 30000);

  snapshot = await api.get();
  personality = new window.StarPersonality(snapshot.dialogue);
  selected = pages.includes(snapshot.settings.bubblePage) ? snapshot.settings.bubblePage : "quota";
  render();

  window.addEventListener("beforeunload", () => {
    clearTimeout(timeout);
    clearTimeout(autoHide);
    clearTimeout(hideAnimation);
    clearTimeout(eggTimer);
    clearTimeout(rightClickTimer);
    clearInterval(ambient);
    stopSound();
  });
})();
