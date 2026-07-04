// Listenr popup — thin UI over the service worker.
const $ = (id) => document.getElementById(id);

function send(msg) { return chrome.runtime.sendMessage(msg); }

function setPlayIcon(p) {
  $('icoPlay').style.display = p ? 'none' : 'block';
  $('icoPause').style.display = p ? 'block' : 'none';
}

function updateRateLabel(rate) {
  $('rateLabel').textContent = rate.toFixed(2).replace(/0$/, '').replace(/\.$/, '') + '×';
}

function showError(kind) {
  $('main').style.display = 'none';
  const err = $('err'); err.style.display = 'flex';
  if (kind === 'protected') {
    err.style.background = '#fdeef0'; err.style.border = '1.5px solid #f6d2d8';
    $('eicon').style.background = '#fbdce1'; $('eicon').style.color = '#d8453c';
    $('etitle').style.color = '#b23a36';
    $('etitle').textContent = "Listenr can't read this page";
    $('emsg').textContent = "Browser system pages (chrome://, extensions, web store) are protected and can't be accessed.";
  } else {
    err.style.background = '#fff7ed'; err.style.border = '1.5px solid #fbe2c4';
    $('eicon').style.background = '#fcecd2'; $('eicon').style.color = '#d98b1f';
    $('etitle').style.color = '#a96612';
    $('etitle').textContent = 'No readable text found';
    $('emsg').textContent = "This page doesn't have article-style content for Listenr to read.";
  }
}

function render(s) {
  if (!s) return;
  lastState = s;
  if (s.error) { showError(s.error); return; }
  $('err').style.display = 'none';
  if (!settingsOpen) $('main').style.display = 'flex';

  updateRateLabel(s.rate);
  setPlayIcon(s.playing);
  $('autoScroll').checked = s.autoScroll !== false;
  $('samBanner').style.display = s.noSamantha ? 'flex' : 'none';

  // Time-based progress: elapsed / remaining, scaled by current rate.
  const totalWords = s.wordsTotal || 0;
  const leftWords = s.status === 'finished' ? 0 : (s.wordsLeft != null ? s.wordsLeft : totalWords);
  const secPerWord = 0.3 / (s.rate || 1); // ~200 wpm baseline
  timeBase = {
    totalSec: totalWords * secPerWord,
    elapsedSec: (totalWords - leftWords) * secPerWord,
    playing: !!s.playing,
    ts: Date.now()
  };
  tick();
}

// ---- live time display ----
let timeBase = null;
function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
}
function tick() {
  if (!timeBase) return;
  const b = timeBase;
  if (!b.totalSec) { $('prog').style.display = 'none'; return; }
  $('prog').style.display = 'flex';
  let el = b.elapsedSec + (b.playing ? (Date.now() - b.ts) / 1000 : 0);
  el = Math.min(el, b.totalSec);
  const pct = Math.min(100, (el / b.totalSec) * 100);
  $('tElapsed').textContent = fmt(el);
  $('tRemain').textContent = '−' + fmt(b.totalSec - el);
  $('progFill').style.width = pct + '%';
  $('progTip').textContent = fmt(el) + ' elapsed';
  $('progTip').style.left = Math.max(12, Math.min(88, pct)) + '%';
}
setInterval(tick, 500);

// Live updates from the service worker.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.from === 'sw' && msg.type === 'state') render(msg.state);
});

let lastState = null;
let settingsOpen = false;

// ---- settings view ----
function fillVoices(s) {
  const sel = $('voiceSel');
  const cur = s.preferredVoiceURI || '';
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = ''; def.textContent = 'Samantha (recommended)';
  sel.appendChild(def);
  const voices = (s.voices || []).slice().sort((a, b) => {
    const ae = /^en/i.test(a.lang) ? 0 : 1, be = /^en/i.test(b.lang) ? 0 : 1;
    return ae - be || a.name.localeCompare(b.name);
  });
  for (const v of voices) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    sel.appendChild(o);
  }
  sel.value = cur;
  if (sel.value !== cur) sel.value = '';
}

function openSettings() {
  settingsOpen = true;
  $('main').style.display = 'none';
  $('err').style.display = 'none';
  $('settings').style.display = 'flex';
  const s = lastState || {};
  fillVoices(s);
  const sk = s.skip || {};
  $('skipUrls').checked = sk.skipUrls !== false;
  $('skipCurly').checked = sk.skipCurly !== false;
  $('skipRefs').checked = sk.skipRefs !== false;
  $('skipEmails').checked = sk.skipEmails !== false;
  $('skipPaths').checked = sk.skipPaths !== false;
  $('skipHeadings').checked = !!sk.skipHeadings;
  $('rememberPos').checked = s.rememberPos !== false;
  const r = String(s.rate || 2);
  $('defRate').value = ['1','1.25','1.5','1.75','2','2.5','3'].includes(r) ? r : '2';
  renderDiag(s.lastShortcut);
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = setInterval(() => {
    send({ cmd: 'getState' }).then((r2) => {
      if (r2 && r2.state) { lastState = r2.state; renderDiag(r2.state.lastShortcut); }
    });
  }, 1000);
}

// ---- shortcut diagnostics ----
let diagTimer = null;
const MAC_UA = /Mac/i.test(navigator.userAgent);
const DIAG_NAMES = {
  toggle: 'Play / Pause', 'toggle-play': 'Play / Pause',
  rateUp: 'Speed up', 'rate-up': 'Speed up',
  rateDown: 'Speed down', 'rate-down': 'Speed down',
  nextSentence: 'Next sentence', 'next-sentence': 'Next sentence',
  prevSentence: 'Previous sentence', 'prev-sentence': 'Previous sentence',
  next: 'Next block', 'next-block': 'Next block',
  prev: 'Previous block', 'prev-block': 'Previous block'
};
function renderDiag(ls) {
  const d = $('diag');
  if (!d) return;
  if (!ls) {
    d.innerHTML = 'No shortcut received yet.<br>Press <b>' + (MAC_UA ? '\u2325 \u2191' : 'Alt + \u2191') + '</b> on the page to test.';
    return;
  }
  const ago = Math.max(0, Math.round((Date.now() - ls.t) / 1000));
  const via = ls.via === 'chrome' ? 'Chrome command' : 'page listener';
  d.innerHTML = 'Last: <b style="color:var(--text);">' + (DIAG_NAMES[ls.cmd] || ls.cmd) + '</b><br>via ' + via + ' \u00b7 ' + (ago < 2 ? 'just now' : ago + 's ago');
}

function closeSettings() {
  settingsOpen = false;
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
  $('settings').style.display = 'none';
  send({ cmd: 'getState' }).then((r) => r && r.state && render(r.state));
  armAutoHide();
}
$('gearBtn').addEventListener('click', () => settingsOpen ? closeSettings() : openSettings());
$('backBtn').addEventListener('click', closeSettings);

$('voiceSel').addEventListener('change', (e) => send({ cmd: 'setVoice', voiceURI: e.target.value }));
$('defRate').addEventListener('change', (e) => send({ cmd: 'setRate', rate: Number(e.target.value) }));
for (const id of ['skipUrls','skipCurly','skipRefs','skipEmails','skipPaths','skipHeadings']) {
  $(id).addEventListener('change', (e) => send({ cmd: 'setSkip', skip: { [id]: e.target.checked } }));
}
$('rememberPos').addEventListener('change', (e) => send({ cmd: 'setRememberPos', value: e.target.checked }));

// ---- auto-close popup after 5s of inactivity (playback keeps running) ----
let autoHideOn = true;
let hideTimer = null;
function armAutoHide() {
  if (hideTimer) clearTimeout(hideTimer);
  if (!autoHideOn || settingsOpen) return;
  hideTimer = setTimeout(() => window.close(), 5000);
}
for (const ev of ['pointerdown', 'pointermove', 'keydown', 'change', 'input']) {
  document.addEventListener(ev, armAutoHide, true);
}
chrome.storage.local.get(['autoHide']).then((st) => {
  autoHideOn = st.autoHide !== false;
  $('autoHide').checked = autoHideOn;
  armAutoHide();
});
$('autoHide').addEventListener('change', (e) => {
  autoHideOn = e.target.checked;
  chrome.storage.local.set({ autoHide: autoHideOn });
  armAutoHide();
});

// ---- controls ----
$('toggle').addEventListener('click', () => send({ cmd: 'toggle' }));
$('prevSent').addEventListener('click', () => send({ cmd: 'prevSentence' }));
$('nextSent').addEventListener('click', () => send({ cmd: 'nextSentence' }));

$('speedUp').addEventListener('click', () => {
  send({ cmd: 'getState' }).then((r) => {
    if (r && r.state) send({ cmd: 'setRate', rate: Math.min(4, r.state.rate + 0.1) });
  });
});
$('speedDown').addEventListener('click', () => {
  send({ cmd: 'getState' }).then((r) => {
    if (r && r.state) send({ cmd: 'setRate', rate: Math.max(1, r.state.rate - 0.1) });
  });
});
// Auto-scroll toggle
$('autoScroll').addEventListener('change', (e) => {
  send({ cmd: 'setAutoScroll', value: e.target.checked });
});

// Samantha voice download helper
$('samBtn').addEventListener('click', () => send({ cmd: 'openVoiceSettings' }));

// ---- pin the on-page mini player (default: on) ----
let pinOn = true;
function setPinUI(on) {
  pinOn = !!on;
  const b = $('pinBtn');
  b.style.background = pinOn ? 'rgba(255,255,255,.4)' : 'rgba(255,255,255,.16)';
  b.title = pinOn ? 'Unpin mini player' : 'Pin mini player on the page';
}
chrome.storage.local.get(['pinPlayer']).then((st) => setPinUI(st.pinPlayer !== false));
$('pinBtn').addEventListener('click', () => {
  setPinUI(!pinOn);
  send({ cmd: 'setPinPlayer', value: pinOn });
});

// ---- dark mode (persisted) ----
function applyDark(on) {
  document.body.classList.toggle('dark', !!on);
  $('icoMoon').style.display = on ? 'none' : 'block';
  $('icoSun').style.display = on ? 'block' : 'none';
}
chrome.storage.local.get(['darkMode']).then((st) => applyDark(st.darkMode));
$('darkToggle').addEventListener('click', () => {
  const on = !document.body.classList.contains('dark');
  applyDark(on);
  chrome.storage.local.set({ darkMode: on });
});

// ---- keyboard shortcut hints (hover tooltips) + shortcuts inside the popup ----
const MAC = /Mac/i.test(navigator.userAgent);
$('toggle').dataset.kbd = MAC ? '⌥ /' : 'Alt + /';
$('speedUp').dataset.kbd = MAC ? '⌥ ↑' : 'Alt + ↑';
$('speedDown').dataset.kbd = MAC ? '⌥ ↓' : 'Alt + ↓';
$('nextSent').dataset.kbd = MAC ? '⌥ →' : 'Alt + →';
$('prevSent').dataset.kbd = MAC ? '⌥ ←' : 'Alt + ←';

document.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  let cmd = null;
  if (e.altKey && (e.key === '/' || e.code === 'Slash')) cmd = 'toggle';
  else if (e.altKey && (e.key === 'ArrowUp' || e.code === 'ArrowUp')) cmd = 'rateUp';
  else if (e.altKey && (e.key === 'ArrowDown' || e.code === 'ArrowDown')) cmd = 'rateDown';
  else if (e.altKey && e.key === 'ArrowRight') cmd = 'nextSentence';
  else if (e.altKey && e.key === 'ArrowLeft') cmd = 'prevSentence';
  if (!cmd) return;
  e.preventDefault();
  send({ cmd });
});

// Boot
send({ cmd: 'init' }).then((r) => { if (r && r.state) render(r.state); });
setTimeout(() => send({ cmd: 'getState' }).then((r) => r && r.state && render(r.state)), 500);
