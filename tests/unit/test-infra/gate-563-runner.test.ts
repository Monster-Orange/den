/**
 * Issue 563's live check, run as the bed runs it (runLikeBed) on a fake
 * bed: a Den whose web start restarted the terminal host passes; one that
 * left the host from before the update running fails; without the bed's
 * keep-host mark every clause is skipped with its reason.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function runGate(kind: "fixed" | "unfixed" | "no-keep-host") {
  const js = `
    const g = await import("./gate/563.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const kind = ${JSON.stringify(kind)};
    if (kind !== "no-keep-host") process.env.BG_HOST_BEFORE = "111 1700000000 0.4.70";
    else delete process.env.BG_HOST_BEFORE;
    const PTY = "/bed/node_modules/@lydell/node-pty-darwin-arm64/pty.node";
    let started = false;
    const host = () => kind === "fixed"
      ? { pid: 222, startedAt: "2026-11-19T04:00:00.000Z", den: "0.4.71", pty: started ? { path: PTY, version: "1.2.0-beta.18", id: "sha256:x" } : null }
      : null;
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep() {}, async until(fn) { return (await fn()) ? 0 : null; },
      cli(args) {
        const checks = [{ id: "terminal_host_ptys", status: "ok", detail: "" }];
        // An unfixed Den has no such row: its host can't say what it runs.
        if (kind === "fixed") checks.push({ id: "terminal_host_module", status: "ok", detail: "current", host: host() });
        return { code: 0, out: JSON.stringify({ ok: true, checks }), err: "" };
      },
      readBed(rel) {
        if (rel === "node_modules/@monster-orange/den/package.json") return JSON.stringify({ version: "0.4.71" });
        if (rel === "audit.jsonl") return kind === "fixed" ? '{"verb":"terminal-host","detail":"terminal host restarted (pid 111 → 222)"}\\n' : "";
        return null;
      },
      listBed(rel) { return rel === "node_modules/@lydell/node-pty-darwin-arm64" ? ["package.json", "pty.node", "spawn-helper"] : null; },
      async api(p) { return p === "/api/notifications" ? { groups: [] } : {}; },
      agent() { return { start() { started = true; return { code: 0 }; }, async running() { return 500; }, state() { return "running"; }, remove() {} }; },
    };
    const out = await runLikeBed("563.mjs", g, ctx);
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

describe("gate/563.mjs as the bed runs it", () => {
  it("a Den whose web start restarted the terminal host passes every clause", () => {
    const r = runGate("fixed");
    expect(r.error).toBeUndefined();
    for (const i of [0, 1, 2, 3]) expect(row(r, i)?.ok).toBe(true);
  });

  it("a Den that left the host from before the update fails clauses 1, 2 and 4", () => {
    const r = runGate("unfixed");
    expect(r.error).toBeUndefined();
    expect(row(r, 0)?.ok).toBe(false);
    expect(row(r, 1)?.ok).toBe(false);
    expect(row(r, 3)?.ok).toBe(false);
  });

  it("without the bed's keep-host mark, each clause is skipped with its reason", () => {
    const r = runGate("no-keep-host");
    for (const i of [0, 1, 2, 3])
      expect(row(r, i)).toMatchObject({ ok: null, skip: "needs-keep-host" });
  });
});
