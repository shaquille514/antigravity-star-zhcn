// 桌面漂浮模式渲染源、防双宠互斥锁及桌面控窗交互测试。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { rendererSource } from '../sidecars/pet/lib/renderer-source.mjs';
import { clearDesktopLock, isDesktopPetRunning, writeDesktopLock } from '../sidecars/pet/lib/runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 构建用于测试 pet.js 桌面控窗与交互状态的轻量 DOM/Canvas 沙箱环境。
 */
async function bootDesktopPetHarness() {
  const sent = [];
  let timerSeq = 1;
  const timers = new Map();
  let disposed = false;

  class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...names) { for (const n of names) if (n) this.set.add(n); }
    remove(...names) { for (const n of names) this.set.delete(n); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
      const next = force === undefined ? !this.set.has(name) : Boolean(force);
      if (next) this.set.add(name);
      else this.set.delete(name);
      return next;
    }
  }

  class FakeTarget {
    constructor() {
      this.listeners = new Map();
      this.parentNode = null;
    }
    addEventListener(type, fn, opts = {}) {
      if (opts?.signal?.aborted) return;
      const list = this.listeners.get(type) || [];
      const entry = { fn, capture: Boolean(opts.capture) };
      list.push(entry);
      this.listeners.set(type, list);
      opts?.signal?.addEventListener?.('abort', () => {
        const cur = this.listeners.get(type) || [];
        this.listeners.set(type, cur.filter(item => item !== entry));
      });
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type) || [];
      this.listeners.set(type, list.filter(item => item.fn !== fn));
    }
    dispatchEvent(event) {
      const chain = [];
      for (let node = this; node; node = node.parentNode) chain.push(node);
      const evt = {
        defaultPrevented: false,
        cancelBubble: false,
        ...event,
        target: event.target || this,
        preventDefault() { this.defaultPrevented = true; },
        stopPropagation() { this.cancelBubble = true; },
        composedPath() { return chain; },
      };
      // 捕获阶段（从外到内）
      for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i];
        for (const entry of [...(node.listeners.get(evt.type) || [])]) {
          if (entry.capture) entry.fn(evt);
        }
        if (evt.cancelBubble) return evt;
      }
      // 冒泡阶段（从内到外）
      for (let i = 0; i < chain.length; i++) {
        const node = chain[i];
        for (const entry of [...(node.listeners.get(evt.type) || [])]) {
          if (!entry.capture) entry.fn(evt);
        }
        if (evt.cancelBubble) return evt;
      }
      return evt;
    }
  }

  class FakeElement extends FakeTarget {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.classList = new FakeClassList();
      this.style = {};
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this._className = '';
      this.textContent = '';
      this.value = '';
      this.checked = false;
      this.disabled = false;
      this.scrollTop = 0;
      this.scrollHeight = 40;
      this.offsetWidth = 180;
      this.offsetHeight = 200;
      this.isConnected = false;
      this.shadow = null;
    }
    get className() { return this._className; }
    set className(v) {
      this._className = String(v || '');
      this.classList = new FakeClassList();
      for (const part of this._className.split(/\s+/).filter(Boolean)) this.classList.add(part);
    }
    appendChild(child) {
      child.parentNode = this;
      child.isConnected = this.isConnected;
      this.children.push(child);
      return child;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() {
      this.isConnected = false;
      if (this.parentNode?.children) {
        this.parentNode.children = this.parentNode.children.filter(c => c !== this);
      }
    }
    setAttribute(name, val) { this.attributes[name] = String(val); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    attachShadow() {
      const shadow = new FakeElement('#shadow-root');
      shadow.parentNode = this;
      shadow.isConnected = true;
      this.shadow = shadow;
      return shadow;
    }
    getBoundingClientRect() {
      return this.classList.contains('show')
        ? { left: 100, top: 100, right: 280, bottom: 300 }
        : { left: 0, top: 0, right: 0, bottom: 0 };
    }
    focus() {}
    closest(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      for (let node = this; node; node = node.parentNode) {
        if (cls && node.classList?.contains(cls)) return node;
      }
      return null;
    }
    matches() { return false; }
    setPointerCapture() {}
    findAll(predicate) {
      const out = [];
      const walk = node => {
        if (predicate(node)) out.push(node);
        for (const child of node.children || []) walk(child);
      };
      walk(this);
      return out;
    }
  }

  const windowTarget = new FakeTarget();
  const docElement = new FakeElement('html');
  docElement.isConnected = true;
  docElement.parentNode = windowTarget;

  const documentObj = new FakeTarget();
  documentObj.hidden = false;
  documentObj.documentElement = docElement;
  documentObj.hasFocus = () => true;
  documentObj.getElementById = id => docElement.children.find(c => c.id === id) || null;
  documentObj.createElement = tag => new FakeElement(tag);

  class FakeAbortController {
    constructor() {
      this.signal = new FakeTarget();
      this.signal.aborted = false;
    }
    abort() {
      this.signal.aborted = true;
      this.signal.dispatchEvent({ type: 'abort' });
    }
  }

  let nowMs = 1000;
  const context = {
    HAGEMI: {
      rigData: { idle: { size: [700, 640], eyes: [[300, 200], [400, 200]] } },
      STAGE: { w: 700, h: 640, cx: 350 },
      css: '',
      createRig: () => ({
        resize() {},
        draw() {},
        destroy() {},
        opaqueAt: (_pose, ax, ay) => ax >= 200 && ax <= 500 && ay >= 100 && ay <= 540,
      }),
      createFx: () => ({
        resize() {},
        draw() {},
        clear() {},
        burst() {},
        setStash() {},
        setClones() {},
        setCloneImage() {},
      }),
    },
    Math,
    Date,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Map,
    Set,
    Promise,
    Uint8Array,
    AbortController: FakeAbortController,
    CSSStyleSheet: class { replaceSync() {} },
    performance: { now: () => nowMs },
    navigator: { language: 'zh-CN' },
    document: documentObj,
    window: Object.assign(windowTarget, {
      innerWidth: 1280,
      innerHeight: 800,
      devicePixelRatio: 1,
      getSelection: () => null,
    }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setTimeout(fn, ms = 0) {
      const id = timerSeq++;
      timers.set(id, { fn, at: nowMs + ms, interval: false });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    setInterval(fn, ms = 0) {
      const id = timerSeq++;
      timers.set(id, { fn, at: nowMs + ms, interval: ms });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
  };
  context.window.window = context.window;

  vm.createContext(context);
  for (const file of ['util.js', 'behavior.js', 'pet.js']) {
    vm.runInContext(readFileSync(join(ROOT, 'sidecars', 'pet', 'renderer', file), 'utf8'), context);
  }

  const pet = await context.HAGEMI.boot(msg => sent.push(JSON.parse(JSON.stringify(msg))), { standalone: true, desktop: true });
  const host = docElement.children.find(c => c.id === 'hagemi-pet-host');
  const shadow = host.shadow;
  const stage = shadow.children.find(c => c.classList.contains('stage'));
  const hit = stage.children.find(c => c.classList.contains('hit'));
  const menu = shadow.children.find(c => c.classList.contains('menu'));
  const panel = shadow.children.find(c => c.classList.contains('panel'));
  const chatBox = shadow.children.find(c => c.classList.contains('chat-box'));

  const advance = ms => {
    nowMs += ms;
    for (const [id, entry] of [...timers]) {
      if (entry.at <= nowMs) {
        if (!entry.interval) timers.delete(id);
        else entry.at = nowMs + entry.interval;
        entry.fn();
      }
    }
  };

  return {
    pet,
    sent,
    window: context.window,
    hit,
    menu,
    panel,
    chatBox,
    advance,
    dispose() {
      if (!disposed) {
        disposed = true;
        pet.dispose();
      }
    },
  };
}

test('rendererSource supports desktop mode flag and generates valid isolated script under 400KB', () => {
  const { source, version } = rendererSource({ standalone: true, desktop: true });
  assert.doesNotThrow(() => new Function(source));
  assert.equal(version.length, 16);
  assert.ok(source.length < 400 * 1024);
  assert.match(source, /standalone:\s*true,\s*desktop:\s*true/);
  assert.match(source, /desktop_hit/);
  assert.match(source, /desktop_focus/);
  assert.match(source, /desktop_quit/);
  assert.match(source, /startLiveBubble/);
  assert.match(source, /is-chat/);
  assert.match(source, /panel\.classList\.contains\('show'\)\s*\|\|\s*chatBox\.classList\.contains\('show'\)\s*\|\|\s*menu\.classList\.contains\('show'\)/);
});

test('desktop lock detects live process and ignores stale PID files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hagemi-desktop-lock-'));
  assert.equal(isDesktopPetRunning(dir), false);

  writeDesktopLock(dir, process.pid);
  assert.equal(isDesktopPetRunning(dir), process.pid);

  // 不同 PID 不应误清锁
  clearDesktopLock(dir, process.pid + 99999);
  assert.equal(isDesktopPetRunning(dir), process.pid);

  clearDesktopLock(dir, process.pid);
  assert.equal(isDesktopPetRunning(dir), false);

  // 已退出或不可能存在的 PID 应返回 false
  writeFileSync(join(dir, 'desktop.lock.json'), JSON.stringify({ pid: 99999999, startedAt: Date.now() }));
  assert.equal(isDesktopPetRunning(dir), false);
});

test('桌面右键菜单展开即获取焦点，支持外部失焦与 Esc 关闭且不与面板/聊天框产生焦点闪烁竞态', async () => {
  const h = await bootDesktopPetHarness();
  try {
    h.pet.receive({
      t: 'hello',
      settings: {
        language: 'zhs',
        size: 'm',
        ai: { enabled: true, model: 'Gemini 3.8 Flash (Low)' },
        chat: {
          mode: 'auto',
          apiModel: 'gemini-4-hydrogen',
          baseUrl: 'https://generativelanguage.googleapis.com/v1',
          apiKey: '',
          hasApiKey: true,
          keyMask: 'AIza••••9876',
        },
        quota: { lowAt: 0.25, criticalAt: 0.1, resetSoonMin: 20 },
      },
      ui: {},
    });

    const openContextMenu = () => {
      h.sent.length = 0;
      h.hit.dispatchEvent({ type: 'contextmenu', clientX: 600, clientY: 500 });
      h.advance(370);
    };

    // 1. 打开右键菜单应获取焦点，按 Esc 可关闭并归还焦点
    openContextMenu();
    assert.equal(h.menu.classList.contains('show'), true);
    assert.deepEqual(
      h.sent.filter(m => m.type === 'desktop_focus'),
      [{ type: 'desktop_focus', focused: true }],
    );

    h.sent.length = 0;
    h.window.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.equal(h.menu.classList.contains('show'), false);
    assert.deepEqual(
      h.sent.filter(m => m.type === 'desktop_focus'),
      [{ type: 'desktop_focus', focused: false }],
    );

    // 2. 点击透明区外部触发 desktop_blur 时应关闭菜单并交还焦点
    openContextMenu();
    h.sent.length = 0;
    h.pet.receive({ t: 'desktop_blur' });
    assert.equal(h.menu.classList.contains('show'), false);
    assert.deepEqual(
      h.sent.filter(m => m.type === 'desktop_focus'),
      [{ type: 'desktop_focus', focused: false }],
    );

    // 3. 菜单 -> 设置面板 切换期间不能发出 desktop_focus: false 再 true 的闪烁
    openContextMenu();
    h.sent.length = 0;
    const settingsBtn = h.menu.findAll(el => el.tagName === 'BUTTON' && el.textContent.includes('Settings'));
    assert.equal(settingsBtn.length, 1);
    settingsBtn[0].dispatchEvent({ type: 'click' });
    assert.equal(h.menu.classList.contains('show'), false);
    assert.equal(h.panel.classList.contains('show'), true);
    assert.deepEqual(h.sent.filter(m => m.type === 'desktop_focus'), []);

    // 面板展开时触发原生 window blur 应一次性收起，不得错误反弹 desktop_focus: true
    h.sent.length = 0;
    h.window.dispatchEvent({ type: 'blur' });
    assert.equal(h.panel.classList.contains('show'), false);
    assert.deepEqual(h.sent.filter(m => m.type === 'desktop_focus'), []);

    // 4. 菜单 -> 对话框 切换期间同样不能先 blur 再 focus
    openContextMenu();
    h.sent.length = 0;
    const chatBtn = h.menu.findAll(el => el.tagName === 'BUTTON' && el.textContent.includes('Ask Hagemi'));
    assert.equal(chatBtn.length, 1);
    chatBtn[0].dispatchEvent({ type: 'click' });
    assert.equal(h.menu.classList.contains('show'), false);
    assert.equal(h.chatBox.classList.contains('show'), true);
    assert.deepEqual(h.sent.filter(m => m.type === 'desktop_focus'), []);
  } finally {
    h.dispose();
  }
});

test('pet.js 本地 patch() 安全合并 chat 与 quota 字段，不丢失已有 hasApiKey/keyMask/baseUrl', async () => {
  const h = await bootDesktopPetHarness();
  try {
    h.pet.receive({
      t: 'hello',
      settings: {
        language: 'zhs',
        size: 'm',
        ai: { enabled: true, model: 'Gemini 3.8 Flash (Low)' },
        chat: {
          mode: 'auto',
          apiModel: 'gemini-4-hydrogen',
          baseUrl: 'https://proxy.example.com/v1',
          apiKey: '',
          hasApiKey: true,
          keyMask: 'AIza••••9876',
        },
        quota: { lowAt: 0.25, criticalAt: 0.1, resetSoonMin: 20 },
      },
      ui: {},
    });

    // 通过菜单打开设置面板并更改 Reply engine (chat.mode)
    h.hit.dispatchEvent({ type: 'contextmenu', clientX: 600, clientY: 500 });
    h.advance(370);
    const settingsBtn = h.menu.findAll(el => el.tagName === 'BUTTON' && el.textContent.includes('Settings'));
    settingsBtn[0].dispatchEvent({ type: 'click' });

    const selects = h.panel.findAll(el => el.tagName === 'SELECT');
    const modeSelect = selects.find(sel => sel.children.some(opt => opt.value === 'api') && sel.children.some(opt => opt.value === 'host'));
    assert.ok(modeSelect);
    modeSelect.value = 'api';
    modeSelect.dispatchEvent({ type: 'change' });

    // 未等待 runtime 回传前，再次打开面板与聊天框，原有 chat 子字段应完好保留
    const closeBtn = h.panel.findAll(el => el.classList?.contains('panel-close'))[0];
    closeBtn.dispatchEvent({ type: 'click' });
    h.hit.dispatchEvent({ type: 'contextmenu', clientX: 600, clientY: 500 });
    h.advance(370);
    h.menu.findAll(el => el.tagName === 'BUTTON' && el.textContent.includes('Settings'))[0].dispatchEvent({ type: 'click' });

    const textInputs = h.panel.findAll(el => el.tagName === 'INPUT' && el.type === 'text');
    const passwordInputs = h.panel.findAll(el => el.tagName === 'INPUT' && el.type === 'password');
    assert.equal(textInputs[0].value, 'https://proxy.example.com/v1');
    assert.match(passwordInputs[0].placeholder, /AIza••••9876/);
    const reloadedModeSelect = h.panel.findAll(el => el.tagName === 'SELECT')
      .find(sel => sel.children.some(opt => opt.value === 'api') && sel.children.some(opt => opt.value === 'host'));
    assert.equal(reloadedModeSelect.value, 'api');
  } finally {
    h.dispose();
  }
});
