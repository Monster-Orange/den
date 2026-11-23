/**
 * Issue 209: the Verify page's answer for each environment (VERIFY-SPEC
 * section 12, handoff S1, S4, S8). T3: environments come worst first, and
 * a failed one carries what failed and what waits on it. A run where
 * nothing ran, or an environment no check runs on, is never a pass.
 */
import { describe, expect, it } from "@jest/globals";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import { verifyOverview } from "../../../src/shared/verify/overview.js";
import type { RunRecord } from "../../../src/shared/verify/records.js";

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    name: "shop",
    verify: {
      layers: { web: { depends_on: ["api"] }, api: {} },
      modules: {
        "api/orders": {
          kind: "integration",
          cmd: "make contract",
          environments: ["local", "staging"],
        },
        "web/checkout": {
          kind: "synthetic",
          cmd: "make uat",
          environments: ["local", "staging"],
        },
        "web/home": { kind: "performance", cmd: "make speed" },
      },
    },
  },
});

const at = "2026-11-15T14:10:00Z";
const run = (over: Partial<RunRecord>): RunRecord => ({
  runId: "r1",
  project: "north",
  env: "staging",
  scope: "all",
  verdict: "failed",
  exitCode: 1,
  startedAt: at,
  endedAt: at,
  modules: [],
  ...over,
});

const runs: RunRecord[] = [
  run({
    runId: "r-stage",
    startedBy: { kind: "agent", name: "Release helper" },
    allowedBy: { kind: "person" },
    commit: "e4f5a6b",
    modules: [
      {
        id: "shop:api/orders",
        name: "api/orders",
        repo: "shop",
        layer: "api",
        kind: "integration",
        mark: "declared",
        state: "failed",
        message: "POST /orders returned 500",
        tail: ["POST /orders returned 500"],
        ms: 900,
      },
      {
        id: "shop:web/checkout",
        name: "web/checkout",
        repo: "shop",
        layer: "web",
        kind: "synthetic",
        mark: "declared",
        state: "blocked",
        blockedBy: "api",
        ms: 0,
      },
    ],
  }),
  run({
    runId: "r-prod",
    env: "production",
    verdict: "nothing ran",
    exitCode: 3,
    endedAt: "2026-11-15T10:00:00Z",
  }),
];

const idOf = (name: string) => shop.modules.find((m) => m.name === name)!.id;

const latest = {
  local: {
    [idOf("api/orders")]: { commit: "a1b2c3d", state: "passed" as const, at },
    [idOf("web/checkout")]: { commit: "a1b2c3d", state: "passed" as const, at },
    [idOf("web/home")]: { commit: "a1b2c3d", state: "passed" as const, at },
  },
  staging: {
    [idOf("api/orders")]: {
      commit: "e4f5a6b",
      state: "failed" as const,
      at,
      runId: "r-stage",
    },
    [idOf("web/checkout")]: {
      commit: "e4f5a6b",
      state: "blocked" as const,
      at,
      runId: "r-stage",
    },
  },
};

const ov = verifyOverview({
  project: "north",
  envs: ["local", "staging", "production", "qa"],
  modules: shop.modules,
  layers: shop.layers,
  latest,
  runs,
});

describe("issue 209: the overview", () => {
  it("T3: orders environments worst first", () => {
    expect(ov.envs.map((e) => [e.env, e.answer])).toEqual([
      ["staging", "failed"],
      ["production", "nothing"],
      ["qa", "nothing"],
      ["local", "ready"],
    ]);
  });

  it("T3: a failed environment says what failed, from which run, and what waits on it", () => {
    const s = ov.envs[0];
    expect(s.failures).toEqual([
      {
        module: "api/orders",
        state: "failed",
        message: "POST /orders returned 500",
        runId: "r-stage",
        report: true,
      },
    ]);
    expect(s.blocked).toEqual([{ module: "web/checkout", blockedBy: "api" }]);
    expect(s.run).toMatchObject({
      runId: "r-stage",
      startedBy: { kind: "agent", name: "Release helper" },
      allowedBy: { kind: "person" },
      commit: "e4f5a6b",
    });
  });

  it("S8: nothing ran, or no check here, is never a pass", () => {
    const prod = ov.envs.find((e) => e.env === "production")!;
    expect(prod.answer).toBe("nothing");
    expect(prod.nothing).toBe("none-here");
    expect(prod.run?.verdict).toBe("nothing ran");
  });

  it("partly checked when some checks have no result yet; not run yet when none do", () => {
    const one = verifyOverview({
      project: "north",
      envs: ["local"],
      modules: shop.modules,
      layers: shop.layers,
      latest: { local: { [idOf("web/home")]: latest.local[idOf("web/home")] } },
      runs: [],
    });
    expect(one.envs[0].answer).toBe("partly");
    expect(one.envs[0].counts).toMatchObject({
      passed: 1,
      notrun: 2,
      total: 3,
    });
    const none = verifyOverview({
      project: "north",
      envs: ["local"],
      modules: shop.modules,
      layers: shop.layers,
      latest: {},
      runs: [],
    });
    expect(none.envs[0].answer).toBe("notrun");
  });

  it("lists every check with its state on each environment, and what it waits on", () => {
    const web = ov.checks.find((c) => c.module === "web/checkout")!;
    expect(web.dependsOn).toEqual(["api"]);
    expect(web.states).toEqual({
      local: "passed",
      staging: "blocked",
      production: "off",
      qa: "off",
    });
    expect(ov.modules).toBe(3);
  });

  it("S7: a project with no checks is empty", () => {
    const e = verifyOverview({
      project: "north",
      envs: ["local"],
      modules: [],
      layers: {},
      latest: {},
      runs: [],
    });
    expect(e.modules).toBe(0);
    expect(e.envs[0].answer).toBe("nothing");
  });
});

// Issue 211: the All environments board (S1b) needs, per check and
// environment, its recent results (the panel's strip), its mark, and the
// commit and run its latest result came from (a scan not re-run says
// "scanned at <commit>", not "passed").
describe("issue 211: what the board needs", () => {
  const mk = (runId: string, state: "passed" | "failed", endedAt: string) =>
    run({
      runId,
      endedAt,
      verdict: state,
      modules: [
        {
          id: "shop:api/orders",
          name: "api/orders",
          repo: "shop",
          layer: "api",
          kind: "integration",
          mark: "declared",
          state,
          ms: 10,
        },
      ],
    });

  it("recent: the last results on each environment, oldest first, at most 10", () => {
    const many = Array.from({ length: 12 }, (_, n) =>
      mk(
        `r${n}`,
        n === 11 ? "failed" : "passed",
        `2026-11-15T${String(10 + n).padStart(2, "0")}:00:00Z`,
      ),
    ).reverse(); // newest first, as listRunRecords gives them
    const o = verifyOverview({
      project: "north",
      envs: ["local", "staging"],
      modules: shop.modules,
      layers: shop.layers,
      latest: {},
      runs: [
        ...many,
        // A run still going never counts.
        {
          ...mk("r-going", "passed", ""),
          verdict: "running",
          endedAt: undefined,
        },
      ],
    });
    const api = o.checks.find((c) => c.module === "api/orders")!;
    expect(api.recent.staging).toHaveLength(10);
    expect(api.recent.staging.at(-1)).toBe("failed");
    expect(api.recent.staging.slice(0, 9).every((s) => s === "passed")).toBe(
      true,
    );
    expect(api.recent.local).toEqual([]);
  });

  it("carries each check's mark, and where its latest result came from", () => {
    const api = ov.checks.find((c) => c.module === "api/orders")!;
    expect(api.mark).toBe(
      shop.modules.find((m) => m.name === "api/orders")!.mark,
    );
    expect(api.from.staging).toEqual({ commit: "e4f5a6b", runId: "r-stage" });
    expect(api.from.local).toEqual({ commit: "a1b2c3d" });
    expect(api.from.production).toBeUndefined();
  });
});
