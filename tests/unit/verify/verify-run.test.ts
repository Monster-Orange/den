/**
 * Issue 208: running a plan, and its verdict (VERIFY-SPEC section 5).
 *
 *   T16  a "what changed" run with no changes exits 3 ("nothing ran"),
 *        runs nothing, and leaves the latest answer as it was (the run
 *        hands it back, for the page to keep showing)
 *
 * Plus the one exit-code table this slice needs: 0 passed, 1 failed (a
 * failure, an error or a block), 3 nothing ran. Commands and probes are
 * fakes; the latest results live in a temp state folder.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import {
  moduleChanges,
  readLatest,
  writeLatest,
} from "../../../src/shared/verify/changes.js";
import { planVerify } from "../../../src/shared/verify/plan.js";
import { runPlan, type RunDeps } from "../../../src/shared/verify/run.js";
import { NOTHING_RAN_EXIT } from "../../../src/shared/run-outcome.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-run-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    name: "shop",
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

function deps(over: Partial<RunDeps> = {}) {
  const cmds: string[] = [];
  const probes: string[] = [];
  const d: RunDeps = {
    stateDir,
    head: () => "c0ffee1",
    runCmd: async (m) => {
      cmds.push(m.name);
      return { exitCode: 0 };
    },
    probe: async (url) => {
      probes.push(url);
      return 200;
    },
    runId: () => "run-1",
    now: () => new Date("2026-11-15T12:00:00Z"),
    ...over,
  };
  return { d, cmds, probes };
}

const plan = (scope: "changed" | "all", project: string) =>
  planVerify({
    project,
    env: "local",
    scope,
    modules: shop.modules,
    layers: shop.layers,
    changes: moduleChanges(
      shop.modules,
      readLatest(stateDir, project).local ?? {},
      { head: () => "c0ffee1", changedSince: () => [] },
    ),
  });

describe("T16: what changed, with no changes", () => {
  it("exits 3, runs nothing, and keeps the latest answer", async () => {
    // Earlier results at this commit: nothing changed since.
    writeLatest(stateDir, "north", "local", {
      "shop:api/smoke": { commit: "c0ffee1", state: "passed", at: "t1" },
      "shop:api/orders": { commit: "c0ffee1", state: "failed", at: "t1" },
      "shop:web/checkout": { commit: "c0ffee1", state: "passed", at: "t1" },
    });
    const before = fs.readFileSync(
      path.join(stateDir, "verify", "north", "latest.json"),
      "utf-8",
    );
    const { d, cmds, probes } = deps();
    const r = await runPlan(plan("changed", "north"), d);
    expect(r.verdict).toBe("nothing ran");
    expect(r.exitCode).toBe(NOTHING_RAN_EXIT);
    expect(r.exitCode).toBe(3);
    expect(r.reason).toBe("unchanged");
    expect(cmds).toEqual([]);
    expect(probes).toEqual([]);
    // The latest answer stays, and comes back with the run.
    expect(
      fs.readFileSync(
        path.join(stateDir, "verify", "north", "latest.json"),
        "utf-8",
      ),
    ).toBe(before);
    expect(r.latest["shop:api/orders"]).toMatchObject({ state: "failed" });
  });
});

describe("a run's verdict and exit code", () => {
  it("all passed: 0, and each module's result is the latest", async () => {
    const { d, cmds, probes } = deps();
    const r = await runPlan(plan("all", "east"), d);
    expect(r.verdict).toBe("passed");
    expect(r.exitCode).toBe(0);
    expect(probes).toEqual(["http://localhost:4000/health"]);
    expect(cmds).toEqual(["api/orders", "web/checkout"]);
    expect(readLatest(stateDir, "east").local).toMatchObject({
      "shop:api/orders": { commit: "c0ffee1", state: "passed" },
    });
  });

  it("a failed module: 1; a layer that depends on it is blocked, never run", async () => {
    const { d, cmds } = deps({
      runCmd: async (m) => {
        cmds.push(m.name);
        return { exitCode: m.name === "api/orders" ? 2 : 0 };
      },
    });
    const r = await runPlan(plan("all", "west"), d);
    expect(r.verdict).toBe("failed");
    expect(r.exitCode).toBe(1);
    expect(cmds).toEqual(["api/orders"]);
    const st = Object.fromEntries(r.modules.map((m) => [m.name, m]));
    expect(st["api/orders"]).toMatchObject({ state: "failed", exitCode: 2 });
    expect(st["web/checkout"]).toMatchObject({
      state: "blocked",
      blockedBy: "api",
    });
  });

  it("a smoke that fails blocks the rest of its layer", async () => {
    const { d, cmds } = deps({ probe: async () => 502 });
    const r = await runPlan(plan("all", "south"), d);
    expect(r.exitCode).toBe(1);
    expect(cmds).toEqual([]);
    const st = Object.fromEntries(r.modules.map((m) => [m.name, m]));
    expect(st["api/smoke"].state).toBe("failed");
    expect(st["api/orders"]).toMatchObject({
      state: "blocked",
      blockedBy: "smoke",
    });
  });
});
