// =============================================================
// Pawa AI — Gemini Live Voice Assistant
// Ported from Jarvis Mark-XXXIX (main.py) to the browser.
// Uses Google Gemini Live API for real-time audio conversation.
// =============================================================

(function () {
  const SEND_SR = 16000;   // mic sample rate (PCM 16kHz — what Gemini expects)
  const RECV_SR = 24000;   // playback sample rate (Gemini outputs 24kHz)
  const CHUNK   = 2048;    // ScriptProcessor buffer size

  class PawaVoice {
    // tokenUrl + anonKey point at the Supabase `gemini-token` Edge Function,
    // which mints a short-lived ephemeral token. The real GEMINI_API_KEY
    // stays server-side and never reaches the browser.
    constructor({ tokenUrl, anonKey, model, systemPrompt, onTranscript, onState }) {
      this.tokenUrl     = tokenUrl;
      this.anonKey      = anonKey;
      this.model        = model || "gemini-2.5-flash-native-audio-preview-09-2025";
      this.systemPrompt = systemPrompt;
      this.onTranscript = onTranscript; // (role, text) => void
      this.onState      = onState;      // (state) => void

      this._session   = null;
      this._sendCtx   = null;
      this._recvCtx   = null;
      this._stream    = null;
      this._processor = null;
      this._active      = false;
      this._closed      = false;
      this._wasListening = false;
      this._nextAt    = 0;
      this._sources   = [];   // active audio buffer sources (for barge-in cutoff)
      this._outBuf    = [];
      this._inBuf     = [];
    }

    // ── Public API ─────────────────────────────────────────────

    async start() {
      this.onState("connecting");
      try {
        // 1) Ask the Edge Function for a fresh ephemeral token.
        const token = await this._fetchToken();
        if (!token) { this.onState("error"); return; }

        // 2) Connect to Gemini Live with the token (NOT the real key).
        //    Ephemeral tokens require the v1alpha API version.
        const { GoogleGenAI } = await import("https://esm.sh/@google/genai@2.0.0");
        const ai = new GoogleGenAI({
          apiKey: token,
          httpOptions: { apiVersion: "v1alpha" },
        });

        this._closed = false;
        this._session = await ai.live.connect({
          model: this.model,
          callbacks: {
            onopen:    ()    => this._onOpen(),
            onmessage: (msg) => this._onMessage(msg),
            onerror:   (e)   => this._onError(e),
            onclose:   (e)   => this._onClose(e),
          },
          config: {
            responseModalities:       ["AUDIO"],
            outputAudioTranscription: {},
            inputAudioTranscription:  {},
            systemInstruction:        { parts: [{ text: this.systemPrompt }] },
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: "Charon" }
              }
            }
          }
        });
      } catch (err) {
        console.error("[PawaVoice] Connect failed:", err);
        this.onState("error");
      }
    }

    async _fetchToken() {
      try {
        const res = await fetch(this.tokenUrl, {
          method:  "POST",
          headers: {
            "Content-Type":  "application/json",
            "apikey":        this.anonKey,
            "Authorization": "Bearer " + this.anonKey,
          },
          body: "{}",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.token) {
          console.error("[PawaVoice] token error:", data?.error || res.status, data?.detail || "");
          return null;
        }
        return data.token;
      } catch (e) {
        console.error("[PawaVoice] token fetch failed:", e);
        return null;
      }
    }

    sendText(text) {
      if (!this._session) return;
      this._session.sendClientContent({
        turns: [{ parts: [{ text }] }],
        turnComplete: true
      });
      this.onState("thinking");
    }

    stop() {
      this._active = false;
      this._closed = true;
      this._stopAllAudio();
      try { this._processor?.disconnect();              } catch {}
      try { this._stream?.getTracks().forEach(t=>t.stop()); } catch {}
      try { this._session?.close();                     } catch {}
      try { this._sendCtx?.close();                     } catch {}
      try { this._recvCtx?.close();                     } catch {}
      this._session = null;
      this.onState("idle");
    }

    // ── Internal ───────────────────────────────────────────────

    async _onOpen() {
      try {
        await this._startMic();
        // If the server closed the socket while the mic was spinning up
        // (e.g. bad model / auth), don't flip to "listening".
        if (this._closed) return;
        this._wasListening = true;
        this.onState("listening");
      } catch (e) {
        console.error("[PawaVoice] Mic error:", e);
        this.onState("error");
      }
    }

    async _startMic() {
      this._sendCtx = new AudioContext({ sampleRate: SEND_SR });
      this._recvCtx = new AudioContext({ sampleRate: RECV_SR });
      this._nextAt  = this._recvCtx.currentTime;

      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
        video: false
      });

      const source      = this._sendCtx.createMediaStreamSource(this._stream);
      this._processor   = this._sendCtx.createScriptProcessor(CHUNK, 1, 1);

      this._processor.onaudioprocess = (e) => {
        if (!this._active || this._closed || !this._session) return;
        const f32 = e.inputBuffer.getChannelData(0);
        try {
          this._session.sendRealtimeInput({
            media: { data: this._pcmToBase64(f32), mimeType: "audio/pcm;rate=16000" }
          });
        } catch {
          // Socket closed mid-send — stop trying.
          this._active = false;
        }
      };

      source.connect(this._processor);
      this._processor.connect(this._sendCtx.destination);
      this._active = true;
    }

    _onMessage(msg) {
      // Gemini sends raw audio data
      if (msg.data) {
        this._scheduleAudio(msg.data);
        this.onState("speaking");
      }

      const sc = msg.serverContent;
      if (!sc) return;

      // Barge-in: the user started talking over Pawa. The model tells us to
      // drop whatever it was saying. Kill all queued audio immediately — else
      // stale speech keeps playing and the reply feels delayed / out of sync.
      if (sc.interrupted) {
        this._stopAllAudio();
        this._outBuf = [];
        this.onState("listening");
        return;
      }

      // What the user said (accumulates while they speak)
      if (sc.inputTranscription?.text) this._inBuf.push(sc.inputTranscription.text);

      // The moment Pawa starts replying, the user has finished — flush their
      // line first so it shows above Pawa's answer.
      if ((sc.modelTurn || sc.outputTranscription) && this._inBuf.length) {
        const inp = this._inBuf.join("").trim();
        if (inp) this.onTranscript("user", inp);
        this._inBuf = [];
      }

      // What Pawa is saying (accumulates across the reply)
      if (sc.outputTranscription?.text) this._outBuf.push(sc.outputTranscription.text);

      // Native-audio models signal the end of a reply with generationComplete;
      // turnComplete may lag or never arrive, so flush on EITHER.
      if (sc.generationComplete || sc.turnComplete) {
        const out = this._outBuf.join("").trim();
        if (out) this.onTranscript("assistant", out);
        this._outBuf = [];
      }

      // Reply finished → floor is back to the user. Use generationComplete
      // too so the badge never gets stuck on "speaking" when turnComplete lags.
      if (sc.generationComplete || sc.turnComplete) this.onState("listening");
    }

    // Seamless audio playback — schedule chunks back-to-back
    _scheduleAudio(base64) {
      try {
        const bin  = atob(base64);
        const u8   = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const i16  = new Int16Array(u8.buffer);
        const f32  = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;

        const buf = this._recvCtx.createBuffer(1, f32.length, RECV_SR);
        buf.getChannelData(0).set(f32);

        const src = this._recvCtx.createBufferSource();
        src.buffer = buf;
        src.connect(this._recvCtx.destination);

        const now = this._recvCtx.currentTime;
        if (this._nextAt < now) this._nextAt = now;
        src.start(this._nextAt);
        this._nextAt += buf.duration;

        // Track so we can cut playback short on a barge-in.
        this._sources.push(src);
        src.onended = () => {
          const i = this._sources.indexOf(src);
          if (i !== -1) this._sources.splice(i, 1);
        };
      } catch (e) {
        console.warn("[PawaVoice] Audio play error:", e);
      }
    }

    // Stop every queued/playing audio chunk and reset the playback clock.
    _stopAllAudio() {
      for (const s of this._sources) {
        try { s.onended = null; s.stop(); } catch {}
      }
      this._sources = [];
      if (this._recvCtx) this._nextAt = this._recvCtx.currentTime;
    }

    _onError(e) {
      console.error("[PawaVoice] error:", e?.message || e);
      this._closed = true;
      this._active = false;
      this.onState("error");
    }

    _onClose(e) {
      this._active = false;
      // A close with a 1008 (policy) code or any reason text means the
      // server rejected us (bad model, bad key) — that's an error, not a
      // normal hang-up. Surface it so the UI shows "error", not "idle".
      const reason = e?.reason || "";
      const code   = e?.code;
      const wasReady = this._wasListening;
      if (!this._closed && !wasReady && (code === 1008 || reason)) {
        console.error("[PawaVoice] closed:", code, reason);
        this._closed = true;
        this.onState("error");
        return;
      }
      this._closed = true;
      this.onState("idle");
    }

    _pcmToBase64(f32) {
      const i16 = new Int16Array(f32.length);
      for (let i = 0; i < f32.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768));
      }
      const u8 = new Uint8Array(i16.buffer);
      let s = "";
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
      return btoa(s);
    }
  }

  window.PawaVoice = PawaVoice;
})();
