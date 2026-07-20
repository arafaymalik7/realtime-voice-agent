// UI elements
const connPill = document.getElementById("conn-pill") as HTMLElement;
const connText = document.getElementById("conn-text") as HTMLElement;
const micPill = document.getElementById("mic-pill") as HTMLElement;
const micText = document.getElementById("mic-text") as HTMLElement;
const orb = document.getElementById("orb") as HTMLElement;
const stateLabel = document.getElementById("state-label") as HTMLElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const transcriptEl = document.getElementById("transcript") as HTMLElement;
const statEot = document.getElementById("stat-eot") as HTMLElement;
const statLlm = document.getElementById("stat-llm") as HTMLElement;
const statHeadline = document.getElementById("stat-headline") as HTMLElement;
const statBarge = document.getElementById("stat-barge") as HTMLElement;

function setConn(text: string, status: "ok" | "err" | "warn"): void {
  connText.textContent = text;
  connPill.dataset.status = status;
}
function setMic(text: string, status: "ok" | "err" | "warn"): void {
  micText.textContent = text;
  micPill.dataset.status = status;
}
function setOrbState(
  state: "idle" | "listening" | "thinking" | "speaking" | "error",
  label: string
): void {
  orb.dataset.state = state;
  stateLabel.textContent = label;
}

/** Format a millisecond metric with a color class: good < goodMax, warn < warnMax, else bad. */
function fmtMs(el: HTMLElement, ms: number | null, goodMax: number, warnMax: number): void {
  el.classList.remove("stat-good", "stat-warn", "stat-bad");
  if (ms === null) {
    el.textContent = "—";
    return;
  }
  el.textContent = `${ms} ms`;
  el.classList.add(ms <= goodMax ? "stat-good" : ms <= warnMax ? "stat-warn" : "stat-bad");
}

function scrollTranscriptToBottom(): void {
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// --- Session token (short-lived, single-use) then connect ---
const proto = location.protocol === "https:" ? "wss" : "ws";
const sessionRes = await fetch("/session");
const { token } = (await sessionRes.json()) as { token: string };
const ws = new WebSocket(`${proto}://${location.host}/?token=${encodeURIComponent(token)}`);
ws.binaryType = "arraybuffer";

// --- Agent speech playback ---
// Raw 16 kHz PCM in, gapless Web Audio scheduling, instantly stoppable (barge-in).
const PLAYBACK_RATE = 16000;
let playCtx: AudioContext | null = null;
let nextPlayAt = 0;
let liveSources: AudioBufferSourceNode[] = [];
let speechEndWallMs: number | null = null;
let awaitingFirstAudio = false;
// Gate against stale TTS chunks that were in flight when a barge-in stopped
// playback. WS ordering guarantees the next reply's speech_end arrives after
// every chunk of the old reply, so this can never eat new-reply audio.
let acceptAudio = true;
let vadActive = false; // user currently talking (from worklet VAD)
let bargeCount = 0;

function playPcm(buf: ArrayBuffer): void {
  // User is mid-speech as this reply's audio arrives (they started talking while
  // the agent was still thinking): never play it — barge-in before first sound.
  if (awaitingFirstAudio && vadActive) {
    acceptAudio = false;
    bargeCount++;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "barge_in" }));
      ws.send(JSON.stringify({ type: "client_metric", name: "barge_stop_ms", value: 0 }));
    }
    fmtMs(statBarge, 0, 150, 300);
    console.log(`BARGE-IN #${bargeCount}: user talking as reply arrived — suppressed, 0ms`);
    awaitingFirstAudio = false;
    setOrbState("listening", "Listening");
    return;
  }

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
      fmtMs(statHeadline, headline, 1500, 2500);
      console.log(`HEADLINE speech-end -> first-audio-played: ${headline}ms`);
    }
    setOrbState("speaking", "Speaking");
  }

  src.start(nextPlayAt);
  nextPlayAt += audioBuf.duration;
  liveSources.push(src);
  src.onended = () => {
    liveSources = liveSources.filter((s) => s !== src);
  };
}

/** Instant stop of all agent audio (barge-in). */
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

/** True while agent audio is audible or scheduled. */
function agentAudioActive(): boolean {
  return liveSources.length > 0;
}

/** Client VAD says the user is talking. If the agent is audible: barge-in. */
function onVoiceDetected(detectMs: number): void {
  if (!agentAudioActive()) return;
  const t0 = performance.now();
  stopPlayback();
  acceptAudio = false; // drop stale in-flight chunks of the reply we just killed
  const stopMs = Math.round(performance.now() - t0 + detectMs);
  bargeCount++;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "barge_in" }));
    ws.send(JSON.stringify({ type: "client_metric", name: "barge_stop_ms", value: stopMs }));
  }
  fmtMs(statBarge, stopMs, 150, 300);
  console.log(`BARGE-IN #${bargeCount}: voice-onset -> silence in ${stopMs}ms`);
  setOrbState("listening", "Listening");
}

// --- Transcript rendering (chat bubbles) ---
let interimBubble: HTMLElement | null = null;
let agentBubble: HTMLElement | null = null;

function renderStt(msg: { event: string; transcript: string; turnIndex: number }): void {
  if (!msg.transcript.trim()) return;
  if (!interimBubble) {
    interimBubble = document.createElement("div");
    interimBubble.className = "bubble bubble-user interim";
    transcriptEl.appendChild(interimBubble);
  }
  interimBubble.textContent = msg.transcript;
  if (msg.event === "EndOfTurn") {
    interimBubble.classList.remove("interim");
    interimBubble = null; // next turn starts a fresh bubble
  }
  scrollTranscriptToBottom();
}

function addToolRow(text: string): void {
  const row = document.createElement("div");
  row.className = "row-tool";
  row.textContent = text;
  transcriptEl.appendChild(row);
  scrollTranscriptToBottom();
}

function addNoticeRow(text: string): void {
  const row = document.createElement("div");
  row.className = "row-notice";
  row.textContent = text;
  transcriptEl.appendChild(row);
  scrollTranscriptToBottom();
}

function addFatalRow(text: string): void {
  const row = document.createElement("div");
  row.className = "row-fatal";
  row.textContent = `⚠ ${text}`;
  transcriptEl.appendChild(row);
  scrollTranscriptToBottom();
}

ws.addEventListener("message", (e: MessageEvent) => {
  if (typeof e.data !== "string") {
    if (acceptAudio) playPcm(e.data as ArrayBuffer); // binary downlink = agent speech PCM
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
    if (!agentBubble) {
      agentBubble = document.createElement("div");
      agentBubble.className = "bubble bubble-agent";
      transcriptEl.appendChild(agentBubble);
    }
    agentBubble.textContent += String(msg.delta);
    scrollTranscriptToBottom();
  } else if (msg.type === "agent_done") {
    agentBubble = null;
  } else if (msg.type === "tool_call") {
    addToolRow(`⚙ ${msg.name}(${JSON.stringify(msg.args)})`);
  } else if (msg.type === "tool_result") {
    addToolRow(`⚙ → ${JSON.stringify(msg.result)}`);
  } else if (msg.type === "metric" && msg.name === "eot_gap_ms") {
    fmtMs(statEot, msg.value as number | null, 700, 1200);
  } else if (msg.type === "metric" && msg.name === "llm_first_token_ms") {
    fmtMs(statLlm, msg.value as number, 700, 1500);
  } else if (msg.type === "turn_state") {
    const s = String(msg.state);
    if (s === "LISTENING") setOrbState("listening", "Listening");
    else if (s === "THINKING") setOrbState("thinking", "Thinking");
    else if (s === "SPEAKING") setOrbState("speaking", "Speaking");
  } else if (msg.type === "speech_end") {
    speechEndWallMs = typeof msg.wallMs === "number" ? msg.wallMs : null;
    awaitingFirstAudio = true;
    acceptAudio = true; // new reply begins; stale-chunk window is over
  } else if (msg.type === "tts_done") {
    // agent finished speaking (playback may still be draining scheduled audio)
  } else if (msg.type === "stop_audio") {
    stopPlayback(); // server-side barge-in confirmation / STT fallback
    acceptAudio = false;
  } else if (msg.type === "notice") {
    // Soft, non-fatal session note (e.g. rate limit) — connection is fine.
    addNoticeRow(String(msg.message ?? msg.code));
  } else if (msg.type === "fatal") {
    console.error("FATAL server error:", msg);
    acceptAudio = true; // let the fallback line play
    awaitingFirstAudio = false; // never suppress it
    setConn(`Failed (${msg.source}/${msg.code})`, "err");
    setOrbState("error", "Error");
    addFatalRow(String(msg.fallbackLine ?? "Something went wrong. Session ending."));
  } else if (msg.type === "session_ended") {
    stopCapture();
    setConn("Session ended", "warn");
    setOrbState("idle", "Idle");
  } else if (msg.type === "error") {
    console.error("server error:", msg);
    addNoticeRow(String(msg.message ?? msg.code));
  }
});

ws.addEventListener("open", () => {
  setConn("Connected", "ok");
  startBtn.disabled = false;
});
ws.addEventListener("close", () => {
  setConn("Disconnected", "err");
  startBtn.disabled = true;
});
ws.addEventListener("error", () => {
  setConn("Connection error", "err");
});

// --- Mic capture ---
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

  capture.port.onmessage = (e: MessageEvent<ArrayBuffer | { vad: boolean; detectMs?: number }>) => {
    if (e.data instanceof ArrayBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(e.data);
        framesSent++;
      }
      return;
    }
    if (e.data.vad === true) {
      vadActive = true;
      onVoiceDetected(e.data.detectMs ?? 64);
    } else if (e.data.vad === false) {
      vadActive = false;
    }
  };

  source.connect(capture);
  capture.connect(audioCtx.destination); // keeps the node processing; worklet outputs silence

  framesSent = 0;
  setMic("Mic live", "ok");
  setOrbState("listening", "Listening");
  startBtn.disabled = true;
  stopBtn.disabled = false;
  console.log(`capture started, context rate ${audioCtx.sampleRate} Hz`);
}

function stopCapture(): void {
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  void audioCtx?.close();
  audioCtx = null;
  stopPlayback();
  setMic("Mic off", "err");
  setOrbState("idle", "Idle");
  startBtn.disabled = false;
  stopBtn.disabled = true;
  console.log(`capture stopped after ${framesSent} frames`);
}

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  startCapture().catch((err) => {
    console.error("mic start failed:", err);
    setMic(`Mic error: ${err.message ?? err}`, "err");
    startBtn.disabled = false;
  });
});
stopBtn.addEventListener("click", stopCapture);

// Buttons stay disabled until the WS is actually open.
startBtn.disabled = ws.readyState !== WebSocket.OPEN;
stopBtn.disabled = true;

export {};
