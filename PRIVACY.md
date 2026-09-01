# Privacy Policy — Listenr

_Last updated: September 1, 2026_

Listenr is a Chrome extension that reads the text of the web page you are viewing aloud using your device's built-in text-to-speech engine.

## Privacy-preserving analytics

Listenr automatically sends limited, pseudonymous usage analytics to a Listenr-operated relay and Google Analytics. This helps measure installations, active users, reliability, and feature engagement.

The analytics data is limited to:

- A randomly generated extension installation identifier
- Extension installation, update, open, playback start, pause, completion, and error events
- Coarse reading-size, playback-progress, and playback-speed buckets
- Extension version and broad operating-system category

Listenr does **not** send page URLs, page titles, browsing history, document or page text, highlighted text, search terms, voice names, or locally saved playback positions. The analytics relay accepts only a fixed set of event names and predefined values; arbitrary text is rejected.

Analytics is processed through the Listenr relay hosted on Vercel and the separate **Listenr Chrome Extension** Google Analytics property. It is used only to improve product reliability and understand aggregate usage. Listenr does not sell this information or use it for advertising.

## What Listenr stores locally

Listenr saves the following on your own device using Chrome's local storage:

- Your settings (voice, playback speed, toggles)
- Your last playback position for pages you've listened to
- The randomly generated analytics installation identifier

Settings and playback positions never leave your device. Local data is deleted when you uninstall the extension.

## How Listenr accesses pages

When you start playback, Listenr reads the visible text of the current page in order to speak it aloud and highlight the sentence being spoken. This happens entirely on your device. Page content is never recorded or transmitted anywhere.

## Speech synthesis

Text-to-speech is performed by your operating system's built-in speech engine (e.g. Samantha on macOS). No text is sent to any third-party speech service by Listenr.

## Contact

Questions or concerns: open an issue at
https://github.com/mayankmalviya64/listenr-extension/issues
