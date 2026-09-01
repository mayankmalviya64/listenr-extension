const EVENT_RULES = Object.freeze({
  extension_installed: {
    install_reason: ['install']
  },
  extension_updated: {
    install_reason: ['update', 'chrome_update', 'shared_module_update']
  },
  extension_opened: {},
  playback_started: {
    rate_bucket: ['1x', '1.5x', '2x', '2.5x', '3x', '4x'],
    document_size_bucket: ['small', 'medium', 'large', 'very_large']
  },
  playback_paused: {
    progress_bucket: ['0-25', '25-50', '50-75', '75-100']
  },
  playback_completed: {},
  playback_error: {
    error_type: ['protected_page', 'no_readable_text', 'speech_error', 'unknown']
  }
});

const COMMON_RULES = Object.freeze({
  platform: ['mac', 'windows', 'linux', 'chromeos', 'other'],
  interaction_source: ['popup', 'shortcut', 'page_control', 'background']
});

function json(res, status, body) {
  res.status(status).json(body);
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

function isClientId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isVersion(value) {
  return typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value);
}

function sanitizeEvent(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!isClientId(body.client_id)) return null;
  if (!Object.prototype.hasOwnProperty.call(EVENT_RULES, body.event_name)) return null;

  const supplied = body.params && typeof body.params === 'object' && !Array.isArray(body.params) ? body.params : {};
  const eventRules = EVENT_RULES[body.event_name];
  const params = {
    engagement_time_msec: 1
  };

  if (Number.isSafeInteger(supplied.session_id) && supplied.session_id > 0) {
    params.session_id = supplied.session_id;
  }
  if (isVersion(supplied.app_version)) params.app_version = supplied.app_version;

  for (const [key, allowed] of Object.entries(COMMON_RULES)) {
    if (allowed.includes(supplied[key])) params[key] = supplied[key];
  }
  for (const [key, allowed] of Object.entries(eventRules)) {
    if (allowed.includes(supplied[key])) params[key] = supplied[key];
  }

  return {
    client_id: body.client_id,
    events: [{ name: body.event_name, params }]
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return json(res, 200, { ok: true, service: 'listenr-extension-analytics' });
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  const length = Number(req.headers['content-length'] || 0);
  if (length > 4096) return json(res, 413, { ok: false, error: 'payload_too_large' });

  const payload = sanitizeEvent(req.body);
  if (!payload) return json(res, 400, { ok: false, error: 'invalid_event' });

  const measurementId = process.env.GA_MEASUREMENT_ID;
  const apiSecret = process.env.GA_API_SECRET;
  if (!measurementId || !apiSecret) return json(res, 503, { ok: false, error: 'analytics_not_configured' });

  const endpoint = new URL('https://www.google-analytics.com/mp/collect');
  endpoint.searchParams.set('measurement_id', measurementId);
  endpoint.searchParams.set('api_secret', apiSecret);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) return json(res, 502, { ok: false, error: 'analytics_upstream_failed' });
    return res.status(204).end();
  } catch {
    return json(res, 502, { ok: false, error: 'analytics_unavailable' });
  }
}

export { sanitizeEvent };
