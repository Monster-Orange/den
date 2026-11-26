/**
 * Issue 625: doctor's rows for the test boxes (gate slots on other
 * machines). Each box: its slots, how many are held, and what its last
 * check found. A held or unreachable box is ⚠ with why: it is skipped,
 * never waited on. Doctor reads the last check; it never checks a box
 * itself (a box is checked only when a slot on it is about to be given).
 * A box turned off, or outside its window, says so: it is skipped by
 * choice, not a warning.
 */
import type { OnboardCheck } from "./doctor-onboard.js";
import {
  boxEndpoints,
  pwServes,
  type GateBox,
} from "../../shared/gates/boxes.js";
import type { GateStore } from "../../shared/gates/store.js";
import { boxOffWords, gateBoxesView } from "../../shared/gates/view.js";
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
    const off = boxOffWords(b);
    const what = off
      ? `skipped, ${off}`
      : b.state === "unchecked"
        ? "not checked yet (checked when a slot on it is about to be given)"
        : b.state === "open"
          ? `open${when}`
          : `skipped, ${b.state}${b.reason ? `: ${b.reason}` : ""}${when}`;
    const mark =
      b.state === "held" ||
      b.state === "unreachable" ||
      b.state === "low" ||
      b.state === "unknown"
        ? "⚠"
        : "✓";
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

export function boxPinLines(
  boxes: readonly GateBox[],
  pins: readonly { project: string; version: string }[],
): { lines: string[]; check: OnboardCheck } {
  const known = boxes
    .map((b) => ({
      name: b.name,
      versions: boxEndpoints(b).flatMap((x) => (x.version ? [x.version] : [])),
    }))
    .filter((b) => b.versions.length);
  if (!known.length || !pins.length)
    return {
      lines: [],
      check: { id: "gate_box_playwright", status: "ok", detail: "" },
    };
  const off = known.flatMap((b) =>
    pins
      .filter((p) => !b.versions.some((v) => pwServes(v, p.version)))
      .map(
        (p) =>
          `box ${b.name} serves Playwright ${b.versions.join(", ")}; project ${p.project} pins ${p.version}, so its browser runs skip this box`,
      ),
  );
  const ok = "every test box serves the Playwright its projects pin";
  return {
    lines: [
      "",
      "Test boxes' Playwright",
      "",
      ...(off.length ? off.map((t) => `  ⚠  ${t}`) : [`  ✓  ${ok}`]),
    ],
    check: {
      id: "gate_box_playwright",
      status: off.length ? "warn" : "ok",
      detail: off.length ? off.join("; ") : ok,
    },
  };
}
