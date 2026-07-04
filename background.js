// Listenr service worker — coordinates popup, content script (highlighting),
// and the offscreen document (speech). Holds playback state.

let S = {
  tabId: null,
  url: '',
  blocks: [],
  current: 0,
  playing: false,
  rate: 2,
  voiceURI: '', // Samantha by default (macOS)
  preferredVoiceURI: '', // user-chosen default voice ('' = Samantha/auto)
  voices: [],
  startChar: 0,
  charIndex: 0,     // last spoken char within current block (absolute)
  autoScroll: true,
  rememberPos: true,
  skip: { skipUrls: true, skipCurly: true, skipRefs: true, skipEmails: true, skipPaths: true, skipHeadings: false },
  noSamantha: false, // true when on macOS and Samantha voice is not installed
  error: null,
  status: 'idle',
  lastShortcut: null // { cmd, via: 'chrome'|'page', t } — for the popup's diagnostics panel
};

const IS_MAC = /Mac/i.test(navigator.userAgent);

function pickVoice() {
  // 1. user's preferred voice, if installed
  if (S.preferredVoiceURI) {
    const v = S.voices.find(x => x.voiceURI === S.preferredVoiceURI);
    if (v) { S.voiceURI = v.voiceURI; S.noSamantha = false; return; }
  }
  // 2. Samantha (macOS default)
  const samantha = S.voices.find(v => v.name && v.name.includes('Samantha'));
  if (samantha) { S.voiceURI = samantha.voiceURI; S.noSamantha = false; return; }
  if (IS_MAC && S.voices.length) S.noSamantha = true;
  // 3. fallback: first local English voice, then any English voice
  const en = S.voices.find(v => v.localService && /^en/i.test(v.lang)) ||
             S.voices.find(v => /^en/i.test(v.lang));
  if (en) S.voiceURI = en.voiceURI;
}

// ---------- offscreen lifecycle ----------
let creating = null;
async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;
  } catch (e) {}
  if (creating) { await creating; return; }
  try {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Text-to-speech playback for reading pages aloud.'
    });
    await creating;
  } catch (e) {
    // Already exists (race) — fine.
  } finally {
    creating = null;
  }
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, msg));
}

// ---------- content script messaging ----------
function toContent(msg) {
  if (S.tabId == null) return;
  chrome.tabs.sendMessage(S.tabId, msg).catch(() => {});
}

// ---------- state broadcast ----------
function broadcast() {
  chrome.runtime.sendMessage({ from: 'sw', type: 'state', state: publicState() }).catch(() => {});
  toContent({ cmd: 'playerState', playing: S.playing, rate: S.rate });
}
function publicState() {
  return {
    total: S.blocks.length, current: S.current, playing: S.playing,
    rate: S.rate, voiceURI: S.voiceURI, preferredVoiceURI: S.preferredVoiceURI, voices: S.voices,
    autoScroll: S.autoScroll, rememberPos: S.rememberPos, skip: S.skip,
    noSamantha: S.noSamantha, wordsLeft: wordsLeft(), wordsTotal: wordsTotal(),
    error: S.error, status: S.status, lastShortcut: S.lastShortcut
  };
}

// ---------- reading time estimate ----------
function countWords(t) { return t ? (t.match(/\S+/g) || []).length : 0; }
function wordsLeft() {
  if (!S.blocks.length) return 0;
  let n = 0;
  for (let i = S.current; i < S.blocks.length; i++) {
    if (i === S.current) n += countWords(S.blocks[i].slice(S.charIndex || 0));
    else n += countWords(S.blocks[i]);
  }
  return n;
}
function wordsTotal() {
  let n = 0;
  for (const b of S.blocks) n += countWords(b);
  return n;
}

// ---------- remember position per page ----------
async function savePosition() {
  if (!S.rememberPos || !S.url || !S.blocks.length) return;
  try {
    const { positions = {} } = await chrome.storage.local.get(['positions']);
    positions[S.url] = { current: S.current, t: Date.now() };
    // cap: keep the 50 most recent pages
    const keys = Object.keys(positions);
    if (keys.length > 50) {
      keys.sort((a, b) => (positions[a].t || 0) - (positions[b].t || 0));
      for (const k of keys.slice(0, keys.length - 50)) delete positions[k];
    }
    chrome.storage.local.set({ positions });
  } catch (e) {}
}
async function restorePosition() {
  if (!S.rememberPos || !S.url) return;
  try {
    const { positions = {} } = await chrome.storage.local.get(['positions']);
    const p = positions[S.url];
    if (p && p.current > 0 && p.current < S.blocks.length) S.current = p.current;
  } catch (e) {}
}

// ---------- core playback ----------
function isProtected(url) {
  return !url || /^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/.test(url);
}

async function loadTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return false;
  S.tabId = tab.id;
  S.url = (tab.url || '').split('#')[0];
  if (isProtected(tab.url)) { S.error = 'protected'; return false; }
  S.error = null;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'extract', opts: S.skip });
    S.blocks = (res && res.blocks) || [];
  } catch (e) {
    // content script not present (e.g. injected before load) — try inject
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      const res = await chrome.tabs.sendMessage(tab.id, { cmd: 'extract', opts: S.skip });
      S.blocks = (res && res.blocks) || [];
    } catch (e2) { S.error = 'protected'; return false; }
  }
  if (!S.blocks.length) { S.error = 'notext'; return false; }
  await restorePosition();
  return true;
}

async function speakCurrent() {
  if (S.current < 0) S.current = 0;
  if (S.current >= S.blocks.length) {
    S.playing = false; S.status = 'finished';
    toContent({ cmd: 'clear' });
    // page finished — forget the saved position
    if (S.url) {
      chrome.storage.local.get(['positions']).then(({ positions = {} }) => {
        if (positions[S.url]) { delete positions[S.url]; chrome.storage.local.set({ positions }); }
      }).catch(() => {});
    }
    broadcast();
    return;
  }
  S.playing = true; S.status = 'playing';
  S.charIndex = S.startChar || 0;
  savePosition();
  toContent({ cmd: 'hlBlock', index: S.current, autoScroll: S.autoScroll });
  const text = S.blocks[S.current].slice(S.startChar || 0);
  await toOffscreen({ cmd: 'speak', text, voiceURI: S.voiceURI, rate: S.rate });
  broadcast();
}

// Load saved settings even when playback starts from a keyboard shortcut
// (i.e. the popup's init never ran in this service-worker lifetime).
let settingsLoaded = false;
async function ensureSettings() {
  if (settingsLoaded) return;
  settingsLoaded = true;
  const st = await chrome.storage.local.get(['rate', 'autoScroll', 'rememberPos', 'preferredVoiceURI', 'skip']);
  if (st.preferredVoiceURI) S.preferredVoiceURI = st.preferredVoiceURI;
  if (st.skip) S.skip = Object.assign({}, S.skip, st.skip);
  if (typeof st.rememberPos === 'boolean') S.rememberPos = st.rememberPos;
  S.rate = st.rate ? Number(st.rate) : 2;
  if (typeof st.autoScroll === 'boolean') S.autoScroll = st.autoScroll;
  await ensureOffscreen();
  toOffscreen({ cmd: 'getVoices' });
  pickVoice();
}

async function play() {
  await ensureSettings();
  if (!S.blocks.length || S.error) {
    const ok = await loadTab();
    if (!ok) { broadcast(); return; }
  }
  await speakCurrent();
}

async function pause() {
  S.playing = false; S.status = 'paused';
  savePosition();
  await toOffscreen({ cmd: 'stop' });
  broadcast();
}

async function toggle() {
  if (S.playing) { await pause(); hud('⏸ Paused'); return; }
  await play();
  hud(S.error ? 'Listenr: no readable text here' : '▶︎ Reading');
}

async function next() {
  if (!S.blocks.length) { await loadTab(); }
  S.current = Math.min(S.blocks.length - 1, S.current + 1);
  S.startChar = 0;
  if (S.playing) await speakCurrent();
  else { toContent({ cmd: 'hlBlock', index: S.current, autoScroll: S.autoScroll }); broadcast(); }
}

async function prev() {
  if (!S.blocks.length) { await loadTab(); }
  S.current = Math.max(0, S.current - 1);
  S.startChar = 0;
  if (S.playing) await speakCurrent();
  else { toContent({ cmd: 'hlBlock', index: S.current, autoScroll: S.autoScroll }); broadcast(); }
}

// ---------- sentence skip ----------
function sentenceStarts(text) {
  const starts = [0];
  const re = /[.!?…]["'”’)\]]*\s+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index + m[0].length < text.length) starts.push(m.index + m[0].length);
  }
  return starts;
}

// HUD toast removed — the pinned mini player gives feedback. Kept as a no-op
// so existing call sites stay harmless.
async function hud() {}

async function nextSentence() {
  if (!S.blocks.length) return play();
  const text = S.blocks[S.current] || '';
  const starts = sentenceStarts(text);
  const pos = S.charIndex || S.startChar || 0;
  const target = starts.find(s => s > pos);
  if (target !== undefined) {
    S.startChar = target;
    if (S.playing) await speakCurrent();
    else { S.charIndex = target; broadcast(); }
  } else {
    await next();
  }
}

async function prevSentence() {
  if (!S.blocks.length) return play();
  const text = S.blocks[S.current] || '';
  const starts = sentenceStarts(text);
  const pos = S.charIndex || S.startChar || 0;
  // start of the sentence we're currently in
  let curStart = 0;
  for (const s of starts) { if (s <= pos) curStart = s; else break; }
  // if we're just past the start, go one sentence further back
  let target = curStart;
  if (pos - curStart < 12) {
    const before = starts.filter(s => s < curStart);
    if (before.length) target = before[before.length - 1];
    else if (S.current > 0) {
      // jump to last sentence of previous block
      S.current -= 1;
      const pt = S.blocks[S.current] || '';
      const ps = sentenceStarts(pt);
      S.startChar = ps[ps.length - 1] || 0;
      if (S.playing) await speakCurrent();
      else { S.charIndex = S.startChar; toContent({ cmd: 'hlBlock', index: S.current, autoScroll: S.autoScroll }); broadcast(); }
      return;
    }
  }
  S.startChar = target;
  if (S.playing) await speakCurrent();
  else { S.charIndex = target; broadcast(); }
}

// Continue from the next word to be spoken (used when rate/voice changes
// mid-playback so it doesn't restart from the top of the block).
function resumeFromNextWord() {
  const text = S.blocks[S.current] || '';
  let c = Math.min(S.charIndex || S.startChar || 0, text.length);
  while (c < text.length && /\S/.test(text[c])) c++;   // finish current word
  while (c < text.length && !/\S/.test(text[c])) c++;  // skip whitespace
  if (c < text.length) S.startChar = c;
  else S.startChar = Math.min(S.charIndex || 0, Math.max(0, text.length - 1));
}

function clampRate(r) { return Math.min(4, Math.max(1, Math.round(r * 10) / 10)); }
async function changeRate(delta) {
  await ensureSettings();
  S.rate = clampRate(S.rate + delta);
  chrome.storage.local.set({ rate: S.rate });
  hud(S.rate.toFixed(1) + '×');
  if (S.playing) { resumeFromNextWord(); await speakCurrent(); } else broadcast();
}

async function jumpTo(index, startChar) {
  if (!S.blocks.length || S.status === 'idle') return; // only after a session has started
  S.current = Math.max(0, Math.min(S.blocks.length - 1, index));
  S.startChar = Math.max(0, startChar || 0);
  await speakCurrent();
}

// ---------- message routing ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // From offscreen (speech events)
  if (msg.from === 'offscreen') {
    if (msg.type === 'voices') {
      if (msg.voices && msg.voices.length) {
        S.voices = msg.voices;
        pickVoice();
        broadcast();
      }
    } else if (msg.type === 'boundary') {
      S.charIndex = msg.charIndex + (S.startChar || 0);
      toContent({ cmd: 'hlWord', index: S.current, charIndex: S.charIndex });
    } else if (msg.type === 'end') {
      if (S.playing) { S.current++; S.startChar = 0; speakCurrent(); }
    } else if (msg.type === 'error') {
      S.playing = false; S.status = 'paused'; broadcast();
    }
    return;
  }

  // Shortcut diagnostics: record shortcuts relayed by the content script's
  // in-page key listener.
  if (msg.viaKey && ['toggle','rateUp','rateDown','nextSentence','prevSentence','next','prev'].includes(msg.cmd)) {
    S.lastShortcut = { cmd: msg.cmd, via: 'page', t: Date.now() };
  }

  // From popup
  switch (msg.cmd) {
    case 'init':
      (async () => {
        await ensureSettings();
        toOffscreen({ cmd: 'getVoices' });
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const sameTab = tab && tab.id === S.tabId;
        if (!(S.playing && sameTab)) {
          S.current = 0; S.status = 'idle';
          await loadTab();
        }
        sendResponse({ state: publicState() });
        broadcast();
      })();
      return true;
    case 'getState': sendResponse({ state: publicState() }); return true;
    case 'toggle': toggle(); break;
    case 'play': play(); break;
    case 'pause': pause(); break;
    case 'next': next(); break;
    case 'prev': prev(); break;
    case 'nextSentence': (async () => { await ensureSettings(); await nextSentence(); hud('Next sentence →'); })(); break;
    case 'prevSentence': (async () => { await ensureSettings(); await prevSentence(); hud('← Previous sentence'); })(); break;
    case 'rateUp': changeRate(0.1); break;
    case 'rateDown': changeRate(-0.1); break;
    case 'setAutoScroll':
      S.autoScroll = !!msg.value;
      chrome.storage.local.set({ autoScroll: S.autoScroll });
      broadcast();
      break;
    case 'setRememberPos':
      S.rememberPos = !!msg.value;
      chrome.storage.local.set({ rememberPos: S.rememberPos });
      if (S.rememberPos) savePosition();
      broadcast();
      break;
    case 'setVoice':
      S.preferredVoiceURI = msg.voiceURI || '';
      chrome.storage.local.set({ preferredVoiceURI: S.preferredVoiceURI });
      pickVoice();
      (async () => { if (S.playing) { resumeFromNextWord(); await speakCurrent(); } else broadcast(); })();
      break;
    case 'setSkip':
      // msg.skip: partial {skipUrls, skipCurly, skipRefs, skipEmails, skipPaths, skipHeadings}
      S.skip = Object.assign({}, S.skip, msg.skip || {});
      chrome.storage.local.set({ skip: S.skip });
      // re-extract with the new rules; keep position roughly by block index
      (async () => {
        const wasPlaying = S.playing;
        if (wasPlaying) await toOffscreen({ cmd: 'stop' });
        const keep = S.current;
        S.blocks = []; S.startChar = 0; S.charIndex = 0;
        const ok = await loadTab();
        if (ok) S.current = Math.min(keep, S.blocks.length - 1);
        if (wasPlaying && ok) await speakCurrent();
        else broadcast();
      })();
      break;
    case 'openVoiceSettings':
      // Deep-link into macOS System Settings → Accessibility → Spoken Content,
      // where Samantha can be downloaded via System Voice → Manage Voices.
      (async () => {
        const urls = [
          'x-apple.systempreferences:com.apple.Accessibility-Settings.extension?SpokenContent',
          'x-apple.systempreferences:com.apple.preference.universalaccess?TextToSpeech'
        ];
        for (const url of urls) {
          try { await chrome.tabs.create({ url }); return; } catch (e) {}
        }
        sendResponse && sendResponse({ ok: false });
      })();
      break;
    case 'jumpTo': 
      jumpTo(msg.index, msg.startChar);
      sendResponse({ ok: true });
      break;
    case 'setRate':
      (async () => {
        await ensureSettings();
        S.rate = clampRate(Number(msg.rate));
        chrome.storage.local.set({ rate: S.rate });
        if (S.playing) { resumeFromNextWord(); await speakCurrent(); }
        broadcast();
      })();
      break;
    case 'setPinPlayer':
      chrome.storage.local.set({ pinPlayer: !!msg.value });
      chrome.tabs.query({}).then((tabs) => {
        for (const t of tabs) chrome.tabs.sendMessage(t.id, { cmd: 'pinPlayer', value: !!msg.value }).catch(() => {});
      });
      break;
  }
});

// ---------- keyboard shortcuts ----------
async function runCommand(command) {
  S.lastShortcut = { cmd: command, via: 'chrome', t: Date.now() };
  await ensureSettings();
  if (command === 'toggle-play') await toggle();
  else if (command === 'next-sentence') { await nextSentence(); hud('Next sentence →'); }
  else if (command === 'prev-sentence') { await prevSentence(); hud('← Previous sentence'); }
  else if (command === 'next-block') await next();
  else if (command === 'prev-block') await prev();
  else if (command === 'rate-up') await changeRate(0.1);
  else if (command === 'rate-down') await changeRate(-0.1);
}
chrome.commands.onCommand.addListener((command) => { runCommand(command); });

// Stop & clear highlight when the user navigates or switches tabs.
chrome.tabs.onActivated.addListener(() => {
  if (S.playing) pause();
  toContent({ cmd: 'clear' });
  S.blocks = []; S.current = 0; S.charIndex = 0; S.error = null;
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === S.tabId && info.status === 'loading') {
    S.blocks = []; S.current = 0; S.charIndex = 0; S.error = null;
    if (S.playing) pause();
  }
});
