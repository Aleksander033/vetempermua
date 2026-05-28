/**
 * REPLAY RECORDER FOR ONYX GAME (save.js)
 * Kohëzgjatja: 15 sekondat e fundit të ekranit
 */

class ReplayRecorder {
    constructor(options = {}) {
        this.bufferLengthInSeconds = options.bufferLength || 15;
        this.timeSliceMs = options.timeSlice || 1000;
        this.fps = options.fps || 30;
        
        this.mediaRecorder = null;
        this.stream = null;
        this.recordedChunks = [];
        this.isRecording = false;
        
        this.maxChunks = Math.ceil((this.bufferLengthInSeconds * 1000) / this.timeSliceMs);
    }

    start(canvasElement) {
        if (this.isRecording) return;

        if (!canvasElement) {
            console.error("ReplayRecorder: Nuk u gjet asnjë Canvas i vlefshëm.");
            return;
        }

        try {
            this.recordedChunks = [];
            // Kapja e stream-it direkt nga canvas-i i lojës ONYX
            this.stream = canvasElement.captureStream(this.fps);
            
            let options = { mimeType: 'video/webm;codecs=vp9' };
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options = { mimeType: 'video/webm;codecs=vp8' };
            }
            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                options = { mimeType: 'video/webm' };
            }

            this.mediaRecorder = new MediaRecorder(this.stream, options);

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data && event.data.size > 0) {
                    this.recordedChunks.push(event.data);
                    // Mbajtja e saktë e buffer-it prej 15 sekondash
                    if (this.recordedChunks.length > this.maxChunks) {
                        this.recordedChunks.shift();
                    }
                }
            };

            this.mediaRecorder.start(this.timeSliceMs);
            this.isRecording = true;
            console.log("%c[Onyx Replay] Regjistrimi në buffer (15s) u nis me sukses!", "color: #6111ff; font-weight: bold;");

        } catch (error) {
            console.error("ReplayRecorder: Gabim gjatë nisjes së MediaRecorder", error);
        }
    }

    saveClip(filename = "onyx-replay.webm") {
        if (this.recordedChunks.length === 0) {
            console.warn("Buffer-i është ende bosh. Prisni disa sekonda.");
            return;
        }

        const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        
        setTimeout(() => {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 100);

        console.log(`%c[Onyx Replay] U ruajt klipi: ${filename}`, "color: #00ff00;");
    }
}

// INICIALIZIMI DHE LIDHJA AUTOMATIKE ME CANVASIN E LOJËS
(function() {
    const initRecorder = () => {
        // Kontrollojmë ID kryesore të lojës ose selektorin e parë të canvas
        const targetCanvas = document.getElementById("canvas") || document.querySelector("canvas");
        
        if (targetCanvas) {
            const recorder = new ReplayRecorder({ bufferLength: 15, fps: 30 });
            recorder.start(targetCanvas);

            // LIDHJA ME TASTIERËN:
            // Kur shtypni tastin "P" (pa qenë në chat), ruhen 15 sekondat e fundit.
            window.addEventListener("keydown", (event) => {
                const inChat = document.activeElement && 
                               (document.activeElement.tagName === "INPUT" || 
                                document.activeElement.tagName === "TEXTAREA" || 
                                document.activeElement.id === "chat_message"); // ID e mundshme e chat-it në lojë

                if (event.key.toLowerCase() === 'p' && !inChat) {
                    event.preventDefault();
                    const timeStr = new Date().toISOString().slice(11, 19).replace(/:/g, "-");
                    recorder.saveClip(`Onyx-${timeStr}.webm`);
                }
            });
        } else {
            // Nëse kodi ngarkohet përpara se të krijohet Canvas-i në DOM, pret 1 sekondë dhe provon përsëri
            setTimeout(initRecorder, 1000);
        }
    };

    // Nisja e procesit të gjetjes së Canvas
    if (document.readyState === "complete" || document.readyState === "interactive") {
        initRecorder();
    } else {
        window.addEventListener("DOMContentLoaded", initRecorder);
    }
})();
