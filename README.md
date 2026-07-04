# Listenr 🎧

**Read any page aloud** — a Chrome extension that turns any article into audio with synced sentence highlighting, a floating mini player, and keyboard shortcuts.

## Features

- **Read aloud** any web page using your system's text-to-speech voices (Samantha on macOS)
- **Synced highlighting** — the sentence being spoken is highlighted on the page as it plays
- **Floating mini player** (bottom right) — play/pause, previous/next sentence, and speed controls without opening the popup
- **Keyboard shortcuts** that work on any page
- **Speed control** from 1× to 3× (default 2×)
- **Remembers your position** per page, so you can pick up where you left off
- **Shortcut diagnostics** panel in settings to debug key handling

## Keyboard shortcuts

| Action | Mac | Windows / Linux |
|---|---|---|
| Play / Pause | ⌥ / | Alt + / |
| Speed up | ⌥ ↑ | Alt + ↑ |
| Speed down | ⌥ ↓ | Alt + ↓ |
| Next sentence | ⌥ → | Alt + → |
| Previous sentence | ⌥ ← | Alt + ← |

Shortcuts are handled by an in-page listener, so they work on any page where the extension is active — no Chrome-level binding required.

## Install (unpacked)

1. Download or clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select this folder
5. Pin Listenr to your toolbar, open any article, and hit ⌥ / (Alt + /)

## Structure

```
manifest.json     Extension manifest (MV3)
background.js     Service worker — coordinates popup, content script, and speech
content.js        Extraction, synced highlighting, mini player, shortcuts
offscreen.html/js Offscreen document that hosts speech synthesis
popup.html/js     Toolbar popup UI + settings
icons/            Extension icons
```

## Notes

- On macOS, Listenr prefers the **Samantha** voice; install it via System Settings → Accessibility → Spoken Content → System Voice if missing.
- Playback position and settings are stored locally via `chrome.storage` — nothing leaves your machine.

## Version

**v0.6.0**

## License

Copyright (C) 2026 Mayank Malviya

Licensed under the [GNU General Public License v3.0](LICENSE).
