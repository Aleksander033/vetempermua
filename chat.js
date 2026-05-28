(function () {
  'use strict';

  /* ─────────────────────────────────────────────
     CONSTANTS
  ───────────────────────────────────────────── */
  const CHAT_WS_URL       = 'wss://chat.delt.io/delta7?protocol=v1';
  const MAX_MESSAGES      = 120;
  const FADE_AFTER_MS     = 12000;
  const FADE_DURATION_MS  = 1800;
  const RECONNECT_BASE_MS = 2000;
  const RECONNECT_MAX_MS  = 30000;
  const SPAM_MIN_MS       = 600;
  const SPAM_BURST_MAX    = 5;
  const SPAM_WINDOW_MS    = 4000;
  const HISTORY_MAX       = 60;
  const PLAYER_REG_MS     = 800;
  const PLAYER_UPD_MS     = 2000;
  const MSG_INPUT_MAX_LEN = 100;
  const SEND_QUEUE_TTL_MS = 8000;   // drop queued msgs older than this

  const EMOJI_LIST = [
    '😀','😁','😂','🤣','😊','😍','🥰','😎','😭','😤',
    '😡','🥺','😳','🤔','🙄','😴','🤯','🥳','🤩','😈',
    '💀','👾','🔥','💥','⚡','✨','❤️','💙','💚','💛',
    '💜','🖤','💯','👍','👎','🙌','👏','🤝','🫡','✌️',
    '🤙','💪','🏆','🎯','⚔️','🛡️','🎮','👑','🚀','💎',
    '🍕','🍔','🍟','🌮','🍜','🍣','🍺','☕','🧃','💧',
    '🐍','🦁','🐯','🦊','🐺','🦅','🐲','🦋','🌊','🍀',
    '🌙','☀️','⭐','🌈','💫','🎵','🎶','🎲','🃏','🎰',
  ];

  const COMMANDS = {
    '/me':    { usage: '/me <action>',       desc: 'Send an action message' },
    '/clear': { usage: '/clear',             desc: 'Clear the chat log' },
    '/mute':  { usage: '/mute <nick>',       desc: 'Locally mute a player' },
    '/unmute':{ usage: '/unmute <nick>',     desc: 'Unmute a player' },
    '/muted': { usage: '/muted',             desc: 'List muted players' },
    '/help':  { usage: '/help',              desc: 'Show this help text' },
    '/w':     { usage: '/w <nick> <msg>',    desc: 'Whisper (decorative label)' },
  };

  /* ─────────────────────────────────────────────
     UTILITY
  ───────────────────────────────────────────── */
  const qs  = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const nowHHMM = () => new Date().toTimeString().slice(0, 5);
  const clean   = (v, fallback = '') => String(v ?? fallback).trim();
  const clamp   = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ─────────────────────────────────────────────
     ONYX DOM HELPERS
  ───────────────────────────────────────────── */
  function nicknameEl() {
    return (
      qs('#nick') ||
      qs('#nickname') ||
      qs('input[name="nick"]') ||
      qs('input[name="nickname"]') ||
      qs('input[placeholder*="nick" i]') ||
      qs('input[placeholder*="name" i]')
    );
  }

  function detectNick() {
    return clean(nicknameEl()?.value, 'player') || 'player';
  }

  function detectTag() {
    const el = qs('#tag') || qs('input[placeholder*="tag" i]');
    return clean(el?.value).toUpperCase();
  }

  function selectedServerUrl() {
    const sel = qs('#servers');
    let raw = clean(
      sel?.value ||
      localStorage.getItem('ZYNX:server') ||
      'eu.senpa.io:2001'
    );
    if (!raw.startsWith('ws')) raw = 'wss://' + raw;
    return raw;
  }

  function normalizeServerUrl(url) { return clean(url).replace(/\/+$/, ''); }

  function chatRoomUrl() {
    const server = normalizeServerUrl(selectedServerUrl());
    return server.replace(/senpa\.io/gi, 'mi.com');
  }

  function tokenFromUrl(url) {
    const m = normalizeServerUrl(url).match(/^wss?:\/\/(.+)/i);
    return m ? btoa(m[1]) : '';
  }

  function makeProtocol() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map((v, i, a) => {
      const next = (a[i + 3] || 0) ^ (a[i + 2] || 0);
      return (i % 5 === 0 ? next : v).toString(16).padStart(2, '0');
    }).join('');
  }

  /* ─────────────────────────────────────────────────────────────────────────
     STABLE FALLBACK CLIENT ID
     ─────────────────────────────────────────────────────────────────────────
     The core reason outgoing messages fail:
       tryRegisterClient() returns early when window.multibox has no clients
       yet (lobby state). The server therefore never sends back the op=1
       packet that carries chatId. Without chatId sendChat() always hits
       the "not connected" guard.

     Fix: generate a stable UInt32 ID stored in sessionStorage so it
     persists across reconnects within the same tab but resets on a new
     session. This ID is used whenever no real clientID is available.
  ───────────────────────────────────────────────────────────────────────── */
  function getFallbackClientId() {
    const KEY = 'ONYX_CHAT_CLIENT_ID';
    let id = parseInt(sessionStorage.getItem(KEY), 10);
    if (!id || id <= 0) {
      const bytes = crypto.getRandomValues(new Uint32Array(1));
      id = (bytes[0] % 0x7fffffff) + 1;   // positive, non-zero
      sessionStorage.setItem(KEY, String(id));
    }
    return id;
  }

  function getPrimaryClient() {
    const clients = Array.isArray(window.multibox?.clients) ? window.multibox.clients : [];
    return clients.find(c => c?.clientID) || clients[0] || null;
  }

  function resolveClientId() {
    const client = getPrimaryClient();
    return Number(client?.clientID) || getFallbackClientId();
  }

  /* ─────────────────────────────────────────────
     BINARY PROTOCOL — Writer / Reader
  ───────────────────────────────────────────── */
  class Writer {
    constructor(size = 8192) {
      this.buffer = new ArrayBuffer(size);
      this.view   = new DataView(this.buffer);
      this.bytes  = new Uint8Array(this.buffer);
      this.offset = 0;
    }
    writeUInt8(v)  { this.view.setUint8(this.offset++, v & 0xff); }
    writeUInt16(v) { this.view.setUint16(this.offset, v & 0xffff, true); this.offset += 2; }
    writeUInt32(v) { this.view.setUint32(this.offset, v >>> 0,    true); this.offset += 4; }
    writeInt16(v)  { this.view.setInt16 (this.offset, v || 0,     true); this.offset += 2; }
    writeInt32(v)  { this.view.setInt32 (this.offset, v || 0,     true); this.offset += 4; }
    writeUInt24(v) {
      this.writeUInt8((v & 0xff0000) >>> 16);
      this.writeUInt8((v & 0x00ff00) >>> 8);
      this.writeUInt8( v & 0x0000ff);
    }
    writeUTF16String(str) {
      for (const ch of String(str || '')) this.writeUInt16(ch.charCodeAt(0));
    }
    writeUTF16StringZero(str) {
      this.writeUTF16String(str);
      this.writeUInt16(0);
    }
    writeUTF16StringLength(str) {
      const s = String(str || '').slice(0, 255);
      this.writeUInt8(s.length);
      this.writeUTF16String(s);
    }
    finalize() { return this.bytes.slice(0, this.offset); }
  }

  class Reader {
    constructor(data) {
      const buf = data instanceof ArrayBuffer ? data : data.buffer;
      this.view   = new DataView(buf, data.byteOffset || 0, data.byteLength || buf.byteLength);
      this.offset = 0;
    }
    get remaining() { return this.view.byteLength - this.offset; }
    readUInt8()  { return this.view.getUint8 (this.offset++); }
    readInt8()   { return this.view.getInt8  (this.offset++); }
    readUInt16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    readInt16()  { const v = this.view.getInt16 (this.offset, true); this.offset += 2; return v; }
    readUInt24() { return (this.readUInt8() << 16) | (this.readUInt8() << 8) | this.readUInt8(); }
    readUInt32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    readInt32()  { const v = this.view.getInt32 (this.offset, true); this.offset += 4; return v; }
    readUTF16StringLength() {
      const len = this.readUInt8();
      let out = '';
      for (let i = 0; i < len && this.offset + 1 < this.view.byteLength; i++) {
        out += String.fromCharCode(this.readUInt16());
      }
      return out;
    }
  }

  /* ─────────────────────────────────────────────
     MUTE / FILTER
  ───────────────────────────────────────────── */
  const mutedNicks = new Set(
    JSON.parse(localStorage.getItem('ONYX_CHAT_MUTED') || '[]')
  );
  function saveMuted()      { localStorage.setItem('ONYX_CHAT_MUTED', JSON.stringify([...mutedNicks])); }
  function mutePlayer(n)    { if (n) { mutedNicks.add(n.toLowerCase());    saveMuted(); } }
  function unmutePlayer(n)  { if (n) { mutedNicks.delete(n.toLowerCase()); saveMuted(); } }
  function isMuted(n)       { return mutedNicks.has(clean(n).toLowerCase()); }

  /* ─────────────────────────────────────────────
     ANTI-SPAM
  ───────────────────────────────────────────── */
  let lastSendTime  = 0;
  const recentSends = [];

  function canSend() {
    const now = Date.now();
    if (now - lastSendTime < SPAM_MIN_MS) return false;
    const cutoff = now - SPAM_WINDOW_MS;
    while (recentSends.length && recentSends[0] < cutoff) recentSends.shift();
    return recentSends.length < SPAM_BURST_MAX;
  }

  function recordSend() {
    const now = Date.now();
    lastSendTime = now;
    recentSends.push(now);
  }

  /* ─────────────────────────────────────────────
     MESSAGE HISTORY
  ───────────────────────────────────────────── */
  const msgHistory   = [];
  let   historyIndex = -1;

  function historyPush(text) {
    if (!text || msgHistory[0] === text) return;
    msgHistory.unshift(text);
    if (msgHistory.length > HISTORY_MAX) msgHistory.length = HISTORY_MAX;
    historyIndex = -1;
  }

  /* ─────────────────────────────────────────────
     SEND QUEUE
     Messages sent before chatId is ready are held
     here and flushed as soon as chatId arrives.
  ───────────────────────────────────────────── */
  const sendQueue = [];  // { nick, text, ts }

  function enqueueSend(nick, text) {
    sendQueue.push({ nick, text, ts: Date.now() });
  }

  function flushSendQueue() {
    const now = Date.now();
    while (sendQueue.length) {
      const item = sendQueue.shift();
      if (now - item.ts > SEND_QUEUE_TTL_MS) continue;  // expired — drop
      dispatchSendPacket(item.nick, item.text);
    }
  }

  function dispatchSendPacket(nick, text) {
    if (!chat.isOpen || !chat.chatId) return;
    const w = new Writer();
    w.writeUInt8(25);
    w.writeUInt8(1);
    w.writeUInt16(0);
    w.writeUInt16(chat.chatId);
    w.writeUInt16(0);
    w.writeUTF16StringLength(nick);
    w.writeUTF16StringLength(text);
    chat.send(w);
  }

  /* ─────────────────────────────────────────────
     DOM — BUILD CHAT UI
  ───────────────────────────────────────────── */
  let root, logEl, inputWrap, inputEl, emojiPickerEl, emojiToggleEl, resizeHandle;

  function buildUI() {
    qs('#ONYX_CHAT_ROOT')?.remove();
    qs('#ONYX_CHAT_INPUT_WRAP')?.remove();

    root = document.createElement('div');
    root.id        = 'ONYX_CHAT_ROOT';
    root.className = 'onyx-chat-container';
    root.setAttribute('aria-label', 'Chat');
    root.innerHTML = `
      <div class="onyx-chat-resize-handle" id="ONYX_CHATResize" title="Drag to resize"></div>
      <div class="onyx-chat-messages" id="ONYX_CHATLog" role="log" aria-live="polite" aria-relevant="additions"></div>
    `;
    document.body.appendChild(root);

    logEl        = root.querySelector('#ONYX_CHATLog');
    resizeHandle = root.querySelector('#ONYX_CHATResize');

    inputWrap = document.createElement('div');
    inputWrap.id        = 'ONYX_CHAT_INPUT_WRAP';
    inputWrap.className = 'onyx-chat-input-container';
    inputWrap.innerHTML = `
      <div class="onyx-emoji-picker" id="ONYX_EmojiPicker" role="listbox" aria-label="Emoji picker"></div>
      <input
        class="onyx-chat-input-field"
        id="ONYX_CHATInput"
        maxlength="${MSG_INPUT_MAX_LEN}"
        placeholder="Press Enter to chat…"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        aria-label="Chat input"
        role="textbox"
      >
      <div class="onyx-emoji-toggle" id="ONYX_EmojiToggle" title="Emoji" role="button" aria-label="Open emoji picker">
        <span>☺</span>
      </div>
    `;
    document.body.appendChild(inputWrap);

    inputEl       = inputWrap.querySelector('#ONYX_CHATInput');
    emojiPickerEl = inputWrap.querySelector('#ONYX_EmojiPicker');
    emojiToggleEl = inputWrap.querySelector('#ONYX_EmojiToggle');

    injectStyles();
    buildEmojiPicker();
    restoreSize();
  }

  /* ─────────────────────────────────────────────
     STYLES
  ───────────────────────────────────────────── */
  function injectStyles() {
    if (qs('#ONYX_CHAT_STYLES')) return;
    const style = document.createElement('style');
    style.id = 'ONYX_CHAT_STYLES';
    style.textContent = `
      #ONYX_CHAT_ROOT {
        position: fixed;
        left: 12px;
        bottom: 12px;
        width: 330px;
        height: 320px;
        min-width: 220px;
        min-height: 160px;
        max-width: 60vw;
        max-height: 55vh;
        background: rgba(0,0,0,0.42);
        backdrop-filter: blur(5px);
        -webkit-backdrop-filter: blur(5px);
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        z-index: 9100;
        pointer-events: all;
        overflow: hidden;
        transition: opacity 0.35s ease;
      }
      #ONYX_CHAT_ROOT.onyx-chat-hidden {
        opacity: 0;
        pointer-events: none;
      }
      .onyx-chat-resize-handle {
        position: absolute;
        top: 0; right: 0;
        width: 22px; height: 22px;
        cursor: nesw-resize;
        z-index: 9110;
        opacity: 0.55;
        transition: opacity 0.15s;
      }
      .onyx-chat-resize-handle:hover { opacity: 1; }
      .onyx-chat-resize-handle::after {
        content: '';
        position: absolute;
        top: 5px; right: 5px;
        width: 0; height: 0;
        border-style: solid;
        border-width: 0 10px 10px 0;
        border-color: transparent rgba(79,236,255,0.55) transparent transparent;
      }
      #ONYX_CHATLog {
        flex: 1;
        overflow-y: auto;
        overflow-x: hidden;
        padding: 8px 10px 6px;
        display: flex;
        flex-direction: column-reverse;
        gap: 2px;
        direction: rtl;
        scrollbar-width: thin;
        scrollbar-color: rgba(255,255,255,0.18) transparent;
      }
      #ONYX_CHATLog::-webkit-scrollbar { width: 5px; }
      #ONYX_CHATLog::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.18);
        border-radius: 3px;
      }
      .onyx-msg-row {
        direction: ltr;
        text-align: left;
        color: #e8e8e8;
        font-family: 'Ubuntu','Rajdhani',sans-serif;
        font-size: 13px;
        line-height: 1.4;
        word-break: break-word;
        text-shadow: 1px 1px 2px rgba(0,0,0,0.85);
        transition: opacity ${FADE_DURATION_MS}ms ease;
      }
      .onyx-msg-row.faded          { opacity: 0.18; }
      .onyx-msg-row.onyx-msg-sys   { color: #f0c040; font-weight: 500; }
      .onyx-msg-row.onyx-msg-me    { color: #b8a0f8; font-style: italic; }
      .onyx-msg-row.onyx-msg-whisper { color: #ff9ed8; }
      .onyx-chat-time {
        color: #767688;
        font-size: 11px;
        margin-right: 5px;
        font-family: 'Ubuntu Mono',monospace;
      }
      .onyx-chat-nick             { font-weight: 700; font-size: 13px; margin-right: 4px; color: #4fecff; }
      .onyx-chat-nick.onyx-nick-self { color: #b8f08a; }
      #ONYX_CHAT_INPUT_WRAP {
        display: none;
        position: fixed;
        bottom: 56px;
        left: 50%;
        transform: translateX(-50%);
        width: 360px;
        max-width: 90vw;
        z-index: 9200;
        animation: onyx-chat-fadein 0.12s ease-out;
      }
      #ONYX_CHAT_INPUT_WRAP.onyx-input-open { display: block; }
      @keyframes onyx-chat-fadein {
        from { opacity:0; transform: translateX(-50%) translateY(8px); }
        to   { opacity:1; transform: translateX(-50%) translateY(0);   }
      }
      .onyx-chat-input-field {
        width: 100%;
        background: rgba(10,10,12,0.96);
        border: 2px solid rgba(79,236,255,0.28);
        color: #fff;
        padding: 11px 46px 11px 18px;
        font-family: 'Ubuntu','Rajdhani',sans-serif;
        font-size: 15px;
        font-weight: 500;
        border-radius: 8px;
        outline: none;
        box-shadow: 0 0 22px rgba(79,236,255,0.08);
        box-sizing: border-box;
        transition: border-color 0.18s, box-shadow 0.18s;
      }
      .onyx-chat-input-field:focus {
        border-color: #4fecff;
        box-shadow: 0 0 24px rgba(79,236,255,0.38);
      }
      .onyx-chat-input-field::placeholder {
        color: rgba(255,255,255,0.32);
        text-transform: uppercase;
        text-align: center;
        letter-spacing: 0.05em;
      }
      .onyx-emoji-toggle {
        position: absolute;
        right: 12px; top: 50%;
        transform: translateY(-50%);
        font-size: 20px;
        cursor: pointer;
        color: rgba(79,236,255,0.75);
        user-select: none;
        line-height: 1;
        transition: transform 0.15s, color 0.15s;
        filter: drop-shadow(0 0 4px rgba(79,236,255,0.25));
      }
      .onyx-emoji-toggle:hover {
        color: #4fecff;
        transform: translateY(-50%) scale(1.15);
      }
      .onyx-emoji-picker {
        display: none;
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0; width: 100%;
        background: rgba(14,14,18,0.98);
        border: 1px solid rgba(79,236,255,0.2);
        border-radius: 8px;
        padding: 5px 7px;
        flex-wrap: wrap;
        gap: 3px;
        max-height: 108px;
        overflow-y: auto;
        box-shadow: 0 6px 24px rgba(0,0,0,0.75);
        backdrop-filter: blur(6px);
        box-sizing: border-box;
        scrollbar-width: thin;
        scrollbar-color: #4fecff transparent;
        animation: onyx-picker-in 0.18s cubic-bezier(0.18,0.89,0.32,1.28);
      }
      .onyx-emoji-picker.onyx-picker-open { display: flex; }
      @keyframes onyx-picker-in {
        from { opacity:0; transform: translateY(8px) scale(0.96); }
        to   { opacity:1; transform: translateY(0)   scale(1);    }
      }
      .onyx-emoji-picker::-webkit-scrollbar       { width: 4px; }
      .onyx-emoji-picker::-webkit-scrollbar-thumb { background: #4fecff; border-radius: 2px; }
      .onyx-emoji-item {
        cursor: pointer;
        font-size: 19px;
        width: 30px; height: 30px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 5px;
        transition: background 0.1s, transform 0.1s;
        user-select: none;
      }
      .onyx-emoji-item:hover {
        background: rgba(79,236,255,0.14);
        transform: scale(1.22);
      }
      #ONYX_CMD_HINT {
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0;
        background: rgba(14,14,18,0.96);
        border: 1px solid rgba(79,236,255,0.2);
        border-radius: 6px;
        padding: 4px 10px;
        font-size: 12px;
        color: rgba(255,255,255,0.55);
        white-space: pre;
        pointer-events: none;
        display: none;
        font-family: 'Ubuntu Mono',monospace;
        backdrop-filter: blur(4px);
      }
    `;
    document.head.appendChild(style);
  }

  /* ─────────────────────────────────────────────
     EMOJI PICKER
  ───────────────────────────────────────────── */
  function buildEmojiPicker() {
    EMOJI_LIST.forEach(emoji => {
      const btn = document.createElement('div');
      btn.className   = 'onyx-emoji-item';
      btn.textContent = emoji;
      btn.title       = emoji;
      btn.setAttribute('role', 'option');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        insertAtCursor(inputEl, emoji);
        inputEl.focus();
      });
      emojiPickerEl.appendChild(btn);
    });
  }

  function insertAtCursor(input, text) {
    const start = input.selectionStart;
    const end   = input.selectionEnd;
    const val   = input.value;
    input.value = val.slice(0, start) + text + val.slice(end);
    const pos   = start + text.length;
    input.setSelectionRange(pos, pos);
    input.dispatchEvent(new Event('input'));
  }

  /* ─────────────────────────────────────────────
     VISIBILITY / OPEN / CLOSE
  ───────────────────────────────────────────── */
  let chatOpen    = false;
  let chatVisible = true;
  let emojiOpen   = false;

  function showChat()   { chatVisible = true;  root.classList.remove('onyx-chat-hidden'); }
  function hideChat()   { chatVisible = false; root.classList.add   ('onyx-chat-hidden'); }
  function toggleChat() { chatVisible ? hideChat() : showChat(); }

  function openInput() {
    chatOpen    = true;
    chatVisible = true;
    root.classList.remove('onyx-chat-hidden');
    inputWrap.classList.add('onyx-input-open');
    clearFadeTimers();
    historyIndex = -1;
    requestAnimationFrame(() => inputEl.focus());
  }

  function closeInput() {
    chatOpen = false;
    inputWrap.classList.remove('onyx-input-open');
    closeEmojiPicker();
    inputEl.blur();
    scheduleFadeTimers();
  }

  function openEmojiPicker()   { emojiOpen = true;  emojiPickerEl.classList.add   ('onyx-picker-open'); }
  function closeEmojiPicker()  { emojiOpen = false; emojiPickerEl.classList.remove('onyx-picker-open'); }
  function toggleEmojiPicker() { emojiOpen ? closeEmojiPicker() : openEmojiPicker(); }

  /* ─────────────────────────────────────────────
     FADE SYSTEM
  ───────────────────────────────────────────── */
  const fadeTimers = new Map();

  function scheduleFadeTimers() {
    if (chatOpen) return;
    qsa('.onyx-msg-row', logEl).forEach(el => {
      if (fadeTimers.has(el)) return;
      const age   = Date.now() - (parseInt(el.dataset.ts, 10) || Date.now());
      const delay = Math.max(0, FADE_AFTER_MS - age);
      const tid   = setTimeout(() => { el.classList.add('faded'); fadeTimers.delete(el); }, delay);
      fadeTimers.set(el, tid);
    });
  }

  function clearFadeTimers() {
    fadeTimers.forEach(tid => clearTimeout(tid));
    fadeTimers.clear();
    qsa('.onyx-msg-row.faded', logEl).forEach(el => el.classList.remove('faded'));
  }

  function scheduleFadeForRow(el) {
    if (chatOpen) return;
    const tid = setTimeout(() => { el.classList.add('faded'); fadeTimers.delete(el); }, FADE_AFTER_MS);
    fadeTimers.set(el, tid);
  }

  /* ─────────────────────────────────────────────
     MESSAGE RENDERING
  ───────────────────────────────────────────── */
  function addMessage(nick, text, type = 'msg') {
    if (!logEl) return;
    if (type === 'msg' && isMuted(nick)) return;

    const selfNick = detectNick();
    const isMe     = nick && nick.toLowerCase() === selfNick.toLowerCase();

    const row = document.createElement('div');
    row.className  = 'onyx-msg-row';
    row.dataset.ts = String(Date.now());
    if (type === 'sys')     row.classList.add('onyx-msg-sys');
    if (type === 'me')      row.classList.add('onyx-msg-me');
    if (type === 'whisper') row.classList.add('onyx-msg-whisper');

    const timeSpan = document.createElement('span');
    timeSpan.className   = 'onyx-chat-time';
    timeSpan.textContent = '[' + nowHHMM() + ']';

    const nickSpan = document.createElement('span');
    nickSpan.className = 'onyx-chat-nick' + (isMe ? ' onyx-nick-self' : '');
    if (nick) nickSpan.textContent = nick + ':';

    const textSpan = document.createElement('span');
    textSpan.className   = 'onyx-chat-text';
    textSpan.textContent = clean(text);

    row.appendChild(timeSpan);
    if (nick) row.appendChild(nickSpan);
    row.appendChild(textSpan);
    logEl.prepend(row);

    const allRows = qsa('.onyx-msg-row', logEl);
    if (allRows.length > MAX_MESSAGES) {
      allRows.slice(MAX_MESSAGES).forEach(el => {
        if (fadeTimers.has(el)) { clearTimeout(fadeTimers.get(el)); fadeTimers.delete(el); }
        el.remove();
      });
    }

    scheduleFadeForRow(row);
    bridgeToONYXChatroom(nick, text, type);
  }

  function system(text) { addMessage(null, text, 'sys'); }

  function bridgeToONYXChatroom(nick, text, type) {
    const chatroom = qs('#chatroom');
    if (!chatroom) return;
    const line = document.createElement('div');
    line.className = 'chat-line' + (type === 'sys' ? ' chat-system' : '');
    if (nick) {
      const n = document.createElement('span');
      n.className   = 'chat-nick';
      n.textContent = nick + ':';
      line.appendChild(n);
      const t = document.createElement('span');
      t.className   = 'chat-msg';
      t.textContent = ' ' + clean(text);
      line.appendChild(t);
    } else {
      line.textContent = clean(text);
    }
    chatroom.appendChild(line);
    chatroom.scrollTop = chatroom.scrollHeight;
    while (chatroom.childNodes.length > MAX_MESSAGES) chatroom.removeChild(chatroom.firstChild);
  }

  /* ─────────────────────────────────────────────
     COMMAND HANDLING
  ───────────────────────────────────────────── */
  function handleCommand(raw) {
    const parts = raw.trim().split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    const args  = parts.slice(1);

    switch (cmd) {
      case '/clear':
        qsa('.onyx-msg-row', logEl).forEach(el => {
          if (fadeTimers.has(el)) { clearTimeout(fadeTimers.get(el)); fadeTimers.delete(el); }
          el.remove();
        });
        const cr = qs('#chatroom');
        if (cr) cr.innerHTML = '';
        system('Chat cleared.');
        return true;

      case '/help':
        Object.values(COMMANDS).forEach(c => system(c.usage + ' — ' + c.desc));
        return true;

      case '/mute':
        if (!args[0]) { system('Usage: /mute <nick>'); return true; }
        mutePlayer(args.join(' '));
        system('Muted: ' + args.join(' '));
        return true;

      case '/unmute':
        if (!args[0]) { system('Usage: /unmute <nick>'); return true; }
        unmutePlayer(args.join(' '));
        system('Unmuted: ' + args.join(' '));
        return true;

      case '/muted':
        system([...mutedNicks].length ? 'Muted: ' + [...mutedNicks].join(', ') : 'No muted players.');
        return true;

      case '/me': {
        const action = args.join(' ');
        if (!action) { system('Usage: /me <action>'); return true; }
        addMessage(detectNick(), '* ' + action, 'me');
        chat.sendChat('/me ' + action);
        return true;
      }

      case '/w': {
        const target = args[0] || '';
        const msg    = args.slice(1).join(' ');
        if (!target || !msg) { system('Usage: /w <nick> <message>'); return true; }
        addMessage('[→' + target + ']', msg, 'whisper');
        chat.sendChat('/w ' + target + ' ' + msg);
        return true;
      }
    }
    return false;
  }

  /* ─────────────────────────────────────────────
     COMMAND AUTOCOMPLETE
  ───────────────────────────────────────────── */
  let cmdHintEl = null;

  function ensureCmdHint() {
    if (cmdHintEl) return;
    cmdHintEl = document.createElement('div');
    cmdHintEl.id = 'ONYX_CMD_HINT';
    inputWrap.appendChild(cmdHintEl);
  }

  function updateCmdHint(val) {
    ensureCmdHint();
    if (!val.startsWith('/') || val.includes(' ')) { cmdHintEl.style.display = 'none'; return; }
    const matches = Object.entries(COMMANDS)
      .filter(([k]) => k.startsWith(val.toLowerCase()))
      .map(([, c]) => c.usage + ' — ' + c.desc);
    if (!matches.length) { cmdHintEl.style.display = 'none'; return; }
    cmdHintEl.textContent = matches.slice(0, 4).join('\n');
    cmdHintEl.style.display = 'block';
  }

  /* ─────────────────────────────────────────────────────────────────────────
     WEBSOCKET CHAT CLIENT
     ─────────────────────────────────────────────────────────────────────────
     Protocol summary (outgoing):
       op=0  handshake (UInt16)       → sent on socket open
       op=1  register client (UInt8 + UInt32 clientId) → triggers chatId response
       op=9  enter room               → join with token/tag
       op=16 player update            → nickname/position broadcast
       op=25 send message             → requires chatId

     Protocol summary (incoming):
       op=0  connection ack + connectionID → triggers enterRoom
       op=1  tab registered + chatId       → unlocks sendChat; flushes queue
       op=12 players left
       op=16 player updates
       op=25 message received
  ───────────────────────────────────────────────────────────────────────── */
  const chat = {
    socket:             null,
    connectionID:       null,
    chatId:             null,
    registeredClientId: null,
    players:            new Map(),
    reconnectTimer:     null,
    reconnectAttempts:  0,
    currentRoomToken:   '',
    destroyed:          false,

    get isOpen() {
      return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    },

    connect() {
      if (this.destroyed) return;
      clearTimeout(this.reconnectTimer);

      try { this.socket?.close(); } catch (_) { /* ignore */ }

      this.connectionID       = null;
      this.chatId             = null;
      this.registeredClientId = null;
      this.currentRoomToken   = tokenFromUrl(chatRoomUrl());

      let ws;
      try {
        ws = new WebSocket(CHAT_WS_URL, makeProtocol());
      } catch (_) {
        this._scheduleReconnect();
        return;
      }

      this.socket            = ws;
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        const w = new Writer();
        w.writeUInt16(0);
        this.send(w);
      };

      this.socket.onmessage = (event) => {
        try { this.onMessage(event.data); } catch (_) { /* guard malformed packets */ }
      };

      this.socket.onclose = () => {
        if (!this.destroyed) this._scheduleReconnect();
      };

      this.socket.onerror = () => {
        // onclose always fires after onerror; let onclose handle reconnect
      };
    },

    _scheduleReconnect() {
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(1.6, this.reconnectAttempts++),
        RECONNECT_MAX_MS
      );
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    },

    send(packet) {
      if (!this.isOpen) return false;
      try {
        this.socket.send(packet instanceof Writer ? packet.finalize() : packet);
        return true;
      } catch (_) { return false; }
    },

    /* ───────────────────────────────────────────────────────────────────
       enterRoom — sent immediately after connection handshake (op=0 ack).
       Joins the delt.io chat room for the currently selected server.
    ─────────────────────────────────────────────────────────────────── */
    enterRoom() {
      const token = this.currentRoomToken || tokenFromUrl(chatRoomUrl());
      const tag   = detectTag();
      const w     = new Writer();
      let flags   = 0;

      w.writeUInt8(9);
      w.writeUInt8(0);    // flags byte — back-patched below

      [
        [token,    1],
        [tag,      2],
        ['',       4],
        [':party', 8],
        ['',      16],
      ].forEach(([value, bit]) => {
        flags |= bit;
        w.writeUTF16StringZero(String(value));
      });

      w.view.setUint8(1, flags);    // patch flags at byte index 1
      this.send(w);
      this._doRegisterClient();     // attempt registration immediately
    },

    /* ───────────────────────────────────────────────────────────────────
       _doRegisterClient — always sends op=1 to the server using the best
       available clientId (real from multibox OR stable fallback).

       This is the critical fix: the original code returned early when
       window.multibox had no clients (lobby state), leaving chatId = null
       and making sendChat permanently fail.
    ─────────────────────────────────────────────────────────────────── */
    _doRegisterClient() {
      if (!this.isOpen) return;

      const id = resolveClientId();   // never 0 — fallback guarantees a valid UInt32

      if (this.registeredClientId === id) return;   // already registered with this id
      this.registeredClientId = id;

      const w = new Writer();
      w.writeUInt8(1);
      w.writeUInt32(id);
      this.send(w);

      // sendPlayerUpdate will be called once op=1 ack arrives (chatId set)
    },

    /* tryRegisterClient — called on a timer; upgrades from fallback id to
       real multibox id as soon as the game client connects.              */
    tryRegisterClient() {
      if (!this.isOpen) return;

      const client = getPrimaryClient();
      const realId = Number(client?.clientID);

      if (realId && realId !== this.registeredClientId) {
        // Real id now available and differs from what we registered with
        this.registeredClientId = realId;

        const w = new Writer();
        w.writeUInt8(1);
        w.writeUInt32(realId);
        this.send(w);

        this.sendPlayerUpdate(true);
      } else if (!this.chatId) {
        // chatId still not received — re-send registration to recover
        this._doRegisterClient();
      }
    },

    sendPlayerUpdate(force = false) {
      if (!this.isOpen || !this.chatId) return;

      const client   = getPrimaryClient();
      const playerId = Number(
        client?.multiboxID ||
        client?.stores?.ownedIDs?.[0] ||
        this.chatId ||
        1
      );
      const clientId = resolveClientId();
      const nick     = detectNick();

      const w = new Writer();
      w.writeUInt8(16);
      w.writeUInt16(playerId || this.chatId);
      w.writeUInt8(1);
      w.writeUInt8(1 | 2 | 64);
      w.writeUInt16(clientId);
      w.writeUTF16StringLength(nick);
      w.writeUInt32(clientId);
      w.writeUInt16(0);
      this.send(w);
    },

    parsePlayerUpdates(r) {
      while (r.remaining >= 2) {
        const playerId = r.readUInt16();
        if (playerId === 0) break;
        if (r.remaining < 1) break;

        const flags = r.readUInt8();
        const info  = this.players.get(playerId) || { playerId };

        if (flags & 1) {
          const f = r.remaining >= 1 ? r.readUInt8() : 0;
          if (f &  1) info.clientId    = r.readUInt16();
          if (f &  2) info.nick        = r.readUTF16StringLength();
          if (f &  4) info.customSkin  = r.readUTF16StringLength();
          if (f &  8) info.customColor = r.readUInt24();
          if (f & 16) r.readUTF16StringLength();
          if (f & 32) info.pColor      = r.readUInt24();
          if (f & 64) info.tabId       = r.readUInt32();
        }
        if (flags & 2) {
          info.position = { x: r.readInt16(), y: r.readInt16(), mass: r.readUInt32() };
        }
        if (flags & 4) info.isAlive = r.readUInt8() !== 0;
        if (flags & 8) r.readInt8();

        this.players.set(playerId, info);
      }
    },

    parseMessage(r) {
      const rawType  = r.readUInt8();
      const type     = rawType === 1 ? 'msg' : rawType === 2 ? 'cmd' : String(rawType);
      r.readUInt16();
      const playerID = r.readUInt16();
      r.readUInt16();
      let nick       = r.readUTF16StringLength();
      const text     = r.readUTF16StringLength();

      if (!nick) nick = this.players.get(playerID)?.nick || '';
      addMessage(nick || ('player#' + playerID), text, type);
    },

    onMessage(data) {
      const r  = new Reader(data);
      const op = r.readUInt8();

      switch (op) {
        case 0:    // handshake ack — server confirms connection
          this.connectionID = r.readUInt16();
          this.enterRoom();
          break;

        case 1: {  // registration ack — server assigns chatId
          r.readUInt32();            // tabID (not used)
          this.chatId = r.readUInt16();
          this.sendPlayerUpdate(true);
          flushSendQueue();          // dispatch any messages queued before chatId arrived
          break;
        }

        case 12:   // players disconnected
          while (r.remaining >= 2) {
            const id = r.readUInt16();
            if (!id) break;
            this.players.delete(id);
          }
          break;

        case 16:   // player update batch
          this.parsePlayerUpdates(r);
          break;

        case 25:   // incoming chat message
          this.parseMessage(r);
          break;
      }
    },

    /* ───────────────────────────────────────────────────────────────────
       sendChat — primary outgoing message dispatch.

       If chatId is not yet available the message is placed in sendQueue
       and flushed automatically when op=1 ack arrives.  The socket is
       always open at this point (we can receive messages), so we never
       need to wait for reconnect — only for chatId.
    ─────────────────────────────────────────────────────────────────── */
    sendChat(text) {
      const trimmed = clean(text);
      if (!trimmed) return;

      if (!this.isOpen) {
        system('Chat is not connected. Reconnecting…');
        return;
      }

      if (!canSend()) {
        system('Slow down — you are sending messages too fast.');
        return;
      }

      recordSend();

      const nick = detectNick();

      if (!this.chatId) {
        // chatId not yet received — queue and ensure registration is flying
        enqueueSend(nick, trimmed);
        this._doRegisterClient();    // re-trigger registration in case it stalled
        return;
      }

      dispatchSendPacket(nick, trimmed);
    },

    destroy() {
      this.destroyed = true;
      clearTimeout(this.reconnectTimer);
      try { this.socket?.close(); } catch (_) { /* ignore */ }
    }
  };

  /* ─────────────────────────────────────────────
     INPUT SUBMISSION
  ───────────────────────────────────────────── */
  function submitInput() {
    const raw = inputEl.value.trim();
    if (!raw) return;

    historyPush(raw);
    inputEl.value = '';
    if (cmdHintEl) cmdHintEl.style.display = 'none';

    if (raw.startsWith('/')) {
      const handled = handleCommand(raw);
      if (handled) return;
      // Unknown slash command — fall through and send as plain text
    }

    addMessage(detectNick(), raw, 'msg');
    chat.sendChat(raw);
  }

  /* ─────────────────────────────────────────────
     RESIZE
  ───────────────────────────────────────────── */
  let resizing = false, rsX = 0, rsY = 0, rsW = 0, rsH = 0;

  function saveSize() {
    try {
      localStorage.setItem('ONYX_CHAT_SIZE', JSON.stringify({
        w: root.offsetWidth,
        h: root.offsetHeight
      }));
    } catch (_) { /* ignore */ }
  }

  function restoreSize() {
    try {
      const d = JSON.parse(localStorage.getItem('ONYX_CHAT_SIZE') || 'null');
      if (d?.w && d?.h) {
        root.style.width  = clamp(d.w, 220, window.innerWidth  * 0.6)  + 'px';
        root.style.height = clamp(d.h, 160, window.innerHeight * 0.55) + 'px';
      }
    } catch (_) { /* ignore */ }
  }

  /* ─────────────────────────────────────────────
     POSTMESSAGE BRIDGE (delt.io iframes)
  ───────────────────────────────────────────── */
  function onWindowMessage(event) {
    if (event.origin !== 'https://delt.io') return;
    const data = event.data;
    if (!data) return;
    if (data.type === 'DELTA_CHAT') {
      const nick = clean(data.name, 'Unknown');
      const text = clean(data.text);
      if (text) addMessage(nick, text, 'msg');
    }
  }

  /* ─────────────────────────────────────────────
     KEYBOARD HANDLER
  ───────────────────────────────────────────── */
  function onKeyDown(e) {
    const target      = e.target;
    const isChatInput = target === inputEl;
    const isOtherInput = !isChatInput && (
      target.tagName === 'INPUT'    ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable
    );
    if (isOtherInput) return;

    const toggleKeyEl = qs('#toggleChatKey') || qs('[name="chatKey"]') || qs('#chatKey');
    if (toggleKeyEl && e.code === toggleKeyEl.value) {
      e.preventDefault();
      toggleChat();
      return;
    }

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (!chatOpen)     openInput();
        else if (isChatInput) { submitInput(); closeInput(); }
        break;

      case 'Escape':
        if (chatOpen) { e.preventDefault(); closeInput(); }
        break;

      case 'ArrowUp':
        if (isChatInput && msgHistory.length) {
          e.preventDefault();
          historyIndex      = Math.min(historyIndex + 1, msgHistory.length - 1);
          inputEl.value     = msgHistory[historyIndex] || '';
          requestAnimationFrame(() =>
            inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length)
          );
        }
        break;

      case 'ArrowDown':
        if (isChatInput) {
          e.preventDefault();
          historyIndex  = Math.max(historyIndex - 1, -1);
          inputEl.value = historyIndex >= 0 ? (msgHistory[historyIndex] || '') : '';
        }
        break;

      case 'Tab':
        if (isChatInput && inputEl.value.startsWith('/')) {
          e.preventDefault();
          const partial = inputEl.value.toLowerCase();
          const match   = Object.keys(COMMANDS).find(k => k.startsWith(partial));
          if (match) { inputEl.value = match + ' '; updateCmdHint(''); }
        }
        break;
    }
  }

  /* ─────────────────────────────────────────────
     ONYX NATIVE #message INPUT BRIDGE
  ───────────────────────────────────────────── */
  function hookONYXMessageInput() {
    const msgEl = qs('#message');
    if (!msgEl || msgEl.__onyxChatHooked) return;
    msgEl.__onyxChatHooked = true;

    msgEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = clean(msgEl.value);
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      if (text.startsWith('/')) {
        const handled = handleCommand(text);
        if (handled) { msgEl.value = ''; return; }
      }
      addMessage(detectNick(), text, 'msg');
      chat.sendChat(text);
      msgEl.value = '';
    });
  }

  /* ─────────────────────────────────────────────
     PERIODIC TASKS
  ───────────────────────────────────────────── */
  let regIntervalId  = null;
  let updIntervalId  = null;
  let hookIntervalId = null;

  function startIntervals() {
    clearIntervals();
    regIntervalId  = setInterval(() => chat.tryRegisterClient(), PLAYER_REG_MS);
    updIntervalId  = setInterval(() => chat.sendPlayerUpdate(false), PLAYER_UPD_MS);
    hookIntervalId = setInterval(() => hookONYXMessageInput(), 2000);
  }

  function clearIntervals() {
    clearInterval(regIntervalId);
    clearInterval(updIntervalId);
    clearInterval(hookIntervalId);
  }

  /* ─────────────────────────────────────────────
     EVENT LISTENERS
  ───────────────────────────────────────────── */
  function attachListeners() {
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('message', onWindowMessage);

    emojiToggleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleEmojiPicker();
    });

    document.addEventListener('click', (e) => {
      if (emojiOpen && !emojiPickerEl.contains(e.target) && e.target !== emojiToggleEl) {
        closeEmojiPicker();
      }
    });

    inputEl.addEventListener('input', () => updateCmdHint(inputEl.value));
    inputEl.addEventListener('blur', () => {
      setTimeout(() => {
        if (document.activeElement !== inputEl) updateCmdHint('');
      }, 180);
    });

    resizeHandle.addEventListener('mousedown', (e) => {
      resizing = true;
      rsX = e.clientX; rsY = e.clientY;
      rsW = root.offsetWidth; rsH = root.offsetHeight;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      root.style.width  = clamp(rsW + (rsX - e.clientX), 220, window.innerWidth  * 0.6)  + 'px';
      root.style.height = clamp(rsH + (rsY - e.clientY), 160, window.innerHeight * 0.55) + 'px';
    });

    document.addEventListener('mouseup', () => { if (resizing) { resizing = false; saveSize(); } });

    // Server change → reconnect
    function wireServerSelect() {
      const sel = qs('#servers');
      if (!sel || sel.__onyxChatHooked) return;
      sel.__onyxChatHooked = true;
      sel.addEventListener('change', () => {
        chat.currentRoomToken = tokenFromUrl(chatRoomUrl());
        setTimeout(() => chat.connect(), 300);
      });
    }

    wireServerSelect();

    // Observe for late-mounted #servers
    const obs = new MutationObserver(() => { wireServerSelect(); });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* ─────────────────────────────────────────────
     PUBLIC API
  ───────────────────────────────────────────── */
  function exposeAPI() {
    const api = {
      connect:      () => chat.connect(),
      disconnect:   () => chat.destroy(),
      sendChat:     (text) => { addMessage(detectNick(), text, 'msg'); chat.sendChat(text); },
      addMessage,
      system,
      mute:         mutePlayer,
      unmute:       unmutePlayer,
      isMuted,
      showChat,
      hideChat,
      toggleChat,
      openInput,
      closeInput,
      clearHistory: () => { msgHistory.length = 0; historyIndex = -1; },
      get players()     { return chat.players; },
      get isConnected() { return chat.isOpen; },
      get chatId()      { return chat.chatId; },
    };
    window.ONYXChat    = api;
    window.ZMDeltaChat = chat;   // backward-compat alias (EON scripts)
  }

  /* ─────────────────────────────────────────────
     BOOT
  ───────────────────────────────────────────── */
  function init() {
    buildUI();
    attachListeners();
    startIntervals();
    exposeAPI();
    hookONYXMessageInput();

    // Give ONYX game scripts ~600 ms to finish their own DOM work,
    // then open the WebSocket connection.
    setTimeout(() => {
      chat.connect();
      scheduleFadeTimers();
    }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
