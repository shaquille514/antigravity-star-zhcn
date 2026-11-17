const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const runtime = fs.readFileSync(path.join(__dirname, '../core/i18n-runtime.js'), 'utf8');
const dictionary = require('../dict/zh-CN.json');

function settle(window) {
  return new Promise(resolve => window.setTimeout(resolve, 40));
}

test('i18n runtime skips Dream Skin wallpaper/style layers while translating host controls', async t => {
  const dom = new JSDOM(`<!doctype html>
    <html class="agy-dream-active-v2">
      <head><style id="agy-dream-style-v2" data-agy-dream-layer="style">body { color: inherit; }</style></head>
      <body>
        <div id="agy-dream-wallpaper-v2" data-agy-dream-layer="wallpaper" title="Settings">Settings</div>
        <div data-agy-dream-layer="custom"><span>New Window</span></div>
        <div id="root"><button title="Settings">Settings</button></div>
      </body>
    </html>`, { runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());

  const { window } = dom;
  window.__AGY_I18N_DATA__ = dictionary;
  window.eval(runtime);
  await settle(window);

  const wallpaper = window.document.getElementById('agy-dream-wallpaper-v2');
  const customLayer = window.document.querySelector('[data-agy-dream-layer="custom"] span');
  const hostBtn = window.document.querySelector('#root button');

  assert.equal(wallpaper.textContent, 'Settings');
  assert.equal(wallpaper.getAttribute('title'), 'Settings');
  assert.equal(customLayer.textContent, 'New Window');
  assert.equal(hostBtn.textContent, '设置');
  assert.equal(hostBtn.getAttribute('title'), '设置');
});
