const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  activeHostContext,
  safeActiveHostContext,
  readHagemiHostStatus,
  resolveHagemiInvocation,
  wslContext,
  toWslPath,
  hagemiInstallCommand
} = require('./active-host.cjs');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'active-host-test-'));

test('Ubuntu plugins and installer use the selected Linux home through the Windows bridge', () => {
  const context = wslContext('Ubuntu', '/home/developer');
  assert.equal(context.configDir, '\\\\wsl.localhost\\Ubuntu\\home\\developer\\.gemini\\config');
  const invocation = hagemiInstallCommand('D:\\Tools\\suite', context, 'install', 'D:\\Node.js\\node.exe');
  assert.equal(invocation.command, 'wsl.exe');
  assert.deepEqual(invocation.args.slice(0, 4), ['-d', 'Ubuntu', '--exec', 'python3']);
  assert.equal(invocation.args[4], '/mnt/d/Tools/suite/hagemi-pet/sidecars/pet/windows-bridge.py');
  assert.equal(invocation.args[5], '--install');
});

test('paths keep spaces and Chinese characters and reject unrelated UNC shares', () => {
  assert.equal(toWslPath('D:\\工具 目录\\suite', 'Ubuntu'), '/mnt/d/工具 目录/suite');
  assert.equal(toWslPath('\\\\wsl.localhost\\Ubuntu\\home\\developer\\suite', 'Ubuntu'), '/home/developer/suite');
  assert.throws(() => toWslPath('\\\\another-server\\share', 'Ubuntu'));
  assert.throws(() => wslContext('docker-desktop', '/root'));
  assert.throws(() => wslContext('Ubuntu', '/home/../root'));
});

test('activeHostContext preserves original throw contract on stale wsl_state.json or failing wsl.exe', () => {
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'wsl_state.json');

  // 场景 1：wsl.exe 执行失败 / 超时
  fs.writeFileSync(stateFile, JSON.stringify({ distro: 'Ubuntu-Removed' }));
  assert.throws(() => {
    activeHostContext(null, {
      platform: 'win32',
      stateFile,
      homedir: dir,
      homesCache: new Map(),
      execFileSync: () => {
        throw new Error('wsl.exe ETIMEDOUT');
      }
    });
  }, /wsl\.exe ETIMEDOUT/);

  // 场景 2：残余的禁止发行版（如 docker-desktop）
  fs.writeFileSync(stateFile, JSON.stringify({ distro: 'docker-desktop' }));
  assert.throws(() => {
    activeHostContext(null, {
      platform: 'win32',
      stateFile,
      homedir: dir,
      homesCache: new Map(),
      execFileSync: () => '/root\n'
    });
  }, /不是可安装桌宠的 WSL 发行版/);
});

test('safeActiveHostContext falls back to local configDir and logs warning when WSL probe fails', () => {
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'wsl_state.json');
  fs.writeFileSync(stateFile, '\uFEFF' + JSON.stringify({ distro: 'StaleUbuntu' }));

  const warnings = [];
  const context = safeActiveHostContext(null, (msg, err) => {
    warnings.push({ msg, err });
  }, {
    platform: 'win32',
    stateFile,
    homedir: dir,
    homesCache: new Map(),
    execFileSync: () => {
      throw new Error('WSL 发行版不存在');
    }
  });

  assert.equal(context.kind, 'local');
  assert.equal(context.configDir, path.join(dir, '.gemini', 'config'));
  assert.match(context.fallbackReason, /WSL 发行版不存在/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /WSL 宿主环境探测失败.*WSL 发行版不存在/);

  // 当显式提供 configOverride 时直接返回本地覆盖目录且不走回退
  const customDir = path.join(dir, 'custom-config');
  assert.deepEqual(safeActiveHostContext(customDir), { kind: 'local', configDir: customDir });
  assert.throws(() => {
    safeActiveHostContext(customDir, {
      resolveHostContext: () => {
        throw new Error('explicit override error');
      }
    });
  }, /explicit override error/);
});

test('readHagemiHostStatus inspects lock PID, plugin install/enable state, and survives WSL failure', () => {
  const dir = makeTempDir();
  const stateFile = path.join(dir, 'wsl_state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ distro: 'BrokenDistro' }));

  const geminiDir = path.join(dir, '.gemini');
  const configDir = path.join(geminiDir, 'config');
  const pluginDir = path.join(configDir, 'plugins', 'hagemi-pet-agy');
  const lockFile = path.join(geminiDir, 'antigravity', 'sidecar_data', 'hagemi-pet-agy', 'pet', 'data', 'desktop.lock.json');
  const installScript = path.join(dir, 'install-local.mjs');
  const desktopMain = path.join(dir, 'main.cjs');

  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ id: 'hagemi-pet-agy' }));
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    plugins: { 'hagemi-pet-agy': { enabled: true } },
    sidecars: { 'hagemi-pet-agy/pet': { enabled: false } }
  }));
  fs.writeFileSync(lockFile, '\uFEFF' + JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(installScript, '// installer');
  fs.writeFileSync(desktopMain, '// main');

  const warnings = [];
  const status = readHagemiHostStatus({
    installScriptPath: installScript,
    desktopMainPath: desktopMain,
    onWarning: msg => warnings.push(msg),
    hostContextOptions: {
      platform: 'win32',
      stateFile,
      homedir: dir,
      homesCache: new Map(),
      execFileSync: () => {
        throw new Error('wsl.exe exit 1');
      }
    }
  });

  assert.equal(status.configDir, configDir);
  assert.equal(status.available, true);
  assert.equal(status.desktopAvailable, true);
  assert.equal(status.desktopRunning, true);
  assert.equal(status.desktopPid, process.pid);
  assert.equal(status.installed, true);
  assert.equal(status.enabled, false);
  assert.match(status.fallbackReason, /wsl\.exe exit 1/);
  assert.equal(warnings.length, 1);

  // 无效或损坏的锁文件不会导致误判或异常
  fs.writeFileSync(lockFile, '{invalid-json');
  const afterBrokenLock = readHagemiHostStatus({
    configDir,
    lockFile
  });
  assert.equal(afterBrokenLock.desktopRunning, false);
  assert.equal(afterBrokenLock.desktopPid, null);
});

test('resolveHagemiInvocation returns friendly Chinese error when WSL probing fails', () => {
  const failed = resolveHagemiInvocation({
    rootDir: 'D:\\suite',
    action: 'install',
    resolveHostContext: () => {
      throw new Error('distro offline');
    }
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /^WSL 环境探测失败: distro offline$/);

  const succeeded = resolveHagemiInvocation({
    rootDir: 'D:\\suite',
    action: 'uninstall',
    configOverride: 'D:\\local\\.gemini\\config',
    nodeExe: 'D:\\Node\\node.exe'
  });
  assert.equal(succeeded.ok, true);
  assert.equal(succeeded.invocation.command, 'D:\\Node\\node.exe');
  assert.deepEqual(succeeded.invocation.args, [
    path.join('D:\\suite', 'hagemi-pet', 'tools', 'install-local.mjs'),
    '--uninstall'
  ]);
});
