// Listenr content script — extraction + synced highlighting.
// Runs on every page; idle until the service worker messages it.
(function () {
  // If a previous copy of this script is still alive (same extension context),
  // don't double-install. If its context was invalidated by an extension reload,
  // let this fresh copy take over.
  try {
    if (window.__listenrAlive && window.__listenrAlive()) return;
  } catch (e) {}
  window.__listenrAlive = function () {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  };

  function ctxAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','NAV','HEADER','FOOTER','ASIDE','FORM','BUTTON','SVG','CANVAS','SELECT','TEXTAREA','SUP']);
  // Containers whose text is navigational / non-prose — skip anything inside them.
  // ARIA landmark roles are included so app-like pages (e.g. Google AI Mode) that
  // use <div role="navigation|search|...">, not the semantic tags, are still skipped.
  const SKIP_CONTAINER = 'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"],.navbox,.infobox,.sidebar,.reflist,.references,.mw-editsection,.hatnote,.thumb,.toc,.mw-jump-link,.metadata,.navigation-not-searchable,figure';

  let els = [];          // DOM element per block
  let texts = [];        // normalized text per block (matches what TTS receives)
  let curBlock = -1;
  let savedHTML = null;  // original innerHTML of the block being word-split
  let wordSpans = [];    // {start, end, el} for current block

  // ---- highlight styles ----
  function injectStyle() {
    if (document.getElementById('__listenr_style')) return;
    const s = document.createElement('style');
    s.id = '__listenr_style';
    s.textContent = `
      .__lr-block{background:rgba(19,176,184,.14)!important;box-shadow:0 0 0 2px rgba(19,176,184,.30)!important;border-radius:4px!important;transition:background .15s;}
      .__lr-word{background:#ffd84d!important;color:#1a1a1a!important;border-radius:3px!important;box-shadow:0 0 0 2px #ffd84d!important;}
    `;
    document.documentElement.appendChild(s);
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  // Clean text before it reaches TTS. Which categories get skipped is
  // user-configurable (opts from the service worker's saved settings).
  function cleanForSpeech(t, opts) {
    opts = opts || {};
    let s = (t || '');
    if (opts.skipCurly !== false)  s = s.replace(/\{[^{}]*\}/g, ' ');                 // {curly bracket} content
    if (opts.skipRefs !== false)   s = s.replace(/\[\d+\]/g, ' ');                    // [1] reference marks
    if (opts.skipUrls !== false)   s = s.replace(/https?:\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
    if (opts.skipEmails !== false) s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, ' ');
    if (opts.skipPaths !== false)  s = s.replace(/\b[\w-]+(\/[\w.-]+){2,}\b/g, ' ');  // path/like/segments
    s = s.replace(/[|_~^\\]{2,}/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  // Deep scan: collect visible, text-bearing *leaf* block elements — including
  // generic <div>/<section>/<span> that app-like pages (e.g. Google AI Mode) use
  // to render prose instead of semantic <p>/<li>/<h*> tags. Returns element refs
  // so highlighting and click-to-read keep working. Used only as a fallback when
  // the semantic pass finds nothing, so pages that already work are unaffected.
  function extractDeep(root, opts) {
    const SEL = 'p,li,blockquote,figcaption,dd,dt,h1,h2,h3,h4,h5,h6,div,section,td,th,pre,span';
    const raw = [];
    root.querySelectorAll(SEL).forEach((el) => {
      if (SKIP.has(el.tagName)) return;
      if (opts.skipHeadings && /^H[1-6]$/.test(el.tagName)) return;
      if (el.closest(SKIP_CONTAINER)) return;
      if (!visible(el)) return;
      const t = cleanForSpeech(el.innerText, opts);
      if (t.length < 2) return;
      if (/^\[\d+\]$/.test(t)) return;
      raw.push({ el, t });
    });
    // Keep only leaf-most blocks: drop any element that is an ancestor of another
    // kept element, so we read the smallest text container, not its wrappers.
    const kept = raw.filter((a) => !raw.some((b) => b.el !== a.el && a.el.contains(b.el)));
    const seen = new Set();
    const outEls = [], outTexts = [];
    kept.forEach(({ el, t }) => {
      if (seen.has(t)) return;
      seen.add(t);
      outEls.push(el); outTexts.push(t);
    });
    return { els: outEls, texts: outTexts };
  }

  function extract(opts) {
    opts = opts || {};
    els = []; texts = [];
    const seen = new Set();
    const root =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.querySelector('#mw-content-text') ||
      document.body;
    const nodes = root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,dd,dt');
    nodes.forEach((el) => {
      if (SKIP.has(el.tagName)) return;
      if (opts.skipHeadings && /^H[1-6]$/.test(el.tagName)) return;
      if (el.closest(SKIP_CONTAINER)) return;
      // skip elements whose text is mostly inside a nested block we already take
      if (el.querySelector('p,li,h1,h2,h3,h4,h5,h6,blockquote')) return;
      if (!visible(el)) return;
      let t = cleanForSpeech(el.innerText, opts);
      if (t.length < 2) return;
      if (/^\[\d+\]$/.test(t)) return;
      if (seen.has(t)) return;
      seen.add(t);
      els.push(el);
      texts.push(t);
    });
    if (texts.length < 2) {
      // Semantic pass found nothing usable. Deep-scan for text-bearing leaf blocks,
      // first within the chosen root, then across the whole page if needed.
      let deep = extractDeep(root, opts);
      if (deep.texts.length < 2 && root !== document.body) {
        deep = extractDeep(document.body, opts);
      }
      if (deep.texts.length >= 2) {
        els = deep.els; texts = deep.texts;
      } else {
        // Last resort: whole-page sentences with no element refs.
        const raw = norm(document.body.innerText).split(/(?<=[.!?])\s+/).filter(s => s.length > 30);
        els = []; texts = raw;
      }
    }
    return texts;
  }

  function restoreBlock() {
    if (curBlock >= 0 && els[curBlock] && savedHTML !== null) {
      els[curBlock].classList.remove('__lr-block');
      els[curBlock].innerHTML = savedHTML;
    } else if (curBlock >= 0 && els[curBlock]) {
      els[curBlock].classList.remove('__lr-block');
    }
    savedHTML = null;
    wordSpans = [];
  }

  function clearAll() {
    restoreBlock();
    curBlock = -1;
  }

  // Split block into per-word spans aligned to the normalized text, so
  // boundary charIndex values line up with what TTS is speaking.
  function prepareWords(el, text) {
    savedHTML = el.innerHTML;
    const frag = document.createDocumentFragment();
    wordSpans = [];
    const re = /\S+/g;
    let m, last = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.textContent = m[0];
      frag.appendChild(span);
      wordSpans.push({ start: m.index, end: m.index + m[0].length, el: span });
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    el.innerHTML = '';
    el.appendChild(frag);
  }

  function highlightBlock(index, autoScroll) {
    injectStyle();
    restoreBlock();
    curBlock = index;
    const el = els[index];
    if (!el) return;
    el.classList.add('__lr-block');
    prepareWords(el, texts[index] || norm(el.innerText));
    if (autoScroll === false) return;
    const r = el.getBoundingClientRect();
    if (r.top < 60 || r.bottom > innerHeight - 60) {
      window.scrollTo({ top: window.scrollY + r.top - innerHeight * 0.35, behavior: 'smooth' });
    }
  }

  let lastWordEl = null;
  function highlightWord(index, charIndex) {
    if (index !== curBlock) return;
    if (lastWordEl) lastWordEl.classList.remove('__lr-word');
    let hit = null;
    for (const w of wordSpans) {
      if (charIndex >= w.start && charIndex < w.end) { hit = w; break; }
      if (charIndex < w.start) { hit = w; break; }
    }
    if (hit) { hit.el.classList.add('__lr-word'); lastWordEl = hit.el; }
  }

  // ---- HUD removed: the pinned mini player (bottom right) already shows state ----
  function showHud() {}

  // ---- pinned on-page mini player ----
  const P_SVG = {
    prev: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 5.5v13l-9-6.5z"></path><rect x="5.5" y="5.5" width="2.2" height="13" rx="1"></rect></svg>',
    next: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M6.5 5.5v13l9-6.5z"></path><rect x="16.3" y="5.5" width="2.2" height="13" rx="1"></rect></svg>',
    play: '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" style="margin-left:2px;"><path d="M7 4.5v15l13-7.5z"></path></svg>',
    pause: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.3"></rect><rect x="14" y="5" width="4" height="14" rx="1.3"></rect></svg>',
    close: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>'
  };
  let playerEl = null, pPlayBtn = null, pRateEl = null;
  let pState = { playing: false, rate: 2 };
  const IS_MAC = /Mac/i.test(navigator.userAgent);
  const KBD = {
    toggle: IS_MAC ? '\u2325 /' : 'Alt + /',
    rateUp: IS_MAC ? '\u2325 \u2191' : 'Alt + \u2191',
    rateDown: IS_MAC ? '\u2325 \u2193' : 'Alt + \u2193',
    next: IS_MAC ? '\u2325 \u2192' : 'Alt + \u2192',
    prev: IS_MAC ? '\u2325 \u2190' : 'Alt + \u2190'
  };

  function sendCmd(msg) {
    if (!ctxAlive()) return;
    try { chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; }); } catch (e) {}
  }
  function pBtn(html, title, onClick, w, kbd) {
    const b = document.createElement('button');
    b.innerHTML = html;
    if (!kbd) b.title = title;
    b.style.cssText = 'all:unset;position:relative;cursor:pointer;width:' + (w || 28) + 'px;height:28px;display:flex;align-items:center;justify-content:center;border-radius:999px;color:#fff;box-sizing:border-box;flex:none;';
    let tip = null, tipTimer = null;
    b.addEventListener('mouseenter', () => {
      b.style.background = 'rgba(255,255,255,.2)';
      if (!kbd) return;
      clearTimeout(tipTimer);
      tipTimer = setTimeout(() => {
        if (!tip) {
          tip = document.createElement('span');
          tip.style.cssText = 'position:absolute;bottom:calc(100% + 9px);left:50%;transform:translateX(-50%);background:rgba(8,20,40,.92);color:#fff;font:800 9.5px/1 -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.4px;padding:4px 8px;border-radius:6px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity .12s;';
          tip.textContent = kbd;
          b.appendChild(tip);
        }
        requestAnimationFrame(() => { if (tip) tip.style.opacity = '1'; });
      }, 250);
    });
    b.addEventListener('mouseleave', () => {
      b.style.background = 'transparent';
      clearTimeout(tipTimer);
      if (tip) tip.style.opacity = '0';
    });
    b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onClick(); });
    return b;
  }
  function updatePlayerUI() {
    if (!playerEl) return;
    pPlayBtn.innerHTML = pState.playing ? P_SVG.pause : P_SVG.play;
    pRateEl.textContent = (Math.round(pState.rate * 10) / 10).toFixed(1).replace(/\.0$/, '') + '\u00d7';
  }
  function mountPlayer() {
    if (playerEl && playerEl.isConnected) return;
    playerEl = document.createElement('div');
    playerEl.id = '__listenr_player';
    playerEl.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483646;display:flex;align-items:center;gap:1px;padding:5px 8px;border-radius:999px;background:linear-gradient(135deg,#0a3d8f,#0e7fb8);box-shadow:0 8px 24px rgba(10,61,143,.38);font:800 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;user-select:none;';
    playerEl.appendChild(pBtn(P_SVG.prev, 'Previous sentence', () => sendCmd({ cmd: 'prevSentence' }), 28, KBD.prev));
    pPlayBtn = pBtn(P_SVG.play, 'Play / Pause', () => sendCmd({ cmd: 'toggle' }), 32, KBD.toggle);
    playerEl.appendChild(pPlayBtn);
    playerEl.appendChild(pBtn(P_SVG.next, 'Next sentence', () => sendCmd({ cmd: 'nextSentence' }), 28, KBD.next));
    const sep = document.createElement('span');
    sep.style.cssText = 'width:1px;height:16px;background:rgba(255,255,255,.32);margin:0 5px;flex:none;';
    playerEl.appendChild(sep);
    playerEl.appendChild(pBtn('\u2212', 'Slower', () => sendCmd({ cmd: 'rateDown' }), 24, KBD.rateDown));
    pRateEl = document.createElement('span');
    pRateEl.style.cssText = 'min-width:30px;text-align:center;font-variant-numeric:tabular-nums;flex:none;';
    playerEl.appendChild(pRateEl);
    playerEl.appendChild(pBtn('+', 'Faster', () => sendCmd({ cmd: 'rateUp' }), 24, KBD.rateUp));
    const close = pBtn(P_SVG.close, 'Unpin player (re-enable from the Listenr popup)', () => {
      try { chrome.storage.local.set({ pinPlayer: false }); } catch (e) {}
      sendCmd({ cmd: 'setPinPlayer', value: false });
      unmountPlayer();
    }, 22);
    close.style.opacity = '.75';
    close.style.marginLeft = '3px';
    playerEl.appendChild(close);
    document.documentElement.appendChild(playerEl);
    updatePlayerUI();
    // sync with current playback state
    try {
      chrome.runtime.sendMessage({ cmd: 'getState' }, (r) => {
        void chrome.runtime.lastError;
        if (r && r.state) { pState.playing = !!r.state.playing; pState.rate = r.state.rate || 2; updatePlayerUI(); }
      });
    } catch (e) {}
  }
  function unmountPlayer() {
    if (playerEl) { playerEl.remove(); playerEl = null; }
  }
  // Pinned player is ON by default.
  try {
    chrome.storage.local.get(['pinPlayer']).then((st) => { if (st.pinPlayer !== false) mountPlayer(); });
  } catch (e) {}

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!ctxAlive()) return;
    try {
      switch (msg && msg.cmd) {
        case 'extract':   sendResponse({ blocks: extract(msg.opts) }); break;
        case 'hlBlock':   highlightBlock(msg.index, msg.autoScroll); sendResponse({ ok: true }); break;
        case 'hlWord':    highlightWord(msg.index, msg.charIndex); sendResponse({ ok: true }); break;
        case 'clear':     clearAll(); sendResponse({ ok: true }); break;
        case 'hud':       showHud(msg.text); sendResponse({ ok: true }); break;
        case 'playerState': pState.playing = !!msg.playing; pState.rate = msg.rate || pState.rate; updatePlayerUI(); sendResponse({ ok: true }); break;
        case 'pinPlayer': msg.value ? mountPlayer() : unmountPlayer(); sendResponse({ ok: true }); break;
        case 'ping':      sendResponse({ ok: true }); break;
        default: sendResponse({ ok: false });
      }
    } catch (e) {
      console.error('Listenr content script error:', e);
      sendResponse({ error: e.message });
    }
    return true;
  });

  // ---- click-to-read: jump to the word the user clicks ----
  function blockIndexOf(node) {
    for (let i = 0; i < els.length; i++) {
      if (els[i] && (els[i] === node || els[i].contains(node))) return i;
    }
    return -1;
  }
  function charOffsetAt(blockEl, x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    }
    if (!range) return 0;
    const pre = document.createRange();
    try { pre.setStart(blockEl, 0); pre.setEnd(range.startContainer, range.startOffset); }
    catch (e) { return 0; }
    return norm(pre.toString()).length;
  }
  // ---- keyboard shortcuts, handled in-page ----
  // chrome.commands suggested keys often fail to bind (conflicts, or the
  // extension was updated after install). This listener makes the shortcuts
  // work whenever a normal page has focus, regardless of command binding.
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    let cmd = null;
    // e.code fallback: on macOS, Option changes e.key (\u2325/ types "\u00f7"), but the
    // physical key always reports a stable e.code ('Slash', 'ArrowUp', ...).
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      if (e.key === '/' || e.code === 'Slash') cmd = 'toggle';
      else if (e.key === 'ArrowUp' || e.code === 'ArrowUp') cmd = 'rateUp';
      else if (e.key === 'ArrowDown' || e.code === 'ArrowDown') cmd = 'rateDown';
      else if (e.key === 'ArrowRight' || e.code === 'ArrowRight') cmd = 'nextSentence';
      else if (e.key === 'ArrowLeft' || e.code === 'ArrowLeft') cmd = 'prevSentence';
    }
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    if (!ctxAlive()) return;
    try {
      chrome.runtime.sendMessage({ cmd, viaKey: true }, () => { void chrome.runtime.lastError; });
    } catch (err) {}
  }, true);

  document.addEventListener('click', (e) => {
    if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest('a,button,input,textarea,select,label,[role="button"],[contenteditable]')) return;
    const idx = blockIndexOf(e.target);
    if (idx < 0) return;
    let sc = charOffsetAt(els[idx], e.clientX, e.clientY);
    const t = texts[idx] || '';
    while (sc > 0 && /\S/.test(t[sc - 1])) sc--;   // snap to start of clicked word

    // Guard against "Extension context invalidated" (extension reloaded while
    // this stale content script is still on the page).
    if (!ctxAlive()) { try { clearAll(); } catch (err) {} return; }
    try {
      chrome.runtime.sendMessage({ cmd: 'jumpTo', index: idx, startChar: sc }, () => {
        void chrome.runtime.lastError; // swallow "receiving end does not exist"
      });
    } catch (err) {
      // Context died between the check and the call — clean up quietly.
      try { clearAll(); } catch (e2) {}
    }
  }, true);
})();
