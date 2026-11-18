import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applySettingsUpdate } from '../sidecars/pet/lib/runtime.mjs';
import { DEFAULTS, sanitize, SettingsStore } from '../sidecars/pet/lib/settings.mjs';

test('defaults match the promises in the README', () => {
  assert.equal(DEFAULTS.ai.model, 'Gemini 3.8 Flash (Low)');
  assert.equal(DEFAULTS.language, 'auto');
  assert.equal(DEFAULTS.ai.enabled, true);
  assert.equal(DEFAULTS.ai.pauseBelowQuota, 0.1);
  assert.equal(DEFAULTS.ai.contextLevel, 'snippets');
  assert.equal(DEFAULTS.autoCheckUpdates, true);
});

test('the default rate and daily token budget match the README', () => {
  assert.equal(DEFAULTS.ai.minIntervalMin, 2);
  assert.equal(DEFAULTS.ai.maxPerHour, 30);
  assert.equal(DEFAULTS.ai.maxPerDay, 300);
  assert.equal(DEFAULTS.ai.dailyTokenBudget, 200000);
});

test('old settings files pick up new defaults but keep real choices', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hagemi-')), 'settings.json');
  writeFileSync(file, JSON.stringify({ language: 'zhs', ai: { enabled: true, model: 'Gemini 3.8 Flash (Low)', minIntervalMin: 10, maxPerHour: 7, maxPerDay: 24, dailyTokenBudget: 12000, pauseBelowQuota: 0.15 } }));
  const { value } = new SettingsStore(file);
  assert.equal(value.language, 'zhs');
  assert.equal(value.ai.maxPerHour, 7, 'a value the user changed stays');
  assert.equal(value.ai.minIntervalMin, DEFAULTS.ai.minIntervalMin);
  assert.equal(value.ai.maxPerDay, DEFAULTS.ai.maxPerDay);
  assert.equal(value.ai.dailyTokenBudget, DEFAULTS.ai.dailyTokenBudget);
  assert.equal(value.ai.pauseBelowQuota, DEFAULTS.ai.pauseBelowQuota);
});

test('only changes are saved, so later default improvements reach everyone', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hagemi-')), 'settings.json');
  new SettingsStore(file).patch({ language: 'zhs', ai: { maxPerHour: 9 } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, language: 'zhs', ai: { maxPerHour: 9 } });
  const reloaded = new SettingsStore(file);
  assert.equal(reloaded.value.ai.maxPerHour, 9);
  assert.equal(reloaded.value.ai.maxPerDay, DEFAULTS.ai.maxPerDay);
  assert.equal(reloaded.value.ai.pauseBelowQuota, 0.1);
  // Going back to a default forgets the override.
  reloaded.patch({ ai: { maxPerHour: DEFAULTS.ai.maxPerHour } });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2, language: 'zhs' });
});

test('an explicitly saved quota cutoff still overrides the new default', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hagemi-')), 'settings.json');
  writeFileSync(file, JSON.stringify({ version: 2, ai: { pauseBelowQuota: 0.05 } }));
  assert.equal(new SettingsStore(file).value.ai.pauseBelowQuota, 0.05);
});

test('junk input cannot break her', () => {
  const value = sanitize({ language: 'klingon', size: 99, ai: { maxPerDay: 'lots', minIntervalMin: -5, contextLevel: 'everything', model: 42 }, quota: { lowAt: 7 }, position: { x: 'a' } });
  assert.equal(value.language, 'auto');
  assert.equal(value.size, 'm');
  assert.equal(value.ai.maxPerDay, DEFAULTS.ai.maxPerDay);
  assert.equal(value.ai.minIntervalMin, 1);
  assert.equal(value.ai.contextLevel, DEFAULTS.ai.contextLevel);
  assert.equal(value.ai.model, DEFAULTS.ai.model);
  assert.equal(value.quota.lowAt, 0.9);
  assert.equal(value.position, null);
});

test('saved settings survive a restart, and patches merge', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hagemi-')), 'settings.json');
  const store = new SettingsStore(file);
  store.patch({ language: 'zhs', ai: { maxPerHour: 2 } });
  store.patch({ size: 'l', autoCheckUpdates: false, position: { x: 0.2, y: 0.4 } });
  const reloaded = new SettingsStore(file);
  assert.equal(reloaded.value.language, 'zhs');
  assert.equal(reloaded.value.size, 'l');
  assert.equal(reloaded.value.autoCheckUpdates, false);
  assert.equal(reloaded.value.ai.maxPerHour, 2);
  assert.equal(reloaded.value.ai.model, DEFAULTS.ai.model);
  assert.deepEqual(reloaded.value.position, { x: 0.2, y: 0.4 });
  assert.ok(JSON.parse(readFileSync(file, 'utf8')));
});

test('a corrupt settings file falls back to defaults', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hagemi-')), 'settings.json');
  writeFileSync(file, '{ not json');
  assert.equal(new SettingsStore(file).value.language, 'auto');
});

test('docking is remembered with the position', () => {
  const value = sanitize({ position: { x: 0, y: 0.5, dock: 'left' } });
  assert.equal(value.position.dock, 'left');
  assert.equal(sanitize({ position: { x: 0, y: 0.5, dock: 'sideways' } }).position.dock, undefined);
});

test('runtime 拦截无效 chat.baseUrl 时记录日志、保留原设置并向用户气泡反馈', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hagemi-runtime-settings-')), 'settings.json');
  const store = new SettingsStore(file);
  store.patch({ chat: { baseUrl: 'https://valid.example.com/v1' } });

  const broadcasts = [];
  const logs = [];
  let lang = 'zhs';
  const invoke = rawPatch => applySettingsUpdate({
    settings: store,
    rawPatch,
    getLanguage: () => lang,
    safeSettingsForRenderer: () => ({ ...store.value, chat: { ...store.value.chat, apiKey: '' } }),
    ui: () => ({ lang }),
    bridge: { broadcast: msg => broadcasts.push(msg) },
    log: msg => logs.push(msg),
  });

  // 1. 中文界面下提交非本机 HTTP 地址：应记录日志、忽略 baseUrl、应用合法字段、回推完整设置与中文提示气泡
  invoke({ chat: { mode: 'api', baseUrl: 'http://remote-insecure.example.com/v1' } });
  assert.equal(store.value.chat.baseUrl, 'https://valid.example.com/v1');
  assert.equal(store.value.chat.mode, 'api');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^invalid chat baseUrl ignored:/);
  assert.equal(broadcasts.find(m => m.t === 'settings')?.settings.chat.baseUrl, 'https://valid.example.com/v1');
  const zhSay = broadcasts.find(m => m.t === 'say');
  assert.equal(zhSay?.mood, 'worried');
  assert.equal(zhSay?.force, true);
  assert.match(zhSay?.text || '', /API 地址无效/);

  // 2. 英文界面下提交非法格式 URL：应回推英文提示气泡
  broadcasts.length = 0;
  logs.length = 0;
  lang = 'en';
  invoke({ chat: { baseUrl: 'not a url' } });
  assert.equal(store.value.chat.baseUrl, 'https://valid.example.com/v1');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^invalid chat baseUrl ignored:/);
  const enSay = broadcasts.find(m => m.t === 'say');
  assert.equal(enSay?.mood, 'worried');
  assert.equal(enSay?.force, true);
  assert.match(enSay?.text || '', /Invalid API Base URL/);

  // 3. 提交合法 HTTPS 地址（含尾斜杠）：应规范化且无错误日志与警告气泡
  broadcasts.length = 0;
  logs.length = 0;
  invoke({ chat: { baseUrl: 'https://proxy.example.com/v1/' } });
  assert.equal(store.value.chat.baseUrl, 'https://proxy.example.com/v1');
  assert.equal(logs.length, 0);
  assert.equal(broadcasts.some(m => m.t === 'say'), false);
});
