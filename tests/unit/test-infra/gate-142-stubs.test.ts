/**
 * Issue 142's live check (gate/142.mjs) on a bed whose agents.max_concurrent
 * is 4 (the default) with one other agent already running: it must never
 * have so many of its own stubs running that the next start is refused.
 * On 11-18 it kept the perm, ask and turnq stubs running, so the idle
 * stub's start was refused and every clause errored. A refused start
 * must say so, naming the cap.
 * A fake ctx (no bed, no browser), in a child node: the gate file is ESM.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

/** Runs gate/142's setup and run on a fake bed; its answer as JSON. */
function runGate(opts: { max: number; others: number }) {
  const js = `
    const g = await import("./gate/142.mjs");
    const MAX = ${opts.max}, OTHERS = ${opts.others};
    const running = new Set();
    let peak = 0, refused = 0;
    const said = new Map(); // agent -> "needs" | "update"
    const reads = new Map(); // idle agent's update, read this many times
    const settings = { bell_kinds: { finished: false } };
    const item = (name, kind) => ({ id: name + kind, subject: "agent:" + name, kind, read: false, link: "/agents?agent=" + name });
    const bell = () => {
      const needs = [], updates = [];
      for (const [name, k] of said) {
        if (k === "needs") needs.push(item(name, "waiting"));
        else {
          const n = (reads.get(name) ?? 0) + 1;
          reads.set(name, n);
          if (n <= 3) updates.push(item(name, "finished"));
        }
      }
      const groups = (l) => [{ scope: "workspace/w", subjects: l.map((n) => ({ subject: n.subject, items: [n] })) }];
      return { unread: needs.length, waiting: [], groups: groups(needs), updates: { count: updates.length, groups: groups(updates) } };
    };
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const ctx = {
      page: null,
      url: "http://bed.invalid",
      api: async (p) => ok(p === "/api/settings" ? settings : p === "/api/notifications" ? bell() : { ok: true }),
      agent: async (name) => ({
        id: name,
        start() {
          if (running.size + OTHERS >= MAX) {
            refused++;
            return { code: 1, out: "", err: "", all: "✗ " + MAX + " agents are running and agents.max_concurrent is " + MAX };
          }
          running.add(name);
          peak = Math.max(peak, running.size);
          return { code: 0, out: "started", err: "", all: "started" };
        },
        running: async () => (running.has(name) ? 10 : null),
        stop: async () => { running.delete(name); return { code: 0 }; },
        remove: async () => { running.delete(name); return { code: 0 }; },
        sessionStart: async () => {},
        print: async () => {},
        idlePrompt: async () => {},
        permissionRequest: async () => { said.set(name, "needs"); },
        askHuman: async () => { said.set(name, "needs"); },
        hook: async (ev, input) => {
          if (ev === "Stop") said.set(name, /\\?$/.test(input.last_assistant_message ?? "") ? "needs" : "update");
        },
      }),
    };
    let error = null;
    try {
      const state = await g.setup(ctx);
      await g.run(ctx, state);
      await g.teardown(ctx, state);
    } catch (e) { error = String(e?.message ?? e); }
    console.log(JSON.stringify({ peak, refused, error }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    peak: number;
    refused: number;
    error: string | null;
  };
}

describe("gate/142.mjs under agents.max_concurrent", () => {
  it("max 4, one other agent running: no start refused, never more than 2 of its own running", () => {
    const r = runGate({ max: 4, others: 1 });
    expect(r).toEqual({ peak: expect.any(Number), refused: 0, error: null });
    expect(r.peak).toBeLessThanOrEqual(2);
  }, 120_000);

  it("a refused start throws at once, naming the cap", () => {
    const r = runGate({ max: 1, others: 1 });
    expect(r.error).toMatch(/max_concurrent/);
    expect(r.error).toMatch(/gate142-perm-/);
  }, 120_000);
});
