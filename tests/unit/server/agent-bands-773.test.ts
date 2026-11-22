/**
 * Issue 773: the Agents list's bands (public/agent-bands.js), as the
 * approved mock draws them: one list across projects in four bands, Needs
 * you, Done not seen, Working, Idle, each with its own mark and chip; the
 * project tag on All projects only; the server agent ranked like any other
 * with a "Server" tag; Done turns Idle the moment the person opens it; the
 * sub-line names each state above zero.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

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

const mod = () => import("../../../src/ui/server/public/agent-bands.js");
const T = (m: number) => new Date(Date.UTC(2026, 10, 20, 10, m)).toISOString();
const ag = (
  agent: string,
  attn: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  id: `s-${agent}`,
  kind: "agent",
  agent,
  label: agent,
  workspace: "acme",
  state: "running",
  runtime: "claude",
  ...(attn ? { attn } : {}),
  ...extra,
});

describe("issue 773 Order: four bands, sorted by who needs you", () => {
  it("bands in order Needs you, Done, Working, Idle; empty bands left out", async () => {
    const { bandsOf } = await mod();
    const b = bandsOf([
      ag("scribe", "idle"),
      ag("tester", "working"),
      ag("planner", "needs", { attnSince: T(3) }),
      ag("builder", "done", { attnSince: T(1) }),
    ]);
    expect(b.map((x) => x.state)).toEqual(["needs", "done", "working", "idle"]);
    const idleOnly = bandsOf([ag("a", "idle"), ag("b", "idle")]);
    expect(idleOnly.map((x) => x.state)).toEqual(["idle"]);
    expect(bandsOf([])).toEqual([]);
  });

  it("inside Needs you and Done the longest wait first; Working and Idle A to Z", async () => {
    const { bandsOf } = await mod();
    const b = bandsOf([
      ag("reviewer", "needs", { attnSince: T(11) }),
      ag("planner", "needs", { attnSince: T(3) }),
      ag("linter", "working"),
      ag("docs", "working"),
      ag("triage", "idle"),
      ag("scribe", "idle"),
    ]);
    const names = (s: string) =>
      b.find((x) => x.state === s)!.rows.map((r) => r.agent);
    expect(names("needs")).toEqual(["planner", "reviewer"]);
    expect(names("working")).toEqual(["docs", "linter"]);
    expect(names("idle")).toEqual(["scribe", "triage"]);
  });

  it("sorts by the name shown: a given name before the id", async () => {
    const { bandsOf } = await mod();
    const b = bandsOf([
      ag("zz", "idle", { displayName: "Alpha" }),
      ag("bb", "idle"),
    ]);
    expect(b[0].rows.map((r) => r.agent)).toEqual(["zz", "bb"]);
  });
});

describe("issue 773: a row's state", () => {
  it("no state from the server: waiting (not an idle notice) is Needs you, else Idle", async () => {
    const { rowState } = await mod();
    expect(rowState(ag("a", undefined, { waiting: true }))).toBe("needs");
    expect(
      rowState(ag("a", undefined, { waiting: true, waitingWhy: "input" })),
    ).toBe("idle");
    expect(rowState(ag("a", undefined))).toBe("idle");
    expect(rowState({ id: "s1", kind: "session", state: "running" })).toBe(
      "idle",
    );
  });

  it("Done becomes Idle the moment the person opens it (no button)", async () => {
    const { bandsOf, rowState } = await mod();
    const r = ag("builder", "done", { attnSince: T(1) });
    const seenNow = new Set(["s-builder"]);
    expect(rowState(r, seenNow)).toBe("idle");
    // A need stays a need when opened: only its answer ends it.
    expect(rowState(ag("p", "needs", { id: "s-builder" }), seenNow)).toBe(
      "needs",
    );
    // The Done band goes when it is empty.
    expect(bandsOf([r], { seenNow }).map((x) => x.state)).toEqual(["idle"]);
  });
});

describe("issue 773: marks and chips", () => {
  it("each mark has its own shape and word: !, a tick, a halo, a ring", async () => {
    const { markHtml } = await mod();
    expect(markHtml("needs")).toBe(
      '<span class="agm need" data-mark="needs" aria-hidden="true">!</span>',
    );
    expect(markHtml("done")).toBe(
      '<span class="agm done" data-mark="done" aria-hidden="true">✓</span>',
    );
    expect(markHtml("working")).toBe(
      '<span class="agm work" data-mark="working" aria-hidden="true"></span>',
    );
    expect(markHtml("idle")).toBe(
      '<span class="agm idle" data-mark="idle" aria-hidden="true"></span>',
    );
  });

  it("the chip says the state, and for Needs you which need", async () => {
    const { chipHtml } = await mod();
    expect(chipHtml(ag("p", "needs", { waitingWhy: "permission" }))).toBe(
      '<span class="cp need" data-attn="needs">[ag.chip.needsWhy:[ag.why.permission]]</span>',
    );
    expect(chipHtml(ag("q", "needs", { waitingWhy: "asked" }))).toContain(
      "[ag.why.asked]",
    );
    expect(chipHtml(ag("x", "needs"))).toContain(">[ag.chip.needs]<");
    expect(chipHtml(ag("b", "done"))).toBe(
      '<span class="cp done" data-attn="done">[ag.chip.done]</span>',
    );
    expect(chipHtml(ag("t", "working"))).toContain(">[ag.chip.working]<");
    expect(chipHtml(ag("s", "idle"))).toContain(">[ag.chip.idle]<");
  });
});

describe("issue 773 Project picker and Server agent: the tag", () => {
  it("All projects: each row has its project tag; one project: none", async () => {
    const { tagHtml } = await mod();
    expect(tagHtml(ag("a", "idle"), { all: true, name: () => "Acme" })).toBe(
      '<span class="ptag" data-ptag="project">Acme</span>',
    );
    expect(tagHtml(ag("a", "idle"), { all: false })).toBe("");
  });

  it("the server agent is tagged Server, in every view", async () => {
    const { tagHtml } = await mod();
    const srv = ag("den-server-agent", "idle", {
      server: true,
      workspace: "den-server",
    });
    expect(tagHtml(srv, { all: true })).toBe(
      '<span class="ptag" data-ptag="server">[ag.tag.server]</span>',
    );
    expect(tagHtml(srv, { all: false })).toBe(
      '<span class="ptag" data-ptag="server">[ag.tag.server]</span>',
    );
  });

  it("the server agent is ranked by its state, not first", async () => {
    const { bandsOf } = await mod();
    const b = bandsOf([
      ag("Server", "idle", { server: true, workspace: "den-server" }),
      ag("builder", "done", { attnSince: T(1) }),
      ag("alpha", "idle"),
    ]);
    expect(b.map((x) => [x.state, x.rows.map((r) => r.agent)])).toEqual([
      ["done", ["builder"]],
      ["idle", ["alpha", "Server"]],
    ]);
  });
});

describe("issue 773 Counts: the sub-line and the rail", () => {
  it("the sub-line: agents, then each state above zero, then the scope", async () => {
    const { attnSub } = await mod();
    const rows = [
      ag("p", "needs"),
      ag("r", "needs"),
      ag("b", "done"),
      ag("t", "working"),
    ];
    expect(attnSub(rows, "All projects")).toBe(
      "[ag.sub.agents:4] · [ag.sub.needs:2] · [ag.sub.doneOne:1] · [ag.sub.working:1] · All projects",
    );
    expect(attnSub([ag("s", "idle")], "acme")).toBe(
      "[ag.sub.agent:1] · [ag.sub.idleOne:1] · acme",
    );
  });

  it("the rail counts Needs you only", async () => {
    const { railNeeds } = await mod();
    expect(
      railNeeds([ag("p", "needs"), ag("b", "done"), ag("t", "working")]),
    ).toBe(1);
  });
});

describe("issue 773 (mock v3 rules): A to Z inside Working and Idle", () => {
  it("a saved drag order (place) does not move rows inside a band: same input, same order", async () => {
    const { bandsOf } = await mod();
    const rows = [
      ag("alpha", "idle", { place: 2 }),
      ag("zeta", "idle", { place: 0 }),
      ag("planner", "needs", { attnSince: T(3), place: 3 }),
      ag("mid", "idle", { place: 1 }),
      ag("worker", "working", { place: 0 }),
      ag("beta", "working", { place: 1 }),
    ];
    const b = bandsOf(rows);
    expect(b.map((x) => x.state)).toEqual(["needs", "working", "idle"]);
    expect(b[1].rows.map((r) => r.agent)).toEqual(["beta", "worker"]);
    expect(b[2].rows.map((r) => r.agent)).toEqual(["alpha", "mid", "zeta"]);
    expect(bandsOf([...rows].reverse())).toEqual(b);
  });

  it("no in-band moves: the page has nothing to move a running row among", async () => {
    const m = await mod();
    expect("bandGroup" in m).toBe(false);
    expect("personOrdered" in m).toBe(false);
  });
});
