// Real Electron regression for the status panel keeping app.asar locked on Windows.
// Uses a tiny temporary archive, never the installed Antigravity application.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');

async function runElectronCheck() {
  const { app } = require('electron');
  const fs = require('original-fs');
  const fixture = process.argv[process.argv.indexOf('--check-fixture') + 1];
  const asarPath = path.join(fixture, 'app.asar');
  app.setPath('userData', path.join(fixture, 'electron-profile'));
  await app.whenReady();
  try {
    const cli = require('../localization/cli.js');
    const { SuiteBridge } = require('../Antigravity-Dream-Skin/src/domain/suite-bridge.cjs');
    const bridge = new SuiteBridge({ rootDir: root, geminiConfigDir: path.join(fixture, 'config'), discover: async () => null });
    bridge._loadCli = () => ({ ...cli, getCandidateAsarPaths: () => [asarPath], isProcessRunning: () => false, getGlobalPluginTargetDir: () => path.join(fixture, 'plugin') });
    let status;
    for (let i = 0; i < 3; i++) status = await bridge.getStatus();
    const moved = path.join(fixture, 'app.asar.moved');
    // Keep this Electron process alive during the move, just as the real panel is.
    fs.renameSync(asarPath, moved);
    fs.renameSync(moved, asarPath);
    assert.equal(status.asarFound, true);
    assert.equal(status.patched, true);
    assert.equal(cli.isAsarPatched(asarPath), true);
    console.log(JSON.stringify({ statusAccurate: true, renameWhilePanelAlive: true, modelRequests: 0 }));
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
}

async function runFixture() {
  const fs = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-asar-unlocked-'));
  const input = path.join(fixture, 'source');
  try {
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'package.json'), JSON.stringify({ name: 'asar-lock-fixture', version: '1.0.0' }));
    fs.writeFileSync(path.join(input, 'main.js'), '// Antigravity Chinese Localization Injection\n');
    const asar = require(require.resolve('@electron/asar', { paths: [path.join(root, 'localization')] }));
    await asar.createPackage(input, path.join(fixture, 'app.asar'));
    const option = process.argv.indexOf('--electron-path');
    const executable = option >= 0 ? process.argv[option + 1] : require('electron');
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(executable, [__filename, '--check-fixture', fixture], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
    if (child.error) throw child.error;
    process.exitCode = child.status === 0 ? 0 : 1;
  } finally {
    const actual = fs.realpathSync.native(fixture);
    const temp = fs.realpathSync.native(os.tmpdir());
    if (path.dirname(actual) !== temp || !path.basename(actual).startsWith('agy-asar-unlocked-')) throw new Error('Unexpected fixture cleanup path');
    fs.rmSync(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

if (process.argv.includes('--check-fixture')) runElectronCheck().catch(error => { console.error(error); require('electron').app.exit(1); });
else runFixture().catch(error => { console.error(error); process.exitCode = 1; });
