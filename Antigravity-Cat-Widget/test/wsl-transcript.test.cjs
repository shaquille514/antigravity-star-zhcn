const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { TranscriptAdapter, parseWslDistroList } = require("../src/adapters/transcript-adapter.cjs");
const { SettingsManager } = require("../src/domain/settings.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "star-wsl-test-"));

test("parseWslDistroList decodes UTF-16LE BOM and UTF-8 outputs cleanly", () => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Ubuntu\r\nDebian\r\n\r\n", "utf16le")]);
  assert.deepEqual(parseWslDistroList(utf16), ["Ubuntu", "Debian"]);
  assert.deepEqual(parseWslDistroList("Ubuntu-24.04\n\n"), ["Ubuntu-24.04"]);
  assert.deepEqual(parseWslDistroList(null), []);
});

test("TranscriptAdapter scans extraAppDataDirs alongside primary appDataDir and deduplicates", () => {
  const winRoot = tmp();
  const wslRoot = tmp();
  const winLog = path.join(winRoot, "brain", "conv-win", ".system_generated", "logs", "transcript_full.jsonl");
  const wslLog = path.join(wslRoot, "brain", "conv-wsl", ".system_generated", "logs", "transcript_full.jsonl");
  fs.mkdirSync(path.dirname(winLog), { recursive: true });
  fs.mkdirSync(path.dirname(wslLog), { recursive: true });

  const stepBase = { source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: new Date().toISOString() };
  fs.writeFileSync(winLog, JSON.stringify({ ...stepBase, step_index: 1, input_tokens: 10, output_tokens: 5 }) + "\n");
  fs.writeFileSync(wslLog, JSON.stringify({ ...stepBase, step_index: 2, input_tokens: 20, output_tokens: 8 }) + "\n");

  const adapter = new TranscriptAdapter({
    appDataDir: winRoot,
    extraAppDataDirs: [wslRoot, wslRoot],
    discoverWsl: false
  });
  const files = adapter.files();
  assert.equal(files.length, 2);

  const events = [];
  adapter.on("turnDone", e => events.push(e));
  adapter.scan();
  assert.equal(events.length, 2);
  assert.deepEqual(events.map(e => e.sessionId).sort(), ["conv-win", "conv-wsl"]);
  adapter.stop();
});

test("SettingsManager preserves discoverWsl and sanitizes extraBrainDirs", () => {
  const file = path.join(tmp(), "settings.json");
  const s = new SettingsManager(file);
  assert.equal(s.get("discoverWsl"), true);
  assert.deepEqual(s.get("extraBrainDirs"), []);
  s.update({ discoverWsl: false, extraBrainDirs: ["  /tmp/a  ", "", 123] });
  const reloaded = new SettingsManager(file);
  assert.equal(reloaded.get("discoverWsl"), false);
  assert.deepEqual(reloaded.get("extraBrainDirs"), ["/tmp/a"]);
});
