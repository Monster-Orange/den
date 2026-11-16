/**
 * Issue 209: every Verify run leaves a record the page reads (who started
 * it, who allowed it, each module's state, the first failure and the last
 * lines of output), including a run where nothing ran.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import { planVerify } from "../../../src/shared/verify/plan.js";
import { runPlan, type RunDeps } from "../../../src/shared/verify/run.js";
import {
  listRunRecords,
  readRunRecord,
} from "../../../src/shared/verify/records.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-rec-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    name: "shop",
    verify: {
      layers: { web: { depends_on: ["api"] }, api: {} },
      modules: {
        "api/orders": { kind: "integration", cmd: "make contract" },
        "web/checkout": { kind: "synthetic", cmd: "make uat" },
      },
    },
  },
});

const plan = (project: string, chosen?: string[]) =>
  planVerify({
    project,
    env: "local",
    scope: "all",
    ...(chosen ? { chosen } : {}),
    modules: shop.modules,
    layers: shop.layers,
    changes: new Map(),
  });

function deps(runId: string, at: string, over: Partial<RunDeps> = {}) {
  const d: RunDeps = {
    stateDir,
    head: () => "e4f5a6b",
    runCmd: async (m) =>
      m.name === "api/orders"
        ? {
            exitCode: 1,
            lines: ["creating an order", "POST /orders returned 500"],
          }
        : { exitCode: 0 },
    probe: async () => 200,
    runId: () => runId,
    now: () => new Date(at),
    ...over,
  };
  return d;
}

describe("issue 209: run records", () => {
  it("keeps who started and allowed a run, each state, the failure and its output", async () => {
    await runPlan(
      plan("north"),
      deps("run-a", "2026-11-15T14:10:00Z", {
        by: {
          startedBy: { kind: "agent", name: "Release helper" },
          allowedBy: { kind: "person" },
        },
      }),
    );
    const rec = readRunRecord(stateDir, "north", "run-a");
    expect(rec).not.toBeNull();
    expect(rec!.verdict).toBe("failed");
    expect(rec!.exitCode).toBe(1);
    expect(rec!.env).toBe("local");
    expect(rec!.commit).toBe("e4f5a6b");
    expect(rec!.startedBy).toEqual({ kind: "agent", name: "Release helper" });
    expect(rec!.allowedBy).toEqual({ kind: "person" });
    const orders = rec!.modules.find((m) => m.name === "api/orders")!;
    expect(orders.state).toBe("failed");
    expect(orders.message).toBe("POST /orders returned 500");
    expect(orders.tail).toEqual([
      "creating an order",
      "POST /orders returned 500",
    ]);
    const web = rec!.modules.find((m) => m.name === "web/checkout")!;
    expect(web.state).toBe("blocked");
    expect(web.blockedBy).toBe("api");
  });

  it("keeps a run where nothing ran, and lists runs newest first", async () => {
    const empty = { ...plan("north"), modules: [], nothingToRun: true };
    await runPlan(empty, deps("run-b", "2026-11-15T15:00:00Z"));
    const rec = readRunRecord(stateDir, "north", "run-b");
    expect(rec?.verdict).toBe("nothing ran");
    expect(rec?.exitCode).toBe(3);
    expect(listRunRecords(stateDir, "north").map((r) => r.runId)).toEqual([
      "run-b",
      "run-a",
    ]);
  });

  it("answers null for a run that isn't there or a name that isn't an id", () => {
    expect(readRunRecord(stateDir, "north", "nope")).toBeNull();
    expect(readRunRecord(stateDir, "north", "../../etc")).toBeNull();
    expect(listRunRecords(stateDir, "nowhere")).toEqual([]);
  });
});
