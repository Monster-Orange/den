/**
 * Issue 1002: an ask's measured estimate (issue 999) reads only the slot
 * log's tail, so its cost doesn't grow with the log. It reads back from the
 * end until it has the label's last 10 and the asker's last 10, and never
 * more than a fixed amount, and finds the same median as a full read.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  GateStore,
  MEASURE_TAIL_MAX_BYTES,
} from "../../../src/shared/gates/store.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T06:00:00Z");
const WHO = "den · north · agent:coder";

function store(dir: string) {
  return new GateStore({
    platform: "linux",
    dir,
    now: () => T0,
    alive: () => true,
  });
}

/** A log of `n` rows: mostly other runs, with `label`'s released runs. */
function bigLog(dir: string, n: number, recent: number[]) {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const at = new Date(T0 - (n - i) * 1000).toISOString();
    lines.push(
      JSON.stringify({
        at,
        event: i % 2 ? "granted" : "released",
        id: `old${i}`,
        kind: "browser",
        who: `den · other${i % 7} · a person`,
        label: `other ${i % 50}`,
        minutes: 500,
      }),
    );
  }
  // An old run of the label, then a settings change, then the recent runs.
  lines.splice(
    10,
    0,
    JSON.stringify({
      at: new Date(T0 - n * 1000).toISOString(),
      event: "released",
      id: "ancient",
      kind: "browser",
      who: WHO,
      label: "full check",
      minutes: 999,
    }),
  );
  recent.forEach((m, j) => {
    lines.push(
      JSON.stringify({
        at: new Date(T0 - 100 + j).toISOString(),
        event: "released",
        id: `r${j}`,
        kind: "browser",
        who: WHO,
        label: "full check",
        minutes: m,
      }),
    );
    lines.push(
      JSON.stringify({
        at: new Date(T0 - 100 + j).toISOString(),
        event: "settings",
        by: "a person",
        changes: {},
      }),
    );
  });
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");
}

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1002-"));
  tmps.push(dir);
  return dir;
}

/** Today's answer: the same rule over a full read of the log. */
function fullRead(s: GateStore, label: string) {
  const done = s
    .events()
    .filter((r) => r.event === "released" && typeof r.minutes === "number")
    .filter((r) => r.kind === "browser" && r.label === label)
    .slice(-10)
    .map((r) => r.minutes!)
    .sort((a, b) => a - b);
  return done;
}

describe("the measured estimate reads the log's tail (issue 1002)", () => {
  it("a 100k-row log: a fixed read, and the same median as a full read", () => {
    const dir = tmp();
    const recent = [70, 74, 90, 72, 80, 71, 73, 75, 77, 79, 81, 83];
    bigLog(dir, 100_000, recent);
    expect(fs.statSync(path.join(dir, "events.jsonl")).size).toBeGreaterThan(
      10 * MEASURE_TAIL_MAX_BYTES,
    );
    const s = store(dir);
    const m = s.measured({ kind: "browser", label: "full check", who: WHO });
    const full = fullRead(s, "full check");
    expect(full).toHaveLength(10);
    // Today's rule over the whole log: the median of the label's last 10.
    const want = Math.round((full[4]! + full[5]!) / 2);
    expect(m).toEqual({ minutes: want, from: "label" });
    // measured() alone, before the full read above added its own bytes.
    const t = store(dir);
    t.measured({ kind: "browser", label: "full check", who: WHO });
    expect(t.logBytesRead).toBeGreaterThan(0);
    expect(t.logBytesRead).toBeLessThanOrEqual(MEASURE_TAIL_MAX_BYTES);
  });

  it("the label's runs are near the end: it stops long before the cap", () => {
    const dir = tmp();
    bigLog(dir, 100_000, [70, 74, 90, 72, 80, 71, 73, 75, 77, 79]);
    const s = store(dir);
    s.measured({ kind: "browser", label: "full check", who: WHO });
    expect(s.logBytesRead).toBeLessThan(MEASURE_TAIL_MAX_BYTES / 4);
  });

  it("a log under the cap: the same answer as a full read, the old run counted", () => {
    const dir = tmp();
    bigLog(dir, 200, [70, 74]);
    const s = store(dir);
    // Old 999 + two recent: the label's 3, median 74.
    expect(
      s.measured({ kind: "browser", label: "full check", who: WHO }),
    ).toEqual({ minutes: 74, from: "label" });
  });

  it("no log: none, and nothing read", () => {
    const s = store(tmp());
    expect(
      s.measured({ kind: "browser", label: "full check", who: WHO }),
    ).toBeNull();
    expect(s.logBytesRead).toBe(0);
  });
});
