import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolSet } from "../src/server/tools";

const SLOTS = ["10:00", "11:30", "14:30", "16:00"];

test("check_availability returns all slots when nothing is booked", () => {
  const tools = createToolSet(SLOTS);
  const res = tools.execute("check_availability", { date: "2026-07-21" });
  assert.deepEqual(res.availableSlots, SLOTS);
  assert.equal(res.date, "2026-07-21");
});

test("check_availability rejects a malformed date", () => {
  const tools = createToolSet(SLOTS);
  const res = tools.execute("check_availability", { date: "tomorrow" });
  assert.ok(res.error, "expected an error for a non-ISO date");
});

test("book_appointment returns a confirmation id and records the booking", () => {
  const tools = createToolSet(SLOTS);
  const res = tools.execute("book_appointment", {
    date: "2026-07-21",
    slot: "14:30",
    name: "Alice",
  });
  assert.match(String(res.confirmationId), /^APT-[A-Z0-9]{4}$/);
  assert.equal(res.slot, "14:30");
  assert.equal(res.name, "Alice");
});

test("a booked slot is removed from later availability", () => {
  const tools = createToolSet(SLOTS);
  tools.execute("book_appointment", { date: "2026-07-21", slot: "14:30" });
  const res = tools.execute("check_availability", { date: "2026-07-21" });
  assert.ok(!(res.availableSlots as string[]).includes("14:30"));
  // A different date is unaffected.
  const other = tools.execute("check_availability", { date: "2026-07-22" });
  assert.deepEqual(other.availableSlots, SLOTS);
});

test("double-booking the same slot is rejected", () => {
  const tools = createToolSet(SLOTS);
  tools.execute("book_appointment", { date: "2026-07-21", slot: "14:30" });
  const res = tools.execute("book_appointment", { date: "2026-07-21", slot: "14:30" });
  assert.ok(res.error, "expected an error for a taken slot");
  assert.ok(!res.confirmationId);
});

test("booking an unknown slot is rejected", () => {
  const tools = createToolSet(SLOTS);
  const res = tools.execute("book_appointment", { date: "2026-07-21", slot: "09:00" });
  assert.ok(res.error);
});

test("book_appointment defaults the name to Guest", () => {
  const tools = createToolSet(SLOTS);
  const res = tools.execute("book_appointment", { date: "2026-07-21", slot: "10:00" });
  assert.equal(res.name, "Guest");
});

test("an unknown tool name returns an error, never throws", () => {
  const tools = createToolSet(SLOTS);
  const res = tools.execute("delete_everything", {});
  assert.ok(res.error);
});

test("declarations expose exactly the two tools", () => {
  const tools = createToolSet(SLOTS);
  const names = tools.declarations.map((d) => d.name).sort();
  assert.deepEqual(names, ["book_appointment", "check_availability"]);
});
