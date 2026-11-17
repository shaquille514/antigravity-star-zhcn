const fs = require('node:fs');
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

function activeHostContext(configOverride) {
  if (configOverride) return { kind: 'local', configDir: configOverride };
  if (process.platform === 'win32') {
    const stateFile = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Antigravity', 'wsl_state.json');
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    if (state?.distro) {
      const distro = state.distro;
      let home = homes.get(distro);
      if (!home) {
        home = execFileSync('wsl.exe', ['-d', distro, '--exec', 'printenv', 'HOME'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }).trim();
        homes.set(distro, home);
      }
      return wslContext(distro, home);
    }
  }
  return { kind: 'local', configDir: path.join(os.homedir(), '.gemini', 'config') };
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

module.exports = { activeHostContext, wslContext, toWslPath, hagemiInstallCommand };
