/**
 * sav.js — ONYX Replay Recorder (drop-in, fixed)
 * ---------------------------------------------------------------
 * Regjistron vazhdimisht ~15s e fundit nga <canvas> dhe i ruan
 * si .webm kur shtypet "P" ose thirret OnyxReplay.save().
 *
 * FIX: MediaRecorder nuk ndalet kurrë pas save(). Mbajmë "headerChunk"
 * (init segment) që del në copën e parë dhe e prependojmë në ÇDO save.
 * Kështu çdo regjistrim pasues është i plotë dhe i luajtshëm.
 */
(function () {
  "use strict";

  const DEFAULTS = {
    seconds: 15,
    fps: 30,
    timeSliceMs: 500,
    videoBitsPerSecond: 4_000_000,
    hotkey: "p",
    autoStart: true,
    filenamePrefix: "onyx-replay",
  };

  const MIME_CANDIDATES = [
    'video/webm;codecs="vp9,opus"',
    'video/webm;codecs=vp9',
    'video/webm;codecs="vp8,opus"',
    'video/webm;codecs=vp8',
    "video/webm",
  ];

  function pickMime() {
    if (typeof MediaRecorder === "undefined") return null;
    for (const m of MIME_CANDIDATES) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
    }
    return null;
  }

  function findGameCanvas() {
    const cs = document.querySelectorAll("canvas");
    let best = null, bestArea = 0;
    cs.forEach((c) => {
      const w = c.width || c.clientWidth;
      const h = c.height || c.clientHeight;
      const a = w * h;
      if (a > bestArea) { bestArea = a; best = c; }
    });
    return best;
  }

  function tsName(prefix) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${prefix}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.webm`;
  }

  class ReplayRecorder {
    constructor(opts = {}) {
      this.opts = { ...DEFAULTS, ...opts };
      this.canvas = null;
      this.stream = null;
      this.recorder = null;
      this.mime = null;
      this.chunks = [];          // ring buffer (pa header)
      this.headerChunk = null;   // init segment nga copa e parë
      this.totalBytes = 0;
      this.maxBytes = this.opts.seconds * (this.opts.videoBitsPerSecond / 8) * 1.5;
      this._saving = false;
    }

    get isRecording() {
      return !!this.recorder && this.recorder.state === "recording";
    }

    start(canvasEl) {
      if (this.isRecording) return true;
      const canvas = canvasEl || findGameCanvas();
      if (!canvas) { console.warn("[OnyxReplay] canvas not found"); return false; }
      const mime = pickMime();
      if (!mime) { console.warn("[OnyxReplay] MediaRecorder/webm not supported"); return false; }

      try {
        const stream = canvas.captureStream(this.opts.fps);
        const rec = new MediaRecorder(stream, {
          mimeType: mime,
          videoBitsPerSecond: this.opts.videoBitsPerSecond,
        });

        this.canvas = canvas;
        this.stream = stream;
        this.recorder = rec;
        this.mime = mime;
        this.chunks = [];
        this.headerChunk = null;
        this.totalBytes = 0;

        rec.ondataavailable = (e) => {
          if (!e.data || e.data.size === 0) return;
          // Copa e parë përmban header-in (init segment) — e ruajmë veçmas.
          if (!this.headerChunk) {
            this.headerChunk = e.data;
            return;
          }
          this.chunks.push(e.data);
          this.totalBytes += e.data.size;
          // Mbaje ring buffer-in nën kufirin e sekondave të kërkuara.
          while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
            const dropped = this.chunks.shift();
            this.totalBytes -= dropped.size;
          }
        };

        rec.onerror = (ev) => console.warn("[OnyxReplay] recorder error", ev);
        rec.onstop = () => { /* no-op: ne nuk e ndalim mes save() */ };

        rec.start(this.opts.timeSliceMs);
        return true;
      } catch (err) {
        console.warn("[OnyxReplay] start failed", err);
        this._cleanupStream();
        return false;
      }
    }

    stop() {
      try { if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop(); } catch (_) {}
      this._cleanupStream();
      this.recorder = null;
    }

    _cleanupStream() {
      try { if (this.stream) this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      this.stream = null;
    }

    clear() {
      this.chunks = [];
      this.totalBytes = 0;
      // headerChunk MBAHET — duhet për luajtjen e regjistrimeve të mëvonshme.
    }

    async save(filename) {
      if (this._saving) return null;
      if (!this.isRecording && !this.chunks.length) {
        console.warn("[OnyxReplay] nothing to save");
        return null;
      }
      this._saving = true;
      try {
        // Flush copën aktuale që ring buffer-i të jetë sa më i fundit.
        try { this.recorder && this.recorder.requestData(); } catch (_) {}
        // Prit një tick që ondataavailable të mbushë chunks-at e flush-uar.
        await new Promise((r) => setTimeout(r, this.opts.timeSliceMs + 50));

        if (!this.headerChunk) {
          console.warn("[OnyxReplay] header not captured yet, retry shortly");
          return null;
        }
        if (!this.chunks.length) {
          console.warn("[OnyxReplay] no body chunks yet");
          return null;
        }

        // Ndërto blob: header + të gjitha chunks-at aktuale. Nuk fshijmë asgjë —
        // MediaRecorder vazhdon të punojë dhe ring buffer-i rifreskohet vetë.
        const parts = [this.headerChunk, ...this.chunks];
        const blob = new Blob(parts, { type: this.mime || "video/webm" });
        const name = filename || tsName(this.opts.filenamePrefix);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return { name, size: blob.size, type: blob.type };
      } finally {
        this._saving = false;
      }
    }
  }

  const recorder = new ReplayRecorder();

  function tryAutoStart() {
    if (!recorder.opts.autoStart) return;
    if (recorder.start()) return;
    // Provo sërish kur shtohet ndonjë canvas (loja ngarkohet vonë).
    const obs = new MutationObserver(() => {
      if (recorder.start()) obs.disconnect();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // Stop pas 60s për të mos rënduar DOM-in.
    setTimeout(() => obs.disconnect(), 60_000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tryAutoStart, { once: true });
  } else {
    tryAutoStart();
  }

  window.addEventListener("keydown", (e) => {
    const k = (e.key || "").toLowerCase();
    if (k !== recorder.opts.hotkey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    e.preventDefault();
    recorder.save();
  }, { capture: true });

  window.OnyxReplay = {
    start:  (el) => recorder.start(el),
    stop:   ()    => recorder.stop(),
    save:   (n)   => recorder.save(n),
    clear:  ()    => recorder.clear(),
    get isRecording() { return recorder.isRecording; },
    _instance: recorder,
  };
})();

