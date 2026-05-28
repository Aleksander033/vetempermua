(function () {
  'use strict';

  const CHAT_URL = 'wss://chat.delt.io/delta7?protocol=v1';
  const qs = (s, r = document) => r.querySelector(s);
  const nowHHMM = () => new Date().toTimeString().slice(0, 5);
  const clean = (v, fallback = '') => String(v ?? fallback).trim();

  function nicknameEl() {
    return qs('#nickname') || qs('input[name="nick"]') || qs('input[name="nickname"]') || qs('input[placeholder*="name" i]');
  }

  function detectNick() {
    return clean(nicknameEl()?.value, 'noname') || 'noname';
  }

  function detectTag() {
    return clean((qs('#tag') || qs('input[placeholder*="tag" i]'))?.value).toUpperCase();
  }

  function selectedServerUrl() {
    const select = qs('#servers');
    return clean(select?.value || localStorage.getItem('ZYNX:server') || 'wss://eu.senpa.io:2001/');
  }

  function normalizeServerUrl(url) {
    return clean(url).replace(/\/+$/, '');
  }

  function chatRoomUrl() {
    const server = normalizeServerUrl(selectedServerUrl());
    if (server === 'wss://eu.senpa.io:2001') return 'wss://eu.mi.com:2001';
    if (server === 'wss://us.senpa.io:2001') return 'wss://us.mi.com:2001';
    if (/^wss:\/\/eu\.senpa\.io:\d+$/i.test(server)) return server.replace('senpa.io', 'mi.com');
    if (/^wss:\/\/us\.senpa\.io:\d+$/i.test(server)) return server.replace('senpa.io', 'mi.com');
    return server.replace('senpa.io', 'mi.com');
  }

  function tokenFromUrl(url) {
    const m = normalizeServerUrl(url).match(/^wss?:\/\/(.+)/i);
    return m ? btoa(m[1]) : '';
  }

  function makeProtocol() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes).map((value, index, all) => {
      const next = (all[index + 3] || 0) ^ (all[index + 2] || 0);
      return (index % 5 === 0 ? next : value).toString(16).padStart(2, '0');
    }).join('');
  }

  class Writer {
    constructor(size = 8192) {
      this.buffer = new ArrayBuffer(size);
      this.view = new DataView(this.buffer);
      this.bytes = new Uint8Array(this.buffer);
      this.offset = 0;
    }
    writeUInt8(v) { this.view.setUint8(this.offset++, v & 255); }
    writeUInt16(v) { this.view.setUint16(this.offset, v & 65535, true); this.offset += 2; }
    writeUInt32(v) { this.view.setUint32(this.offset, v >>> 0, true); this.offset += 4; }
    writeInt16(v) { this.view.setInt16(this.offset, v || 0, true); this.offset += 2; }
    writeInt32(v) { this.view.setInt32(this.offset, v || 0, true); this.offset += 4; }
    writeUInt24(v) { this.writeUInt8((v & 0xff0000) >>> 16); this.writeUInt8((v & 0xff00) >>> 8); this.writeUInt8(v & 0xff); }
    writeUTF16String(str) { for (const ch of String(str || '')) this.writeUInt16(ch.charCodeAt(0)); }
    writeUTF16StringZero(str) { this.writeUTF16String(str); this.writeUInt16(0); }
    writeUTF16StringLength(str) {
      const s = String(str || '').slice(0, 255);
      this.writeUInt8(s.length);
      this.writeUTF16String(s);
    }
    finalize() { return this.bytes.slice(0, this.offset); }
  }

  class Reader {
    constructor(data) {
      const buffer = data instanceof ArrayBuffer ? data : data.buffer;
      this.view = new DataView(buffer, data.byteOffset || 0, data.byteLength || buffer.byteLength);
      this.offset = 0;
    }
    readUInt8() { return this.view.getUint8(this.offset++); }
    readInt8() { return this.view.getInt8(this.offset++); }
    readUInt16() { const v = this.view.getUint16(this.offset, true); this.offset += 2; return v; }
    readInt16() { const v = this.view.getInt16(this.offset, true); this.offset += 2; return v; }
    readUInt24() { return (this.readUInt8() << 16) | (this.readUInt8() << 8) | this.readUInt8(); }
    readUInt32() { const v = this.view.getUint32(this.offset, true); this.offset += 4; return v; }
    readInt32() { const v = this.view.getInt32(this.offset, true); this.offset += 4; return v; }
    readUTF16StringLength() {
      const len = this.readUInt8();
      let out = '';
      for (let i = 0; i < len && this.offset + 1 < this.view.byteLength; i++) out += String.fromCharCode(this.readUInt16());
      return out;
    }
  }

  const root = document.createElement('div');
  root.className = 'chat-container';
  root.style.display = 'flex';
  root.style.position = 'fixed';
  root.style.left = '12px';
  root.style.bottom = '12px';
  root.style.zIndex = '50';
  setTimeout(() => { root.style.display = 'none'; }, 1000);
  root.innerHTML = `
    <div class="chat-resize-handle" id="CHATResize"></div>
    <div class="chat-messages" id="CHATLog"></div>
    <div class="chat-input-container" id="CHATInputWrap">
      <div id="emoji-picker" class="emoji-picker"></div>
      <input class="chat-input-field" id="CHATInput" maxlength="100" placeholder="Press Enter to Chat..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
      <div class="emoji-toggle" id="CHATEmojiToggle" style="display:none"></div>
    </div>
  `;
  document.body.appendChild(root);

  const logEl = root.querySelector('#CHATLog');
  const inputWrap = root.querySelector('#CHATInputWrap');
  const inputEl = root.querySelector('#CHATInput');
  let chatOpen = false;
  let chatVisible = false;

  function addMessage(nick, text, type = 'msg') {
    const row = document.createElement('div');
    row.className = 'chat-message-row' + (type === 'cmd' ? ' cmd' : '');
    row.innerHTML = `
      <span class="chat-time">[${nowHHMM()}]</span>
      <span class="chat-id"></span>
      <span class="chat-nick"></span>
      <span class="chat-text"></span>
    `;
    row.querySelector('.chat-nick').textContent = nick ? `${nick}:` : '';
    row.querySelector('.chat-text').textContent = clean(text);
    logEl.prepend(row);
  }

  function system(text) { addMessage('•', text, 'cmd'); }

  function getPrimaryClient() {
    const clients = window.multibox && Array.isArray(window.multibox.clients) ? window.multibox.clients : [];
    return clients.find(c => c && c.clientID) || clients[0] || null;
  }

  const chat = {
    socket: null,
    connectionID: null,
    chatId: null,
    registeredClientId: null,
    players: new Map,
    reconnectTimer: null,
    currentRoomToken: '',

    get isOpen() { return this.socket && this.socket.readyState === WebSocket.OPEN; },

    connect() {
      clearTimeout(this.reconnectTimer);
      try { if (this.socket) this.socket.close(); } catch {}
      this.connectionID = null;
      this.chatId = null;
      this.registeredClientId = null;
      this.currentRoomToken = tokenFromUrl(chatRoomUrl());
      this.socket = new WebSocket(CHAT_URL, makeProtocol());
      this.socket.binaryType = 'arraybuffer';
      this.socket.onopen = () => {
        const w = new Writer();
        w.writeUInt16(0);
        this.send(w);
        // "Connecting to delt.io chat..." mesajı kaldırıldı.
      };
      this.socket.onmessage = (event) => this.onMessage(event.data);
      this.socket.onclose = () => {
        // "Chat disconnected, reconnecting..." mesajı kaldırıldı.
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      };
      this.socket.onerror = () => { /* "Chat socket error" mesajı opsiyonel olarak susturuldu. */ };
    },

    send(packet) {
      if (!this.isOpen) return false;
      this.socket.send(packet instanceof Writer ? packet.finalize() : packet);
      return true;
    },

    enterRoom() {
      const token = this.currentRoomToken || tokenFromUrl(chatRoomUrl());
      const tag = detectTag();
      const w = new Writer();
      let flags = 0;
      w.writeUInt8(9);
      w.writeUInt8(0);
      [
        [token, 1],
        [tag, 2],
        ['', 4],
        [':party', 8],
        ['', 16],
      ].forEach(([value, bit]) => {
        if (typeof value === 'string') {
          flags |= bit;
          w.writeUTF16StringZero(value);
        }
      });
      w.view.setUint8(1, flags);
      this.send(w);
      // "Joined chat room..." mesajı kaldırıldı.
      this.tryRegisterClient();
    },

    tryRegisterClient() {
      if (!this.isOpen) return;
      const client = getPrimaryClient();
      const id = Number(client && client.clientID);
      if (!id || this.registeredClientId === id) return;
      this.registeredClientId = id;
      const w = new Writer();
      w.writeUInt8(1);
      w.writeUInt32(id);
      this.send(w);
      this.sendPlayerUpdate(true);
    },

    sendPlayerUpdate(force = false) {
      if (!this.isOpen || !this.chatId) return;
      const client = getPrimaryClient();
      const playerId = Number(client?.multiboxID || client?.stores?.ownedIDs?.[0] || this.chatId || 1);
      const clientId = Number(client?.clientID || this.registeredClientId || 0);
      const nick = detectNick();
      const tag = detectTag();
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
      // "Registered with delt.io chat" mesajı kaldırıldı.
    },

    parsePlayerUpdates(r) {
      while (r.offset + 2 <= r.view.byteLength) {
        const playerId = r.readUInt16();
        if (playerId === 0) break;
        const flags = r.readUInt8();
        const info = this.players.get(playerId) || { playerId };
        if (flags & 1) {
          const f = r.readUInt8();
          if (f & 1) info.clientId = r.readUInt16();
          if (f & 2) info.nick = r.readUTF16StringLength();
          if (f & 4) info.customSkin = r.readUTF16StringLength();
          if (f & 8) info.customColor = r.readUInt24();
          if (f & 16) r.readUTF16StringLength();
          if (f & 32) info.pColor = r.readUInt24();
          if (f & 64) info.tabId = r.readUInt32();
        }
        if (flags & 2) { info.position = { x: r.readInt16(), y: r.readInt16(), mass: r.readUInt32() }; }
        if (flags & 4) info.isAlive = r.readUInt8() !== 0;
        if (flags & 8) r.readInt8();
        this.players.set(playerId, info);
      }
    },

    parseMessage(r) {
      const rawType = r.readUInt8();
      const type = rawType === 1 ? 'msg' : rawType === 2 ? 'cmd' : String(rawType);
      r.readUInt16();
      const playerID = r.readUInt16();
      r.readUInt16();
      let nick = r.readUTF16StringLength();
      const text = r.readUTF16StringLength();
      if (!nick && this.players.get(playerID)?.nick) nick = this.players.get(playerID).nick;
      addMessage(nick || `unnamed#${playerID}`, text, type);
    },

    onMessage(data) {
      const r = new Reader(data);
      const op = r.readUInt8();
      if (op === 0) {
        this.connectionID = r.readUInt16();
        this.enterRoom();
      } else if (op === 1) {
        const tabID = r.readUInt32();
        this.chatId = r.readUInt16();
        // "Chat tab registered..." mesajı kaldırıldı.
        this.sendPlayerUpdate(true);
      } else if (op === 12) {
        while (r.offset + 2 <= r.view.byteLength) {
          const id = r.readUInt16();
          if (!id) break;
          this.players.delete(id);
        }
      } else if (op === 16) {
        this.parsePlayerUpdates(r);
      } else if (op === 25) {
        this.parseMessage(r);
      }
    },

    sendChat(text) {
      this.tryRegisterClient();
      if (!this.chatId) {
        // Bu hata mesajını, kullanıcı mesaj yazmaya çalıştığında bilgilendirmek için bıraktım.
        system('Chat is not registered yet, wait until you spawn/connect.');
        return;
      }
      const nick = detectNick();
      const w = new Writer();
      w.writeUInt8(25);
      w.writeUInt8(1);
      w.writeUInt16(0);
      w.writeUInt16(this.chatId);
      w.writeUInt16(0);
      w.writeUTF16StringLength(nick);
      w.writeUTF16StringLength(text);
      this.send(w);
    }
  };

  function openInput() {
    chatOpen = true;
    chatVisible = true;
    root.style.display = 'flex';
    inputWrap.classList.add('active');
    setTimeout(() => inputEl.focus(), 0);
  }

  function closeInput() {
    chatOpen = false;
    inputWrap.classList.remove('active');
    inputEl.blur();
  }

  function sendFromInput() {
    const text = inputEl.value.trim();
    if (!text) return;
    chat.sendChat(text);
    addMessage(detectNick(), text, 'msg');
    inputEl.value = '';
  }

  function toggleChatHUD() {
    chatVisible = !chatVisible;
    root.style.display = chatVisible ? 'flex' : 'none';
  }

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const isChatInput = target === inputEl;
    if ((target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) && !isChatInput) return;

    const toggleKeyInput = document.getElementById('toggleChatHUDKey');
    if (toggleKeyInput && e.code === toggleKeyInput.value) {
      e.preventDefault();
      toggleChatHUD();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      if (!chatOpen) openInput();
      else if (isChatInput) {
        sendFromInput();
        closeInput();
      }
    }

    if (e.key === 'Escape' && chatOpen) {
      e.preventDefault();
      closeInput();
    }
  });

  const resize = root.querySelector('#CHATResize');
  let resizing = false;
  resize.addEventListener('mousedown', (e) => { resizing = true; e.preventDefault(); });
  document.addEventListener('mousemove', (e) => {
    if (!resizing) return;
    const rect = root.getBoundingClientRect();
    root.style.width = `${Math.max(240, rect.right - e.clientX)}px`;
    root.style.height = `${Math.max(180, rect.bottom - e.clientY)}px`;
  });
  document.addEventListener('mouseup', () => { resizing = false; });

  qs('#servers')?.addEventListener('change', () => setTimeout(() => chat.connect(), 250));
  setInterval(() => chat.tryRegisterClient(), 1000);
  setInterval(() => chat.sendPlayerUpdate(false), 1000);

  window.ZMDeltaChat = chat;
  chat.connect();
})();
