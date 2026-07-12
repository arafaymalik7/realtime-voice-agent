const statusEl = document.getElementById("status") as HTMLElement;
const micEl = document.getElementById("mic") as HTMLElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;

function setStatus(text: string, cls: string): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

function setMic(text: string, cls: string): void {
  micEl.textContent = text;
  micEl.className = cls;
}

const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);
ws.binaryType = "arraybuffer";

ws.addEventListener("open", () => {
  console.log("WS open");
  setStatus("connected", "ok");
});
ws.addEventListener("close", () => {
  console.log("WS closed");
  setStatus("disconnected", "err");
});
ws.addEventListener("error", () => {
  console.error("WS error");
  setStatus("error", "err");
});

// --- Audio uplink (Phase 1) ---
let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let framesSent = 0;

async function startCapture(): Promise<void> {
  if (audioCtx) return; // already running

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  audioCtx = new AudioContext();
  await audioCtx.audioWorklet.addModule("/worklet/capture.js");

  const source = audioCtx.createMediaStreamSource(mediaStream);
  const capture = new AudioWorkletNode(audioCtx, "capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  capture.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(e.data);
      framesSent++;
      if (framesSent % 20 === 0) console.log(`sent ${framesSent} audio frames`);
    }
  };

  source.connect(capture);
  capture.connect(audioCtx.destination); // keeps the node processing; worklet outputs silence

  framesSent = 0;
  setMic("live (16 kHz PCM streaming)", "ok");
  console.log(`capture started, context rate ${audioCtx.sampleRate} Hz`);
}

function stopCapture(): void {
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  void audioCtx?.close();
  audioCtx = null;
  setMic("off", "err");
  console.log(`capture stopped after ${framesSent} frames`);
}

startBtn.addEventListener("click", () => {
  startCapture().catch((err) => {
    console.error("mic start failed:", err);
    setMic(`mic error: ${err.message ?? err}`, "err");
  });
});
stopBtn.addEventListener("click", stopCapture);

export {};
