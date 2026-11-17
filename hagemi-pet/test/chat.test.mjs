// 哈基米桌宠 Gemini 实时对话引擎与设置兼容性测试。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_CHAT_MODEL,
  PetChatEngine,
  buildInteractivePrompt,
  maskApiKey,
  normalizeBaseUrl,
  parseSseFrame,
  splitSseFrames,
} from '../sidecars/pet/lib/chat.mjs';
import { DEFAULTS, SettingsStore, sanitize } from '../sidecars/pet/lib/settings.mjs';

function makeSseStream(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function apiEngine(fetchImpl) {
  return new PetChatEngine({ fetchImpl, getSettings: () => ({ chat: { mode: 'api', apiKey: 'test-only-key' } }) });
}

it('API 首段文本与增量共同组成完整回复', async () => {
  const engine = apiEngine(async () => ({ ok: true, body: makeSseStream([
    'data: {"event_type":"step.start","step":{"type":"model_output","content":[{"type":"text","text":"你好"}]}}\n\n',
    'data: {"event_type":"step.delta","delta":{"type":"text","text":"，世界"}}\n\n',
    'data: {"event_type":"interaction.completed","interaction":{"id":"complete","status":"completed"}}\n\n',
  ]) }));
  assert.equal((await engine.sendMessage('test')).text, '你好，世界');
});

it('API 断流不能提交未完成的对话上下文', async () => {
  const engine = apiEngine(async () => ({ ok: true, body: makeSseStream([
    'data: {"event_type":"interaction.created","interaction":{"id":"unfinished"}}\n\n',
    'data: {"event_type":"step.delta","delta":{"type":"text","text":"partial"}}\n\n',
  ]) }));
  engine.previousInteractionId = 'last-complete';
  await assert.rejects(engine.sendMessage('test'), /提前结束|未完成/);
  assert.equal(engine.previousInteractionId, 'last-complete');
});

it('API 在响应头到达前停止也应报告中断而不是生成失败', async () => {
  const engine = apiEngine((_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')));
  }));
  const pending = engine.sendMessage('test');
  engine.abort();
  assert.equal((await pending).aborted, true);
  assert.equal(engine.busy, false);
});

describe('chat helpers', () => {
  it('校验并规范化 API Base URL', () => {
    assert.equal(normalizeBaseUrl(''), DEFAULT_CHAT_BASE_URL);
    assert.equal(normalizeBaseUrl('https://generativelanguage.googleapis.com/'), 'https://generativelanguage.googleapis.com/v1');
    assert.equal(normalizeBaseUrl('https://proxy.example.com/gemini/v1beta/'), 'https://proxy.example.com/gemini/v1beta');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8787/v1'), 'http://127.0.0.1:8787/v1');
    assert.equal(normalizeBaseUrl('http://localhost:8080'), 'http://localhost:8080/v1');
    assert.throws(() => normalizeBaseUrl('http://remote-insecure.example.com/v1'), /HTTPS/);
    assert.throws(() => normalizeBaseUrl('not a url'), /无效/);
  });

  it('对 API Key 做安全脱敏', () => {
    assert.equal(maskApiKey(''), '');
    assert.equal(maskApiKey('12345678'), '••••');
    assert.equal(maskApiKey('AIzaSyDemoKeyValue9876'), 'AIza••••9876');
  });

  it('正确切分与解析 SSE 帧（含半包与 CRLF）', () => {
    const first = splitSseFrames('event: message\r\ndata: {"event_type":"step.delta"}\r\n\r\ndata: {"part":1');
    assert.equal(first.events.length, 1);
    assert.equal(first.rest, 'data: {"part":1');

    const second = splitSseFrames(`${first.rest}}\n\n`);
    assert.equal(second.events.length, 1);
    assert.equal(second.rest, '');

    assert.deepEqual(parseSseFrame(first.events[0]), { event_type: 'step.delta' });
    assert.deepEqual(parseSseFrame(second.events[0]), { part: 1 });
    assert.equal(parseSseFrame('data: [DONE]'), null);
    assert.equal(parseSseFrame('data: {broken'), null);
  });

  it('构建包含人设、附加设定与最近历史的交互提示词', () => {
    const prompt = buildInteractivePrompt({
      language: 'zhs',
      prompt: '怎么修这个 bug？',
      personaExtra: '只用三句话回答。',
      history: [
        { role: 'user', text: '在吗？' },
        { role: 'assistant', text: '在的喵~' },
      ],
    });
    assert.match(prompt, /只用三句话回答/);
    assert.match(prompt, /最近对话上下文/);
    assert.match(prompt, /用户: 在吗？/);
    assert.match(prompt, /Hagemi: 在的喵~/);
    assert.match(prompt, /怎么修这个 bug？/);
  });
});

describe('PetChatEngine', () => {
  it('优先使用 Antigravity LanguageServer 免 Key 回答并维护上下文', async () => {
    const calls = [];
    const ls = {
      async call(method, body) {
        calls.push({ method, body });
        if (calls.length === 1) return { response: 'happy | 喵~ 这行漏了 await 哦！' };
        return { response: '加上 try/catch 就稳了。' };
      },
    };
    const models = {
      configs: [
        { id: 'claude-4', label: 'Claude 4 Sonnet' },
        { id: 'gemini-3-8-flash', label: 'Gemini 3.8 Flash (Low)' },
      ],
      async refresh() {},
      resolve(name) {
        return this.configs.find(c => c.label === name) || null;
      },
    };

    const engine = new PetChatEngine({
      ls,
      models,
      getSettings: () => ({ ai: { model: 'Gemini 3.8 Flash (Low)' }, chat: { mode: 'auto', personaExtra: '' } }),
      getLanguage: () => 'zhs',
    });

    const first = await engine.sendMessage('为什么异步没等完？');
    assert.equal(first.aborted, false);
    assert.equal(first.engine, 'host');
    assert.equal(first.model, 'Gemini 3.8 Flash (Low)');
    // 验证剥离了意外的 mood| 前缀
    assert.equal(first.text, '喵~ 这行漏了 await 哦！');
    assert.equal(calls[0].method, 'GetModelResponse');
    assert.equal(calls[0].body.model, 'gemini-3-8-flash');

    const second = await engine.sendMessage('那错误怎么处理？');
    assert.equal(second.text, '加上 try/catch 就稳了。');
    assert.match(calls[1].body.prompt, /为什么异步没等完？/);
    assert.match(calls[1].body.prompt, /喵~ 这行漏了 await 哦！/);

    engine.reset();
    assert.equal(engine.history.length, 0);
  });

  it('在 api 模式下走官方 Interactions SSE 流式接口并串联 previous_interaction_id', async () => {
    const requests = [];
    const fetchImpl = async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      const idx = requests.length;
      return {
        ok: true,
        status: 200,
        body: makeSseStream([
          `data: ${JSON.stringify({ event_type: 'interaction.created', interaction: { id: `ix_${idx}` } })}\r\n\r\n`,
          `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'text', text: '第一段' } })}\n`,
          `\n`,
          `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'text', text: '第二段' } })}\n\n`,
          `data: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { id: `ix_${idx}`, usage: { total_tokens: 42 } } })}\n\n`,
        ]),
      };
    };

    const engine = new PetChatEngine({
      fetchImpl,
      getSettings: () => ({
        chat: {
          mode: 'api',
          apiModel: DEFAULT_CHAT_MODEL,
          baseUrl: DEFAULT_CHAT_BASE_URL,
          apiKey: 'AIzaTestSecret12345',
          personaExtra: '精简作答',
        },
      }),
      getLanguage: () => 'zhs',
    });

    const deltas = [];
    const r1 = await engine.sendMessage('你好哈基米', {
      onDelta(chunk, full) {
        deltas.push({ chunk, full });
      },
    });

    assert.equal(r1.aborted, false);
    assert.equal(r1.engine, 'api');
    assert.equal(r1.text, '第一段第二段');
    assert.deepEqual(r1.usage, { total_tokens: 42 });
    assert.deepEqual(deltas, [
      { chunk: '第一段', full: '第一段' },
      { chunk: '第二段', full: '第一段第二段' },
    ]);
    assert.equal(requests[0].url, 'https://generativelanguage.googleapis.com/v1/interactions');
    assert.equal(requests[0].init.headers['x-goog-api-key'], 'AIzaTestSecret12345');
    assert.equal(requests[0].body.stream, true);
    assert.equal(requests[0].body.previous_interaction_id, undefined);

    const r2 = await engine.sendMessage('继续说说');
    assert.equal(r2.aborted, false);
    assert.equal(requests[1].body.previous_interaction_id, 'ix_1');

    engine.reset();
    assert.equal(engine.previousInteractionId, null);
  });

  it('auto 模式下宿主不可用且存在 API Key 时自动降级到 API', async () => {
    const engine = new PetChatEngine({
      ls: { async call() { throw new Error('LS offline'); } },
      models: { configs: [], async refresh() {}, resolve() { return null; } },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        body: makeSseStream([
          `data: ${JSON.stringify({ event_type: 'step.delta', delta: { type: 'text', text: '备用通道已接通' } })}\n\n`,
          `data: ${JSON.stringify({ event_type: 'interaction.completed', interaction: { id: 'fallback-complete', status: 'completed' } })}\n\n`,
        ]),
      }),
      getSettings: () => ({
        chat: {
          mode: 'auto',
          apiModel: DEFAULT_CHAT_MODEL,
          baseUrl: DEFAULT_CHAT_BASE_URL,
          apiKey: 'AIzaFallbackKey999',
        },
      }),
    });

    const res = await engine.sendMessage('测试降级');
    assert.equal(res.engine, 'api');
    assert.equal(res.text, '备用通道已接通');
  });

  it('正确处理缺 Key、空输入与中断请求', async () => {
    const engine = new PetChatEngine({
      getSettings: () => ({ chat: { mode: 'api', apiKey: '' } }),
    });

    await assert.rejects(() => engine.sendMessage('   '), /请输入内容/);
    await assert.rejects(() => engine.sendMessage('你好'), err => err.code === 'MISSING_API_KEY');

    let resolveHost;
    const slowEngine = new PetChatEngine({
      ls: {
        call() {
          return new Promise(resolve => { resolveHost = resolve; });
        },
      },
      models: { configs: [{ id: 'g', label: 'Gemini' }], async refresh() {}, resolve() { return null; } },
      getSettings: () => ({ chat: { mode: 'host' } }),
    });

    const pending = slowEngine.sendMessage('慢请求');
    await new Promise(r => setTimeout(r, 10));
    slowEngine.abort();
    resolveHost?.({ response: '迟到的响应' });
    const result = await pending;
    assert.equal(result.aborted, true);
    assert.equal(slowEngine.busy, false);
  });
});

describe('chat settings sanitize & persistence', () => {
  it('校验 chat 字段并仅将变更项写入配置文件', () => {
    const clean = sanitize({
      chat: {
        mode: 'invalid-mode',
        apiModel: 'bad model name with spaces!',
        baseUrl: '  https://custom.api.local/v1  ',
        apiKey: '  key-123  ',
        personaExtra: '冷静模式',
      },
    });

    assert.equal(clean.chat.mode, DEFAULTS.chat.mode);
    assert.equal(clean.chat.apiModel, DEFAULTS.chat.apiModel);
    assert.equal(clean.chat.baseUrl, 'https://custom.api.local/v1');
    assert.equal(clean.chat.apiKey, 'key-123');
    assert.equal(clean.chat.personaExtra, '冷静模式');

    const dir = mkdtempSync(join(tmpdir(), 'hagemi-chat-settings-'));
    const file = join(dir, 'settings.json');
    const store = new SettingsStore(file);
    store.patch({ chat: { mode: 'api', apiKey: 'my-key' } });

    const saved = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(saved.chat.mode, 'api');
    assert.equal(saved.chat.apiKey, 'my-key');
    // 默认未改动的字段不应该污染磁盘文件
    assert.equal(saved.chat.baseUrl, undefined);

    const reloaded = new SettingsStore(file);
    assert.equal(reloaded.value.chat.mode, 'api');
    assert.equal(reloaded.value.chat.baseUrl, DEFAULTS.chat.baseUrl);
  });
});
