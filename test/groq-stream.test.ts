import { test } from "node:test";
import assert from "node:assert/strict";
import { streamDeltas, type StreamDelta } from "../src/server/llm-groq";

// Build a ReadableStream from string chunks, mimicking network framing where a
// single SSE line can be split across two reads.
function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  const ac = new AbortController();
  for await (const d of streamDeltas(streamFrom(chunks), ac.signal)) out.push(d);
  return out;
}

test("parses content deltas and stops at [DONE]", async () => {
  const deltas = await collect([
    'data: {"choices":[{"delta":{"content":"Hi "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"there."}}]}\n\n',
    "data: [DONE]\n\n",
    'data: {"choices":[{"delta":{"content":"IGNORED"}}]}\n\n',
  ]);
  const text = deltas.map((d) => d.content ?? "").join("");
  assert.equal(text, "Hi there.");
});

test("reassembles an SSE line split across chunk boundaries", async () => {
  const deltas = await collect([
    'data: {"choices":[{"delta":{"con',
    'tent":"split"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert.equal(deltas.map((d) => d.content).join(""), "split");
});

test("surfaces tool_call fragments for the caller to accumulate", async () => {
  const deltas = await collect([
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"book","arguments":"{\\"a\\":"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  // Emulate the accumulator the adapter uses.
  let name = "";
  let args = "";
  for (const d of deltas) {
    for (const tc of d.tool_calls ?? []) {
      if (tc.function?.name) name = tc.function.name;
      if (tc.function?.arguments) args += tc.function.arguments;
    }
  }
  assert.equal(name, "book");
  assert.deepEqual(JSON.parse(args), { a: 1 });
});

test("ignores keep-alive and non-data lines", async () => {
  const deltas = await collect([
    ": keep-alive\n\n",
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  assert.equal(deltas.map((d) => d.content).join(""), "ok");
});
