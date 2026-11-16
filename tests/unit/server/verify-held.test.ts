/**
 * Issue 208, T7: `verify_run` on a shared environment (staging) is a held
 * write. The person's Allow shows the plan: each module with its mark,
 * what can't run and why. Nothing runs until Allow; Decline runs nothing.
 * It always asks: no setting lets it through unasked (the constant the
 * approval policy reads, and personOnly for today's auto-allow).
 *
 * On local, verify_run runs at once (no Allow). The plan route answers
 * the same plan to a page, the CLI or an agent.
 *
 * The queue in process, the server glue with fake repos and a fake
 * command runner, and the MCP tool against a fake web server. Invented
 * names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { createApprovalQueue } from "../../../src/ui/server/approval-routes.js";
import {
  CRITICAL_HELD_ACTIONS,
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import {
  checkVerifyRun,
  handleVerifyRoutes,
  runVerify,
  verifyPlanOf,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import {
  DenHttpError,
  assertAllowedRequest,
  type DenApi,
  type Query,
} from "../../../src/ui/mcp/api.js";
import type { ResolvedMcpConfig } from "../../../src/shared/den-config.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-held-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const ran: string[] = [];
const vdeps: VerifyServerDeps = {
  stateDir: () => stateDir,
  projectExists: (p) => p === "north",
  focusedProject: () => "north",
  repos: () => [
    {
      repo: "shop",
      repoPath: "/repos/shop",
      manifest: {
        name: "shop",
        verify: {
          layers: { web: { depends_on: ["api"] }, api: {}, code: {} },
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
            "code/deps": { kind: "security", cmd: "trivy fs ." },
            "web/devices": {
              kind: "synthetic",
              adapter: { name: "phone-farm" },
              environments: ["staging"],
            },
          },
        },
      },
    },
  ],
  git: { head: () => "c0ffee1", changedSince: () => ["api/x.ts"] },
  runCmd: async (m) => {
    ran.push(m.name);
    return { exitCode: 0 };
  },
  probe: async () => 200,
};

function held() {
  const deps = {
    verifyRun: {
      check: (a: Record<string, unknown>, who?: { project?: string }) =>
        checkVerifyRun(vdeps, a, who),
      run: (a: Record<string, unknown>) => runVerify(vdeps, a),
    },
  } as unknown as HeldActionDeps;
  return heldActions(deps);
}

describe("T7: verify_run on staging is held", () => {
  it("the Allow's Review: the plan, each module with its mark, what can't run", async () => {
    const c = await held().verify_run.check({ env: "staging", scope: "all" });
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.personOnly).toBe(true);
    expect(c.args).toEqual({
      project: "north",
      env: "staging",
      scope: "all",
      modules: ["shop:code/deps", "shop:api/orders", "shop:web/checkout"],
    });
    expect(c.summary).toBe(
      "run checks on staging in project north: code/deps, api/orders, web/checkout",
    );
    expect(c.detailKeys?.map((k) => k?.key)).toEqual([
      "ap.vr.scope.all",
      "ap.vr.mod.reads-code-only",
      "ap.vr.mod.declared-read-only",
      "ap.vr.mod.declared-read-only",
      "ap.vr.cant.adapter-later",
      "ap.vr.once",
    ]);
    expect(c.details).toEqual([
      "Scope: everything on this environment.",
      "code/deps (security): reads code only",
      "api/orders (integration): declared read-only",
      "web/checkout (synthetic): declared read-only",
      "web/devices can't run yet: its adapter (phone-farm) comes in a later Den.",
      "This Allow covers this run only. Nothing runs until you Allow it.",
    ]);
  });

  it("nothing runs until Allow; Decline runs nothing", async () => {
    ran.length = 0;
    const actions = held();
    const queue = createApprovalQueue(actions, () => stateDir);
    const c = await actions.verify_run.check({ env: "staging", scope: "all" });
    if (!c.ok) throw new Error(c.error);
    const asked = (args: Record<string, unknown>) =>
      queue.request({
        // A person's ask (an agent's needs a live token; the same hold).
        actor: "loopback",
        action: "verify_run",
        args,
        summary: c.summary,
        details: c.details,
      });
    const a = asked(c.args);
    expect(a.state).toBe("pending");
    expect(ran).toEqual([]);
    const no = await queue.decide(a.id, "deny", "s1");
    expect(no.ok && no.approval.state).toBe("denied");
    expect(ran).toEqual([]);

    const b = asked(c.args);
    expect(ran).toEqual([]);
    const yes = await queue.decide(b.id, "allow", "s1");
    expect(yes.ok && yes.approval.state).toBe("done");
    // The plan that was allowed, in its order.
    expect(ran).toEqual(["code/deps", "api/orders", "web/checkout"]);
    expect(yes.ok && yes.approval.result).toMatchObject({
      verdict: "passed",
      exitCode: 0,
      env: "staging",
    });
  });

  it("a shared-environment run is critical: it always asks", () => {
    expect(CRITICAL_HELD_ACTIONS.has("verify_run")).toBe(true);
  });

  it("local is not held: it runs at once", async () => {
    const c = await held().verify_run.check({ env: "local" });
    expect(c).toEqual({
      ok: false,
      error: expect.stringMatching(/local runs at once/),
    });
  });

  it("an agent asks for its own project only", async () => {
    const c = await held().verify_run.check(
      { env: "staging", project: "south" },
      { project: "north" },
    );
    expect(c.ok).toBe(false);
  });
});

describe("the plan route's answer", () => {
  it("each module's mark, the scope, and whether an Allow is needed", () => {
    const r = verifyPlanOf(vdeps, { env: "staging", scope: "all" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.allow).toBe("needed");
    expect(
      [...r.plan.modules, ...r.plan.cantRun].map((m) => [m.name, m.mark]),
    ).toEqual(
      expect.arrayContaining([
        ["code/deps", "reads-code-only"],
        ["api/orders", "declared-read-only"],
        ["web/devices", "declared-by-service"],
      ]),
    );
    const local = verifyPlanOf(vdeps, { env: "local" });
    expect(local.ok && local.plan.allow).toBe("none");
    expect(local.ok && local.plan.scope).toBe("changed");
  });
});

describe("the routes", () => {
  it("POST /api/verify/run refuses a shared environment (it is held), and runs local", async () => {
    ran.length = 0;
    const server = http.createServer((req, res) => {
      void handleVerifyRoutes(req, res, req.url ?? "", () => vdeps);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (p: string, body: unknown) =>
        fetch(base + p, { method: "POST", body: JSON.stringify(body) });
      const held = await post("/api/verify/run", { env: "staging" });
      expect(held.status).toBe(409);
      expect(await held.json()).toMatchObject({ code: "needs_allow" });
      expect(ran).toEqual([]);
      const plan = await post("/api/verify/plan", { env: "staging" });
      expect(plan.status).toBe(200);
      expect(await plan.json()).toMatchObject({ ok: true, allow: "needed" });
      const local = await post("/api/verify/run", { scope: "all" });
      expect(await local.json()).toMatchObject({
        verdict: "passed",
        exitCode: 0,
      });
      expect(ran).toEqual(["code/deps", "api/orders", "web/checkout"]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

// ── The MCP tool ────────────────────────────────────────────────────────────

const ID = "AbCdEfGhIjKlMnOp";
interface Call {
  path: string;
  method?: string;
  body?: unknown;
}
function fakeApi(plan: Record<string, unknown>, state = "denied") {
  const calls: Call[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(p: string, _q?: Query, method?: string, body?: unknown) {
      assertAllowedRequest(method ?? "GET", p, {});
      // The scoped server's one check that its project is there.
      if (p === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path: p, method, body });
      if (p === "/api/verify/plan") return plan;
      if (p === "/api/verify/run")
        return { verdict: "passed", exitCode: 0, modules: [] };
      if (p === "/api/approvals" && method === "POST")
        return { id: ID, state: "pending" };
      if (p === `/api/approvals/${ID}`) return { id: ID, state };
      if (p === "/api/activity") return { ok: true };
      throw new DenHttpError("GET", p, 404, "not found");
    },
    async stream() {
      throw new Error("no streams here");
    },
  };
  return { api, calls };
}
const cfg = (actions: string[] = []): ResolvedMcpConfig =>
  ({
    actions,
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  }) as ResolvedMcpConfig;
const ctx = (api: DenApi, actions: string[] = []): ToolContext => ({
  api,
  cfg: cfg(actions),
  cli: "acme",
  approvalWait: { intervalMs: 1, waitMs: 50, sleep: async () => undefined },
  scope: { workspace: "north", actor: "agent:helper" },
});

describe("T7: the MCP tool verify_run", () => {
  it("on staging, asks the person (a held write) and runs nothing itself; Declined: nothing ran", async () => {
    const { api, calls } = fakeApi({ nothingToRun: false, modules: [{}] });
    const r = await callTool("verify_run", { env: "staging" }, ctx(api));
    expect(calls.map((c) => `${c.method ?? "GET"} ${c.path}`)).toEqual([
      "POST /api/verify/plan",
      "POST /api/approvals",
      `GET /api/approvals/${ID}`,
      // The refusal, in the activity trail.
      "POST /api/activity",
    ]);
    expect(calls[1].body).toEqual({
      action: "verify_run",
      args: { project: "north", env: "staging", scope: "changed" },
    });
    expect(calls.some((c) => c.path === "/api/verify/run")).toBe(false);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/denied it .*nothing ran/);
  });

  it("what changed with no changes: nothing ran, exit 3, nothing asked", async () => {
    const { api, calls } = fakeApi({
      nothingToRun: true,
      reason: "unchanged",
      modules: [],
    });
    const r = await callTool("verify_run", { env: "staging" }, ctx(api));
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({
      verdict: "nothing ran",
      exitCode: 3,
      reason: "unchanged",
    });
    expect(calls.map((c) => c.path)).toEqual(["/api/verify/plan"]);
  });

  it("on local it runs at once, when the org lets agents run tests", async () => {
    const off = fakeApi({});
    const r0 = await callTool("verify_run", {}, ctx(off.api));
    expect(r0.isError).toBe(true);
    expect(r0.text).toMatch(/mcp\.actions/);
    expect(off.calls.some((c) => c.path === "/api/verify/run")).toBe(false);

    const on = fakeApi({});
    const r = await callTool("verify_run", {}, ctx(on.api, ["run_tests"]));
    expect(r.isError).toBe(false);
    expect(on.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/verify/run",
    ]);
    expect(on.calls[0].body).toEqual({
      project: "north",
      env: "local",
      scope: "changed",
    });
  });
});
