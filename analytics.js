// Privacy-preserving extension analytics. This file runs only in the service
// worker and sends a strict, non-content event schema to the Listenr relay.
(function () {
  'use strict';

  const ENDPOINT = 'https://listenr-extension-analytics.vercel.app/api/collect';
  const CLIENT_ID_KEY = 'analyticsClientId';
  const SESSION_ID = Math.floor(Date.now() / 1000);

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
    if (/^[0-9a-f-]{36}$/i.test(stored[CLIENT_ID_KEY] || '')) return stored[CLIENT_ID_KEY];
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: id });
    return id;
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
    try {
      const params = Object.assign({
        session_id: SESSION_ID,
        app_version: chrome.runtime.getManifest().version,
        platform: platform()
      }, eventParams || {});
      await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: await clientId(),
          event_name: eventName,
          params
        })
      });
    } catch {
      // Analytics must never interfere with reading or playback.
    }
  }

  self.listenrAnalytics = Object.freeze({ track, rateBucket, documentSizeBucket, progressBucket });
})();
