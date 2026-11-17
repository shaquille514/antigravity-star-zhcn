// 桌面漂浮模式渲染源、防双宠互斥锁及桌面控窗交互测试。
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rendererSource } from '../sidecars/pet/lib/renderer-source.mjs';
import { clearDesktopLock, isDesktopPetRunning, writeDesktopLock } from '../sidecars/pet/lib/runtime.mjs';

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
