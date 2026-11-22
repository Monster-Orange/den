/**
 * Issue 999: a gate run's estimate comes from its measured history. With
 * no estimate given, the gate uses the median of the label's last 10
 * finished runs (3 or more of them), else the asker's runs of that kind,
 * else the kind's default (10 min). A given estimate over twice that
 * median is kept and flagged, and the queue's wait times use the median.
 * `gate status --json` gives both values and where each came from.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  expectedStart,
  type GateKind,
} from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

const T0 = Date.parse("2026-11-22T06:00:00Z");
const MIN = 60_000;

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate999-"));
  tmps.push(dir);
  let now = T0;
  const store = new GateStore({
    platform: "linux",
    dir,
    now: () => now,
    alive: () => true,
  });
  return {
    store,
    at: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type T = ReturnType<typeof setup>;
const WHO = "den · north · agent:coder";

/** Runs that finished: each held `minutes`, then released. */
function ran(
  t: T,
  minutes: number[],
  o: { label?: string; who?: string; kind?: GateKind } = {},
) {
  for (const m of minutes) {
    const e = t.store.ask({
      kind: o.kind ?? "browser",
      who: o.who ?? WHO,
      label: o.label ?? "full check",
      pid: 1,
      estimateMin: 10,
    });
    expect(e.grantedAt).toBeDefined();
    t.advance(m * MIN);
    t.store.release(e.id);
  }
}

const ask = (
  t: T,
  estimateMin?: number,
  o: { label?: string; who?: string; kind?: GateKind } = {},
) =>
  t.store.ask({
    kind: o.kind ?? "browser",
    who: o.who ?? WHO,
    label: o.label ?? "full check",
    pid: 1,
    ...(estimateMin !== undefined ? { estimateMin } : {}),
  });

describe("no estimate given (issue 999)", () => {
  it("5 past runs of the label: their median", () => {
    const t = setup();
    ran(t, [70, 74, 90, 72, 80]);
    const e = ask(t);
    expect(e).toMatchObject({
      estimateMin: 74,
      estimateFrom: "label",
    });
    expect(e.expectedMin ?? e.estimateMin).toBe(74);
  });

  it("only the last 10 of the label count", () => {
    const t = setup();
    ran(t, [500, 500, 500, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);
    expect(ask(t).estimateMin).toBe(10);
  });

  it("fewer than 3 of the label: the asker's runs of that kind", () => {
    const t = setup();
    ran(t, [30, 40], { label: "full check" });
    ran(t, [20, 22, 24], { label: "unit" });
    // A cpu run of the asker's doesn't count for a browser one.
    ran(t, [99, 99, 99], { label: "lint", kind: "cpu" });
    expect(ask(t)).toMatchObject({ estimateMin: 24, estimateFrom: "actor" });
  });

  it("none: the kind's default, 10 min", () => {
    const t = setup();
    // Someone else's runs of another label: neither the label's nor ours.
    ran(t, [50, 50, 50], { who: "den · south · a person" });
    expect(ask(t, undefined, { label: "new" })).toMatchObject({
      estimateMin: 10,
      estimateFrom: "default",
    });
  });
});

describe("a given estimate against the median (issue 999)", () => {
  it("over twice the median: kept, flagged, and the queue uses the median", () => {
    const t = setup();
    ran(t, [70, 74, 90, 72, 80]);
    const e = ask(t, 150);
    expect(e).toMatchObject({
      estimateMin: 150,
      estimateFrom: "given",
      expectedMin: 74,
      expectedFrom: "label",
      padded: true,
    });
    // A waiter behind it expects to start when the median says, not 150.
    const w = ask(t, 10, { label: "other", who: "den · south · a person" });
    expect(expectedStart(t.store.list(), w.id, t.at())).toBe(t.at() + 74 * MIN);
  });

  it("at twice the median or under: not flagged, the given one is used", () => {
    const t = setup();
    ran(t, [70, 74, 90, 72, 80]);
    const e = ask(t, 148);
    expect(e).toMatchObject({ estimateMin: 148, estimateFrom: "given" });
    expect(e.padded).toBeUndefined();
    expect(e.expectedMin).toBeUndefined();
  });

  it("no history: a given estimate is never flagged", () => {
    const t = setup();
    expect(ask(t, 500).padded).toBeUndefined();
  });
});

describe("gate status --json says both, and where each came from (issue 999)", () => {
  it("estimate and expected, each with its source; the flag", () => {
    const t = setup();
    ran(t, [70, 74, 90, 72, 80]);
    const e = ask(t, 150);
    const s = gateView(t.store, t.at()).slots.find((x) => x.id === e.id)!;
    expect(s).toMatchObject({
      estimate: { minutes: 150, from: "given" },
      expected: { minutes: 74, from: "label" },
      padded: true,
    });
    const plain = ask(t, undefined, { label: "new", kind: "cpu" });
    const p = gateView(t.store, t.at()).slots.find((x) => x.id === plain.id)!;
    expect(p).toMatchObject({
      estimate: { minutes: 10, from: "default" },
      expected: { minutes: 10, from: "default" },
    });
    expect(p).not.toHaveProperty("padded");
  });
});

describe("gate status and the Gate panel show the flag (issue 999)", () => {
  it("the status line: estimate 150 min; this usually takes 74", async () => {
    const { slotLine } = await import("../../../src/ui/cli/gate-command.js");
    const t = setup();
    ran(t, [70, 74, 90, 72, 80]);
    const e = ask(t, 150);
    const all = t.store.list();
    const line = slotLine(e, all, t.at(), t.store.settings());
    expect(line).toContain("estimate 150 min; this usually takes 74");
    // Until about: the median's end, not the padded one's.
    const hm = new Date(t.at() + 74 * MIN).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(line).toContain(`until about ${hm}`);
  });

  it("the panel's row has the line in en, es and ja", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/ui/server/public/gate-chip.js"),
      "utf-8",
    );
    expect(src).toMatch(/t\("gate\.padded"/);
    const pub = path.join(process.cwd(), "src/ui/server/public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect(fs.readFileSync(path.join(pub, f), "utf-8")).toMatch(
        /"gate\.padded": "[^"]*\{est\}[^"]*\{usual\}/,
      );
  });
});
