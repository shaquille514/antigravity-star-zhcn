const { EventEmitter } = require("node:events");

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1";
const DEFAULT_MODEL = "gemini-4-hydrogen";
const DEFAULT_SYSTEM_PROMPT =
  "你是 Google Antigravity 的桌面伙伴「星语猫娘」（Gemini Star Neko）。你有一点点傲娇但聪明可靠，默认使用清晰自然的简体中文回答问题。回答技术与编程问题时准确简洁、直击重点；日常对话可保留轻巧可爱的猫娘语气，控制篇幅以便在桌面气泡中舒适阅读。";

/**
 * 校验并规范化 Gemini API 基础地址，仅允许 https 或本机回环 http 代理。
 * @param {string} rawUrl
 * @returns {string}
 */
function normalizeBaseUrl(rawUrl) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim().replace(/\/+$/, "") : "";
  if (!trimmed) return DEFAULT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Gemini API 地址格式无效，请检查设置中的 URL。");
  }
  const isHttps = parsed.protocol === "https:";
  const isLocalHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (!isHttps && !isLocalHttp) {
    throw new Error("安全限制：API 地址仅支持 HTTPS 或本机 localhost/127.0.0.1 代理。");
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    return `${parsed.origin}/v1`;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/**
 * 掩码显示 API Key，仅保留首尾少量字符用于界面状态确认。
 * @param {string} key
 * @returns {string}
 */
function maskApiKey(key) {
  const s = typeof key === "string" ? key.trim() : "";
  if (!s) return "";
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

/**
 * 从 SSE 缓冲区提取完整事件块（支持 \r\n\r\n 与 \n\n 分隔）。
 * @param {string} buffer
 * @returns {{ events: string[], rest: string }}
 */
function splitSseFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() || "";
  return { events: parts, rest };
}

/**
 * 解析单个 SSE 帧文本中的 data JSON 载荷。
 * @param {string} frame
 * @returns {object|null}
 */
function parseSseFrame(frame) {
  if (!frame) return null;
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join("\n").trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

class GeminiChatClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.fetchImpl = options.fetch || globalThis.fetch;
    this.previousInteractionId = null;
    this.abortController = null;
    this.busy = false;
    this.requestSeq = 0;
  }

  resolveApiKey(settingsKey) {
    const k = typeof settingsKey === "string" ? settingsKey.trim() : "";
    if (k) return k;
    const envKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
    return envKey;
  }

  abort() {
    this.requestSeq++;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.busy = false;
  }

  resetConversation() {
    this.abort();
    this.previousInteractionId = null;
  }

  /**
   * 调用官方 Gemini Interactions API (stream: true) 实时流式生成回复。
   * @param {string} prompt
   * @param {object} config
   * @param {{ onDelta?: (delta: string, fullText: string) => void }} callbacks
   */
  async sendMessage(prompt, config = {}, callbacks = {}) {
    const cleanPrompt = typeof prompt === "string" ? prompt.trim() : "";
    if (!cleanPrompt) {
      const err = new Error("输入内容不能为空");
      err.code = "EMPTY_PROMPT";
      throw err;
    }
    if (cleanPrompt.length > 16000) {
      const err = new Error("单次输入过长，请精简至 16000 字符以内。");
      err.code = "PROMPT_TOO_LONG";
      throw err;
    }

    const apiKey = this.resolveApiKey(config.apiKey);
    if (!apiKey) {
      const err = new Error("尚未配置 Gemini API Key，请点击猫娘右上角 ☰ 设置填写后使用。");
      err.code = "MISSING_API_KEY";
      throw err;
    }

    if (typeof this.fetchImpl !== "function") {
      throw new Error("当前运行时不支持 fetch 请求，请升级至 Electron / Node 22+。");
    }

    const baseUrl = normalizeBaseUrl(config.baseUrl);
    this.abort();
    const controller = new AbortController();
    this.abortController = controller;
    this.busy = true;
    const reqId = ++this.requestSeq;

    const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : DEFAULT_MODEL;
    const systemInstruction = typeof config.systemInstruction === "string" ? config.systemInstruction.trim() : "";

    const payload = {
      model,
      input: cleanPrompt,
      stream: true
    };
    if (systemInstruction) payload.system_instruction = systemInstruction;
    if (this.previousInteractionId) payload.previous_interaction_id = this.previousInteractionId;

    let fullText = "";
    let usage = null;
    let interactionId = this.previousInteractionId;
    let completed = false;
    let reader;
    const ensureActive = () => {
      if (controller.signal.aborted || reqId !== this.requestSeq) {
        const error = new Error("请求已停止");
        error.name = "AbortError";
        throw error;
      }
    };

    try {
      const response = await this.fetchImpl(`${baseUrl}/interactions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      ensureActive();

      if (!response.ok) {
        let detail = "";
        try {
          const text = await response.text();
          const parsed = JSON.parse(text);
          detail = parsed?.error?.message || parsed?.message || text;
        } catch {}
        if (response.status === 401 || response.status === 403) {
          throw new Error("API Key 无效或无访问权限，请在设置中核对。" + (detail ? ` (${detail})` : ""));
        }
        if (response.status === 429) {
          throw new Error("请求过于频繁或配额不足，请稍后再试。");
        }
        throw new Error(`Gemini 接口返回 ${response.status}${detail ? "：" + detail.slice(0, 160) : ""}`);
      }

      if (!response.body || typeof response.body.getReader !== "function") {
        throw new Error("响应流不可读");
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let sseBuffer = "";

      const handleEvent = evt => {
        ensureActive();
        if (!evt || typeof evt !== "object") return;
        if (evt.event_type === "interaction.created" && evt.interaction?.id) {
          interactionId = evt.interaction.id;
        } else if (evt.event_type === "step.start" && evt.step?.type === "model_output") {
          for (const content of evt.step.content || []) {
            if (content.type === "text" && typeof content.text === "string") {
              fullText += content.text;
              callbacks.onDelta?.(content.text, fullText);
            }
          }
        } else if (evt.event_type === "step.delta" && evt.delta?.type === "text" && typeof evt.delta.text === "string") {
          fullText += evt.delta.text;
          callbacks.onDelta?.(evt.delta.text, fullText);
        } else if (evt.event_type === "interaction.completed" && evt.interaction) {
          if (evt.interaction.status && evt.interaction.status !== "completed") {
            throw new Error("Gemini 回复未完成，请重试。");
          }
          completed = true;
          if (evt.interaction.id) interactionId = evt.interaction.id;
          if (evt.interaction.usage) usage = evt.interaction.usage;
        } else if (["interaction.failed", "interaction.cancelled", "interaction.incomplete", "interaction.budget_exceeded"].includes(evt.event_type)) {
          throw new Error(evt.interaction?.error?.message || "Gemini 回复未完成，请重试。");
        } else if (evt.event_type === "error") {
          throw new Error(evt.error?.message || "Gemini 流式生成返回错误");
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        ensureActive();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitSseFrames(sseBuffer);
        sseBuffer = rest;
        for (const frame of events) {
          handleEvent(parseSseFrame(frame));
        }
      }

      sseBuffer += decoder.decode();
      if (sseBuffer.trim()) {
        for (const frame of splitSseFrames(sseBuffer + "\n\n").events) {
          handleEvent(parseSseFrame(frame));
        }
      }

      ensureActive();
      if (!completed) {
        throw new Error("Gemini 回复流提前结束，请重试。");
      }
      if (interactionId && reqId === this.requestSeq) {
        this.previousInteractionId = interactionId;
      }

      return {
        aborted: false,
        text: fullText,
        interactionId,
        usage,
        model
      };
    } catch (err) {
      if (err?.name === "AbortError" || controller.signal.aborted || reqId !== this.requestSeq) {
        return { aborted: true, text: fullText, interactionId, usage, model };
      }
      throw err;
    } finally {
      if (reader) {
        if (!completed || controller.signal.aborted) {
          try { await reader.cancel(); } catch {}
        }
        try { reader.releaseLock(); } catch {}
      }
      if (this.requestSeq === reqId) {
        this.abortController = null;
        this.busy = false;
      }
    }
  }
}

module.exports = {
  GeminiChatClient,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  normalizeBaseUrl,
  maskApiKey,
  splitSseFrames,
  parseSseFrame
};
