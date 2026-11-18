import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LanguageServer } from '../sidecars/pet/lib/ls-client.mjs';

test('concurrent metadata reads share discovery and a failed endpoint is rediscovered', async () => {
  let discoveries = 0;
  const ls = new LanguageServer({
    env: {},
    discoverFn: async () => { discoveries++; await new Promise(resolve => setTimeout(resolve, 5)); return { host: '127.0.0.1', port: discoveries, csrf: 'test-only' }; },
    transport: async (_host, port, _csrf, method) => {
      if (method === 'Fail') throw Object.assign(new Error('stale'), { code: 'ECONNREFUSED' });
      return { port };
    },
  });
  await Promise.all([ls.call('GetStatus'), ls.call('GetModelConfigs')]);
  assert.equal(discoveries, 1);
  await assert.rejects(ls.call('Fail'));
  assert.equal((await ls.call('GetStatus')).port, 2);
});

test('discoverFn 连续失败时在冷却窗口内跳过重复探测，冷却结束后递增退避并在成功后清零', async () => {
  let currentTime = 10_000;
  let discoveries = 0;
  let shouldFailDiscovery = true;
  let shouldFailTransport = false;

  const ls = new LanguageServer({
    env: {},
    now: () => currentTime,
    discoverBackoffMs: [5000, 10000, 20000],
    discoverFn: async () => {
      discoveries++;
      if (shouldFailDiscovery) throw new Error(`Antigravity is not running (#${discoveries})`);
      return { host: '127.0.0.1', port: 5000 + discoveries, csrf: 'test-only' };
    },
    transport: async (_host, port) => {
      if (shouldFailTransport) throw Object.assign(new Error('reset'), { code: 'ECONNREFUSED' });
      return { port };
    },
  });

  // 第 1 次失败：记录 failures = 1，进入 5000ms 冷却期（retryAt = 15000）
  await assert.rejects(ls.call('GetStatus'), /#1/);
  assert.equal(discoveries, 1);
  assert.equal(ls.discoverFailures, 1);
  assert.equal(ls.discoverRetryAt, 15_000);

  // 冷却窗口内多次调用（含并发）不应再次触发 discoverFn
  currentTime = 12_000;
  await assert.rejects(ls.call('GetStatus'), /#1/);
  currentTime = 14_999;
  const inCooldown = await Promise.allSettled([ls.call('GetStatus'), ls.call('GetModelConfigs')]);
  assert.equal(inCooldown.every(r => r.status === 'rejected'), true);
  assert.equal(discoveries, 1);

  // 跨过第 1 个冷却窗口（t = 15000）后允许第 2 次探测；再次失败应步进到 10000ms 冷却（retryAt = 25000）
  currentTime = 15_000;
  await assert.rejects(ls.call('GetStatus'), /#2/);
  assert.equal(discoveries, 2);
  assert.equal(ls.discoverFailures, 2);
  assert.equal(ls.discoverRetryAt, 25_000);

  // 第 2 次冷却窗口内仍跳过探测
  currentTime = 24_999;
  await assert.rejects(ls.call('GetStatus'), /#2/);
  assert.equal(discoveries, 2);

  // 跨过第 2 个冷却窗口后探测成功，应立即清零退避计数与冷却状态
  currentTime = 25_000;
  shouldFailDiscovery = false;
  assert.deepEqual(await ls.call('GetStatus'), { port: 5003 });
  assert.equal(discoveries, 3);
  assert.equal(ls.discoverFailures, 0);
  assert.equal(ls.discoverRetryAt, 0);
  assert.equal(ls.lastDiscoverError, null);

  // 清零后若端点断开且新探测再次失败，退避应从首档 5000ms 重新开始
  shouldFailTransport = true;
  await assert.rejects(ls.call('GetStatus'), { code: 'ECONNREFUSED' });
  shouldFailDiscovery = true;
  currentTime = 26_000;
  await assert.rejects(ls.call('GetStatus'), /#4/);
  assert.equal(discoveries, 4);
  assert.equal(ls.discoverFailures, 1);
  assert.equal(ls.discoverRetryAt, 31_000);
});

test('并发探测同时失败时仅触发一次 discoverFn 并只累计一次失败计数', async () => {
  let currentTime = 1000;
  let discoveries = 0;

  const ls = new LanguageServer({
    env: {},
    now: () => currentTime,
    discoverBackoffMs: [5000, 10000],
    discoverFn: async () => {
      discoveries++;
      await new Promise(resolve => setTimeout(resolve, 10));
      throw new Error('offline');
    },
    transport: async () => ({}),
  });

  const results = await Promise.allSettled([ls.call('GetStatus'), ls.call('GetModelConfigs')]);
  assert.equal(results.every(r => r.status === 'rejected'), true);
  assert.equal(discoveries, 1);
  assert.equal(ls.discoverFailures, 1);
  assert.equal(ls.discoverRetryAt, 6000);
});

test('请求超时（ETIMEDOUT）会清除缓存的 endpoint，下次调用重新探测新端点', async () => {
  let discoveries = 0;
  const ls = new LanguageServer({
    env: {},
    discoverFn: async () => {
      discoveries++;
      return { host: '127.0.0.1', port: 6000 + discoveries, csrf: 'test-only' };
    },
    transport: async (_host, port, _csrf, method) => {
      if (method === 'SlowCall') {
        throw Object.assign(new Error(`${method} timed out`), { code: 'ETIMEDOUT' });
      }
      return { port };
    },
  });

  assert.deepEqual(await ls.call('GetStatus'), { port: 6001 });
  assert.ok(ls.endpoint);

  await assert.rejects(ls.call('SlowCall'), err => err.code === 'ETIMEDOUT');
  assert.equal(ls.endpoint, null);

  assert.deepEqual(await ls.call('GetStatus'), { port: 6002 });
  assert.equal(discoveries, 2);

  // 宿主通过环境变量注入端点时，ETIMEDOUT 不应清理或触发重新探测
  let hostDiscoveries = 0;
  const hostLs = new LanguageServer({
    env: { ANTIGRAVITY_LS_ADDRESS: '127.0.0.1:7777', ANTIGRAVITY_CSRF_TOKEN: 'host-token' },
    discoverFn: async () => {
      hostDiscoveries++;
      return { host: '127.0.0.1', port: 8888, csrf: 'other' };
    },
    transport: async () => {
      throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    },
  });

  await assert.rejects(hostLs.call('SlowCall'), err => err.code === 'ETIMEDOUT');
  assert.deepEqual(hostLs.endpoint, { host: '127.0.0.1', port: 7777, csrf: 'host-token' });
  assert.equal(hostDiscoveries, 0);
});
