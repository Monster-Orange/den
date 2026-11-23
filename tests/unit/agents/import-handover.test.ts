/**
 * Issue 159: bringing a conversation in is one Allow; Den does the rest.
 * After the Allow, when the conversation is still open in a terminal, Den
 * asks it for its hand-off, closes that terminal (one writer at a time),
 * runs the import hook if one is set, continues the conversation as a Den
 * agent and tells it so. handOver is that sequence over injected steps, so
 * nothing here starts or stops a real process.
 */
import { describe, expect, it } from "@jest/globals";
import {
  handOver,
  handoverAsk,
  type HandoverSteps,
} from "../../../src/shared/agents/import-handover.js";
import {
  AGENTS_RESERVED_KEYS,
  readAgentsConfig,
  type DenConfig,
} from "../../../src/shared/den-config.js";

describe("agents.import (issue 159)", () => {
  const read = (v: unknown) =>
    readAgentsConfig({ agents: { import: v } } as unknown as DenConfig).import;

  it("unset: a 30 min wait for the hand-off and no hook; it is no agent id", () => {
    expect(readAgentsConfig({} as DenConfig).import).toEqual({
      handoffWaitMs: 30 * 60_000,
    });
    expect(AGENTS_RESERVED_KEYS).toContain("import");
  });

  it("set: the wait in ms and the hook as written", () => {
    expect(
      read({ handoff_wait_minutes: 5, hook: "lanes forget $DEN_IMPORT_PID" }),
    ).toEqual({
      handoffWaitMs: 5 * 60_000,
      hook: "lanes forget $DEN_IMPORT_PID",
    });
  });

  it("a bad value or key fails naming it", () => {
    for (const bad of [0, -1, "8", true])
      expect(() => read({ handoff_wait_minutes: bad })).toThrow(
        /agents\.import\.handoff_wait_minutes: /,
      );
    for (const bad of [3, "", "  ", "a\nb"])
      expect(() => read({ hook: bad })).toThrow(/agents\.import\.hook: /);
    expect(() => read({ other: 1 })).toThrow(
      /agents\.import\.other: unknown key/,
    );
    expect(() => read("yes")).toThrow(/agents\.import: /);
  });
});

const GOOD = [
  "## Objective",
  "Tidy the docs.",
  "## State",
  "Half done, on branch docs-tidy.",
  "## Open items",
  "none",
  "## How to QA",
  "Open the docs page.",
  "## Next step",
  "Finish the last page.",
].join("\n");

/** A fake world: a holder process, its hand-off file, a clock. */
function world(
  o: {
    pid?: number | null;
    /** The tick at which the hand-off is written (never: undefined). */
    writesAt?: number;
    /** The tick at which the holder exits by itself (never: undefined). */
    exitsAt?: number;
    /** The holder ignores SIGTERM. */
    stubborn?: boolean;
    busyUntil?: number;
    hookFails?: boolean;
    importFails?: boolean;
    /** Who holds it at time t, overriding pid (the runtime's record). */
    holderAt?: (t: number) => number | null;
  } = {},
) {
  let t = 0;
  let alive = o.pid !== null;
  const log: string[] = [];
  const steps: HandoverSteps = {
    holder: () =>
      o.holderAt
        ? o.holderAt(t)
        : alive
          ? o.pid === undefined
            ? 4242
            : o.pid
          : null,
    stillOpen: () => alive,
    turnBusy: () =>
      o.busyUntil !== undefined && t < o.busyUntil ? true : false,
    handoff: () =>
      o.writesAt !== undefined && t >= o.writesAt
        ? { status: "ok", text: GOOD, problems: [] }
        : { status: "missing", problems: [] },
    close: (pid) => {
      log.push(`close ${pid}`);
      if (!o.stubborn) alive = false;
    },
    runHook: async (env) => {
      log.push(`hook ${env.DEN_IMPORT_SESSION} ${env.DEN_IMPORT_PID ?? "-"}`);
      return o.hookFails ? { ok: false, error: "exit 3" } : { ok: true };
    },
    importNow: async () => {
      log.push("import");
      return o.importFails
        ? { ok: false, error: "the folder it ran in is gone" }
        : { ok: true, id: "planner" };
    },
    tell: async (id, text) => {
      log.push(`tell ${id}: ${text.split("\n")[0]}`);
      return true;
    },
    fail: (f) => log.push(`fail: ${f.code}: ${f.text}`),
    sleep: async (ms) => {
      t += ms;
      if (o.exitsAt !== undefined && t >= o.exitsAt) alive = false;
    },
    now: () => t,
  };
  return { steps, log };
}

const opts = (more: Partial<Parameters<typeof handOver>[0]> = {}) => ({
  session: "0f1e2d3c-aaaa-bbbb-cccc-000000000001",
  agent: "planner",
  project: "north",
  persona: "planner",
  handoffPath: "/state/agents/planner/handoff.md",
  waitMs: 60_000,
  closeWaitMs: 5_000,
  pollMs: 1_000,
  hook: "forget-lane",
  ...more,
});

describe("issue 159: after the Allow, Den does every step", () => {
  it("the ask names the hand-off file and says Den closes the terminal and continues the conversation", () => {
    const text = handoverAsk(opts());
    expect(text).toContain("/state/agents/planner/handoff.md");
    expect(text).toContain("## Objective");
    expect(text).toContain("## Next step");
    expect(text).toMatch(/end your turn/i);
    expect(text).toContain("planner");
  });

  it("waits for the hand-off, closes the old terminal, runs the hook, brings it in and tells the agent", async () => {
    const w = world({ writesAt: 3_000 });
    const r = await handOver(opts(), w.steps);
    expect(r).toEqual({ ok: true, id: "planner", notes: [] });
    expect(w.log).toEqual([
      "close 4242",
      "hook 0f1e2d3c-aaaa-bbbb-cccc-000000000001 4242",
      "import",
      expect.stringMatching(/^tell planner: Den brought this conversation in/),
    ]);
  });

  it("never closes the terminal mid-turn: it waits for the turn to end after the hand-off", async () => {
    const w = world({ writesAt: 1_000, busyUntil: 10_000 });
    const r = await handOver(opts(), w.steps);
    expect(r.ok).toBe(true);
    // The hand-off came at 1 s; the close only once the turn ended (10 s).
    expect(w.log[0]).toBe("close 4242");
  });

  it("a terminal that closes by itself is not closed again", async () => {
    const w = world({ exitsAt: 2_000 });
    const r = await handOver(opts(), w.steps);
    expect(r.ok).toBe(true);
    expect(w.log.some((l) => l.startsWith("close"))).toBe(false);
    expect(w.log).toContain("import");
  });

  it("no hand-off in time: nothing is closed, nothing brought in, and the person is told why", async () => {
    const w = world({});
    const r = await handOver(opts({ waitMs: 5_000 }), w.steps);
    expect(r.ok).toBe(false);
    expect(w.log.some((l) => l.startsWith("close"))).toBe(false);
    expect(w.log).not.toContain("import");
    expect(w.log.at(-1)).toMatch(
      /^fail: noHandoff: .*no hand-off.*still open/i,
    );
  });

  it("a terminal that won't close: nothing is brought in (one writer at a time)", async () => {
    const w = world({ writesAt: 0, stubborn: true });
    const r = await handOver(opts(), w.steps);
    expect(r.ok).toBe(false);
    expect(w.log).not.toContain("import");
    expect(w.log.at(-1)).toMatch(/^fail: wontClose: .*didn't close/i);
  });

  it("a failing hook is noted, and the conversation still comes in", async () => {
    const w = world({ writesAt: 0, hookFails: true });
    const r = await handOver(opts(), w.steps);
    expect(r.ok).toBe(true);
    expect(r.ok && r.notes[0]).toMatch(/hook.*exit 3/i);
  });

  it("no hook set: none runs", async () => {
    const w = world({ writesAt: 0 });
    await handOver(opts({ hook: undefined }), w.steps);
    expect(w.log.some((l) => l.startsWith("hook"))).toBe(false);
  });

  it("the holder changed during the wait (reopened in another terminal): nothing is closed, it stops", async () => {
    const w = world({
      writesAt: 0,
      holderAt: (t) => (t < 2_000 ? 4242 : 5151),
    });
    // The hand-off is in at once but the turn runs until 3 s: the holder
    // is read again at the close, and it is no longer the Allow's.
    const r = await handOver(opts(), {
      ...w.steps,
      turnBusy: () => w.steps.now() < 3_000,
    });
    expect(r.ok).toBe(false);
    expect(w.log.some((l) => l.startsWith("close"))).toBe(false);
    expect(w.log).not.toContain("import");
    expect(w.log.at(-1)).toMatch(/^fail: holderChanged: /);
  });

  it("still open but no holder at the close: nothing is closed, it stops (unknownHolder)", async () => {
    const w = world({ writesAt: 0, pid: null });
    const r = await handOver(opts(), { ...w.steps, stillOpen: () => true });
    expect(r.ok).toBe(false);
    expect(w.log.some((l) => l.startsWith("close"))).toBe(false);
    expect(w.log.at(-1)).toMatch(/^fail: unknownHolder: /);
  });

  it("a bring-in that fails after the close tells the person, with the reason", async () => {
    const w = world({ writesAt: 0, importFails: true });
    const r = await handOver(opts(), w.steps);
    expect(r.ok).toBe(false);
    expect(w.log.at(-1)).toMatch(
      /^fail: importFailed: .*the folder it ran in is gone/,
    );
  });
});
