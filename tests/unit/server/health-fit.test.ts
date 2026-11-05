/**
 * The health poll's model (health-fit.js): the problem-first order, the
 * paint gate, one poll's cycle and the rail's share. The header's dot row
 * and its "+N" chip (0.3.0-dev.9 to dev.18) gave way to the status chip
 * and drawer in dev.20 (topbar.test.ts).
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import {
  buildRow,
  healthCycle,
  paintGate,
  shellHealth,
} from "../../../src/ui/server/public/health-fit.js";

type Row = {
  repo: string;
  service: string;
  ok: boolean | null;
  isEntrypoint?: boolean;
  focused?: boolean;
};
const one = (repo: string, ok: boolean | null, focused = false): Row => ({
  repo,
  service: repo,
  ok,
  focused,
});

describe("buildRow", () => {
  it("orders down, degraded, ok, then unknown; focused first, then by name", () => {
    const { flat } = buildRow(
      [
        one("zeta", true, true),
        one("alpha", true),
        one("beta", true, true),
        one("down-b", false),
        one("down-a", false),
        one("quiet", null),
        { repo: "multi", service: "web", ok: true, isEntrypoint: true },
        { repo: "multi", service: "mailpit", ok: false },
      ],
      null,
    );
    expect(
      flat.map((r: { repo: string; state: string }) => [r.repo, r.state]),
    ).toEqual([
      ["down-a", "down"],
      ["down-b", "down"],
      ["multi", "degraded"],
      ["beta", "ok"],
      ["zeta", "ok"],
      ["alpha", "ok"],
      ["quiet", "unknown"],
    ]);
  });

  it("a box sorts by its worst repo, and keeps problems first inside", () => {
    const { units } = buildRow(
      [one("a", true), one("b", false), one("c", true)],
      [
        { app: { name: "fine" }, repos: ["a"] },
        { app: { name: "hurt" }, repos: ["c", "b"] },
      ],
    );
    expect(
      units.map((u: { app: { name: string }; repos: { repo: string }[] }) => [
        u.app.name,
        u.repos.map((r) => r.repo),
      ]),
    ).toEqual([
      ["hurt", ["b", "c"]],
      ["fine", ["a"]],
    ]);
  });
});

describe("paintGate: the first fit waits for the first full cycle", () => {
  // A fake clock: the stream lands batches at 0.6s, 1.2s, 2.4s and 3.6s.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  const at = (ms: number, now: { t: number }) => {
    jest.advanceTimersByTime(ms - now.t);
    now.t = ms;
  };

  it("paints once, when the first cycle ends, not per batch", () => {
    const gate = paintGate();
    const paints: string[] = [];
    const now = { t: 0 };
    gate.hold();
    for (const t of [600, 1200, 2400, 3600]) {
      at(t, now);
      gate.data(() => paints.push(`batch ${t}`));
    }
    at(3650, now);
    expect(paints).toEqual([]);
    gate.done(() => paints.push("full"));
    expect(paints).toEqual(["full"]);
    at(10000, now);
    expect(paints).toEqual(["full"]);
  });

  it("after that, data changes repaint debounced ~300ms; a burst is one paint", () => {
    const gate = paintGate();
    const paints: number[] = [];
    const now = { t: 0 };
    gate.hold();
    gate.done(() => paints.push(0));
    for (const t of [5000, 5100, 5200, 5250]) {
      at(t, now);
      gate.data(() => paints.push(t));
    }
    at(5549, now);
    expect(paints).toEqual([0]);
    at(5550, now);
    expect(paints).toEqual([0, 5250]);
    // The end of a later cycle is a data change too.
    gate.done(() => paints.push(6000));
    expect(paints).toEqual([0, 5250]);
    at(5850, now);
    expect(paints).toEqual([0, 5250, 6000]);
  });

  it("a slow probe never keeps the placeholder past the cap", () => {
    const gate = paintGate({ cap: 8000 });
    const paints: string[] = [];
    gate.hold();
    gate.data(() => paints.push("partial"));
    jest.advanceTimersByTime(7999);
    expect(paints).toEqual([]);
    jest.advanceTimersByTime(1);
    expect(paints).toEqual(["partial"]);
    expect(gate.ready).toBe(true);
  });

  it("an environment switch holds again", () => {
    const gate = paintGate();
    const paints: string[] = [];
    gate.hold();
    gate.done(() => paints.push("local"));
    gate.hold();
    gate.data(() => paints.push("staging batch"));
    jest.advanceTimersByTime(1000);
    expect(paints).toEqual(["local"]);
    gate.done(() => paints.push("staging"));
    expect(paints).toEqual(["local", "staging"]);
  });
});

describe("healthCycle: the first paint waits for every check", () => {
  // A fake clock and a fake stream: api and web answer at 0.1s, a remote
  // probe (remote/web) only at 5s.
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());
  type R = { repo: string; service: string; ok: boolean | null };
  const r = (repo: string, ok: boolean | null): R => ({
    repo,
    service: "web",
    ok,
  });
  const schedule = (
    events: [number, R | "done" | "break"][],
    onResult: (x: R) => void,
  ) =>
    new Promise<string>((resolve) => {
      let got = false;
      for (const [t, e] of events)
        setTimeout(() => {
          if (e === "done") resolve("done");
          else if (e === "break") resolve(got ? "partial" : "none");
          else {
            got = true;
            onResult(e);
          }
        }, t);
    });
  const run = (
    events: [number, R | "done" | "break"][],
    fetchAll: () => Promise<R[] | null> = async () => null,
  ) => {
    const paints: { at: number; rows: R[] }[] = [];
    const t0 = Date.now();
    const gate = paintGate();
    void healthCycle({
      seed: [],
      gate,
      stream: (on: (x: R) => void) => schedule(events, on),
      fetchAll,
      paint: (m: Map<string, R>) =>
        paints.push({ at: Date.now() - t0, rows: [...m.values()] }),
    });
    return paints;
  };
  const downAt = (paints: { rows: R[] }[], repo: string) =>
    paints.some((p) => p.rows.some((x) => x.repo === repo && x.ok === false));

  it("no paint before the slow check lands; then one, with it", async () => {
    const paints = run([
      [100, r("api", true)],
      [100, r("web", true)],
      [5000, r("remote", true)],
      [5000, "done"],
    ]);
    await jest.advanceTimersByTimeAsync(4999);
    expect(paints).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(paints).toHaveLength(1);
    expect(paints[0].at).toBe(5000);
    expect(paints[0].rows.map((x) => x.repo).sort()).toEqual([
      "api",
      "remote",
      "web",
    ]);
    expect(downAt(paints, "remote")).toBe(false);
  });

  it("a stream that breaks at 0.6s is not a cycle: /api/health completes it", async () => {
    const full = [r("api", true), r("web", true), r("remote", true)];
    const paints = run(
      [
        [100, r("api", true)],
        [100, r("web", true)],
        [600, "break"],
      ],
      () => new Promise((res) => setTimeout(() => res(full), 4400)),
    );
    await jest.advanceTimersByTimeAsync(4999);
    expect(paints).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(paints).toHaveLength(1);
    expect(paints[0].rows).toHaveLength(3);
  });

  it("the 8s cap paints what landed; the missing check is absent, never down", async () => {
    const paints = run(
      [
        [100, r("api", true)],
        [100, r("web", true)],
        [600, "break"],
      ],
      async () => null,
    );
    await jest.advanceTimersByTimeAsync(7999);
    expect(paints).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(paints).toHaveLength(1);
    expect(paints[0].at).toBe(8000);
    // What landed is drawn, but a repo no complete cycle has described is
    // unknown until one does: the cycle may still hold its other checks.
    const row = buildRow(paints[0].rows, null);
    expect(row.flat.map((x) => [x.repo, x.state]).sort()).toEqual([
      ["api", "unknown"],
      ["web", "unknown"],
    ]);
    expect(downAt(paints, "remote")).toBe(false);
  });

  // 0.3.0-dev.17: one cold load in twenty painted an app red for ~100ms,
  // its one down service (mailpit) the only one answered so far.
  const m = (service: string, ok: boolean | null) => ({
    repo: "mail",
    service,
    ok,
  });
  const states = (rows: R[]) =>
    buildRow(rows, null).flat.map((x) => [x.repo, x.state]);

  it("a partial paint never shows an app down before its other checks answer", async () => {
    // Nothing seeded, and the gate opened by an overlapping poll that
    // completed first (its done() ends the hold this cycle asked for).
    const gate = paintGate({ delay: 0 });
    const paints: R[][] = [];
    setTimeout(() => gate.done(), 50);
    void healthCycle({
      seed: [],
      gate,
      stream: (on: (x: R) => void) =>
        schedule(
          [
            [100, m("mailpit", false)],
            [300, m("web", true)],
            [300, "done"],
          ],
          on,
        ),
      fetchAll: async () => null,
      paint: (rows: Map<string, R>) => paints.push([...rows.values()]),
    });
    await jest.advanceTimersByTimeAsync(200);
    expect(paints.length).toBeGreaterThan(0);
    for (const p of paints) expect(states(p)).toEqual([["mail", "unknown"]]);
    await jest.advanceTimersByTimeAsync(200);
    expect(states(paints[paints.length - 1])).toEqual([["mail", "degraded"]]);
  });

  it("a repo a complete cycle described keeps its other answers meanwhile", async () => {
    const gate = paintGate({ delay: 0 });
    const paints: R[][] = [];
    const last = new Map([
      ["mail/web", { ...m("web", true), isEntrypoint: true }],
      ["mail/mailpit", m("mailpit", true)],
    ]);
    setTimeout(() => gate.done(), 50);
    void healthCycle({
      seed: [],
      last: () => last,
      gate,
      stream: (on: (x: R) => void) =>
        schedule([[100, m("mailpit", false)]], on),
      fetchAll: async () => null,
      paint: (rows: Map<string, R>) => paints.push([...rows.values()]),
    });
    await jest.advanceTimersByTimeAsync(200);
    expect(states(paints[paints.length - 1])).toEqual([["mail", "degraded"]]);
  });
});

describe("shellHealth: the rail's badge and pinned dots", () => {
  it("counts only answered downs, in repos whose checks have all answered", () => {
    const row = buildRow(
      [
        { repo: "mail", service: "mailpit", ok: false },
        { repo: "mail", service: "…", ok: null, awaiting: true },
        { repo: "shop", service: "web", ok: false },
        { repo: "shop", service: "db", ok: true },
      ],
      null,
    );
    expect(shellHealth(row)).toEqual({
      down: 1,
      health: {
        mail: "unknown",
        "mail/mailpit": "unknown",
        shop: "degraded",
        "shop/web": "down",
        "shop/db": "ok",
      },
    });
  });
});
