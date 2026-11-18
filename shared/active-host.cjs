// 在 Electron 环境下使用 original-fs，避免 ASAR 虚拟文件系统干扰常规文件读取
const fs = require(process.versions?.electron ? 'original-fs' : 'node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const homes = new Map();

function toWslPath(value, distro) {
  const drive = value.match(/^([a-z]):[\\/](.*)$/i);
  if (drive) return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`;
  const prefix = `\\\\wsl.localhost\\${distro}\\`;
  if (value.toLowerCase().startsWith(prefix.toLowerCase())) return '/' + value.slice(prefix.length).replace(/\\/g, '/');
  throw new Error('无法转换 WSL 路径: ' + value);
}

function wslContext(distro, home) {
  if (!distro || /[\\/\r\n]/.test(distro) || ['.', '..', 'docker-desktop', 'docker-desktop-data'].includes(distro)) {
    throw new Error('不是可安装桌宠的 WSL 发行版');
  }
  if (!home.startsWith('/') || home.split('/').includes('..')) throw new Error('WSL 用户目录无效');
  return {
    kind: 'wsl', distro, home,
    configDir: `\\\\wsl.localhost\\${distro}${home.replace(/\//g, '\\')}\\.gemini\\config`
  };
}

/**
 * 解析当前生效宿主的配置目录上下文（Windows 下会尝试读取 wsl_state.json 并探测 WSL 家目录）。
 * 注意：若存在残余/失效的 wsl_state.json 或 wsl.exe 失败，此函数会按原有契约抛出异常。
 *
 * @param {string|null|undefined} configOverride 显式指定的本地配置目录覆盖路径
 * @param {object} [options] 可选运行依赖覆盖（主要用于测试注入）
 * @returns {{ kind: 'local'|'wsl', configDir: string, distro?: string, home?: string }} 宿主上下文对象
 */
function activeHostContext(configOverride, options = {}) {
  if (configOverride) return { kind: 'local', configDir: configOverride };
  const platform = options.platform ?? process.platform;
  const homeDir = options.homedir || os.homedir();
  if (platform === 'win32') {
    const stateFile = options.stateFile || path.join(
      process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'),
      'Antigravity',
      'wsl_state.json'
    );
    const state = readJsonQuiet(stateFile);
    if (state?.distro) {
      const distro = state.distro;
      const cache = options.homesCache || homes;
      let home = cache.get(distro);
      if (!home) {
        const execFn = options.execFileSync || execFileSync;
        home = execFn('wsl.exe', ['-d', distro, '--exec', 'printenv', 'HOME'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 5000
        }).trim();
      }
      const context = wslContext(distro, home);
      cache.set(distro, home);
      return context;
    }
  }
  return { kind: 'local', configDir: path.join(homeDir, '.gemini', 'config') };
}

/**
 * 容错安全包装：获取当前生效宿主的配置目录上下文。
 * 当且仅当未提供 configOverride 且探测 WSL 失败（如残余/失效的 wsl_state.json、wsl.exe 报错或超时）时，
 * 安全降级返回本机默认目录 `{ kind: 'local', configDir, fallbackReason }` 并触发可选警告回调。
 *
 * @param {string|null|undefined} configOverride 显式指定的本地配置目录覆盖路径（非空时不自动回退）
 * @param {((message: string, error: Error) => void)|object} [onWarningOrOptions] 警告回调函数或可选配置对象
 * @param {object} [extraOptions] 当第二个参数为回调时，用于传入额外测试注入选项
 * @returns {{ kind: 'local'|'wsl', configDir: string, distro?: string, home?: string, fallbackReason?: string }} 宿主上下文对象
 */
function safeActiveHostContext(configOverride, onWarningOrOptions, extraOptions) {
  const opts = typeof onWarningOrOptions === 'function'
    ? { ...(extraOptions || {}), onWarning: onWarningOrOptions }
    : (onWarningOrOptions || {});
  const onWarning = typeof opts.onWarning === 'function' ? opts.onWarning : null;
  const resolveHostContext = typeof opts.resolveHostContext === 'function'
    ? opts.resolveHostContext
    : (cfg => activeHostContext(cfg, opts));

  try {
    return resolveHostContext(configOverride);
  } catch (error) {
    // 显式指定配置目录时不静默忽略，仅在默认探测模式（configOverride 为空）下回退到本机目录
    if (configOverride) throw error;
    const fallbackReason = error?.message ? String(error.message) : String(error);
    if (onWarning) {
      try {
        onWarning(`WSL 宿主环境探测失败，已降级使用本机配置目录: ${fallbackReason}`, error);
      } catch {}
    }
    const homeDir = opts.homedir || os.homedir();
    return {
      kind: 'local',
      configDir: path.join(homeDir, '.gemini', 'config'),
      fallbackReason
    };
  }
}

/**
 * 静默读取并解析 UTF-8（含可选 BOM）JSON 文件，读取或解析失败时返回 null。
 *
 * @param {string} filePath JSON 文件路径
 * @returns {any|null} 解析后的对象，失败返回 null
 */
function readJsonQuiet(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 通过向目标进程发送 0 信号检测 PID 是否存活（EPERM 视为进程存在但无权限信号控制）。
 *
 * @param {number} pid 进程 ID
 * @returns {boolean} 进程是否存活
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/**
 * 统一查询哈基米桌面漂浮版运行状态及原生 Sidecar 插件安装/启用状态。
 * 宿主目录探测过程内置 WSL 异常安全降级，避免因残余 WSL 配置导致状态查询崩溃。
 *
 * @param {object} [options] 查询选项
 * @param {string|null} [options.configDir] 显式指定的配置目录覆盖路径
 * @param {string|null} [options.configOverride] configDir 的兼容别名
 * @param {string|null} [options.geminiDir] 显式指定的 .gemini 根目录
 * @param {string|null} [options.lockFile] 显式指定的桌面漂浮版锁文件路径
 * @param {string|null} [options.installScriptPath] 哈基米安装脚本路径，用于计算 available
 * @param {string|null} [options.desktopMainPath] 桌面漂浮版入口路径，用于计算 desktopAvailable
 * @param {(message: string, error: Error) => void} [options.onWarning] WSL 降级时的警告回调
 * @param {object} [options.hostContextOptions] 透传给 safeActiveHostContext 的可选宿主探测配置
 * @returns {object} 统一的哈基米宿主与插件状态对象
 */
function readHagemiHostStatus(options = {}) {
  const explicitConfigDir = options.configDir ?? options.configOverride ?? null;
  const hostContext = safeActiveHostContext(
    explicitConfigDir,
    options.onWarning,
    options.hostContextOptions
  );
  const configDir = hostContext.configDir;
  const geminiDir = options.geminiDir || path.dirname(configDir);
  const lockFile = options.lockFile || path.join(
    geminiDir,
    'antigravity',
    'sidecar_data',
    'hagemi-pet-agy',
    'pet',
    'data',
    'desktop.lock.json'
  );

  const lockData = readJsonQuiet(lockFile);
  const pid = Number(lockData?.pid);
  const desktopRunning = isPidAlive(pid);
  const desktopPid = desktopRunning ? pid : null;

  const pluginDir = path.join(configDir, 'plugins', 'hagemi-pet-agy');
  const installed = fs.existsSync(path.join(pluginDir, 'plugin.json'));
  let enabled = installed;
  if (installed) {
    const config = readJsonQuiet(path.join(configDir, 'config.json'));
    if (config) {
      const pluginEnabled = config?.plugins?.['hagemi-pet-agy']?.enabled;
      const sidecarEnabled = config?.sidecars?.['hagemi-pet-agy/pet']?.enabled;
      if (pluginEnabled === false || sidecarEnabled === false) {
        enabled = false;
      }
    }
  }

  return {
    hostContext,
    configDir,
    geminiDir,
    lockFile,
    pluginDir,
    available: options.installScriptPath ? fs.existsSync(options.installScriptPath) : false,
    desktopAvailable: options.desktopMainPath ? fs.existsSync(options.desktopMainPath) : false,
    desktopRunning,
    desktopPid,
    installed,
    enabled,
    fallbackReason: hostContext.fallbackReason || null
  };
}

function windowsNode() {
  if (!process.versions.electron) return process.execPath;
  const candidates = execFileSync('where.exe', ['node.exe'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }).trim().split(/\r?\n/);
  const selected = candidates.find(file => fs.existsSync(file) && path.basename(file).toLowerCase() === 'node.exe');
  if (!selected) throw new Error('请安装 Windows Node.js 22+');
  return selected;
}

function hagemiInstallCommand(rootDir, context, action, nodeExe = windowsNode()) {
  const installer = path.join(rootDir, 'hagemi-pet', 'tools', 'install-local.mjs');
  const extra = action === 'uninstall' ? ['--uninstall'] : [];
  if (context.kind === 'wsl') {
    const bridge = path.join(rootDir, 'hagemi-pet', 'sidecars', 'pet', 'windows-bridge.py');
    return { command: 'wsl.exe', args: ['-d', context.distro, '--exec', 'python3', toWslPath(bridge, context.distro), '--install', nodeExe, installer, ...extra] };
  }
  return { command: nodeExe, args: [installer, ...extra] };
}

/**
 * 安全解析宿主环境并构造哈基米插件安装/卸载命令。
 * 当探测 WSL 环境失败或构造执行命令出错时，返回 `{ ok: false, message }` 而不是抛出未捕获异常。
 *
 * @param {object} options
 * @param {string} options.rootDir 集成套件根目录
 * @param {'install'|'uninstall'} options.action 操作类型
 * @param {string|null} [options.configOverride] 可选配置目录覆盖路径
 * @param {(configOverride?: string|null) => object} [options.resolveHostContext] 宿主上下文解析函数
 * @param {string} [options.nodeExe] 可选 Node 可执行文件路径
 * @returns {{ ok: true, context: object, invocation: { command: string, args: string[] } } | { ok: false, message: string, error: Error }}
 */
function resolveHagemiInvocation({
  rootDir,
  action,
  configOverride = null,
  resolveHostContext = activeHostContext,
  nodeExe
}) {
  let context;
  try {
    context = resolveHostContext(configOverride);
  } catch (error) {
    const detail = error?.message ? String(error.message) : String(error);
    return { ok: false, message: `WSL 环境探测失败: ${detail}`, error };
  }
  try {
    const invocation = hagemiInstallCommand(rootDir, context, action, nodeExe);
    return { ok: true, context, invocation };
  } catch (error) {
    const detail = error?.message ? String(error.message) : String(error);
    return { ok: false, message: `准备哈基米安装命令失败: ${detail}`, error };
  }
}

module.exports = {
  activeHostContext,
  safeActiveHostContext,
  readHagemiHostStatus,
  resolveHagemiInvocation,
  wslContext,
  toWslPath,
  hagemiInstallCommand
};
