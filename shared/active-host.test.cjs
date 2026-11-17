const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wslContext, toWslPath, hagemiInstallCommand } = require('./active-host.cjs');

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
