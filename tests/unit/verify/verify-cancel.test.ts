/**
 * Issue 210: a run that shows its progress and can be cancelled
 * (VERIFY-SPEC section 5; screen S3).
 *
 *   T6  a cancelled run is "cancelled", never a pass, and exits 4. The
 *       modules that finished keep their results; every unfinished one
 *       is "cancelled". A running command is stopped.
 *
 * Plus progress: the run's record says "running" from the start, every
 * planned module first "queued" (one that waits for a layer says which),
 * and it is kept again after each module.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import { readLatest } from "../../../src/shared/verify/changes.js";
import { planVerify } from "../../../src/shared/verify/plan.js";
import { readRunRecord } from "../../../src/shared/verify/records.js";
import { runPlan, type RunDeps } from "../../../src/shared/verify/run.js";
import { CANCELLED_EXIT } from "../../../src/shared/run-outcome.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-cancel-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    services: {
      api: { health: { local: { url: "http://localhost:4000/health" } } },
    },
    verify: {
      layers: { web: { depends_on: ["api"] }, api: {} },
      modules: {
        "api/smoke": { kind: "smoke" },
        "api/orders": { kind: "integration", cmd: "make contract" },
        "web/checkout": { kind: "synthetic", cmd: "make uat" },
      },
    },
  },
});

const plan = (project: string) =>
  planVerify({
    project,
    env: "local",
    scope: "all",
    modules: shop.modules,
    layers: shop.layers,
    changes: {},
  });

function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    stateDir,
    head: () => "c0ffee1",
    runCmd: async () => ({ exitCode: 0 }),
    probe: async () => 200,
    now: () => new Date("2026-11-15T12:00:00Z"),
    ...over,
  };
}

describe("T6: Cancel", () => {
  it("is cancelled, never a pass: exit 4, finished modules kept, the rest cancelled", async () => {
    const ac = new AbortController();
    let stopped = false;
    const r = await runPlan(
      plan("c1"),
      deps({
        runId: () => "run-c1",
        signal: ac.signal,
        // api/orders is running when Cancel comes: it is stopped.
        runCmd: (m, ctx) =>
          new Promise((resolve) => {
            if (m.name !== "api/orders")
              return resolve({ exitCode: 0, lines: ["ok"] });
            ctx.signal?.addEventListener("abort", () => {
              stopped = true;
              resolve({ exitCode: null, lines: ["stopped"] });
            });
            ac.abort();
          }),
      }),
    );
    expect(stopped).toBe(true);
    expect(r.verdict).toBe("cancelled");
    expect(r.exitCode).toBe(CANCELLED_EXIT);
    expect(CANCELLED_EXIT).toBe(4);
    expect(r.modules.map((m) => [m.name, m.state])).toEqual([
      ["api/smoke", "passed"],
      ["api/orders", "cancelled"],
      ["web/checkout", "cancelled"],
    ]);
    const rec = readRunRecord(stateDir, "c1", "run-c1")!;
    expect(rec.verdict).toBe("cancelled");
    expect(rec.exitCode).toBe(4);
    // Only what finished is a latest result; cancelled is never one.
    expect(Object.keys(readLatest(stateDir, "c1").local ?? {})).toEqual([
      "shop:api/smoke",
    ]);
  });

  it("Cancel before anything ran: every module cancelled, nothing kept as latest", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await runPlan(
      plan("c2"),
      deps({ runId: () => "run-c2", signal: ac.signal }),
    );
    expect(r.verdict).toBe("cancelled");
    expect(r.modules.every((m) => m.state === "cancelled")).toBe(true);
    expect(readLatest(stateDir, "c2").local).toBeUndefined();
  });
});

describe("progress", () => {
  it("the record says running from the start, queued modules say what they wait for, and it is kept after each module", async () => {
    const seen: string[][] = [];
    let first: ReturnType<typeof readRunRecord> = null;
    await runPlan(
      plan("p1"),
      deps({
        runId: () => "run-p1",
        runCmd: async () => {
          const rec = readRunRecord(stateDir, "p1", "run-p1")!;
          first ??= rec;
          seen.push(rec.modules.map((m) => m.state));
          return { exitCode: 0 };
        },
      }),
    );
    const at = first!;
    expect(at.verdict).toBe("running");
    expect(at.endedAt).toBeUndefined();
    // When api/orders starts: smoke done, orders running, checkout waits for api.
    expect(seen[0]).toEqual(["passed", "running", "queued"]);
    expect(at.modules[2].waitsFor).toBe("api");
    expect(seen[1]).toEqual(["passed", "passed", "running"]);
    const done = readRunRecord(stateDir, "p1", "run-p1")!;
    expect(done.verdict).toBe("passed");
    expect(typeof done.endedAt).toBe("string");
  });
});
