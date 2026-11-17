// Interactive Gemini chat engine for Hagemi Pet.
// Primary path reuses Antigravity's signed-in local LanguageServer (GetModelResponse) with no API key;
// optional secondary path streams directly from the official Gemini Interactions API (v1/interactions).
import { personalizedPersona } from './persona.mjs';

export const DEFAULT_CHAT_BASE_URL = 'https://generativelanguage.googleapis.com/v1';
export const DEFAULT_CHAT_MODEL = 'gemini-4-hydrogen';
const MAX_HISTORY_TURNS = 8;

export function normalizeBaseUrl(rawUrl) {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim().replace(/\/+$/, '') : '';
  if (!trimmed) return DEFAULT_CHAT_BASE_URL;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Gemini API 地址格式无效 / Invalid API Base URL');
  }
  const isHttps = parsed.protocol === 'https:';
  const isLocalHttp = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (!isHttps && !isLocalHttp) {
    throw new Error('仅支持 HTTPS 或本机 localhost/127.0.0.1 地址 / Only HTTPS or loopback HTTP is allowed');
  }
  if (!parsed.pathname || parsed.pathname === '/') {
    return `${parsed.origin}/v1`;
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
}

export function maskApiKey(key) {
  const s = typeof key === 'string' ? key.trim() : '';
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export function splitSseFrames(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() || '';
  return { events: parts, rest };
}

export function parseSseFrame(frame) {
  if (!frame) return null;
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n').trim();
  if (!raw || raw === '[DONE]') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function buildInteractivePrompt({ language = 'zhs', prompt, history = [], personaExtra = '' }) {
  const lang = language === 'zhs' ? 'zhs' : 'en';
  const basePersona = personalizedPersona(lang, personaExtra);
  const guide = lang === 'zhs'
    ? '对话模式说明：你现在正在桌面小气泡里直接回答用户的实时提问。请保持哈基米的活泼猫娘语气，但优先做到回答准确、有帮助、结构清晰；如果用户问技术或代码问题，可以直接给出简明步骤或代码片段。不要输出 "mood|line" 格式前缀，直接输出回复正文。'
    : 'Interactive chat mode: reply directly to the user inside your desktop bubble. Keep Hagemi\'s playful catgirl personality while prioritizing clear, accurate, helpful answers (including code or steps when asked). Do not prefix your reply with "mood|line".';

  const sections = [basePersona];
  if (personaExtra && String(personaExtra).trim()) {
    sections.push(String(personaExtra).trim().slice(0, 600));
  }
  sections.push(guide);

  if (history.length) {
    const recent = history.slice(-(MAX_HISTORY_TURNS * 2));
    const lines = recent.map(turn => `${turn.role === 'user' ? (lang === 'zhs' ? '用户' : 'User') : 'Hagemi'}: ${turn.text}`);
    sections.push(`${lang === 'zhs' ? '最近对话上下文' : 'Recent conversation'}:\n${lines.join('\n')}`);
  }

  sections.push(`${lang === 'zhs' ? '用户当前提问' : 'Current question'}:\n${prompt}`);
  return sections.join('\n\n');
}

function cleanHostReply(raw) {
  let text = String(raw || '').trim();
  // Strip accidental mood|line prefix if the model copied ambient style
  const moodPrefix = text.match(/^(happy|smug|love|excited|surprised|worried|sad|angry|sleepy|thinking|embarrassed|wink)\s*[|｜]\s*/i);
  if (moodPrefix) text = text.slice(moodPrefix[0].length).trim();
  return text;
}

export class PetChatEngine {
  constructor({ ls = null, models = null, fetchImpl = globalThis.fetch, getSettings = () => ({}), getLanguage = () => 'zhs', log = () => {} } = {}) {
    Object.assign(this, { ls, models, fetchImpl, getSettings, getLanguage, log });
    this.history = [];
    this.previousInteractionId = null;
    this.abortController = null;
    this.busy = false;
    this.requestSeq = 0;
  }

  resolveApiKey(settingsKey) {
    const k = typeof settingsKey === 'string' ? settingsKey.trim() : '';
    if (k) return k;
    return (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  }

  abort() {
    this.requestSeq++;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.busy = false;
  }

  reset() {
    this.abort();
    this.history = [];
    this.previousInteractionId = null;
  }

  _recordTurn(userText, assistantText) {
    this.history.push({ role: 'user', text: userText }, { role: 'assistant', text: assistantText });
    const cap = MAX_HISTORY_TURNS * 2;
    if (this.history.length > cap) this.history = this.history.slice(-cap);
  }

  async _resolveHostModel(settings) {
    if (!this.models) return null;
    await this.models.refresh().catch(() => {});
    const wanted = settings?.ai?.model;
    const exact = wanted ? this.models.resolve(wanted) : null;
    if (exact) return exact;
    const configs = this.models.configs || [];
    return configs.find(c => /gemini/i.test(c.label)) || configs[0] || null;
  }

  async _askHost(cleanPrompt, settings, seq) {
    if (!this.ls) throw new Error('Antigravity LanguageServer 不可用');
    const model = await this._resolveHostModel(settings);
    if (seq !== this.requestSeq) return { aborted: true, text: '', engine: 'host' };
    if (!model) throw new Error('未在 Antigravity 中找到可用模型（请确认宿主已启动并登录）');
    const language = this.getLanguage();
    const prompt = buildInteractivePrompt({
      language,
      prompt: cleanPrompt,
      history: this.history,
      personaExtra: settings?.chat?.personaExtra || settings?.ai?.personaExtra || '',
    });
    const response = await this.ls.call('GetModelResponse', { prompt, model: model.id }, 45000);
    if (seq !== this.requestSeq) return { aborted: true, text: '', engine: 'host', model: model.label };
    const text = cleanHostReply(response?.response);
    if (!text) throw new Error('模型返回为空');
    this._recordTurn(cleanPrompt, text);
    return { aborted: false, text, engine: 'host', model: model.label };
  }

  async _askApi(cleanPrompt, settings, seq, onDelta) {
    const chat = settings?.chat || {};
    const apiKey = this.resolveApiKey(chat.apiKey);
    if (!apiKey) {
      const err = new Error('尚未配置 Gemini API Key');
      err.code = 'MISSING_API_KEY';
      throw err;
    }
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('当前 Node 运行时不支持 fetch');
    }

    const controller = new AbortController();
    this.abortController = controller;
    const baseUrl = normalizeBaseUrl(chat.baseUrl);
    const model = typeof chat.apiModel === 'string' && chat.apiModel.trim() ? chat.apiModel.trim() : DEFAULT_CHAT_MODEL;
    const language = this.getLanguage();
    const extra = chat.personaExtra || settings?.ai?.personaExtra || '';
    const basePersona = personalizedPersona(language, extra);
    const systemInstruction = extra ? `${basePersona}\n\n${extra}` : basePersona;

    const payload = {
      model,
      input: cleanPrompt,
      system_instruction: systemInstruction,
      stream: true,
    };
    if (this.previousInteractionId) payload.previous_interaction_id = this.previousInteractionId;

    let fullText = '';
    let interactionId = this.previousInteractionId;
    let usage = null;
    let completed = false;

    let response;
    try {
      response = await this.fetchImpl(`${baseUrl}/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || seq !== this.requestSeq) {
        return { aborted: true, text: fullText, engine: 'api', model, usage };
      }
      throw error;
    }
    if (seq !== this.requestSeq) return { aborted: true, text: fullText, engine: 'api', model, usage };

    if (!response.ok) {
      let detail = '';
      try {
        const raw = await response.text();
        const parsed = JSON.parse(raw);
        detail = parsed?.error?.message || parsed?.message || raw;
      } catch {}
      throw new Error(`Gemini API (${response.status})${detail ? `: ${detail.slice(0, 140)}` : ''}`);
    }

    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Error('响应流不可读');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let sseBuffer = '';

    const handleEvent = evt => {
      if (!evt || typeof evt !== 'object' || seq !== this.requestSeq) return;
      if (evt.event_type === 'interaction.created' && evt.interaction?.id) {
        interactionId = evt.interaction.id;
      } else if (evt.event_type === 'step.start' && evt.step?.type === 'model_output') {
        for (const content of evt.step.content || []) {
          if (content.type === 'text' && typeof content.text === 'string') {
            fullText += content.text;
            onDelta?.(content.text, fullText);
          }
        }
      } else if (evt.event_type === 'step.delta' && evt.delta?.type === 'text' && typeof evt.delta.text === 'string') {
        fullText += evt.delta.text;
        onDelta?.(evt.delta.text, fullText);
      } else if (evt.event_type === 'interaction.completed' && evt.interaction) {
        if (evt.interaction.status && evt.interaction.status !== 'completed') throw new Error('Gemini 回复未完成，请重试');
        completed = true;
        if (evt.interaction.id) interactionId = evt.interaction.id;
        if (evt.interaction.usage) usage = evt.interaction.usage;
      } else if (evt.event_type === 'error') {
        throw new Error(evt.error?.message || 'Gemini 流式生成错误');
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done || seq !== this.requestSeq) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitSseFrames(sseBuffer);
        sseBuffer = rest;
        for (const frame of events) handleEvent(parseSseFrame(frame));
      }
      sseBuffer += decoder.decode();
      if (sseBuffer.trim() && seq === this.requestSeq) {
        for (const frame of splitSseFrames(`${sseBuffer}\n\n`).events) handleEvent(parseSseFrame(frame));
      }
    } catch (error) {
      if (error?.name === 'AbortError' || seq !== this.requestSeq) {
        return { aborted: true, text: fullText, engine: 'api', model, usage };
      }
      throw error;
    } finally {
      if (!completed || seq !== this.requestSeq) {
        try { await reader.cancel(); } catch {}
      }
      try { reader.releaseLock(); } catch {}
    }

    if (seq !== this.requestSeq) {
      return { aborted: true, text: fullText, engine: 'api', model, usage };
    }
    if (!completed) throw new Error('Gemini 回复流提前结束，请重试');
    if (interactionId) this.previousInteractionId = interactionId;
    if (fullText) this._recordTurn(cleanPrompt, fullText);
    return { aborted: false, text: fullText, engine: 'api', model, usage };
  }

  async sendMessage(prompt, { onDelta } = {}) {
    const cleanPrompt = typeof prompt === 'string' ? prompt.trim() : '';
    if (!cleanPrompt) throw new Error('请输入内容');
    if (cleanPrompt.length > 16000) throw new Error('单次输入请控制在 16000 字符以内');

    this.abort();
    const seq = ++this.requestSeq;
    this.busy = true;
    const settings = this.getSettings();
    const mode = settings?.chat?.mode || 'auto';
    const hasApiKey = Boolean(this.resolveApiKey(settings?.chat?.apiKey));

    try {
      if (mode === 'api') {
        return await this._askApi(cleanPrompt, settings, seq, onDelta);
      }
      try {
        return await this._askHost(cleanPrompt, settings, seq);
      } catch (hostError) {
        if (seq !== this.requestSeq) return { aborted: true, text: '', engine: 'host' };
        if (mode === 'auto' && hasApiKey) {
          this.log(`chat host fallback to api: ${hostError.message}`);
          return await this._askApi(cleanPrompt, settings, seq, onDelta);
        }
        throw hostError;
      }
    } finally {
      if (seq === this.requestSeq) {
        this.abortController = null;
        this.busy = false;
      }
    }
  }
}
