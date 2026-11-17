const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  GeminiChatClient,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  normalizeBaseUrl,
  maskApiKey,
  splitSseFrames,
  parseSseFrame
} = require("../src/adapters/gemini-chat.cjs");
const { SettingsManager } = require("../src/domain/settings.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "star-gemini-test-"));

function streamingResponse(events) {
  const bytes = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""));
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, ++offset));
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

test("streaming preserves initial model output across byte-sized UTF-8 chunks", async () => {
  const client = new GeminiChatClient({ fetch: async () => streamingResponse([
    { event_type: "interaction.created", interaction: { id: "complete-1" } },
    { event_type: "step.start", index: 0, step: { type: "thought", summary: [{ type: "text", text: "不显示的思考" }] } },
    { event_type: "step.start", index: 1, step: { type: "model_output", content: [{ type: "text", text: "你好" }] } },
    { event_type: "step.delta", index: 1, delta: { type: "text", text: "，世界！" } },
    { event_type: "interaction.completed", interaction: { id: "complete-1", status: "completed" } }
  ]) });
  const deltas = [];
  const result = await client.sendMessage("问候", { apiKey: "test-key" }, { onDelta: delta => deltas.push(delta) });
  assert.equal(result.text, "你好，世界！");
  assert.deepEqual(deltas, ["你好", "，世界！"]);
});

test("reset and a newer request ignore a delayed response from the old request", async () => {
  let releaseOld;
  const oldGate = new Promise(resolve => { releaseOld = resolve; });
  let requests = 0;
  const client = new GeminiChatClient({ fetch: async () => {
    const index = ++requests;
    if (index === 1) await oldGate;
    return streamingResponse([
      { event_type: "interaction.created", interaction: { id: `turn-${index}` } },
      { event_type: "step.delta", delta: { type: "text", text: `reply-${index}` } },
      { event_type: "interaction.completed", interaction: { id: `turn-${index}`, status: "completed" } }
    ]);
  } });
  const oldDeltas = [];
  const old = client.sendMessage("old", { apiKey: "test-key" }, { onDelta: delta => oldDeltas.push(delta) });
  client.resetConversation();
  await client.sendMessage("new", { apiKey: "test-key" });
  releaseOld();
  assert.equal((await old).aborted, true);
  assert.equal(client.previousInteractionId, "turn-2");
  assert.deepEqual(oldDeltas, []);
});

test("a truncated stream does not commit unfinished conversation context", async () => {
  const client = new GeminiChatClient({ fetch: async () => streamingResponse([
    { event_type: "interaction.created", interaction: { id: "unfinished" } },
    { event_type: "step.delta", delta: { type: "text", text: "partial" } }
  ]) });
  client.previousInteractionId = "last-complete";
  await assert.rejects(client.sendMessage("test", { apiKey: "test-key" }), /提前结束|未完成/);
  assert.equal(client.previousInteractionId, "last-complete");
});

test("invalid configuration does not leave the client busy", async () => {
  const client = new GeminiChatClient({ fetch: async () => { throw new Error("must not fetch"); } });
  await assert.rejects(client.sendMessage("test", { apiKey: "test-key", baseUrl: "not-a-url" }), /无效/);
  assert.equal(client.busy, false);
});

test("normalizeBaseUrl validates protocol and defaults cleanly", () => {
  assert.equal(normalizeBaseUrl(""), DEFAULT_BASE_URL);
  assert.equal(normalizeBaseUrl("https://generativelanguage.googleapis.com/"), "https://generativelanguage.googleapis.com/v1");
  assert.equal(normalizeBaseUrl("https://example.com/v1beta/"), "https://example.com/v1beta");
  assert.equal(normalizeBaseUrl("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1");
  assert.throws(() => normalizeBaseUrl("http://remote.example.com/v1"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("not-a-url"), /无效/);
});

test("maskApiKey and SSE framing handle split chunks accurately", () => {
  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey("123456"), "••••");
  assert.equal(maskApiKey("AIzaSyABC123456XYZ"), "AIza••••6XYZ");

  const chunk1 = 'event: step.delta\r\ndata: {"event_type":"step.delta","delta":{"type":"text","text":"喵"}}\r\n\r\nevent: step.';
  const { events, rest } = splitSseFrames(chunk1);
  assert.equal(events.length, 1);
  assert.deepEqual(parseSseFrame(events[0]), {
    event_type: "step.delta",
    delta: { type: "text", text: "喵" }
  });
  assert.equal(rest, "event: step.");
  assert.equal(parseSseFrame("data: [DONE]"), null);
});

test("GeminiChatClient streams Interactions API SSE deltas and tracks previous_interaction_id", async () => {
  const requests = [];
  const sseBody = [
    'event: interaction.created\ndata: {"event_type":"interaction.created","interaction":{"id":"inter_1","status":"in_progress"}}\n\n',
    'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"你好"}}\n\n',
    'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"，主人！"}}\n\n',
    'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"id":"inter_1","status":"completed","usage":{"total_tokens":42}}}\n\n',
    "event: done\ndata: [DONE]\n\n"
  ];

  const fetchMock = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const encoder = new TextEncoder();
    let idx = 0;
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              if (idx >= sseBody.length) return { done: true, value: undefined };
              return { done: false, value: encoder.encode(sseBody[idx++]) };
            }
          };
        }
      }
    };
  };

  const client = new GeminiChatClient({ fetch: fetchMock });
  const deltas = [];
  const res1 = await client.sendMessage(
    "打个招呼",
    { apiKey: "test-key-1234", model: DEFAULT_MODEL, systemInstruction: "猫娘" },
    { onDelta: d => deltas.push(d) }
  );

  assert.equal(res1.aborted, false);
  assert.equal(res1.text, "你好，主人！");
  assert.deepEqual(deltas, ["你好", "，主人！"]);
  assert.equal(requests[0].url, `${DEFAULT_BASE_URL}/interactions`);
  assert.equal(requests[0].headers["x-goog-api-key"], "test-key-1234");
  assert.equal(requests[0].body.previous_interaction_id, undefined);

  await client.sendMessage("继续", { apiKey: "test-key-1234" });
  assert.equal(requests[1].body.previous_interaction_id, "inter_1");

  client.resetConversation();
  assert.equal(client.previousInteractionId, null);
});

test("GeminiChatClient rejects missing key and SettingsManager sanitizes Gemini fields", async () => {
  const prevEnv1 = process.env.GEMINI_API_KEY;
  const prevEnv2 = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  try {
    const client = new GeminiChatClient({ fetch: async () => { throw new Error("should not call fetch"); } });
    await assert.rejects(client.sendMessage("hi", { apiKey: "" }), err => err.code === "MISSING_API_KEY");
  } finally {
    if (prevEnv1 !== undefined) process.env.GEMINI_API_KEY = prevEnv1;
    if (prevEnv2 !== undefined) process.env.GOOGLE_API_KEY = prevEnv2;
  }

  const file = path.join(tmp(), "settings.json");
  const s = new SettingsManager(file);
  s.update({ bubblePage: "chat", geminiModel: "gemini-4-carbon", geminiApiKey: "  my-secret  " });
  const reloaded = new SettingsManager(file);
  assert.equal(reloaded.get("bubblePage"), "chat");
  assert.equal(reloaded.get("geminiModel"), "gemini-4-carbon");
  assert.equal(reloaded.get("geminiApiKey"), "my-secret");
});
