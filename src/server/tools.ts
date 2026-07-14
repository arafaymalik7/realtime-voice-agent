// tools.ts — one function per tool, defined inputs/outputs, no side effects
// beyond the tool's one job. Demo booking system: deterministic fake slots,
// in-memory bookings per session.

export interface ToolDeclaration {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
}

export interface ToolSet {
  declarations: ToolDeclaration[];
  /** Execute a named tool. Never throws: errors come back as {error}. */
  execute(name: string, args: Record<string, unknown>): Record<string, unknown>;
}

const SLOTS = ["10:00", "11:30", "14:30", "16:00"]; // fixed demo availability

function newConfirmationId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 4; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return `APT-${id}`;
}

export function createToolSet(): ToolSet {
  // Session-scoped state: bookings made during this call.
  const bookings = new Map<string, { slot: string; date: string; name: string }>();

  const declarations: ToolDeclaration[] = [
    {
      name: "check_availability",
      description:
        "Look up open appointment slots for a given date. Call this before booking " +
        "so you only offer slots that exist.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date to check, ISO format YYYY-MM-DD" },
        },
        required: ["date"],
      },
    },
    {
      name: "book_appointment",
      description:
        "Book an appointment in a specific open slot. Returns a confirmation id " +
        "that must be read back to the caller.",
      parametersJsonSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Appointment date, ISO format YYYY-MM-DD" },
          slot: { type: "string", description: "Time slot from check_availability, e.g. 14:30" },
          name: { type: "string", description: "Caller's name if they gave one" },
        },
        required: ["date", "slot"],
      },
    },
  ];

  function execute(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (name === "check_availability") {
      const date = String(args.date ?? "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { error: "invalid date, expected YYYY-MM-DD" };
      }
      const taken = [...bookings.values()].filter((b) => b.date === date).map((b) => b.slot);
      return { date, availableSlots: SLOTS.filter((s) => !taken.includes(s)) };
    }

    if (name === "book_appointment") {
      const date = String(args.date ?? "");
      const slot = String(args.slot ?? "");
      const name_ = String(args.name ?? "Guest");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return { error: "invalid date, expected YYYY-MM-DD" };
      }
      if (!SLOTS.includes(slot)) {
        return { error: `unknown slot "${slot}", valid slots: ${SLOTS.join(", ")}` };
      }
      const taken = [...bookings.values()].some((b) => b.date === date && b.slot === slot);
      if (taken) return { error: `slot ${slot} on ${date} is already booked` };

      const confirmationId = newConfirmationId();
      bookings.set(confirmationId, { slot, date, name: name_ });
      return { confirmationId, date, slot, name: name_ };
    }

    return { error: `unknown tool "${name}"` };
  }

  return { declarations, execute };
}
