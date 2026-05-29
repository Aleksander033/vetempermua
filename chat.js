(function () {
  'use strict';

  /* ─────────────────────────────────────────────
     HEADLESS EON→ONYX CHAT ADAPTER
     ─────────────────────────────────────────────
     This script is a pure networking/logic layer.
     It creates NO new HTML, NO new overlays, NO new UI.
     All incoming messages are routed into the existing
     ONYX #chatroom element.
     All outgoing messages are intercepted from the
     existing #message input that ONYX already owns.
  ───────────────────────────────────────────── */

  const CHAT_WS_URL      = 'wss://chat.delt.io/delta7?protocol=v1';
  const RECONNECT_BASE   = 2000;
  const RECONNECT_MAX    = 30000;
  const SPAM_MIN_MS      = 600;
  const SPAM_BURST_MAX   = 5;
  const SPAM_WINDOW_MS   = 4000;
  const PLAYER_REG_MS    = 800;
  const PLAYER_UPD_MS    = 2000;

  /* ─────────────────────────────────────────────
     ONYX DOM ACCESSORS  (read-only, never written)
  ───────────────────────────────────────────── */
  const getMessageInput  = () => document.getElementById('message');
  const getChatroom      = () => document.getElementById('chatroom');
  const getMessageHud    = () => document.getElementById('message-hud');
  const getNick          = () => {
    const el = document.getElementById('nick') ||
               document.getElementById('nickname') ||
               document.querySelector('input[name="nick"]') ||
               document.querySelector('input[name="nickname"]');
    return (el?.value || '').trim() || 'player';
  };
  const getTag = () => {
    const el = document.querySelector('#tag, input[placeholder*="tag" i]');
    return (el?.value || '').trim().toUpperCase();
  };
  const getServerUrl = () => {
    const sel = document.getElementById('servers');
    let raw = (sel?.value || localStorage.getItem('ZYNX:server') || 'eu.senpa.io:2001').trim();
    if (!raw.startsWith('ws')) raw = 'wss://' + raw;
    return raw;
  };
  const chatRoomUrl = () => getServerUrl().replace(/senpa\.io/gi, 'mi.com');
  const tokenFromUrl = (url) => {
    const m = url.replace(/\/+$/, '').match(/^wss?:\/\/(.+)/i);
    return m ? btoa(m[1]) : '';
  };

  /* ─────────────────────────────────────────────
     STABLE CLIENT ID FALLBACK
  ───────────────────────────────────────────── */
  function getFallbackClientId() {
    const KEY = 'ONYX_CHAT_CLIENT_ID';
    let id = parseInt(sessionStorage.getItem(KEY), 10);
    if (!id || id <= 0) {
      id = (crypto.getRandomValues(new Uint32Array(1))[0] % 0x7fffffff) + 1;
      sessionStorage.setItem(KEY, String(id));
    }
    return id;
  }
  function getPrimaryClient() {
    const c = Array.isArray(window.multibox?.clients) ? window.multibox.clients : [];
    return c.find(x => x?.clientID) || c[0] || null;
  }
  function resolveClientId() {
    return Number(getPrimaryClient()?.clientID) || getFallbackClientId();
  }

  /* ─────────────────────────────────────────────
     BINARY PROTOCOL
  ───────────────────────────────────────────── */
  class Writer {
    constructor(size = 4096) {
      this.buffer = new ArrayBuffer(size);
      this.view   = new DataView(this.buffer);
      this.bytes  = new Uint8Array(this.buffer);
      this.offset = 0;
    }
    writeUInt8(v)  { this.view.setUint8(this.offset++, v & 0xff); }
    writeUInt16(v) { this.view.setUint16(this.offset, v & 0xffff, true); this.offset += 2; }
    writeUInt32(v) { this.view.setUint32(this.offset, v >>> 0,    true); this.offset += 4; }
    writeUTF16String(str) {
      for (const ch of String(str || '')) this.writeUInt16(ch.charCodeAt(0));
    }
    writeUTF16StringZero(str)   { this.writeUTF16String(str); this.writeUInt16(0); }
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
    readUInt8()  { return this.view.getUint8(this.offset++); }
    readUInt16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    readUInt32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
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
     ANTI-SPAM
  ───────────────────────────────────────────── */
  let lastSendTime = 0;
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
     SEND QUEUE  (holds messages while chatId is pending)
  ───────────────────────────────────────────── */
  const sendQueue = [];
  function enqueueSend(nick, text) { sendQueue.push({ nick, text, ts: Date.now() }); }
  function flushSendQueue() {
    const now = Date.now();
    while (sendQueue.length) {
      const item = sendQueue.shift();
      if (now - item.ts > 8000) continue;
      dispatchPacket(item.nick, item.text);
    }
  }
  function dispatchPacket(nick, text) {
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
     RENDER INTO EXISTING #chatroom
     ─────────────────────────────────────────────
     This is the ONLY place we touch the DOM.
     We write into the element ONYX already owns —
     no new elements are created outside #chatroom.
  ───────────────────────────────────────────── */
  function renderMessage(nick, text) {
    const chatroom = getChatroom();
    if (!chatroom) return;

    const now  = new Date();
    const hh   = now.getHours().toString().padStart(2, '0');
    const mm   = now.getMinutes().toString().padStart(2, '0');
    const time = hh + ':' + mm;

    const row      = document.createElement('div');
    row.className  = 'chatroom-row';
    row.innerHTML  =
      '<span class="chattime">' + time + '</span>' +
      '<span class="nick">' + escHtml(nick) + '</span>' +
      '<span class="msg"> ' + escHtml(text) + '</span>';

    chatroom.appendChild(row);
    chatroom.scrollTop = chatroom.scrollHeight;

    const MAX = 120;
    while (chatroom.children.length > MAX) chatroom.removeChild(chatroom.firstChild);
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ─────────────────────────────────────────────
     WEBSOCKET CLIENT
  ───────────────────────────────────────────── */
  const chat = {
    socket:             null,
    chatId:             null,
    connectionID:       null,
    registeredClientId: null,
    players:            new Map(),
    reconnectTimer:     null,
    reconnectAttempts:  0,
    destroyed:          false,

    get isOpen() {
      return this.socket !== null && this.socket.readyState === WebSocket.OPEN;
    },

    connect() {
      if (this.destroyed) return;
      clearTimeout(this.reconnectTimer);
      try { this.socket?.close(); } catch (_) {}

      this.chatId             = null;
      this.connectionID       = null;
      this.registeredClientId = null;

      let ws;
      try { ws = new WebSocket(CHAT_WS_URL, makeProtocol()); }
      catch (_) { this._scheduleReconnect(); return; }

      this.socket            = ws;
      this.socket.binaryType = 'arraybuffer';

      this.socket.onopen = () => {
        this.reconnectAttempts = 0;
        const w = new Writer();
        w.writeUInt16(0);
        this.send(w);
      };
      this.socket.onmessage = (e) => { try { this.onMessage(e.data); } catch (_) {} };
      this.socket.onclose   = () => { if (!this.destroyed) this._scheduleReconnect(); };
      this.socket.onerror   = () => {};
    },

    _scheduleReconnect() {
      const delay = Math.min(RECONNECT_BASE * Math.pow(1.6, this.reconnectAttempts++), RECONNECT_MAX);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    },

    send(packet) {
      if (!this.isOpen) return false;
      try { this.socket.send(packet instanceof Writer ? packet.finalize() : packet); return true; }
      catch (_) { return false; }
    },

    enterRoom() {
      const token = tokenFromUrl(chatRoomUrl());
      const tag   = getTag();
      const w     = new Writer();
      let flags   = 0;
      w.writeUInt8(9);
      w.writeUInt8(0);
      [[token, 1], [tag, 2], ['', 4], [':party', 8], ['', 16]].forEach(([v, bit]) => {
        flags |= bit;
        w.writeUTF16StringZero(String(v));
      });
      w.view.setUint8(1, flags);
      this.send(w);
      this._doRegisterClient();
    },

    _doRegisterClient() {
      if (!this.isOpen) return;
      const id = resolveClientId();
      if (this.registeredClientId === id) return;
      this.registeredClientId = id;
      const w = new Writer();
      w.writeUInt8(1);
      w.writeUInt32(id);
      this.send(w);
    },

    tryRegisterClient() {
      if (!this.isOpen) return;
      const realId = Number(getPrimaryClient()?.clientID);
      if (realId && realId !== this.registeredClientId) {
        this.registeredClientId = realId;
        const w = new Writer();
        w.writeUInt8(1);
        w.writeUInt32(realId);
        this.send(w);
        this.sendPlayerUpdate(true);
      } else if (!this.chatId) {
        this._doRegisterClient();
      }
    },

    sendPlayerUpdate(force = false) {
      if (!this.isOpen || !this.chatId) return;
      const clientId = resolveClientId();
      const nick     = getNick();
      const w = new Writer();
      w.writeUInt8(16);
      w.writeUInt16(this.chatId);
      w.writeUInt8(1);
      w.writeUInt8(1 | 2 | 64);
      w.writeUInt16(clientId);
      w.writeUTF16StringLength(nick);
      w.writeUInt32(clientId);
      w.writeUInt16(0);
      this.send(w);
    },

    onMessage(data) {
      const r  = new Reader(data);
      const op = r.readUInt8();
      switch (op) {
        case 0:
          this.connectionID = r.readUInt16();
          this.enterRoom();
          break;
        case 1:
          r.readUInt32();
          this.chatId = r.readUInt16();
          this.sendPlayerUpdate(true);
          flushSendQueue();
          break;
        case 12:
          while (r.remaining >= 2) {
            const id = r.readUInt16();
            if (!id) break;
            this.players.delete(id);
          }
          break;
        case 16:
          this._parsePlayerUpdates(r);
          break;
        case 25:
          this._parseMessage(r);
          break;
      }
    },

    _parsePlayerUpdates(r) {
      while (r.remaining >= 2) {
        const pid = r.readUInt16();
        if (!pid) break;
        if (r.remaining < 1) break;
        const flags = r.readUInt8();
        const info  = this.players.get(pid) || { pid };
        if (flags & 1) {
          const f = r.remaining >= 1 ? r.readUInt8() : 0;
          if (f &  1) info.clientId = r.readUInt16();
          if (f &  2) info.nick     = r.readUTF16StringLength();
          if (f &  4) r.readUTF16StringLength();
          if (f &  8) { r.readUInt8(); r.readUInt8(); r.readUInt8(); }
          if (f & 16) r.readUTF16StringLength();
          if (f & 32) { r.readUInt8(); r.readUInt8(); r.readUInt8(); }
          if (f & 64) r.readUInt32();
        }
        if (flags & 2) { r.readUInt16(); r.readUInt16(); r.readUInt32(); }
        if (flags & 4) r.readUInt8();
        if (flags & 8) r.readUInt8();
        this.players.set(pid, info);
      }
    },

    _parseMessage(r) {
      r.readUInt8();
      r.readUInt16();
      const pid  = r.readUInt16();
      r.readUInt16();
      let   nick = r.readUTF16StringLength();
      const text = r.readUTF16StringLength();
      if (!nick) nick = this.players.get(pid)?.nick || ('player#' + pid);
      renderMessage(nick, text);
    },

    /* Public send — called by the #message input handler */
    sendChat(text) {
      const trimmed = (text || '').trim();
      if (!trimmed || !this.isOpen) return;
      if (!canSend()) return;
      recordSend();
      const nick = getNick();
      if (!this.chatId) {
        enqueueSend(nick, trimmed);
        this._doRegisterClient();
        return;
      }
      dispatchPacket(nick, trimmed);
    },

    destroy() {
      this.destroyed = true;
      clearTimeout(this.reconnectTimer);
      try { this.socket?.close(); } catch (_) {}
    }
  };

  /* ─────────────────────────────────────────────
     PROTOCOL HELPER
  ───────────────────────────────────────────── */
  function makeProtocol() {
    const b = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b).map((v, i, a) => {
      const n = (a[(i + 3) % 16] || 0) ^ (a[(i + 2) % 16] || 0);
      return (i % 5 === 0 ? n : v).toString(16).padStart(2, '0');
    }).join('');
  }

  /* ─────────────────────────────────────────────
     HOOK INTO THE EXISTING #message INPUT
     ─────────────────────────────────────────────
     We intercept the Enter key on ONYX's own input.
     ONYX's own submit handler still fires — we only
     additionally send the text over the EON socket.
     No input field is created or replaced.
  ───────────────────────────────────────────── */
  function hookMessageInput() {
    const input = getMessageInput();
    if (!input || input.__eonChatHooked) return;
    input.__eonChatHooked = true;

    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const text = (input.value || '').trim();
      if (!text) return;
      chat.sendChat(text);
      /* We do NOT call e.preventDefault() so ONYX's own handler
         can still clear the input and close the HUD normally. */
    }, true);   /* capture = true so we fire before ONYX's handler */
  }

  /* ─────────────────────────────────────────────
     HOOK INTO THE EXISTING #message SEND BUTTON
     (if ONYX exposes one)
  ───────────────────────────────────────────── */
  function hookSendButton() {
    const btn = document.getElementById('sendChat') ||
                document.getElementById('chat-send') ||
                document.querySelector('#message-hud button[type="submit"]') ||
                document.querySelector('#message-hud .send-btn');
    if (!btn || btn.__eonChatHooked) return;
    btn.__eonChatHooked = true;
    btn.addEventListener('click', () => {
      const input = getMessageInput();
      const text  = (input?.value || '').trim();
      if (text) chat.sendChat(text);
    });
  }

  /* ─────────────────────────────────────────────
     PERIODIC TASKS
  ───────────────────────────────────────────── */
  function startIntervals() {
    setInterval(() => chat.tryRegisterClient(),       PLAYER_REG_MS);
    setInterval(() => chat.sendPlayerUpdate(false),   PLAYER_UPD_MS);
    setInterval(() => {
      hookMessageInput();
      hookSendButton();
    }, 1500);
  }

  /* ─────────────────────────────────────────────
     SERVER SELECT — reconnect when user changes server
  ───────────────────────────────────────────── */
  function wireServerSelect() {
    const sel = document.getElementById('servers');
    if (!sel || sel.__eonChatHooked) return;
    sel.__eonChatHooked = true;
    sel.addEventListener('change', () => {
      setTimeout(() => chat.connect(), 300);
    });
  }

  /* ─────────────────────────────────────────────
     PUBLIC API  (backward-compat with EON scripts)
  ───────────────────────────────────────────── */
  window.ONYXChat    = { sendChat: (t) => chat.sendChat(t), get isConnected() { return chat.isOpen; } };
  window.ZMDeltaChat = chat;

  /* ─────────────────────────────────────────────
     BOOT
  ───────────────────────────────────────────── */
  function init() {
    hookMessageInput();
    hookSendButton();
    wireServerSelect();
    startIntervals();

    new MutationObserver(() => {
      hookMessageInput();
      hookSendButton();
      wireServerSelect();
    }).observe(document.body, { childList: true, subtree: true });

    setTimeout(() => chat.connect(), 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
