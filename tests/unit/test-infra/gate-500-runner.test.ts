/**
 * Issue 500's live check, run as the bed runs it (runLikeBed) on a fake
 * bed: a Den whose host writes sessions.host.json and whose Restart
 * replaces the host passes; one without them (before the fix) fails; a
 * host that holds others' terminals or agents skips the Restart; the
 * stuck-host clause is always skipped with its reason (proven in tests).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function runGate(kind: "fixed" | "unfixed" | "busy") {
  const js = `
    const g = await import("./gate/500.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const kind = ${JSON.stringify(kind)};
    const fixed = kind !== "unfixed";
    let pid = 111;
    const startedAt = () => "2026-11-19T0" + (pid === 111 ? "1" : "2") + ":00:00.000Z";
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep() {}, async until(fn) { return (await fn()) ? 0 : null; },
      cli(args) {
        const checks = [{ id: "terminal_host_module", status: "ok", detail: "current",
          host: { pid, startedAt: startedAt(), den: "0.4.79", code: "sha256:a", pty: null } }];
        return { code: 0, out: JSON.stringify({ ok: true, checks }), err: "" };
      },
      readBed(rel) {
        if (rel === "state:sessions.host.json")
          return fixed ? JSON.stringify({ pid, startedAt: startedAt(), den: "0.4.79", code: "sha256:a" }) : null;
        if (rel === "node_modules/@monster-orange/den/src/shared/sessions/client.ts")
          return fixed ? 'export const DEFAULT_HOST_WAIT_SECONDS = 10;\\nexport function hostAnswerMs(w = () => agentsListWaits()) {}' : "export function connectHost() {}";
        return null;
      },
      listBed() { return null; },
      async api(p) {
        if (p === "/api/sessions")
          return { sessions: [{ kind: "agent", agent: "gate-500", exited: false },
            ...(kind === "busy" ? [{ kind: "plain", exited: false }] : [])] };
        return {};
      },
      async fetch(p, init) {
        if (p === "/api/agents/terminal-host/restart" && init?.method === "POST") {
          if (!fixed) return { status: 404, headers: {}, body: "no such route" };
          const from = pid; pid = 222;
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, restarted: { from, to: pid, forced: false, ended: 1, fromVersion: "0.4.79" } }) };
        }
        return { status: 404, headers: {}, body: "" };
      },
      agent() { return { start() { return { code: 0 }; }, async running() { return 500; }, state() { return "running"; }, remove() {} }; },
    };
    const out = await runLikeBed("500.mjs", g, ctx);
    console.log(JSON.stringify({ clauses: g.clauses, ...out }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as {
    clauses: string[];
    rows?: { clause: string; ok: boolean | null; skip?: string }[];
    error?: string;
  };
}

const row = (r: ReturnType<typeof runGate>, i: number) =>
  (r.rows ?? []).find((x) => x.clause === r.clauses[i]);

describe("gate/500.mjs as the bed runs it", () => {
  it("a Den with the fix passes clauses 1 to 3; the stuck host is skipped with its reason", () => {
    const r = runGate("fixed");
    expect(r.error).toBeUndefined();
    for (const i of [0, 1, 2]) expect(row(r, i)?.ok).toBe(true);
    expect(row(r, 3)).toMatchObject({ ok: null, skip: "needs-stuck-host" });
  });

  it("a Den without it fails clauses 1 to 3", () => {
    const r = runGate("unfixed");
    expect(r.error).toBeUndefined();
    for (const i of [0, 1, 2]) expect(row(r, i)?.ok).toBe(false);
  });

  it("a host that holds others' terminals or agents: the Restart is skipped", () => {
    const r = runGate("busy");
    expect(row(r, 2)).toMatchObject({
      ok: null,
      skip: "needs-idle-terminal-host",
    });
    expect(row(r, 0)?.ok).toBe(true);
  });
});
