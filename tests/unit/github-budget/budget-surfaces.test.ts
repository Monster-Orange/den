/**
 * Issue 487: where the GitHub budget shows and is used: the web routes
 * (GET /api/github/budget, POST /api/ci/wait), the MCP tools ci_wait and
 * github_budget, doctor's lines, the github_budget settings, and the
 * hook's arguments. A fake GitHub on 127.0.0.1; never the real API or gh.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { GithubBudget } from "../../../src/shared/github-budget/budget.js";
import { createGhCliHttp } from "../../../src/shared/github-budget/client.js";
import { fakeGh } from "./fake-gh.js";
import { CiWatcher } from "../../../src/shared/github-budget/ci-watcher.js";
import {
  GITHUB_BUDGET_LIMITS,
  githubBudgetSettings,
} from "../../../src/shared/github-budget/settings.js";
import { githubBudgetLines } from "../../../src/shared/github-budget/doctor.js";
import {
  handleGithubBudgetRoutes,
  isGithubBudgetPath,
} from "../../../src/ui/server/github-budget-routes.js";
import {
  READ_TOOL_NAMES,
  callTool,
  type ToolContext,
} from "../../../src/ui/mcp/tools.js";
import { assertAllowedRequest, type DenApi } from "../../../src/ui/mcp/api.js";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../src/shared/settings-cli-rows.js";
import {
  GUARDRAILS_DIR,
  hookCommands,
} from "../../../src/shared/agents/guardrails.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ghs-"));

/** A fake GitHub that answers one run, with ETags and a budget. */
let remaining = 5000;
let runStatus = "in_progress";
const reset = Math.floor(Date.now() / 1000) + 1800;
const fakeGh = http.createServer((req, res) => {
  const p = new URL(req.url ?? "/", "http://x").pathname;
  const head = {
    "content-type": "application/json",
    "x-ratelimit-limit": "5000",
    "x-ratelimit-remaining": String(remaining),
    "x-ratelimit-reset": String(reset),
  };
  if (p === "/rate_limit") {
    res.writeHead(200, head);
    return res.end(
      JSON.stringify({
        resources: { core: { limit: 5000, remaining, reset } },
      }),
    );
  }
  if (p === "/repos/o/r/actions/runs/5") {
    const etag = `"${runStatus}"`;
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...head, etag });
      return res.end();
    }
    remaining--;
    res.writeHead(200, { ...head, etag });
    return res.end(
      JSON.stringify({
        id: 5,
        status: runStatus,
        conclusion: runStatus === "completed" ? "success" : null,
      }),
    );
  }
  res.writeHead(404, head);
  res.end("{}");
});

let ghBase = "";
let den: http.Server;
let denBase = "";
let budget: GithubBudget;
const snapshot = path.join(dir, "github-budget.json");

beforeAll(async () => {
  await new Promise<void>((r) => fakeGh.listen(0, "127.0.0.1", r));
  ghBase = `http://127.0.0.1:${(fakeGh.address() as AddressInfo).port}`;
  const api = createGhCliHttp({
    env: fakeGh(dir, ghBase).env,
    timeoutMs: () => 10_000,
  });
  budget = new GithubBudget({
    reserve: () => 1000,
    readRateLimit: () => api.rateLimit(),
    snapshotFile: snapshot,
    spendFile: path.join(dir, "github-spend.jsonl"),
  });
  const watcher = new CiWatcher({ http: api, budget, pollSeconds: () => 1 });
  den = http.createServer(async (req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    if (!isGithubBudgetPath(p)) {
      res.writeHead(404);
      return res.end();
    }
    await handleGithubBudgetRoutes(req, res, p, {
      budget,
      watcher,
      settings: () => githubBudgetSettings({}),
      actorOf: (r) => (r.headers["x-test-actor"] as string) || undefined,
      holdSeconds: 3,
    });
  });
  await new Promise<void>((r) => den.listen(0, "127.0.0.1", r));
  denBase = `http://127.0.0.1:${(den.address() as AddressInfo).port}`;
});
afterAll(() => {
  fakeGh.close();
  den.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function post(p: string, body: unknown, actor = "agent:a1") {
  const r = await fetch(`${denBase}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-actor": actor },
    body: JSON.stringify(body),
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
}

describe("the web routes", () => {
  it("POST /api/ci/wait waits through the shared watcher and says when the run ends", async () => {
    remaining = 5000;
    runStatus = "in_progress";
    const first = await post("/api/ci/wait", {
      repo: "o/r",
      run: 5,
      timeout_seconds: 1,
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ done: false, status: "in_progress" });
    runStatus = "completed";
    const second = await post("/api/ci/wait", {
      repo: "o/r",
      run: 5,
      timeout_seconds: 10,
    });
    expect(second.body).toMatchObject({ done: true, conclusion: "success" });
  });

  it("refuses a bad repo or no run and no PR", async () => {
    expect((await post("/api/ci/wait", { repo: "x", run: 1 })).status).toBe(
      400,
    );
    expect((await post("/api/ci/wait", { repo: "o/r" })).status).toBe(400);
  });

  it("below the reserve an agent's wait is refused with the reset time; a person's is not", async () => {
    remaining = 300;
    await budget.refresh();
    runStatus = "in_progress";
    const a = await post("/api/ci/wait", {
      repo: "o/r",
      run: 5,
      timeout_seconds: 1,
    });
    expect(a.status).toBe(429);
    expect(String(a.body.error)).toMatch(/reserve of 1000/);
    expect(a.body.resetAt).toBeTruthy();
    const p = await post(
      "/api/ci/wait",
      { repo: "o/r", run: 5, timeout_seconds: 1 },
      "person:me",
    );
    expect(p.status).toBe(200);
  });

  it("GET /api/github/budget has the budget, the reserve, the reset and spend per agent", async () => {
    const r = await fetch(`${denBase}/api/github/budget`);
    const b = (await r.json()) as Record<string, unknown>;
    expect(b).toMatchObject({
      reserve: 1000,
      pollSeconds: 60,
      budget: { remaining: 300, limit: 5000, reset },
      below: true,
    });
    expect(Array.isArray(b.spend)).toBe(true);
    expect((b.spend as { actor: string }[]).map((s) => s.actor)).toContain(
      "agent:a1",
    );
  });
});

function fakeApi(answers: unknown[]) {
  const calls: { path: string; method?: string; body?: unknown }[] = [];
  const api: DenApi = {
    baseUrl: "http://localhost:47003",
    async get(p, _q, method, body) {
      if (p === "/api/workspaces")
        return { active: ["north"], workspaces: { north: {} } };
      calls.push({ path: p, method, body });
      return answers.length > 1 ? answers.shift() : answers[0];
    },
    async stream() {
      throw new Error("no streams");
    },
  };
  return { api, calls };
}
const ctx = (api: DenApi): ToolContext => ({
  api,
  cfg: {
    actions: [],
    runTestsEnvs: ["local"],
    logsRemote: false,
    approvals: true,
  },
  cli: "acme",
  scope: { workspace: "north", actor: "agent:planner" },
});

describe("the MCP tools", () => {
  it("ci_wait and github_budget are read tools agents always have", () => {
    expect(READ_TOOL_NAMES).toContain("ci_wait");
    expect(READ_TOOL_NAMES).toContain("github_budget");
    expect(() =>
      assertAllowedRequest("POST", "/api/ci/wait", {}),
    ).not.toThrow();
    expect(() =>
      assertAllowedRequest("GET", "/api/github/budget", {}),
    ).not.toThrow();
  });

  it("ci_wait asks the server again until the run ends", async () => {
    const { api, calls } = fakeApi([
      { done: false, status: "queued", conclusion: null },
      { done: false, status: "in_progress", conclusion: null },
      { done: true, status: "completed", conclusion: "failure" },
    ]);
    const r = await callTool(
      "ci_wait",
      { repo: "o/r", run: 9, timeout_minutes: 30 },
      ctx(api),
    );
    expect(r.isError).toBeFalsy();
    expect(calls.length).toBe(3);
    expect(calls[0]).toMatchObject({
      path: "/api/ci/wait",
      method: "POST",
      body: { repo: "o/r", run: 9 },
    });
    expect(r.text).toMatch(/failure/);
  });

  it("ci_wait needs owner/repo and a run or a PR", async () => {
    const { api } = fakeApi([{}]);
    expect((await callTool("ci_wait", { repo: "o/r" }, ctx(api))).isError).toBe(
      true,
    );
    expect(
      (await callTool("ci_wait", { repo: "bad", run: 1 }, ctx(api))).isError,
    ).toBe(true);
  });
});

describe("doctor", () => {
  const write = (remaining: number) =>
    fs.writeFileSync(
      path.join(dir, "doc.json"),
      JSON.stringify({
        remaining,
        limit: 5000,
        reset,
        reserve: 1000,
        readAt: new Date().toISOString(),
        spend: { "agent:builder": 120, "agent:lane-2": 30.5 },
      }),
    );
  it("shows the budget, the reset and the reserve, and the top spenders", () => {
    write(3200);
    const text = githubBudgetLines(path.join(dir, "doc.json")).join("\n");
    expect(text).toMatch(/3200 of 5000/);
    expect(text).toMatch(/reserve 1000/);
    expect(text).toMatch(/resets at/);
    expect(text).toMatch(/agent:builder/);
    expect(text).not.toMatch(/✗/);
  });
  it("marks ✗ below the reserve", () => {
    write(400);
    expect(githubBudgetLines(path.join(dir, "doc.json")).join("\n")).toMatch(
      /✗/,
    );
  });
  it("says when the server hasn't read it", () => {
    expect(githubBudgetLines(path.join(dir, "none.json")).join("\n")).toMatch(
      /not read yet/,
    );
  });
});

describe("settings", () => {
  it("permissive defaults: poll 60 s, reserve 1000, slow watch 120 s", () => {
    expect(githubBudgetSettings(undefined)).toEqual({
      pollSeconds: 60,
      reserve: 1000,
      watchMinSeconds: 120,
    });
    expect(GITHUB_BUDGET_LIMITS.poll_seconds.default).toBe(60);
  });
  it("github_budget is a person's setting, patched in user.yml", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("github_budget");
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, { github_budget: { reserve: 500, poll_seconds: 30 } }),
    ).toEqual({ ok: true });
    expect(user.github_budget).toEqual({ reserve: 500, poll_seconds: 30 });
    expect(patchCliRows(user, { github_budget: { poll_seconds: 1 } }).ok).toBe(
      false,
    );
  });
  it("the hook gets the slow-watch minimum and the snapshot", () => {
    const c = hookCommands(
      GUARDRAILS_DIR,
      "/usr/bin/node",
      undefined,
      [],
      true,
      undefined,
      undefined,
      { watchMinSeconds: 300, snapshot: "/s/github-budget.json" },
    );
    expect(c.pretooluse).toMatch(/--gh-watch-min 300/);
    expect(c.pretooluse).toMatch(/--gh-budget \/s\/github-budget\.json/);
  });
});
