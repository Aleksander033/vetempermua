/**
 * sav.js — ONYX Replay Recorder (drop-in)
 * ---------------------------------------------------------------
 * Regjistron vazhdimisht 15 sekondat e fundit të lojës nga <canvas>
 * dhe i ruan si .webm kur shtypet tasti "P" ose thirret API publik.
 *
 * Arkitektura (shkurt):
 *  • captureStream(fps)  → MediaStream nga canvas-i i lojës ONYX.
 *  • MediaRecorder       → kodon në copa (chunks) çdo `timeSliceMs` ms.
 *  • Ring buffer         → mbahen vetëm N copat e fundit (≈15s),
 *                          të vjetrat hidhen → memorie e qëndrueshme.
 *  • saveClip()          → bashkon copat në një Blob webm dhe e shkarkon.
 *  • Auto-recovery       → nëse recorder-i ndalon papritur, ristartohet.
 *  • Cleanup             → pas ruajtjes buffer-i pastrohet (opsion).
 *
 * Si kapen "15 sekondat e fundit":
 *  maxChunks = ceil(bufferLength * 1000 / timeSliceMs).
 *  Çdo `ondataavailable` shton një copë; kur kalon maxChunks → shift().
 *  Pra dritarja rrëshqitëse përmban gjithmonë ≤ bufferLength sekonda.
 *
 * Drop-in: thjesht `<script src="sav.js"></script>` pas ngarkimit të lojës.
 * API global: window.OnyxReplay.{start,stop,save,clear,isRecording}
 * ---------------------------------------------------------------
 */
(() => {
  'use strict';

  // -------- Konfigurimi default (mund të mbishkruhet me window.ONYX_REPLAY_CONFIG) --------
  const CFG = Object.assign({
    bufferLength: 15,        // sekonda të mbajtura në buffer
    timeSliceMs: 1000,       // sa shpesh të prodhohen copat
    fps: 30,                 // frame rate i kapur nga canvas
    hotkey: 'p',             // tasti i shpejtë i ruajtjes
    audio: false,            // përfshi audion e tabit (nëse mundet)
    autoClearOnSave: false,  // pastro buffer-in pas ruajtjes
    filenamePrefix: 'Onyx',  // prefiks për emrin e file-it
    canvasSelector: null,    // p.sh. '#canvas' (auto-detect nëse null)
    maxBlobBytes: 80 * 1024 * 1024, // limit mbrojtës ndaj rritjes pa kontroll
    debug: true,
  }, (typeof window !== 'undefined' && window.ONYX_REPLAY_CONFIG) || {});

  const log  = (...a) => CFG.debug && console.log('%c[OnyxReplay]', 'color:#6111ff;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[OnyxReplay]', ...a);
  const err  = (...a) => console.error('[OnyxReplay]', ...a);

  // -------- Përzgjedhja e mimeType më të mirë në dispozicion --------
  const pickMime = () => {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4',
    ];
    return candidates.find(t => MediaRecorder.isTypeSupported(t)) || null;
  };

  class ReplayRecorder {
    constructor(opts = {}) {
      this.cfg = Object.assign({}, CFG, opts);
      this.maxChunks = Math.max(2, Math.ceil((this.cfg.bufferLength * 1000) / this.cfg.timeSliceMs) + 1);
      this.chunks = [];
      this.bytes = 0;
      this.canvas = null;
      this.stream = null;
      this.recorder = null;
      this.isRecording = false;
      this._restartTimer = null;
      this._boundVisibility = this._onVisibility.bind(this);
    }

    /** Gjen canvas-in e ONYX (ose përdor selektorin e dhënë). */
    _resolveCanvas(canvasOrEl) {
      if (canvasOrEl instanceof HTMLCanvasElement) return canvasOrEl;
      if (this.cfg.canvasSelector) {
        const el = document.querySelector(this.cfg.canvasSelector);
        if (el instanceof HTMLCanvasElement) return el;
      }
      // Heuristikë: ID-të e zakonshme ONYX/agar, pastaj canvas-i më i madh.
      const byId = document.getElementById('canvas')
                || document.getElementById('game-canvas')
                || document.getElementById('gameCanvas');
      if (byId instanceof HTMLCanvasElement) return byId;
      const all = Array.from(document.querySelectorAll('canvas'));
      if (!all.length) return null;
      return all.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
    }

    /** Nis regjistrimin në buffer. */
    start(canvasOrEl) {
      if (this.isRecording) return true;
      if (typeof MediaRecorder === 'undefined') {
        err('MediaRecorder nuk mbështetet nga ky browser.');
        return false;
      }
      const canvas = this._resolveCanvas(canvasOrEl);
      if (!canvas || typeof canvas.captureStream !== 'function') {
        warn('Canvas nuk u gjet ende — do të riprovohet.');
        return false;
      }

      try {
        this.canvas = canvas;
        this.stream = canvas.captureStream(this.cfg.fps);

        // Audio opsionale (mute fail → vazhdo pa audio).
        if (this.cfg.audio) {
          try {
            const ctxAudio = window.__onyxAudioStream;
            if (ctxAudio && ctxAudio.getAudioTracks) {
              ctxAudio.getAudioTracks().forEach(t => this.stream.addTrack(t));
            }
          } catch (_) { /* injorohet */ }
        }

        const mimeType = pickMime();
        if (!mimeType) { err('Asnjë mimeType i mbështetur.'); return false; }

        this.recorder = new MediaRecorder(this.stream, {
          mimeType,
          videoBitsPerSecond: 2_500_000, // ~2.5 Mbps – balancë cilësi/madhësi
        });
        this._mimeType = mimeType;

        this.recorder.ondataavailable = (e) => this._onData(e);
        this.recorder.onerror = (e) => err('MediaRecorder error', e.error || e);
        this.recorder.onstop = () => {
          // Ristart automatik nëse nuk është ndalim i kërkuar nga përdoruesi.
          if (this._wantRunning) this._scheduleRestart(250);
        };

        this.chunks = [];
        this.bytes = 0;
        this._wantRunning = true;
        this.recorder.start(this.cfg.timeSliceMs);
        this.isRecording = true;

        document.addEventListener('visibilitychange', this._boundVisibility);
        log(`Buffer ${this.cfg.bufferLength}s aktiv (${mimeType}, ${this.cfg.fps}fps).`);
        return true;
      } catch (e) {
        err('Dështoi nisja:', e);
        this._cleanupStream();
        return false;
      }
    }

    _onData(event) {
      const data = event && event.data;
      if (!data || !data.size) return;
      this.chunks.push(data);
      this.bytes += data.size;

      // Ring buffer: heq copat më të vjetra për të mbajtur dritaren ≈15s.
      while (this.chunks.length > this.maxChunks) {
        const dropped = this.chunks.shift();
        this.bytes -= dropped.size || 0;
      }
      // Mbrojtje shtesë kundër rritjes së memories.
      while (this.bytes > this.cfg.maxBlobBytes && this.chunks.length > 1) {
        const dropped = this.chunks.shift();
        this.bytes -= dropped.size || 0;
      }
    }

    _scheduleRestart(delay) {
      if (this._restartTimer) return;
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        this.isRecording = false;
        this._cleanupStream();
        if (this._wantRunning) this.start(this.canvas);
      }, delay);
    }

    _onVisibility() {
      // Disa browser-a ndalojnë captureStream kur tab-i është i fshehur.
      if (!document.hidden && this._wantRunning && !this.isRecording) {
        this._scheduleRestart(100);
      }
    }

    _cleanupStream() {
      try { this.recorder && this.recorder.state !== 'inactive' && this.recorder.stop(); } catch (_) {}
      try { this.stream && this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
      this.recorder = null;
      this.stream = null;
    }

    /** Ndalon plotësisht regjistrimin (pa ruajtur). */
    stop() {
      this._wantRunning = false;
      document.removeEventListener('visibilitychange', this._boundVisibility);
      this._cleanupStream();
      this.isRecording = false;
      log('U ndal.');
    }

    /** Pastron buffer-in pa ndalur regjistrimin. */
    clear() {
      this.chunks = [];
      this.bytes = 0;
    }

    /** Ruan 15 sekondat e fundit si .webm. */
    async save(filename) {
      if (!this.chunks.length) { warn('Buffer bosh — prit pak.'); return null; }

      // Kërko një copë të freskët para se të bashkojmë (më pak humbje).
      try {
        if (this.recorder && this.recorder.state === 'recording' && this.recorder.requestData) {
          this.recorder.requestData();
          await new Promise(r => setTimeout(r, 80));
        }
      } catch (_) { /* injorohet */ }

      const type = (this._mimeType || 'video/webm').split(';')[0];
      const blob = new Blob(this.chunks.slice(), { type });
      const url = URL.createObjectURL(blob);
      const name = filename || this._defaultName(type);

      try {
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        // Çlirim memorie i sigurt edhe nëse shkarkimi dështon.
        setTimeout(() => URL.revokeObjectURL(url), 1500);
      }

      log(`U ruajt: ${name} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
      if (this.cfg.autoClearOnSave) this.clear();
      return blob;
    }

    _defaultName(type) {
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return `${this.cfg.filenamePrefix}-${ts}.${ext}`;
    }
  }

  // -------- Inicializimi automatik kur canvas-i është gati --------
  const recorder = new ReplayRecorder();

  const tryStart = (attemptsLeft = 30) => {
    if (recorder.start()) return;
    if (attemptsLeft <= 0) { warn('Nuk u gjet canvas pas shumë provave.'); return; }
    setTimeout(() => tryStart(attemptsLeft - 1), 1000);
  };

  const boot = () => {
    tryStart();

    // Hotkey: P (pa qenë në input/chat).
    window.addEventListener('keydown', (e) => {
      if (!e.key || e.key.toLowerCase() !== CFG.hotkey) return;
      const ae = document.activeElement;
      const inField = ae && (
        ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' ||
        ae.isContentEditable || ae.id === 'chat_message' || ae.id === 'chat-input'
      );
      if (inField) return;
      e.preventDefault();
      recorder.save();
    }, { passive: false });

    // Trigger opsional për kill/death (nëse loja emit-on evente).
    const onClipEvent = (ev) => {
      const tag = (ev && ev.detail && ev.detail.type) || 'event';
      recorder.save(`${CFG.filenamePrefix}-${tag}-${Date.now()}.webm`);
    };
    window.addEventListener('onyx:kill',  onClipEvent);
    window.addEventListener('onyx:death', onClipEvent);
    window.addEventListener('onyx:clip',  onClipEvent);

    // Pastrim para mbylljes së faqes (evitim memory-leak).
    window.addEventListener('pagehide', () => recorder.stop(), { once: true });
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    boot();
  } else {
    window.addEventListener('DOMContentLoaded', boot, { once: true });
  }

  // -------- API global --------
  window.OnyxReplay = {
    start:  (el) => recorder.start(el),
    stop:   ()    => recorder.stop(),
    save:   (n)   => recorder.save(n),
    clear:  ()    => recorder.clear(),
    get isRecording() { return recorder.isRecording; },
    _instance: recorder,
  };
})();

