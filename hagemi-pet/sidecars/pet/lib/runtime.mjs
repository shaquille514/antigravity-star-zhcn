// 哈基米桌宠共用核心运行时：支持 Sidecar (CDP 注入) 与 Electron 独立桌面漂浮双模式运行。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Brain, Budget, ModelResolver } from './brain.mjs';
import { PetChatEngine, maskApiKey, normalizeBaseUrl } from './chat.mjs';
import { ambientTriggers, chooseState, classifyTurnEnd, festival, isLate, modelFamily, REACTIONS, rivalAppTrigger, timeOfDay } from './director.mjs';
import { ForegroundWatcher } from './foreground.mjs';
import { fill, resolveLanguage, UI } from './lines.mjs';
import { LanguageServer } from './ls-client.mjs';
import { Monitor } from './monitor.mjs';
import { formatDuration, isResetSoon, levelForModel, parseQuota, quotaEvents, quotaRows, summarize } from './quota.mjs';
import { readArt } from './renderer-source.mjs';
import { SettingsStore } from './settings.mjs';
import { Updater, UPDATE_INTERVAL_MS } from './updater.mjs';

const MINUTE = 60000;

export function resolvePetDirs() {
  const geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR || join(homedir(), '.gemini');
  const appDataDir = resolve(geminiDir, process.env.ANTIGRAVITY_APP_DATA_DIR || 'antigravity');
  const dataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(appDataDir, 'sidecar_data', 'hagemi-pet-agy', 'pet', 'data');
  return { geminiDir, appDataDir, dataDir };
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

export function getDesktopLockFile(dataDir = resolvePetDirs().dataDir) {
  return join(dataDir, 'desktop.lock.json');
}

/**
 * 判断当前是否已有独立桌面漂浮版哈基米在运行，避免 CDP Sidecar 重复注入导致重影。
 */
export function isDesktopPetRunning(dataDir = resolvePetDirs().dataDir) {
  const lockFile = getDesktopLockFile(dataDir);
  if (!existsSync(lockFile)) return false;
  try {
    const data = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (isPidAlive(Number(data?.pid))) return Number(data.pid);
  } catch {}
  return false;
}

export function writeDesktopLock(dataDir = resolvePetDirs().dataDir, pid = process.pid) {
  const lockFile = getDesktopLockFile(dataDir);
  try {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${lockFile}.${pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ pid, startedAt: Date.now() }), { mode: 0o600 });
    renameSync(tmp, lockFile);
  } catch {}
}

export function clearDesktopLock(dataDir = resolvePetDirs().dataDir, pid = process.pid) {
  const lockFile = getDesktopLockFile(dataDir);
  try {
    if (!existsSync(lockFile)) return;
    const data = JSON.parse(readFileSync(lockFile, 'utf8'));
    if (!data?.pid || Number(data.pid) === pid) rmSync(lockFile, { force: true });
  } catch {}
}

export function startPetRuntime({
  createBridge,
  isDesktop = false,
  enableUpdater = !isDesktop,
  onDesktopControl = null,
  onQuit = null,
  log = message => console.log(`[hagemi] ${message}`),
} = {}) {
  const { geminiDir, appDataDir, dataDir } = resolvePetDirs();
  if (!isDesktop) {
    try { mkdirSync(dataDir, { recursive: true }); process.chdir(dataDir); } catch { /* 保持原目录 */ }
  } else {
    try { mkdirSync(dataDir, { recursive: true }); } catch {}
  }

  const settings = new SettingsStore(join(dataDir, 'settings.json'));
  const budget = new Budget(join(dataDir, 'budget.json'));
  const ls = new LanguageServer({ env: isDesktop ? { ...process.env, ANTIGRAVITY_LS_ADDRESS: '', ANTIGRAVITY_CSRF_TOKEN: '' } : process.env });
  const models = new ModelResolver(ls);
  const chat = new PetChatEngine({
    ls,
    models,
    log,
    getSettings: () => settings.value,
    getLanguage: () => resolveLanguage(settings.value.language, appLanguage),
  });

  function safeSettingsForRenderer(value = settings.value) {
    const rawKey = value?.chat?.apiKey || '';
    return {
      ...value,
      chat: {
        ...value.chat,
        apiKey: '',
        hasApiKey: Boolean(chat.resolveApiKey(rawKey)),
        keyMask: maskApiKey(rawKey),
      },
    };
  }

  let appLanguage = isDesktop ? (Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN') : 'en';
  let facts = { running: 0, subagents: 0, category: null, idleMs: 0, quietMs: 0, connected: false };
  let quota = { level: null, mood: 'ok', buckets: [], resetInMs: null };
  let allBuckets = [];
  let presence = { visible: true, focused: true, idleMs: 0 };
  let selectedModel = null;
  let activeSince = null, lastToolAt = 0;
  let lastFactsJson = '', lastLoggedState = null, lastState = null;
  let rivalApp = null;
  let chatReqSeq = 0;
  let greeted = false;

  const language = () => resolveLanguage(settings.value.language, appLanguage);
  const ui = () => UI[language()];
  const quotaOptions = () => ({ lowAt: settings.value.quota.lowAt, criticalAt: settings.value.quota.criticalAt, resetSoonMs: settings.value.quota.resetSoonMin * MINUTE });

  const bridge = createBridge({ onMessage: onPetMessage, log });

  const brain = new Brain({
    ls, budget, models, log,
    getSettings: () => settings.value,
    getLanguage: language,
    getPresence: () => presence,
    getQuotaLevel: () => levelForModel(allBuckets, models.resolve(settings.value.ai.model)?.label || settings.value.ai.model),
    say: (result, trigger) => {
      bridge.broadcast({ t: 'say', text: result.text, mood: result.mood, ai: result.ai, force: trigger === 'greet' || trigger.startsWith('app_rival') });
      if (process.env.HAGEMI_DEBUG) log(`${trigger}${result.ai ? ' (ai)' : ''}: ${result.text}`);
    },
  });

  const updater = enableUpdater
    ? new Updater({
        root: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
        installedRoot: join(geminiDir, 'config', 'plugins', 'hagemi-pet-agy'),
        log,
        onChange: update => bridge.broadcast({ t: 'update', update }),
        onInstalled: () => {
          bridge.broadcast({ t: 'react', state: 'happy', gesture: 'hop', burst: 'sparkles' });
          setTimeout(() => shutdown(), 1500);
        },
      })
    : {
        state: { phase: 'current', canInstall: false, reason: 'checkout', currentVersion: 'desktop' },
        check() {},
        install() {},
      };
  if (enableUpdater) updater.local().then(local => updater.publish(local)).catch(() => {});

  function hudRows() {
    const strings = ui(), rows = quotaRows(quota.buckets, strings, language());
    rows.push({ label: strings.hud_agents, value: facts.subagents ? fill(strings.hud_subagents, facts) : facts.running ? fill(strings.hud_running, facts) : strings.hud_idle });
    const usage = budget.usage;
    if (settings.value.ai.enabled) rows.push({ label: strings.hud_comments, value: `${usage.calls}/${settings.value.ai.maxPerDay} · ~${usage.tokens}` });
    if (!facts.connected) rows.push({ label: 'Antigravity', value: strings.hud_unavailable });
    return rows;
  }

  function publishFacts(force = false) {
    const idleMs = Math.min(facts.idleMs || 0, presence.visible ? presence.idleMs : Infinity);
    const activeRival = settings.value.rivalAppWatch !== false ? rivalApp : null;
    const state = chooseState({ ...facts, rivalApp: activeRival, idleMs }, quota, { resetSoon: isResetSoon(quota, quotaOptions()) });
    if (lastState === 'sleeping' && state !== 'sleeping') moment('wake');
    lastState = state;
    const message = {
      t: 'facts',
      state,
      quota: quota.mood === 'empty' ? 'critical' : quota.mood,
      late: isLate(new Date()),
      subagents: facts.subagents,
      stashLevel: quota.level,
      stashLabel: quota.level == null ? '' : `${Math.round(quota.level * 100)}%`,
      hud: hudRows(),
    };
    const json = JSON.stringify(message);
    if (process.env.HAGEMI_DEBUG && state !== lastLoggedState) {
      lastLoggedState = state;
      log(`state: ${state} (running ${facts.running}, rival ${activeRival || '-'}, tool ${facts.lastTool || '-'})`);
    }
    if (force || json !== lastFactsJson) {
      lastFactsJson = json;
      bridge.broadcast(message);
    } else {
      bridge.broadcast({ t: 'heartbeat' });
    }
  }

  function act(trigger) {
    const reaction = REACTIONS[trigger]?.react;
    if (reaction) bridge.broadcast({ t: 'react', ...reaction });
  }

  function context(extra = {}) {
    return {
      running: facts.running,
      subagents: facts.subagents,
      lastTool: facts.lastTool,
      toolCount: facts.toolCount,
      title: facts.title,
      userText: facts.userText,
      agentText: facts.agentText,
      quotaPercent: quota.level == null ? null : Math.round(quota.level * 100),
      model: selectedModel?.label,
      ...extra,
    };
  }

  function moment(trigger, extra = {}, options = {}) {
    act(trigger);
    brain.consider(trigger, context(extra), options).catch(error => log(`remark failed: ${error.message}`));
  }

  function onEvent(event) {
    switch (event.type) {
      case 'turn_start':
        if (!activeSince) activeSince = Date.now();
        lastToolAt = Date.now();
        moment('turn_start');
        break;
      case 'turn_end': {
        const trigger = classifyTurnEnd(event);
        moment(trigger, {
          title: event.title,
          toolCount: event.toolCount,
          durationMin: Math.round((event.durationMs || 0) / MINUTE),
          userText: event.userText,
          agentText: event.agentText,
          vars: { count: event.toolCount || 0 },
        });
        break;
      }
      case 'tool':
        lastToolAt = Date.now();
        if (event.category === 'drawing') moment('drawing');
        break;
      case 'step_error':
        moment('step_error');
        break;
      case 'compact':
        moment('compact');
        break;
      case 'context_big':
        moment('context_big', { title: event.title });
        break;
      case 'subagent_start': {
        const count = facts.subagents + 1;
        moment(count >= 3 ? 'subagent_many' : 'subagent_start', { vars: { count } });
        break;
      }
      case 'subagent_done':
        if (facts.subagents <= 1) moment('subagent_done');
        break;
      default:
        break;
    }
  }

  let previousRunning = 0, previousWaiting = false;
  const monitor = new Monitor({
    ls,
    brainDir: join(appDataDir, 'brain'),
    onEvent,
    onFacts(next) {
      const now = Date.now();
      facts = { ...next, quietMs: lastToolAt ? now - lastToolAt : 0 };
      if (next.waiting && !previousWaiting) moment('waiting');
      previousWaiting = next.waiting;
      if (next.running === 2 && previousRunning < 2) moment('busy');
      if (next.running >= 3 && previousRunning < 3) moment('swamped', { vars: { count: next.running } });
      previousRunning = next.running;
      if (next.running || next.subagents) activeSince ||= now;
      else if (next.idleMs > 10 * MINUTE) activeSince = null;
      if (next.longestRunMs > 12 * MINUTE && !monitor.longRunWarned) {
        monitor.longRunWarned = true;
        moment('long_run', { durationMin: Math.round(next.longestRunMs / MINUTE) });
      }
      if (!next.running) monitor.longRunWarned = false;
      publishFacts();
    },
  });
  monitor.onError = error => {
    if (facts.connected) {
      log(`monitor disconnected: ${error.message}`);
      facts = { ...facts, running: 0, subagents: 0, category: null, connected: false };
      publishFacts(true);
    }
  };

  async function pollQuota() {
    try {
      const response = await ls.call('RetrieveUserQuotaSummary');
      const now = Date.now();
      allBuckets = parseQuota(response, now);
      const next = summarize(allBuckets, selectedModel?.label || 'gemini', quotaOptions(), now);
      for (const event of quotaEvents(quota, next, quotaOptions())) {
        if (event.type === 'quota_ok') continue;
        moment(event.type, { vars: { left: event.type === 'reset_soon' ? formatDuration(event.resetInMs, language()) : `${Math.round(event.level * 100)}%` } });
      }
      quota = next;
      publishFacts();
    } catch { /* 宿主未启动或尚未登录时安静跳过额度轮询 */ }
  }

  async function pollModel() {
    try {
      const state = await readFile(join(appDataDir, 'antigravity_state.pbtxt'), 'utf8');
      const id = state.match(/last_selected_agent_model:\s*(\S+)/)?.[1];
      if (!id) return;
      await models.refresh();
      const label = models.labelOf(id);
      if (!label) return;
      const next = { id, label, family: modelFamily(label) };
      const previous = selectedModel;
      selectedModel = next;
      if (previous && previous.id !== next.id) {
        if (next.family === 'claude' || next.family === 'gpt') moment(`model_rival_${next.family}`);
        else if (next.family === 'gemini' && previous.family !== 'gemini') moment('model_back');
      }
    } catch {}
  }

  function greet() {
    const now = new Date();
    const fest = festival(now);
    const scene = fest || `greet_${timeOfDay(now)}`;
    bridge.broadcast({ t: 'react', state: scene, ms: 4200, gesture: 'hop', burst: 'sparkles' });
    brain.consider('greet', {}, { line: scene }).catch(() => {});
  }

  function ambient() {
    for (const trigger of ambientTriggers({
      now: Date.now(),
      active: facts.running > 0,
      activeSinceMs: activeSince ? Date.now() - activeSince : 0,
      lastRemarkAgoMs: Date.now() - brain.lastBubbleAt,
      idleMs: Math.min(facts.idleMs || 0, presence.idleMs || 0),
    })) {
      moment(trigger, { vars: { name: `${new Date().getHours()}:00` } });
      break;
    }
  }

  async function sendModelChoices(session) {
    try {
      const configs = await models.refresh();
      bridge.post(session, { t: 'models', models: configs.map(c => c.label), usage: budget.usage });
    } catch {}
  }

  function onPetMessage(message, session) {
    switch (message.type) {
      case 'ready':
        bridge.post(session, { t: 'hello', settings: safeSettingsForRenderer(), ui: ui() });
        bridge.post(session, { t: 'update', update: updater.state });
        lastFactsJson = '';
        publishFacts(true);
        sendModelChoices(session);
        if (!greeted) { greeted = true; setTimeout(greet, 900); }
        break;
      case 'desktop_hit':
      case 'desktop_focus':
        onDesktopControl?.(message, session);
        break;
      case 'desktop_quit':
        onQuit?.();
        break;
      case 'panelOpened':
        bridge.post(session, { t: 'update', update: updater.state });
        break;
      case 'update_check':
        updater.check();
        break;
      case 'update_install':
        updater.install();
        break;
      case 'art':
        bridge.post(session, { t: 'art', name: message.name, data: readArt(message.name) });
        break;
      case 'settings': {
        const before = settings.value.language;
        const patch = message.patch ? { ...message.patch } : {};
        if (patch.chat && typeof patch.chat.baseUrl === 'string') {
          try { patch.chat = { ...patch.chat, baseUrl: normalizeBaseUrl(patch.chat.baseUrl) }; }
          catch { delete patch.chat.baseUrl; }
        }
        settings.patch(patch);
        if (settings.value.rivalAppWatch === false) rivalApp = null;
        if (settings.value.language !== before || patch.chat) {
          bridge.broadcast({ t: 'settings', settings: safeSettingsForRenderer(), ui: ui() });
        }
        publishFacts(true);
        break;
      }
      case 'chat_send': {
        const prompt = String(message.prompt || '').trim();
        if (!prompt) break;
        const requestId = ++chatReqSeq;
        bridge.broadcast({ t: 'chat_start', requestId, prompt });
        chat.sendMessage(prompt, {
          onDelta: (_delta, fullText) => {
            if (requestId === chatReqSeq) bridge.broadcast({ t: 'chat_delta', requestId, fullText });
          },
        }).then(result => {
          if (requestId !== chatReqSeq) return;
          if (result.aborted) {
            bridge.broadcast({ t: 'chat_aborted', requestId, text: result.text || '' });
          } else {
            bridge.broadcast({ t: 'chat_done', requestId, text: result.text, engine: result.engine, model: result.model });
          }
        }).catch(error => {
          if (requestId !== chatReqSeq) return;
          bridge.broadcast({ t: 'chat_error', requestId, message: error.message || '生成失败' });
        });
        break;
      }
      case 'chat_stop': {
        const requestId = chatReqSeq;
        chatReqSeq++;
        chat.abort();
        bridge.broadcast({ t: 'chat_aborted', requestId, text: '' });
        break;
      }
      case 'chat_reset':
        chatReqSeq++;
        chat.reset();
        bridge.broadcast({ t: 'chat_reset' });
        break;
      case 'presence':
        presence = { visible: !!message.visible, focused: !!message.focused, idleMs: Number(message.idleMs) || 0 };
        if (message.language) appLanguage = message.language;
        break;
      case 'remount':
        bridge.remount(session);
        break;
      case 'talk':
        brain.consider('talk', context(), { force: true, line: 'talk_offline' }).catch(() => {});
        break;
      case 'touch': {
        const known = ['poke', 'pet', 'coax', 'annoyed', 'puffed', 'redhot', 'sulk', 'shaken', 'grab'];
        if (known.includes(message.kind)) brain.consider(message.kind, {}).catch(() => {});
        break;
      }
      case 'error':
        log(`pet error: ${String(message.message).slice(0, 400)}`);
        break;
      default:
        break;
    }
  }

  const foreground = new ForegroundWatcher({
    getPosition: () => settings.value.position,
    log,
    onChange(next) {
      if (settings.value.rivalAppWatch === false) return;
      const prevApp = rivalApp;
      rivalApp = next.app;
      if (next.app && next.app !== prevApp) {
        publishFacts(true);
        const trigger = rivalAppTrigger(next.app);
        if (trigger) moment(trigger);
      } else if (prevApp && !next.app) {
        publishFacts(true);
        if (next.isHost) moment('app_rival_back');
      }
    },
  });

  const timers = [setInterval(pollQuota, 60000), setInterval(pollModel, 20000), setInterval(ambient, 5 * MINUTE)];
  if (enableUpdater) {
    const checkUpdates = () => { if (settings.value.autoCheckUpdates) updater.check(); };
    timers.push(setTimeout(checkUpdates, 15000), setInterval(checkUpdates, UPDATE_INTERVAL_MS));
  }
  for (const timer of timers) timer.unref?.();

  pollModel().then(pollQuota);
  monitor.start();
  foreground.start();
  bridge.start();
  log(`started (${isDesktop ? 'desktop' : 'sidecar'}), data in ${dataDir}`);

  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    for (const timer of timers) clearInterval(timer);
    foreground.stop();
    chat.abort();
    monitor.stop();
    await bridge.stop();
  }

  return {
    settings,
    safeSettingsForRenderer,
    ui,
    publishFacts,
    bridge,
    onPetMessage,
    shutdown,
    showDesktopChat() {
      bridge.broadcast({ t: 'open_chat' });
    },
    resetDesktopPosition() {
      bridge.broadcast({ t: 'reset_position' });
    },
    unhide() {
      settings.patch({ hidden: false, hiddenUntil: 0 });
      bridge.broadcast({ t: 'settings', settings: safeSettingsForRenderer(), ui: ui() });
      publishFacts(true);
    },
  };
}
