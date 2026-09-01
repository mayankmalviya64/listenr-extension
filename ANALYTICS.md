# Listenr analytics verification

Listenr v0.6.1 sends pseudonymous events through the Listenr Vercel relay to the Google Analytics 4 property configured by `GA_MEASUREMENT_ID`. Analytics begins only after a user receives v0.6.1 or later; Chrome Web Store user counts are not historical GA4 active-user counts.

## Fast verification

1. Confirm Chrome is running Listenr v0.6.1 or later at `chrome://extensions`.
2. Open a normal article page, then open Listenr.
3. Open **Settings → Analytics diagnostics**.
4. Select **Check analytics connection**. The relay should show **Connected**.
5. Return to the article and start playback. Reopen settings; **Latest event** should show **Accepted**.
6. In GA4, open **Reports → Realtime** and inspect **Event count by Event name**.

Expected event names:

- `extension_installed`
- `extension_updated`
- `extension_opened`
- `playback_started`
- `playback_paused`
- `playback_completed`
- `playback_error`

The in-extension diagnostic proves the relay accepted the request. GA4 Realtime proves the event reached the configured property. Use **Reports → Engagement → Events** for processed historical reporting; it is not the right place for an immediate installation test.

## Relay health

Open:

`https://listenr-extension-analytics.vercel.app/api/collect`

A healthy, configured response is:

```json
{"ok":true,"service":"listenr-extension-analytics","ga_configured":true}
```

In Vercel request logs, extension events appear as `POST /api/collect` with HTTP 204. A 204 proves relay acceptance, while GA4 Realtime is the authoritative check that the configured GA property received the event.

## Interpreting zero

- Store version below v0.6.1: analytics is not installed, so zero is expected.
- Relay not connected: check the production deployment and its two GA environment variables.
- Relay connected but latest event failed: inspect the status shown in Listenr and the Vercel response code.
- Relay accepted but GA4 Realtime is empty: verify that `GA_MEASUREMENT_ID` belongs to the data stream inside the GA4 property being viewed.
- Realtime has events but a standard report is empty: wait for normal GA4 report processing and confirm the report date range and filters.

Never compare the Chrome Web Store's current user estimate directly with GA4 active users. They measure different things over different time windows.
