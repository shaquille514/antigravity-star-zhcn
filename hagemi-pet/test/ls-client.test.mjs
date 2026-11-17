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
