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

// --- Agent speech playback (Phase 4) ---
// Raw 16 kHz PCM in, gapless Web Audio scheduling, instantly stoppable (barge-in).
const PLAYBACK_RATE = 16000;
let playCtx: AudioContext | null = null;
let nextPlayAt = 0;
let liveSources: AudioBufferSourceNode[] = [];
let speechEndWallMs: number | null = null;
let awaitingFirstAudio = false;

function playPcm(buf: ArrayBuffer): void {
  if (!playCtx) playCtx = new AudioContext();
  if (playCtx.state === "suspended") void playCtx.resume();

  const int16 = new Int16Array(buf);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 0x8000;

  const audioBuf = playCtx.createBuffer(1, float32.length, PLAYBACK_RATE);
  audioBuf.getChannelData(0).set(float32);

  const src = playCtx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(playCtx.destination);

  const now = playCtx.currentTime;
  if (nextPlayAt < now) nextPlayAt = now;

  if (awaitingFirstAudio) {
    awaitingFirstAudio = false;
    const startDelayMs = (nextPlayAt - now) * 1000;
    if (speechEndWallMs !== null) {
      const headline = Math.round(Date.now() + startDelayMs - speechEndWallMs);
      latencyEl.textContent = `HEADLINE speech-end -> first audio: ${headline} ms`;
      console.log(`HEADLINE speech-end -> first-audio-played: ${headline}ms`);
    }
  }

  src.start(nextPlayAt);
  nextPlayAt += audioBuf.duration;
  liveSources.push(src);
  src.onended = () => {
    liveSources = liveSources.filter((s) => s !== src);
  };
}

/** Instant stop of all agent audio (barge-in, Phase 5). */
function stopPlayback(): void {
  for (const s of liveSources) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  liveSources = [];
  nextPlayAt = 0;
}
void stopPlayback; // used in Phase 5

const transcriptEl = document.getElementById("transcript") as HTMLElement;
const latencyEl = document.getElementById("latency") as HTMLElement;
let interimLine: HTMLElement | null = null;
let agentLine: HTMLElement | null = null;

function renderStt(msg: { event: string; transcript: string; turnIndex: number }): void {
  if (!interimLine) {
    interimLine = document.createElement("div");
    transcriptEl.appendChild(interimLine);
  }
  if (msg.event === "EndOfTurn") {
    interimLine.textContent = `you: ${msg.transcript}`;
    interimLine.style.color = "";
    interimLine = null; // next turn starts a fresh line
  } else {
    interimLine.textContent = `you: ${msg.transcript}`;
    interimLine.style.color = "#888";
  }
}

ws.addEventListener("message", (e: MessageEvent) => {
  if (typeof e.data !== "string") {
    playPcm(e.data as ArrayBuffer); // binary downlink = agent speech PCM
    return;
  }
  let msg: { type: string; [k: string]: unknown };
  try {
    msg = JSON.parse(e.data);
  } catch {
    return;
  }
  if (msg.type === "stt") {
    renderStt(msg as unknown as { event: string; transcript: string; turnIndex: number });
  } else if (msg.type === "agent") {
    if (!agentLine) {
      agentLine = document.createElement("div");
      agentLine.textContent = "agent: ";
      agentLine.style.fontWeight = "bold";
      transcriptEl.appendChild(agentLine);
    }
    agentLine.textContent += String(msg.delta);
  } else if (msg.type === "agent_done") {
    agentLine = null;
  } else if (msg.type === "metric" && msg.name === "eot_gap_ms") {
    latencyEl.textContent = `end-of-turn gap: ${msg.value} ms`;
  } else if (msg.type === "metric" && msg.name === "llm_first_token_ms") {
    console.log(`LLM first token: ${msg.value} ms`);
  } else if (msg.type === "speech_end") {
    speechEndWallMs = typeof msg.wallMs === "number" ? msg.wallMs : null;
    awaitingFirstAudio = true;
  } else if (msg.type === "tts_done") {
    // agent finished speaking (playback may still be draining scheduled audio)
  } else if (msg.type === "error") {
    console.error("server error:", msg);
    setStatus(`error: ${msg.code}`, "err");
  }
});

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
