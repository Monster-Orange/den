/**
 * Issue 208: the plan (VERIFY-SPEC sections 5 to 7).
 *
 *   T8   the plan marks each module enforced, declared read-only, reads
 *        code only, or declared by the service
 *   T14  the default plan is "what changed": smoke, plus modules whose
 *        `watch` paths changed, plus the layers that depend on them; a
 *        module with no `watch` is affected by any change in its repo
 *
 * The plan is pure: what changed is handed in. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import {
  moduleChanges,
  type GitProbe,
} from "../../../src/shared/verify/changes.js";
import { planVerify } from "../../../src/shared/verify/plan.js";

const shop = readVerifyModules({
  repo: "shop",
  repoPath: "/repos/shop",
  manifest: {
    name: "shop",
    services: {
      web: { health: { local: { url: "http://localhost:3000/health" } } },
    },
    verify: {
      layers: { web: { depends_on: ["api"] }, api: {}, code: {} },
      modules: {
        "web/smoke": { kind: "smoke", environments: ["local", "staging"] },
        "web/checkout": {
          kind: "synthetic",
          cmd: "npx playwright test --grep @uat",
          environments: ["local", "staging"],
          watch: ["web/**"],
        },
        "web/headers": {
          kind: "security",
          zap: { mode: "baseline" },
          environments: ["local", "staging"],
          watch: ["web/**"],
        },
        "api/orders": {
          kind: "integration",
          cmd: "make contract-test",
          environments: ["local", "staging"],
          watch: ["api/**"],
        },
        "api/load": {
          kind: "performance",
          cmd: "k6 run perf/load.js",
          cost: "heavy",
          watch: ["perf/**"],
        },
        "code/deps": { kind: "security", cmd: "trivy fs --exit-code 1 ." },
        "web/devices": {
          kind: "synthetic",
          adapter: { name: "phone-farm", devices: 4 },
          environments: ["staging"],
          watch: ["web/**"],
        },
      },
    },
  },
});
expect(shop.errors).toEqual([]);

const all = shop.modules;
const ids = (xs: { name: string }[]) => xs.map((x) => x.name);

/** A git with these files changed in the repo since any result. */
function git(files: string[]): GitProbe {
  return {
    head: () => "c0ffee1",
    changedSince: () => files,
  };
}
/** Each module's latest result on the environment, at an older commit. */
const ran = (names: string[]) =>
  Object.fromEntries(
    names.map((n) => [
      `shop:${n}`,
      { commit: "abc1234", state: "passed", at: "2026-11-15T10:00:00Z" },
    ]),
  );

describe("T8: each module's mark", () => {
  it("enforced, declared read-only, reads code only, declared by the service", () => {
    const p = planVerify({
      project: "north",
      env: "staging",
      scope: "all",
      modules: all,
      layers: shop.layers,
      changes: {},
    });
    const mark = Object.fromEntries(
      [...p.modules, ...p.cantRun].map((m) => [m.name, m.mark]),
    );
    expect(mark).toEqual({
      "web/smoke": "enforced", // built-in: GET and HEAD only
      "web/checkout": "declared-read-only", // a cmd: Den can't see inside
      "web/headers": "enforced", // ZAP baseline: passive only
      "api/orders": "declared-read-only",
      "api/load": "declared-read-only",
      "code/deps": "reads-code-only",
      "web/devices": "declared-by-service", // an outside adapter
    });
  });
});

describe("the plan's order and what can't run", () => {
  it("code first, then smoke, integration, synthetic, security, performance; a layer after the one it depends on", () => {
    const p = planVerify({
      project: "north",
      env: "local",
      scope: "all",
      modules: all,
      layers: shop.layers,
      changes: {},
    });
    expect(ids(p.modules)).toEqual([
      "code/deps",
      "web/smoke",
      "api/orders",
      "web/checkout",
      "api/load",
    ]);
    // Built-in adapters other than smoke and cmd come later: said before
    // anything starts, never a silent skip.
    expect(p.cantRun.map((c) => [c.name, c.reason])).toEqual([
      ["web/devices", "environment"],
      ["web/headers", "adapter-later"],
    ]);
  });

  it("a module not listed for the environment can't run there, with why", () => {
    const p = planVerify({
      project: "north",
      env: "staging",
      scope: "all",
      modules: all,
      layers: shop.layers,
      changes: {},
    });
    expect(p.shared).toBe(true);
    expect(p.cantRun.map((c) => [c.name, c.reason])).toEqual(
      expect.arrayContaining([
        ["api/load", "environment"],
        ["web/smoke", "no-health-url"],
      ]),
    );
    expect(ids(p.modules)).toEqual(["code/deps", "api/orders", "web/checkout"]);
  });
});

describe("T14: the default scope is what changed", () => {
  it("is the default", () => {
    const p = planVerify({
      project: "north",
      env: "local",
      modules: all,
      layers: shop.layers,
      changes: moduleChanges(all, ran(ids(all)), git(["api/src/orders.ts"])),
    });
    expect(p.scope).toBe("changed");
  });

  it("smoke, the modules whose watch paths changed, and the layers that depend on theirs", () => {
    const changes = moduleChanges(
      all,
      ran(ids(all)),
      git(["api/src/orders.ts"]),
    );
    const p = planVerify({
      project: "north",
      env: "local",
      modules: all,
      layers: shop.layers,
      changes,
    });
    // api/orders watches api/**; web depends on api, so web's modules
    // come too; code/deps has no watch, so any change counts; api/load
    // watches perf/** only and stays out.
    expect(ids(p.modules)).toEqual([
      "code/deps",
      "web/smoke",
      "api/orders",
      "web/checkout",
    ]);
    const why = Object.fromEntries(p.modules.map((m) => [m.name, m.why]));
    expect(why).toEqual({
      "code/deps": "changed",
      "web/smoke": "smoke",
      "api/orders": "changed",
      "web/checkout": "depends",
    });
  });

  it("a change only a perf script sees: smoke, that module and the layer that depends on its layer, not api/orders", () => {
    const p = planVerify({
      project: "north",
      env: "local",
      modules: all,
      layers: shop.layers,
      changes: moduleChanges(all, ran(ids(all)), git(["perf/load.js"])),
    });
    expect(ids(p.modules)).toEqual([
      "code/deps",
      "web/smoke",
      "web/checkout",
      "api/load",
    ]);
  });

  it("a module with no watch is affected by any change in its repo", () => {
    const changes = moduleChanges(all, ran(ids(all)), git(["README.md"]));
    expect(changes["shop:code/deps"]).toBe("changed");
    expect(changes["shop:api/orders"]).toBe("unchanged");
  });

  it("a module with no result yet counts as changed (never checked)", () => {
    const changes = moduleChanges(all, {}, git([]));
    expect(changes["shop:api/orders"]).toBe("never");
  });

  it("no change anywhere: nothing to run, not even smoke", () => {
    const p = planVerify({
      project: "north",
      env: "local",
      modules: all,
      layers: shop.layers,
      changes: moduleChanges(all, ran(ids(all)), git([])),
    });
    expect(p.modules).toEqual([]);
    expect(p.nothingToRun).toBe(true);
    expect(p.reason).toBe("unchanged");
  });

  it("everything is a choice, never the default", () => {
    const p = planVerify({
      project: "north",
      env: "local",
      scope: "all",
      modules: all,
      layers: shop.layers,
      changes: moduleChanges(all, ran(ids(all)), git([])),
    });
    expect(p.nothingToRun).toBe(false);
    expect(ids(p.modules)).toContain("api/load");
  });
});
