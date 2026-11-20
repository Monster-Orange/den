/**
 * Issue 631's live check, run as the bed runs it (runLikeBed) on a fake
 * bed: after a terminal host restart, a Den whose row lists every agent,
 * marks the failed one and says so in the bell and on its row passes; a
 * Den that leaves an agent off its lists, or a failed one unmarked, fails.
 * A host kept (code unchanged) and a bed without keep-host skip, with
 * their reasons; clause 2 always skips (the bed can't rotate an agent
 * before the update).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

type Kind = "fixed" | "missing" | "unmarked" | "kept" | "no-env" | "current";

function runGate(kind: Kind) {
  const js = `
    const kind = ${JSON.stringify(kind)};
    if (kind === "no-env") delete process.env.BG_HOST_BEFORE;
    else process.env.BG_HOST_BEFORE = kind === "current" ? "4242 1700000000 0.0.2" : "4242 1700000000 0.0.1";
    const g = await import("./gate/631.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const T = "2026-11-19T10:00:00.000Z";
    const after = "2026-11-19T10:00:05.000Z";
    const records = {
      a1: { workspace: "gate-ws", startedAt: after },
      a2: { workspace: "gate-ws", startedAt: after },
      a3: { workspace: "gate-ws", startedAt: "2026-11-19T09:40:00.000Z",
            ...(kind === "unmarked" ? { endedAt: after, exitCode: 1 } : {
              interruptedAt: after,
              restartFailed: { at: after, why: "the terminal host restarted; exited (1) after its resume: in use" } }) },
      a4: { workspace: "gate-ws", startedAt: "2026-11-19T09:00:00.000Z", stoppedAt: "2026-11-19T09:10:00.000Z" },
    };
    const lists = {
      resumed: ["a1", "a2"],
      failed: kind === "missing" ? [] : [{ agent: "a3", why: "exited (1) after its resume: in use" }],
      cut: ["a2"],
    };
    if (kind === "missing") { records.a3 = { workspace: "gate-ws", startedAt: T, endedAt: after, exitCode: 1 }; }
    const detail = kind === "kept"
      ? "host kept: code unchanged (0.0.1 → 0.0.2)"
      : "terminal host restarted (pid 4242 → 4343): resumed " + lists.resumed.length + ", failed " + lists.failed.length + ", cut mid-turn " + lists.cut.length + "; open terminals ended: 0; code changed";
    const row = { ts: T, actor: "user", verb: "terminal-host", detail, ...(kind === "kept" ? {} : { agents: lists }) };
    const bellItems = kind === "unmarked" ? [] : [{ subject: "agent:a3", items: [{ kind: "waiting" }] }];
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep() {},
      async until(fn) { return (await fn()) ? 0 : null; },
      cli() { return { code: 0, out: "", err: "" }; },
      readBed(rel) {
        if (rel === "state:audit.jsonl") return kind === "current" ? "" : JSON.stringify(row) + "\\n";
        if (rel === "node_modules/@monster-orange/den/package.json") return JSON.stringify({ version: "0.0.2" });
        const m = /^state:agents\\/(.+)\\.json$/.exec(rel);
        if (m && records[m[1]]) return JSON.stringify(records[m[1]]);
        return null;
      },
      listBed(rel) {
        if (rel === "state:agents") return Object.keys(records).map((k) => k + ".json").sort();
        return null;
      },
      async api(p) {
        if (p === "/api/notifications") return { groups: [{ subjects: bellItems }] };
        if (p === "/api/workspaces/gate-ws/agents")
          return { agents: Object.entries(records).map(([agent, r]) => ({
            agent, ...(r.restartFailed ? { restartFailed: r.restartFailed } : {}) })) };
        return {};
      },
      agent() { return { state() { return null; } }; },
    };
    const out = await runLikeBed("631.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows?: {
      clause: string;
      ok: boolean | null;
      skip?: string;
      detail?: string;
    }[];
    error?: string;
  };
}

// Clause i's one row: a clause answered twice (or never) fails here, so
// a duplicate can't hide behind the first match.
const row = (r: ReturnType<typeof runGate>, i: number) => {
  const got = (r.rows ?? []).filter((x) => x.clause === r.clauses[i]);
  expect(got).toHaveLength(1);
  return got[0];
};

describe("gate/631.mjs as the bed runs it", () => {
  it("a Den that lists every agent and marks the failed one passes clauses 1, 3 and 4", () => {
    const r = runGate("fixed");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(true);
    expect(row(r, 2)?.ok).toBe(true);
    expect(row(r, 3)?.ok).toBe(true);
  });

  it("an agent that ended after the restart and is on no list fails clause 1", () => {
    const r = runGate("missing");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(false);
    expect(row(r, 0)?.detail).toMatch(/a3/);
  });

  it("a failed agent with no mark, no bell item and nothing on its row fails clauses 3 and 4", () => {
    const r = runGate("unmarked");
    expect(r.error).toBeUndefined();
    expect(row(r, 2)?.ok).toBe(false);
    expect(row(r, 3)?.ok).toBe(false);
  });

  it("clause 2 skips with its reason", () => {
    const r = runGate("fixed");
    expect(row(r, 1)?.ok).toBeNull();
    expect(row(r, 1)?.skip).toBe("needs-rotation-before-update");
  });

  it("a host kept (code unchanged) skips every clause, saying so", () => {
    const r = runGate("kept");
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 4; i++) {
      expect(row(r, i)?.ok).toBeNull();
      expect(row(r, i)?.skip).toBe("needs-host-restart");
    }
  });

  it("a kept host that already ran the installed version skips every clause, without waiting on a row", () => {
    // The web start has nothing to do then (no restart, no "kept"), so it
    // writes no row: waiting for one and failing was the bed's 11-19 miss.
    const r = runGate("current");
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 4; i++) {
      expect(row(r, i)?.ok).toBeNull();
      expect(row(r, i)?.skip).toBe("needs-older-host");
      expect(row(r, i)?.detail).toMatch(/already ran 0\.0\.2/);
    }
  });

  it("a bed without keep-host skips every clause", () => {
    const r = runGate("no-env");
    expect(r.error).toBeUndefined();
    for (let i = 0; i < 4; i++) expect(row(r, i)?.skip).toBe("needs-keep-host");
  });
});
