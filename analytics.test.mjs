import assert from 'node:assert/strict';

const storage = {};
const requests = [];

Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true });
Object.defineProperty(globalThis, 'navigator', {
  value: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X)' },
  configurable: true
});
Object.defineProperty(globalThis, 'chrome', {
  value: {
    runtime: { getManifest: () => ({ version: '0.6.2' }) },
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]]));
        },
        async set(values) {
          Object.assign(storage, values);
        }
      }
    }
  },
  configurable: true
});
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, options = {}) => {
    requests.push({ url, options });
    if ((options.method || 'GET') === 'GET') {
      return new Response(JSON.stringify({ ok: true, ga_configured: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response(null, { status: 204 });
  },
  configurable: true
});

await import('./analytics.js');

assert.equal(await self.listenrAnalytics.track('extension_opened', { interaction_source: 'popup' }), true);
const payload = JSON.parse(requests[0].options.body);
assert.match(payload.client_id, /^[1-9]\d{0,19}\.[1-9]\d{0,19}$/);
assert.equal(payload.event_name, 'extension_opened');
assert.equal(payload.params.app_version, '0.6.2');
assert.equal(payload.params.platform, 'mac');

let status = await self.listenrAnalytics.status();
assert.equal(status.lastHttpStatus, 204);
assert.equal(status.lastError, null);

status = await self.listenrAnalytics.checkConnection();
assert.equal(status.healthHttpStatus, 200);
assert.equal(status.healthError, null);

console.log('extension analytics validation passed');
