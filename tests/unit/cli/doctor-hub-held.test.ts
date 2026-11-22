/**
 * Issue 701: doctor shows the Hub comments this install holds, per agent,
 * with how long and why, and a typed one with no answer yet. ⚠ once one
 * has waited past hub.delivery_held_bell_minutes. Read from Den's held
 * file only (no server, no Hub). Invented names.
 */
import { describe, expect, it } from "@jest/globals";
import { heldLines } from "../../../src/ui/cli/doctor-hub-held";

const now = Date.parse("2026-01-02T10:00:00Z");
const item = (id: string, at: string, reason?: string) => ({
  id,
  agent: "x",
  created_at: at,
  ...(reason ? { held_reason: reason } : {}),
});

describe("issue 701: doctor's held Hub comments", () => {
  it("nothing held: one ✓ line", () => {
    const r = heldLines("Den", null, { now, bellMinutes: 5 });
    expect(r.check.status).toBe("ok");
    expect(r.lines.join("\n")).toMatch(/no Hub comments held/);
  });

  it("per agent: count, oldest age and reason; ⚠ past the setting", () => {
    const r = heldLines(
      "Den",
      {
        queue: {
          designer: [
            item("a", "2026-01-02T09:44:00Z", "the agent is busy with a turn"),
            item("b", "2026-01-02T09:50:00Z", "the agent is busy with a turn"),
          ],
          writer: [item("c", "2026-01-02T09:58:00Z")],
        },
        active: {
          helper: { ids: ["d"], typedAt: Date.parse("2026-01-02T08:00:00Z") },
        },
      },
      { now, bellMinutes: 5 },
    );
    const text = r.lines.join("\n");
    expect(text).toContain(
      "designer: 2 held, oldest 16 min: the agent is busy with a turn",
    );
    expect(text).toContain("writer: 1 held, oldest 2 min");
    expect(text).toContain("helper: 1 typed 120 min ago, no answer yet");
    expect(r.check.id).toBe("hub_held_comments");
    expect(r.check.status).toBe("warn");
  });
});
