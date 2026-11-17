// Antigravity Sidecar 入口（CDP 注入模式）：当检测到桌面独立悬浮版已启动时自动礼让，避免双宠重影。
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RendererBridge } from './lib/cdp.mjs';
import { isDesktopPetRunning, resolvePetDirs, startPetRuntime } from './lib/runtime.mjs';

const log = message => console.log(`[hagemi] ${message}`);
const { dataDir } = resolvePetDirs();

if (isDesktopPetRunning(dataDir)) {
  log('desktop floating Hagemi is already running; sidecar yielding to avoid duplicate pet');
  const wait = setInterval(() => {
    if (!isDesktopPetRunning(dataDir)) {
      clearInterval(wait);
      bootSidecar();
    }
  }, 5000);
} else {
  bootSidecar();
}

function bootSidecar() {
  const keepAlive = setInterval(() => {}, 1 << 30);
  let runtime = null;

  async function shutdown() {
    clearInterval(keepAlive);
    const force = setTimeout(() => process.exit(0), 2000);
    force.unref?.();
    if (runtime) await runtime.shutdown();
    process.exit(0);
  }

  runtime = startPetRuntime({
    isDesktop: false,
    log,
    createBridge: ({ onMessage }) => new RendererBridge({ onMessage, log }),
    onQuit: shutdown,
  });

  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);

  // 卸载时主动退出，防止 Windows 占用插件目录
  const manifest = join(dirname(fileURLToPath(import.meta.url)), 'sidecar.json');
  const orphanCheck = setInterval(() => {
    if (existsSync(manifest) && !isDesktopPetRunning(dataDir)) return;
    log(existsSync(manifest) ? 'desktop floating pet started, yielding' : 'plugin files removed, leaving');
    shutdown();
  }, 5000);
  orphanCheck.unref?.();
}
