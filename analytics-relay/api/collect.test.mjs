import assert from 'node:assert/strict';
import { sanitizeEvent } from './collect.js';

const clientId = '123e4567-e89b-42d3-a456-426614174000';

const clean = sanitizeEvent({
  client_id: clientId,
  event_name: 'playback_started',
  params: {
    session_id: 1788250000,
    app_version: '0.6.1',
    platform: 'mac',
    interaction_source: 'popup',
    rate_bucket: '2x',
    document_size_bucket: 'medium',
    page_url: 'https://private.example/document',
    page_title: 'Private document',
    document_text: 'Never forward this'
  }
});

assert.equal(clean.client_id, clientId);
assert.equal(clean.events[0].name, 'playback_started');
assert.deepEqual(clean.events[0].params, {
  engagement_time_msec: 1,
  session_id: 1788250000,
  app_version: '0.6.1',
  platform: 'mac',
  interaction_source: 'popup',
  rate_bucket: '2x',
  document_size_bucket: 'medium'
});

assert.equal(sanitizeEvent({ client_id: clientId, event_name: 'unknown', params: {} }), null);
assert.equal(sanitizeEvent({ client_id: 'not-a-uuid', event_name: 'extension_opened', params: {} }), null);

console.log('analytics relay validation passed');
