// Privacy-preserving extension analytics. This file runs only in the service
// worker and sends a strict, non-content event schema to the Listenr relay.
(function () {
  'use strict';

  const ENDPOINT = 'https://listenr-extension-analytics.vercel.app/api/collect';
  const CLIENT_ID_KEY = 'analyticsClientId';
  const STATUS_KEY = 'analyticsStatus';
  const SESSION_ID = Math.floor(Date.now() / 1000);
  const REQUEST_TIMEOUT_MS = 10000;

  function platform() {
    const ua = navigator.userAgent || '';
    if (/CrOS/i.test(ua)) return 'chromeos';
    if (/Mac/i.test(ua)) return 'mac';
    if (/Windows/i.test(ua)) return 'windows';
    if (/Linux/i.test(ua)) return 'linux';
    return 'other';
  }

  async function clientId() {
    const stored = await chrome.storage.local.get([CLIENT_ID_KEY]);
    if (/^[1-9]\d{0,19}\.[1-9]\d{0,19}$/.test(stored[CLIENT_ID_KEY] || '')) return stored[CLIENT_ID_KEY];
    const random = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    const id = `${random}.${Math.floor(Date.now() / 1000)}`;
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: id });
    return id;
  }

  async function saveStatus(patch) {
    try {
      const stored = await chrome.storage.local.get([STATUS_KEY]);
      const current = stored[STATUS_KEY] || {};
      await chrome.storage.local.set({
        [STATUS_KEY]: Object.assign({}, current, patch)
      });
    } catch {
      // Diagnostics must not interfere with playback.
    }
  }

  async function request(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  function rateBucket(rate) {
    const value = Number(rate) || 2;
    if (value < 1.25) return '1x';
    if (value < 1.75) return '1.5x';
    if (value < 2.25) return '2x';
    if (value < 2.75) return '2.5x';
    if (value < 3.5) return '3x';
    return '4x';
  }

  function documentSizeBucket(words) {
    const value = Math.max(0, Number(words) || 0);
    if (value < 500) return 'small';
    if (value < 2000) return 'medium';
    if (value < 7500) return 'large';
    return 'very_large';
  }

  function progressBucket(current, total) {
    const ratio = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
    if (ratio < 0.25) return '0-25';
    if (ratio < 0.5) return '25-50';
    if (ratio < 0.75) return '50-75';
    return '75-100';
  }

  async function track(eventName, eventParams) {
    const attemptedAt = Date.now();
    await saveStatus({ lastAttemptAt: attemptedAt, lastEvent: eventName });
    try {
      const params = Object.assign({
        session_id: SESSION_ID,
        app_version: chrome.runtime.getManifest().version,
        platform: platform()
      }, eventParams || {});
      const response = await request(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: await clientId(),
          event_name: eventName,
          params
        })
      });
      if (!response.ok) throw new Error(`relay_http_${response.status}`);
      await saveStatus({
        lastSuccessAt: Date.now(),
        lastHttpStatus: response.status,
        lastError: null
      });
      return true;
    } catch (error) {
      await saveStatus({
        lastHttpStatus: null,
        lastError: error && error.name === 'AbortError' ? 'timeout' : String(error && error.message || 'network_error')
      });
      return false;
    }
  }

  async function status() {
    const stored = await chrome.storage.local.get([STATUS_KEY]);
    return stored[STATUS_KEY] || {};
  }

  async function checkConnection() {
    const attemptedAt = Date.now();
    await saveStatus({ healthAttemptAt: attemptedAt });
    try {
      const response = await request(ENDPOINT, { method: 'GET', cache: 'no-store' });
      const body = response.ok ? await response.json() : null;
      if (!response.ok || !body || body.ok !== true || body.ga_configured !== true) {
        throw new Error(`relay_health_${response.status}`);
      }
      await saveStatus({
        healthSuccessAt: Date.now(),
        healthHttpStatus: response.status,
        healthError: null
      });
    } catch (error) {
      await saveStatus({
        healthHttpStatus: null,
        healthError: error && error.name === 'AbortError' ? 'timeout' : String(error && error.message || 'network_error')
      });
    }
    return status();
  }

  self.listenrAnalytics = Object.freeze({
    track, status, checkConnection, rateBucket, documentSizeBucket, progressBucket
  });
})();
