/**
 * Issue 625: doctor's rows for the test boxes (gate slots on other
 * machines). Each box: its slots, how many are held, and what its last
 * check found. A held or unreachable box is ⚠ with why: it is skipped,
 * never waited on. Doctor reads the last check; it never checks a box
 * itself (a box is checked only when a slot on it is about to be given).
 */
import type { OnboardCheck } from "./doctor-onboard.js";
import type { GateStore } from "../../shared/gates/store.js";
import { gateBoxesView } from "../../shared/gates/view.js";
import { localDateTime } from "../../shared/local-time.js";

export function boxLines(store: GateStore): {
  lines: string[];
  check: OnboardCheck;
} {
  const boxes = gateBoxesView(
    store,
    store.list().map((e) => ({ granted: !!e.grantedAt, box: e.box })),
  );
  if (!boxes.length)
    return {
      lines: [],
      check: { id: "gate_boxes", status: "ok", detail: "no test boxes set" },
    };
  const rows = boxes.map((b) => {
    const when = b.checkedAt ? ` (checked ${localDateTime(b.checkedAt)})` : "";
    const what =
      b.state === "unchecked"
        ? "not checked yet (checked when a slot on it is about to be given)"
        : b.state === "open"
          ? `open${when}`
          : `skipped, ${b.state}${b.reason ? `: ${b.reason}` : ""}${when}`;
    const mark = b.state === "held" || b.state === "unreachable" ? "⚠" : "✓";
    return {
      mark,
      text: `${b.name}  ${b.held} of ${b.slots} browser slots held; ${what}`,
    };
  });
  const warn = rows.some((r) => r.mark === "⚠");
  return {
    lines: [
      "",
      "Test boxes (gate slots)",
      "",
      ...rows.map((r) => `  ${r.mark}  ${r.text}`),
    ],
    check: {
      id: "gate_boxes",
      status: warn ? "warn" : "ok",
      detail: rows.map((r) => r.text).join("; "),
    },
  };
}
