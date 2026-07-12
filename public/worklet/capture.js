// AudioWorkletProcessor: downsample mic input to 16 kHz mono 16-bit PCM (linear16)
// and post ~50 ms chunks (800 samples = 1600 bytes) to the main thread.
// `sampleRate` is a global in the AudioWorkletGlobalScope (usually 48000).

const TARGET_RATE = 16000;
const CHUNK_SAMPLES = 800; // 50 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE;
    this.readPos = 0;      // fractional read position into the queued stream
    this.queue = [];       // queued Float32Array blocks (copies)
    this.queuedLen = 0;
    this.chunk = new Int16Array(CHUNK_SAMPLES);
    this.chunkIdx = 0;
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
