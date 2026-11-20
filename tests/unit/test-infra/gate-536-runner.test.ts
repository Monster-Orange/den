/**
 * PR 536's live check, run as the bed runs it (runLikeBed) on a fake bed:
 * a fixed Den passes; one whose live log route still streams for a name
 * that isn't a catalog name fails the first two clauses.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");

function runGate(fixed: boolean, historyOff = false) {
  const js = `
    const g = await import("./gate/536.mjs");
    const { runLikeBed } = await import("./tests/fixtures/gate-runner-like.mjs");
    const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    const ctx = {
      notes: [], log(...a) { this.notes.push(a.join(" ")); },
      async sleep() {}, async until(fn) { return (await fn()) ? 0 : null; },
      async fetch(p) {
        const u = new URL(p, "http://bed");
        const ok = SAFE.test(u.searchParams.get("repo") ?? "") && SAFE.test(u.searchParams.get("service") ?? "");
        if (u.pathname === "/api/service/history") {
          if (${historyOff}) return { status: 403, headers: {}, body: "off" };
          return ok ? { status: 200, headers: { "content-type": "application/json" }, body: "{}" }
                    : { status: 400, headers: { "content-type": "application/json" }, body: "{}" };
        }
        if (ok || !${fixed}) return { status: 200, headers: { "content-type": "text/event-stream" }, body: "" };
        return { status: 400, headers: { "content-type": "application/json" }, body: "{}" };
      },
    };
    const out = await runLikeBed("536.mjs", g, ctx);
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

const ok = (r: ReturnType<typeof runGate>, i: number) =>
  (r.rows ?? []).find((x) => x.clause === r.clauses[i]);

describe("gate/536.mjs as the bed runs it", () => {
  it("a fixed Den passes every clause", () => {
    const r = runGate(true);
    expect(r.error).toBeUndefined();
    for (const i of [0, 1, 2]) expect(ok(r, i)?.ok).toBe(true);
  });

  it("a Den that still streams for such names fails clauses 1 and 2", () => {
    const r = runGate(false);
    expect(ok(r, 0)?.ok).toBe(false);
    expect(ok(r, 1)?.ok).toBe(false);
  });

  it("history behind the local-dev switch is not run, with its reason", () => {
    const r = runGate(true, true);
    expect(ok(r, 2)).toMatchObject({ ok: null, skip: "needs-local-dev" });
  });
});
