// AudioWorkletProcessor: downsample mic input to 16 kHz mono 16-bit PCM (linear16)
// and post ~50 ms chunks (800 samples = 1600 bytes) to the main thread.
// `sampleRate` is a global in the AudioWorkletGlobalScope (usually 48000).

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 800; // 50 ms at 16 kHz

// Voice activity detection (barge-in): windowed RMS with 2-window confirmation.
// Window ~32 ms; two consecutive hot windows => voice (detection delay ~64 ms).
const VAD_THRESHOLD = 0.015; // RMS; mic has AGC so speech sits well above this
const VAD_RELEASE_WINDOWS = 10; // ~320 ms of quiet before "voice off"

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.readPos = 0; // fractional read position into the queued stream
    this.queue = []; // queued Float32Array blocks (copies)
    this.queuedLen = 0;
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.chunkIdx = 0;

    // VAD state
    this.vadWindow = Math.round(sampleRate * 0.032); // samples per RMS window
    this.vadAcc = 0; // sum of squares in current window
    this.vadCount = 0; // samples in current window
    this.vadHotStreak = 0;
    this.vadQuietStreak = 0;
    this.vadActive = false;
    this.vadOnsetMs = 0; // ms since first hot window when 'voice on' fires
  }

  _sampleAt(idx) {
    let i = idx;
    for (const arr of this.queue) {
      if (i < arr.length) return arr[i];
      i -= arr.length;
    }
    return 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch || ch.length === 0) return true;

    // Input buffers are reused by the engine — copy before queuing.
    this.queue.push(ch.slice());
    this.queuedLen += ch.length;

    // --- VAD (runs on raw samples, independent of resampling) ---
    for (let i = 0; i < ch.length; i++) {
      this.vadAcc += ch[i] * ch[i];
      this.vadCount++;
      if (this.vadCount >= this.vadWindow) {
        const rms = Math.sqrt(this.vadAcc / this.vadCount);
        this.vadAcc = 0;
        this.vadCount = 0;
        if (rms >= VAD_THRESHOLD) {
          this.vadHotStreak++;
          this.vadQuietStreak = 0;
          if (!this.vadActive && this.vadHotStreak >= 2) {
            this.vadActive = true;
            // Detection delay: the 2 windows we just confirmed over.
            this.port.postMessage({ vad: true, detectMs: Math.round(2 * 32) });
          }
        } else {
          this.vadQuietStreak++;
          this.vadHotStreak = 0;
          if (this.vadActive && this.vadQuietStreak >= VAD_RELEASE_WINDOWS) {
            this.vadActive = false;
            this.port.postMessage({ vad: false });
          }
        }
      }
    }

    // Linear-interpolation resample: consume while a neighbor pair is available.
    while (Math.floor(this.readPos) + 1 < this.queuedLen) {
      const i = Math.floor(this.readPos);
      const frac = this.readPos - i;
      const s = this._sampleAt(i) * (1 - frac) + this._sampleAt(i + 1) * frac;
      const v = Math.max(-1, Math.min(1, s));
      this.chunk[this.chunkIdx++] = v < 0 ? v * 0x8000 : v * 0x7fff;

      if (this.chunkIdx === CHUNK_SAMPLES) {
        const buf = this.chunk.slice().buffer;
        this.port.postMessage(buf, [buf]);
        this.chunkIdx = 0;
      }
      this.readPos += this.step;
    }

    // Drop fully consumed blocks.
    while (this.queue.length > 0 && this.readPos >= this.queue[0].length) {
      const n = this.queue.shift().length;
      this.readPos -= n;
      this.queuedLen -= n;
    }
    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
