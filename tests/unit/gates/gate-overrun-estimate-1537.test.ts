/**
 * Issue 1537: a run's given --estimate is what its overrun counts from,
 * unless the label's own history (3 or more runs) shows it padded (issue
 * 999). The asker's runs of other commands never mark it padded. The
 * notice says which number it used: "past the 6 min you gave", or "past
 * its usual 2 min, measured" (counted, as before, past that number).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateOverrunWaiting } from "../../../src/ui/server/gate-overrun-bell.js";
import { gateOverrunText } from "../../../src/ui/server/gate-notices.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-25T08:00:00Z");
const MIN = 60_000;
const WHO = "den · north · agent:coder";
const ACTOR = "agent:coder";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate1537-"));
  tmps.push(dir);
  let now = T0;
  const store = new GateStore({
    platform: "linux",
    dir,
    now: () => now,
    alive: () => true,
  });
  const ask = (label: string, estimateMin?: number) =>
    store.ask({
      kind: "browser",
      who: WHO,
      actor: ACTOR,
      label,
      pid: 1,
      ...(estimateMin === undefined ? {} : { estimateMin }),
    });
  return {
    store,
    ask,
    advance: (ms: number) => {
      now += ms;
    },
    /** Runs that finished, each held `minutes`. */
    ran(label: string, minutes: number[]) {
      for (const m of minutes) {
        const e = ask(label, 10);
        now += m * MIN;
        store.release(e.id);
      }
    },
    overruns: () => gateOverrunWaiting(store.peekAll(), store.settings(), now),
  };
}

describe("issue 1537: what a run's overrun counts from", () => {
  it("a new command's given estimate stands, though the asker's other runs were short", () => {
    const t = setup();
    t.ran("one file", [1, 1, 1, 1, 1]);
    const e = t.ask("eleven files", 6);
    expect(e.padded).toBeUndefined();
    t.advance(3 * MIN); // past twice the asker's 1 min, inside its 6
    expect(t.overruns()).toEqual([]);
    t.advance(10 * MIN); // 13 min: past twice its 6
    const [w] = t.overruns();
    expect(w).toMatchObject({
      id: e.id,
      estimateMin: 6,
      estimateFrom: "given",
    });
    expect(gateOverrunText(w!)).toBe(
      `Den: your browser gate slot ${e.id} ("eleven files") is 7 min past the 6 min you gave. Release it with gate_slot_release, or let its command finish.`,
    );
  });

  it("issue 999 still holds: the label's own history marks a padded estimate, and the notice says it was measured", () => {
    const t = setup();
    t.ran("full check", [2, 2, 2]);
    const e = t.ask("full check", 12);
    expect(e).toMatchObject({ padded: true, expectedMin: 2 });
    t.advance(5 * MIN);
    const [w] = t.overruns();
    expect(w).toMatchObject({
      id: e.id,
      estimateMin: 2,
      estimateFrom: "measured",
      givenMin: 12,
    });
    expect(gateOverrunText(w!)).toBe(
      `Den: your browser gate slot ${e.id} ("full check") is 3 min past its usual 2 min, measured (you gave 12). Release it with gate_slot_release, or let its command finish.`,
    );
  });

  it("no estimate given: the measured one, said so", () => {
    const t = setup();
    t.ran("one file", [1, 1, 1]);
    const e = t.ask("one file");
    t.advance(3 * MIN);
    const [w] = t.overruns();
    expect(w).toMatchObject({
      id: e.id,
      estimateMin: 1,
      estimateFrom: "measured",
    });
    expect(gateOverrunText(w!)).toContain(
      "is 2 min past its usual 1 min, measured.",
    );
  });
});

describe("issue 1537: the bell's line says which number it is past", () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = g.window;
  beforeAll(() => {
    g.window = {
      denShell: {
        t: (k: string, v?: Record<string, unknown>) =>
          `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
      },
    };
  });
  afterAll(() => {
    g.window = had;
  });

  const row = (estimateFrom: string) => ({
    kind: "gate_overrun",
    id: "g-1",
    slot: "browser",
    who: WHO,
    label: "full check",
    since: new Date(T0).toISOString(),
    estimateMin: 2,
    estimateFrom,
    overMin: 3,
  });

  it("a given estimate: 'estimate'; a measured one: 'usually …, measured'", async () => {
    const { bellPanel } = await import("../../../src/ui/server/public/bell.js");
    const needs = (w: unknown) => {
      const p = bellPanel({ groups: [], waiting: [w], unread: 0 });
      if (!("sections" in p)) throw new Error("the bell has no sections");
      return p.sections.needs as string;
    };
    expect(needs(row("given"))).toContain("[bell.go.sub:");
    expect(needs(row("given"))).not.toContain("[bell.go.subMeasured:");
    expect(needs(row("measured"))).toContain("[bell.go.subMeasured:");
  });
});
