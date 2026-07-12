const statusEl = document.getElementById("status") as HTMLElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;

function setStatus(text: string, cls: string): void {
  statusEl.textContent = text;
  statusEl.className = cls;
}

const proto = location.protocol === "https:" ? "wss" : "ws";
const ws = new WebSocket(`${proto}://${location.host}`);

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

// Phase 0 stubs — mic capture arrives in Phase 1.
startBtn.addEventListener("click", () => console.log("start clicked (Phase 1)"));
stopBtn.addEventListener("click", () => console.log("stop clicked (Phase 1)"));

export {};
