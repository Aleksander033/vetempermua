/**
 * sav.js — ONYX Replay Recorder (drop-in, fixed)
 * ---------------------------------------------------------------
 * Rregullim kryesor vs versionit të vjetër:
 *  • Mban "header chunk" (copën e parë me init segment të WebM)
 *    dhe e prepend-on në çdo save → videoja luhet GJITHMONË, jo vetëm herën e parë.
 *  • Pas save, recorder-i ristartohet pastër që header-i të rigjenerohet.
 *  • Cleanup i plotë i MediaStream + MediaRecorder, pa memory leak.
 *  • Mbrojtje nga thirrjet e dyfishta (save në vazhdim).
 * ---------------------------------------------------------------
 */
(() => {
  'use strict';

  const CFG = Object.assign({
    bufferLength: 15,
    timeSliceMs: 1000,
    fps: 30,
    hotkey: 'p',
    audio: false,
    autoClearOnSave: false,
    filenamePrefix: 'Onyx',
    canvasSelector: null,
    maxBlobBytes: 80 * 1024 * 1024,
    restartAfterSave: true, // ristarto recorder pas save për header të ri
    debug: true,
  }, (typeof window !== 'undefined' && window.ONYX_REPLAY_CONFIG) || {});

  const log  = (...a) => CFG.debug && console.log('%c[OnyxReplay]', 'color:#6111ff;font-weight:bold', ...a);
  const warn = (...a) => console.warn('[OnyxReplay]', ...a);
  const err  = (...a) => console.error('[OnyxReplay]', ...a);

  const MIME_CANDIDATES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    for (const t of MIME_CANDIDATES) {
      try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (_) {}
    }
    return '';
  }

  function findCanvas(selector) {
    if (selector) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLCanvasElement) return el;
    }
    const all = Array.from(document.querySelectorAll('canvas'));
    if (!all.length) return null;
    // canvas-i më i madh në viewport (zakonisht ai i lojës)
    return all.sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
  }

  class ReplayRecorder {
    constructor(cfg = CFG) {
      this.cfg = cfg;
      this.canvas = null;
      this.stream = null;
      this.recorder = null;
      this._mimeType = null;
      this.chunks = [];
      this.headerChunk = null;   // PIN: copa e parë me header
      this.totalBytes = 0;
      this.isRecording = false;
      this._wantRunning = false;
      this._restartTimer = null;
      this._saving = false;
      this.maxChunks = Math.max(1, Math.ceil((cfg.bufferLength * 1000) / cfg.timeSliceMs));
    }

    start(canvasOrEl) {
      if (this.isRecording) return true;

      const canvas = (canvasOrEl instanceof HTMLCanvasElement)
        ? canvasOrEl
        : findCanvas(this.cfg.canvasSelector);
      if (!canvas) { warn('Canvas s’u gjet ende.'); return false; }
      if (typeof MediaRecorder === 'undefined') { err('MediaRecorder s’suportohet.'); return false; }

      this._cleanupStream(); // siguri shtesë

      try {
        this.canvas = canvas;
        const stream = canvas.captureStream(this.cfg.fps);

        if (this.cfg.audio) {
          try {
            const ac = new (window.AudioContext || window.webkitAudioContext)();
            const dest = ac.createMediaStreamDestination();
            dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
          } catch (e) { warn('Audio s’u shtua:', e); }
        }

        this.stream = stream;
        this._mimeType = pickMimeType();
        const opts = this._mimeType ? { mimeType: this._mimeType } : {};
        this.recorder = new MediaRecorder(stream, opts);

        this.recorder.ondataavailable = (e) => {
          if (!e.data || !e.data.size) return;
          // copa e parë = header / init segment → pin
          if (!this.headerChunk) {
            this.headerChunk = e.data;
            log('Header chunk u ruajt (', e.data.size, 'bytes )');
            return;
          }
          this.chunks.push(e.data);
          this.totalBytes += e.data.size;

          while (this.chunks.length > this.maxChunks) {
            const removed = this.chunks.shift();
            this.totalBytes -= removed.size || 0;
          }
          while (this.totalBytes > this.cfg.maxBlobBytes && this.chunks.length > 1) {
            const removed = this.chunks.shift();
            this.totalBytes -= removed.size || 0;
          }
        };

        this.recorder.onerror = (ev) => {
          err('Recorder error:', ev?.error || ev);
          this._scheduleRestart(500);
        };

        this.recorder.onstop = () => {
          this.isRecording = false;
          if (this._wantRunning) this._scheduleRestart(150);
        };

        this.recorder.start(this.cfg.timeSliceMs);
        this.isRecording = true;
        this._wantRunning = true;
        log('Filloi regjistrimi (', this._mimeType || 'default', ')');
        return true;
      } catch (e) {
        err('Start dështoi:', e);
        this._cleanupStream();
        return false;
      }
    }

    stop() {
      this._wantRunning = false;
      if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
      this._cleanupStream();
      this.isRecording = false;
    }

    clear() {
      this.chunks = [];
      this.totalBytes = 0;
      // headerChunk MBETET — i nevojshëm për luajtjen
    }

    _cleanupStream() {
      if (this.recorder) {
        try { if (this.recorder.state !== 'inactive') this.recorder.stop(); } catch (_) {}
        this.recorder.ondataavailable = null;
        this.recorder.onerror = null;
        this.recorder.onstop = null;
        this.recorder = null;
      }
      if (this.stream) {
        try { this.stream.getTracks().forEach(t => t.stop()); } catch (_) {}
        this.stream = null;
      }
    }

    _scheduleRestart(delay) {
      if (this._restartTimer) return;
      this._restartTimer = setTimeout(() => {
        this._restartTimer = null;
        if (!this._wantRunning) return;
        // header i vjetër s’përputhet me stream të ri → reset
        this.headerChunk = null;
        this.chunks = [];
        this.totalBytes = 0;
        const ok = this.start(this.canvas);
        if (!ok) this._scheduleRestart(1000);
      }, delay);
    }

    async save(filename) {
      if (this._saving) { warn('Save në vazhdim…'); return null; }
      if (!this.headerChunk && !this.chunks.length) {
        warn('Buffer bosh — prit pak sekonda.');
        return null;
      }

      this._saving = true;
      try {
        // kërko copën e fundit që buffer-i të jetë sa më i ri
        if (this.recorder && this.recorder.state === 'recording') {
          try { this.recorder.requestData(); } catch (_) {}
          await new Promise(r => setTimeout(r, 200));
        }

        const type = (this._mimeType || 'video/webm').split(';')[0];
        const parts = [];
        if (this.headerChunk) parts.push(this.headerChunk);
        parts.push(...this.chunks);

        const blob = new Blob(parts, { type });
        if (!blob.size) { warn('Blob bosh.'); return null; }

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
        } catch (e) {
          warn('Download dështoi, hap në tab:', e);
          window.open(url, '_blank');
        } finally {
          setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000);
        }

        log(`U ruajt: ${name} (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);

        if (this.cfg.autoClearOnSave) this.clear();

        // ristarto recorder-in → header i ri për save-t e ardhshëm
        if (this.cfg.restartAfterSave && this._wantRunning) {
          log('Ristartim i recorder-it pas save…');
          this._cleanupStream();
          this.headerChunk = null;
          this.chunks = [];
          this.totalBytes = 0;
          this.isRecording = false;
          // jep 1 tick që browser-i të lirojë burimet
          setTimeout(() => { if (this._wantRunning) this.start(this.canvas); }, 100);
        }

        return blob;
      } catch (e) {
        err('Save error:', e);
        return null;
      } finally {
        this._saving = false;
      }
    }

    _defaultName(type) {
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      return `${this.cfg.filenamePrefix}-${ts}.${ext}`;
    }
  }

  const recorder = new ReplayRecorder();

  const tryStart = (attemptsLeft = 30) => {
    if (recorder.start()) return;
    if (attemptsLeft <= 0) { warn('Canvas s’u gjet pas shumë provave.'); return; }
    setTimeout(() => tryStart(attemptsLeft - 1), 1000);
  };

  const boot = () => {
    tryStart();

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

    const onClipEvent = (ev) => {
      const tag = (ev && ev.detail && ev.detail.type) || 'event';
      recorder.save(`${CFG.filenamePrefix}-${tag}-${Date.now()}.webm`);
    };
    window.addEventListener('onyx:kill',  onClipEvent);
    window.addEventListener('onyx:death', onClipEvent);
    window.addEventListener('onyx:clip',  onClipEvent);

    window.addEventListener('pagehide', () => recorder.stop(), { once: true });
  };

  if (document.readyState === 'complete' || document.readyState === 'interactive') boot();
  else window.addEventListener('DOMContentLoaded', boot, { once: true });

  window.OnyxReplay = {
    start:  (el) => recorder.start(el),
    stop:   ()   => recorder.stop(),
    save:   (n)  => recorder.save(n),
    clear:  ()   => recorder.clear(),
    get isRecording() { return recorder.isRecording; },
    _instance: recorder,
  };
})();

