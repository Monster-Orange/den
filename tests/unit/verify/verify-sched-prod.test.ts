/**
 * Issue 214 (T19): a scheduled production run is read-only.
 *   - It takes only checks Den keeps read-only itself: built-in smoke and
 *     scans of the code. A command Den can't see inside is left out, named.
 *   - Every request goes through the guard: GET, HEAD and OPTIONS, plus
 *     write_allow pairs. A write is blocked, and the run's log says so.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readVerifyModules } from "../../../src/shared/verify/config.js";
import { planVerify } from "../../../src/shared/verify/plan.js";
import { runPlan } from "../../../src/shared/verify/run.js";
import { methodRules } from "../../../src/shared/verify/guard.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-sched-prod-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const shop = readVerifyModules(
  {
    repo: "shop",
    repoPath: "/repos/shop",
    manifest: {
      services: {
        web: { health: { production: { url: "https://shop.example/health" } } },
      },
      verify: {
        modules: {
          "web/smoke": { kind: "smoke", environments: ["production"] },
          "web/checkout": {
            kind: "synthetic",
            cmd: "make uat",
            environments: ["production"],
          },
          "code/lint": { kind: "security", cmd: "make audit" },
        },
      },
    },
  },
  ["local", "production"],
);

const planOf = (trigger?: "schedule") =>
  planVerify({
    project: "shop",
    env: "production",
    scope: "all",
    modules: shop.modules,
    layers: shop.layers,
    changes: {},
    ...(trigger ? { trigger } : {}),
  });

describe("the plan", () => {
  it("by hand, production is still refused (its opt-in comes later)", () => {
    const p = planOf();
    expect(p.cantRun.map((m) => [m.name, m.reason]).sort()).toEqual([
      ["web/checkout", "production"],
      ["web/smoke", "production"],
    ]);
    expect(p.readOnly).toBe(true);
  });

  it("on a schedule: read-only built-in smoke only; every command is left out, named, a code-layer one too", () => {
    const p = planOf("schedule");
    expect(p.readOnly).toBe(true);
    expect(p.trigger).toBe("schedule");
    expect(p.modules.map((m) => m.name)).toEqual(["web/smoke"]);
    expect(p.cantRun.map((m) => [m.name, m.reason]).sort()).toEqual([
      ["code/lint", "production-declared"],
      ["web/checkout", "production-declared"],
    ]);
  });
});

describe("the run", () => {
  it("sends only allowed methods and keeps the request log", async () => {
    const sent: string[] = [];
    const r = await runPlan(planOf("schedule"), {
      stateDir,
      head: () => "c0ffee1",
      runCmd: async () => ({ exitCode: 0 }),
      probe: async (url, method = "GET") => {
        sent.push(`${method} ${url}`);
        return 200;
      },
      runId: () => "sched-1",
      now: () => new Date("2026-11-21T10:00:00Z"),
      methods: methodRules(undefined, "production"),
    });
    expect(r.verdict).toBe("passed");
    expect(sent).toEqual(["GET https://shop.example/health"]);
    const smoke = r.modules.find((m) => m.name === "web/smoke")!;
    expect(smoke.requests).toEqual([
      { method: "GET", url: "https://shop.example/health", status: 200 },
    ]);
  });

  it("a write is blocked before it leaves", async () => {
    const sent: string[] = [];
    const plan = planOf("schedule");
    // A smoke check that tries to write: the guard refuses it.
    const r = await runPlan(plan, {
      stateDir,
      head: () => "c0ffee1",
      runCmd: async () => ({ exitCode: 0 }),
      probe: async (url, method = "GET") => {
        sent.push(`${method} ${url}`);
        return 200;
      },
      runId: () => "sched-2",
      now: () => new Date("2026-11-21T10:00:00Z"),
      methods: methodRules(undefined, "production"),
      smokeMethod: "POST",
    });
    expect(sent).toEqual([]);
    const smoke = r.modules.find((m) => m.name === "web/smoke")!;
    expect(smoke.state).toBe("failed");
    expect(smoke.message).toMatch(
      /blocked: POST is not allowed on a read-only run/,
    );
    expect(smoke.requests).toEqual([
      { method: "POST", url: "https://shop.example/health", blocked: true },
    ]);
  });
});
