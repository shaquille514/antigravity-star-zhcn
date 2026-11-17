// 前台 Claude / Codex 客户端识别与遮挡几何判定测试。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseState, modelFamily, REACTIONS, rivalAppTrigger } from '../sidecars/pet/lib/director.mjs';
import { buildWindowsProbeScript, detectRivalApp, ForegroundWatcher, isHostProcess, isPetOccluded } from '../sidecars/pet/lib/foreground.mjs';
import { pickLine } from '../sidecars/pet/lib/lines.mjs';

test('Cherry Studio 客户端使用专属识别，不把官网、教程或宿主会话误判为客户端', () => {
  for (const processName of ['Cherry Studio.exe', 'CherryStudio.exe', 'cherry-studio', 'cherry_studio.exe']) {
    assert.equal(detectRivalApp({ processName, title: 'Antigravity 与 Codex 讨论' }), 'cherry');
    assert.equal(isHostProcess(processName, 'Antigravity 安装说明'), false);
  }
  assert.equal(detectRivalApp({ processName: 'electron.exe', title: 'Cherry Studio' }), 'cherry');
  assert.equal(detectRivalApp({ processName: 'electron', title: '聊天 - Cherry Studio' }), 'cherry');
  assert.equal(detectRivalApp({ processName: 'chrome.exe', title: 'Cherry Studio' }), null);
  assert.equal(detectRivalApp({ processName: 'msedge.exe', title: 'Cherry Studio 教程 - GitHub' }), null);
  assert.equal(detectRivalApp({ processName: 'Antigravity.exe', title: 'Cherry Studio project' }), null);
  assert.equal(detectRivalApp({ processName: 'Cherry Studio Setup.exe', title: 'Installing' }), null);
});

test('切到 Cherry 会派发独立事件，标题刷新不重复触发，切回宿主能被识别', () => {
  const changes = [];
  const watcher = new ForegroundWatcher({ platform: 'linux', onChange: state => changes.push(state) });
  const snapshot = (processName, title) => JSON.stringify({ processName, title, agyRect: { left: 0, top: 0, right: 1920, bottom: 1040 } });
  watcher.processLine(snapshot('Codex.exe', 'Codex'));
  watcher.processLine(snapshot('Cherry Studio.exe', 'Cherry Studio'));
  watcher.processLine(snapshot('Cherry Studio.exe', 'Claude / AGY - Cherry Studio'));
  watcher.processLine(snapshot('Antigravity.exe', 'Workspace'));
  assert.deepEqual(changes.map(state => state.app), ['codex', 'cherry', null]);
  assert.equal(changes.at(-1).isHost, true);
  assert.equal(rivalAppTrigger('cherry'), 'app_rival_cherry');
  assert.equal(rivalAppTrigger('claude'), 'app_rival_claude');
  assert.equal(rivalAppTrigger('codex'), 'app_rival_codex');
  assert.equal(rivalAppTrigger('unknown'), null);
  assert.equal(rivalAppTrigger('toString'), null);
});

test('识别进程名为 ChatGPT.exe 的 Codex 应用包，不误判普通 ChatGPT', () => {
  const processPath = 'C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1111.2228.0_x64__2p2nqsd0c76g0\\app\\ChatGPT.exe';
  assert.equal(detectRivalApp({ processName: 'ChatGPT.exe', title: 'ChatGPT', processPath }), 'codex');
  assert.equal(isHostProcess('ChatGPT.exe', 'Antigravity project', processPath), false);
  assert.equal(detectRivalApp({ processName: 'ChatGPT.exe', title: 'ChatGPT', processPath: processPath.replace('OpenAI.Codex_', 'OpenAI.ChatGPT_') }), null);
});

test('独立客户端名称优先于聊天标题里的 Antigravity 字样', () => {
  assert.equal(detectRivalApp({ processName: 'Claude.exe', title: 'Antigravity 安装说明' }), 'claude');
  assert.equal(detectRivalApp({ processName: 'Codex.exe', title: 'Antigravity project' }), 'codex');
  assert.equal(isHostProcess('Claude.exe', 'Antigravity 安装说明'), false);
});

test('Windows 前台探针实际产生状态并能正常停止', { skip: process.platform !== 'win32', timeout: 12000 }, async t => {
  let watcher;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('foreground probe timeout')), 10000);
    watcher = new ForegroundWatcher({
      onChange: state => { clearTimeout(timeout); assert.equal(typeof state.occluded, 'boolean'); resolve(); },
      onError: error => { clearTimeout(timeout); reject(error); },
    });
    t.after(() => { clearTimeout(timeout); watcher.stop(); });
    assert.equal(watcher.start(), true);
  });
});

test('准确识别 Claude 与 Codex 客户端，并排除 Antigravity 自身及普通网页', () => {
  assert.equal(detectRivalApp({ processName: 'Claude.exe', title: 'Claude' }), 'claude');
  assert.equal(detectRivalApp({ processName: 'Claude', title: 'Chat - Claude' }), 'claude');
  assert.equal(detectRivalApp({ processName: 'Codex.exe', title: 'OpenAI Codex' }), 'codex');
  assert.equal(detectRivalApp({ processName: 'codex', title: 'Codex' }), 'codex');

  assert.equal(detectRivalApp({ processName: 'WindowsTerminal.exe', title: '✳ Claude Code' }), 'claude');
  assert.equal(detectRivalApp({ processName: 'powershell.exe', title: 'codex — ~/repo' }), 'codex');
  assert.equal(detectRivalApp({ processName: 'WindowsTerminal.exe', title: 'Windows PowerShell' }), null);

  assert.equal(detectRivalApp({ processName: 'chrome.exe', title: 'Claude' }), 'claude');
  assert.equal(detectRivalApp({ processName: 'msedge.exe', title: '代码调试 - Claude' }), 'claude');
  assert.equal(detectRivalApp({ processName: 'msedge.exe', title: 'OpenAI Codex' }), 'codex');

  // 防止刷视频或浏览仓库时误触发
  assert.equal(detectRivalApp({ processName: 'chrome.exe', title: 'Antigravity 整合 Claude 教程 - 哔哩哔哩' }), null);
  assert.equal(detectRivalApp({ processName: 'chrome.exe', title: 'github.com/openai/codex' }), null);

  // 绝不误判 Antigravity 宿主自身或本套件窗口
  assert.equal(detectRivalApp({ processName: 'Antigravity.exe', title: 'claude-app - Antigravity' }), null);
  assert.equal(detectRivalApp({ processName: 'Antigravity', title: 'codex-helper - Antigravity' }), null);
  assert.equal(detectRivalApp({ processName: 'electron.exe', title: 'Gemini · 星语汉化与织梦皮肤' }), null);

  assert.equal(isHostProcess('Antigravity.exe', 'workspace'), true);
  assert.equal(isHostProcess('Claude.exe', 'Claude'), false);
});

test('根据前台与宿主窗口矩形准确判定是否遮挡桌宠（防止分屏重影）', () => {
  const rightHalfAgy = { left: 960, top: 0, right: 1920, bottom: 1040 };
  const leftHalfClaude = { left: 0, top: 0, right: 960, bottom: 1040 };
  const fullScreenClaude = { left: 0, top: 0, right: 1920, bottom: 1080 };

  // 左右分屏：Antigravity 右下角可见，不遮挡
  assert.equal(isPetOccluded({ fgRect: leftHalfClaude, agyRect: rightHalfAgy, agyMinimized: false }), false);
  // 全屏覆盖：遮挡右下角
  assert.equal(isPetOccluded({ fgRect: fullScreenClaude, agyRect: rightHalfAgy, agyMinimized: false }), true);
  // 宿主最小化或不可见：判定为被遮挡
  assert.equal(isPetOccluded({ fgRect: leftHalfClaude, agyRect: null, agyMinimized: true }), true);
  // 用户将桌宠放在 Antigravity 左上角而左侧窗口稍微覆盖：跟随 position 比例点判定
  assert.equal(
    isPetOccluded(
      { fgRect: { left: 0, top: 0, right: 1200, bottom: 1040 }, agyRect: rightHalfAgy, agyMinimized: false },
      { x: 0.1, y: 0.1 },
    ),
    true,
  );
  assert.equal(
    isPetOccluded(
      { fgRect: { left: 0, top: 0, right: 1200, bottom: 1040 }, agyRect: rightHalfAgy, agyMinimized: false },
      { x: 0.9, y: 0.9 },
    ),
    false,
  );
});

test('ForegroundWatcher 状态去重、切换触发与 PowerShell 探针脚本结构', () => {
  const changes = [];
  const watcher = new ForegroundWatcher({
    platform: 'linux',
    onChange: next => changes.push(next),
  });

  watcher.processLine(JSON.stringify({
    pid: 101,
    processName: 'Claude.exe',
    title: 'Claude',
    fgRect: { left: 0, top: 0, right: 900, bottom: 1000 },
    agyRect: { left: 900, top: 0, right: 1920, bottom: 1000 },
    agyMinimized: false,
  }));
  // 同一状态下标题微小刷新且仍未遮挡时，不重复派发 onChange
  watcher.processLine(JSON.stringify({
    pid: 101,
    processName: 'Claude.exe',
    title: 'Claude - New Tab',
    fgRect: { left: 0, top: 0, right: 900, bottom: 1000 },
    agyRect: { left: 900, top: 0, right: 1920, bottom: 1000 },
    agyMinimized: false,
  }));
  // 拖大窗口挡住桌宠 -> occluded 变化 -> 派发
  watcher.processLine(JSON.stringify({
    pid: 101,
    processName: 'Claude.exe',
    title: 'Claude',
    fgRect: { left: 0, top: 0, right: 1920, bottom: 1080 },
    agyRect: { left: 900, top: 0, right: 1920, bottom: 1000 },
    agyMinimized: false,
  }));
  // 切回 Antigravity
  watcher.processLine(JSON.stringify({
    pid: 202,
    processName: 'Antigravity.exe',
    title: 'workspace - Antigravity',
    fgRect: { left: 900, top: 0, right: 1920, bottom: 1000 },
    agyRect: { left: 900, top: 0, right: 1920, bottom: 1000 },
    agyMinimized: false,
  }));

  assert.equal(changes.length, 3);
  assert.deepEqual(
    changes.map(c => ({ app: c.app, isHost: c.isHost, occluded: c.occluded })),
    [
      { app: 'claude', isHost: false, occluded: false },
      { app: 'claude', isHost: false, occluded: true },
      { app: null, isHost: true, occluded: false },
    ],
  );

  const script = buildWindowsProbeScript(12345, 600);
  assert.match(script, /Add-Type -TypeDefinition @'/);
  assert.match(script, /ConvertTo-Json -Compress/);
  assert.match(script, /GetForegroundWindow/);
});

test('前台竞争客户端激活时持续保持 puffed 吃醋表情，且切回台词完整', () => {
  const ok = { mood: 'ok' };
  assert.equal(chooseState({ running: 0, subagents: 0, idleMs: 0, rivalApp: 'claude' }, ok), 'puffed');
  assert.equal(chooseState({ running: 1, subagents: 0, idleMs: 0, rivalApp: 'codex' }, { mood: 'empty' }), 'puffed');
  assert.equal(chooseState({ running: 0, subagents: 0, idleMs: 0, rivalApp: 'cherry' }, ok), 'puffed');
  assert.equal(chooseState({ running: 0, subagents: 0, idleMs: 0, rivalApp: null }, ok), 'idle');

  assert.equal(modelFamily('GPT-5.4-Codex'), 'gpt');
  assert.ok(REACTIONS.app_rival_claude);
  assert.ok(REACTIONS.app_rival_codex);
  assert.ok(REACTIONS.app_rival_cherry);
  assert.ok(REACTIONS.app_rival_back);

  for (const trigger of ['app_rival_claude', 'app_rival_codex', 'app_rival_cherry', 'app_rival_back']) {
    assert.ok(pickLine('zhs', trigger)?.text, `zhs line ${trigger}`);
    assert.ok(pickLine('en', trigger)?.text, `en line ${trigger}`);
  }
});
