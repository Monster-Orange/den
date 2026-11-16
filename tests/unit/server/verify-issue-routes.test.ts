/**
 * Issue 212 follow-up: "Open an issue with this range" (S5).
 *
 *   POST /api/verify/modules/:id/issue { env }             the preview:
 *       the target repo (the check's own, from its origin) and the exact
 *       title and body; sends nothing
 *   POST /api/verify/modules/:id/issue { env, send: true } a person only:
 *       files it as them with their gh (Report's send)
 *   held write verify_issue                                an agent asks;
 *       always the person's own Allow
 *
 * A fake gh and a fake git: never the real ones. Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { writeRunRecord } from "../../../src/shared/verify/records.js";
import { setPrincipal } from "../../../src/ui/server/request-guard.js";
import {
  checkVerifyIssue,
  handleVerifyRoutes,
  runVerifyIssue,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";
import { CRITICAL_HELD_ACTIONS } from "../../../src/ui/server/held-actions.js";
import { isCriticalWrite } from "../../../src/shared/approval-policy.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-issue-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const ghCalls: { args: string[]; stdin?: string }[] = [];
const gh = async (args: string[], stdin?: string) => {
  ghCalls.push({ args, stdin });
  if (args[0] === "auth") return { code: 0, stdout: "", stderr: "" };
  if (args[0] === "api") return { code: 1, stdout: "", stderr: "" };
  return {
    code: 0,
    stdout: "https://github.com/acme/shop/issues/9\n",
    stderr: "",
  };
};

const deps = (over: Partial<VerifyServerDeps> = {}): VerifyServerDeps => ({
  stateDir: () => stateDir,
  projectExists: (p) => p === "north",
  focusedProject: () => "north",
  environments: () => ["local", "staging"],
  repos: () => [
    {
      repo: "shop",
      repoPath: "/repos/shop",
      manifest: {
        name: "shop",
        verify: {
          modules: {
            "api/orders": {
              kind: "integration",
              cmd: "make contract",
              environments: ["local", "staging"],
            },
            "api/users": {
              kind: "integration",
              cmd: "make users",
              environments: ["local", "staging"],
            },
          },
        },
      },
    },
  ],
  git: {
    head: () => "e4f5a6b",
    changedSince: () => [],
    origin: (p) => (p === "/repos/shop" ? "acme/shop" : null),
    between: () => [
      { commit: "e4f5a6b", subject: "api: update database driver" },
    ],
  },
  gh,
  ...over,
});

const mod = (name: string, state: string) => ({
  id: `shop:${name}`,
  name,
  repo: "shop",
  layer: "api",
  kind: "integration",
  mark: "declared-read-only",
  state,
  ms: 1,
  ...(state === "failed" ? { message: "POST /orders returned 500" } : {}),
});
[
  ["r1", "a1b2c3d", "passed"],
  ["r2", "e4f5a6b", "failed"],
].forEach(([runId, commit, s], i) =>
  writeRunRecord(stateDir, {
    runId,
    project: "north",
    env: "staging",
    scope: "all",
    verdict: s === "passed" ? "passed" : "failed",
    exitCode: s === "passed" ? 0 : 1,
    startedAt: `2026-11-1${i}T10:00:00Z`,
    endedAt: `2026-11-1${i}T10:05:00Z`,
    commit,
    modules: [mod("api/orders", s), mod("api/users", "passed")],
  }),
);

async function serve<T>(d: VerifyServerDeps, fn: (b: string) => Promise<T>) {
  const server = http.createServer((req, res) => {
    if (req.headers["x-test-agent"])
      setPrincipal(req, {
        kind: "agent",
        actor: `agent:${String(req.headers["x-test-agent"])}`,
        workspace: "north",
        grants: [],
        session: { name: "north:helper" },
      } as never);
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleVerifyRoutes(req, res, p, () => d).then((done) => {
      if (!done) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const ISSUE = "/api/verify/modules/shop%3Aapi%2Forders/issue";
const post = (url: string, body: unknown, agent?: string) =>
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(agent ? { "x-test-agent": agent } : {}),
    },
    body: JSON.stringify(body),
  });

describe("issue 212: Open an issue with this range", () => {
  it("the preview: the check's own repo and the exact text; nothing sent", async () => {
    ghCalls.length = 0;
    await serve(deps(), async (base) => {
      const r = await post(`${base}${ISSUE}`, { env: "staging" });
      expect(r.status).toBe(200);
      const b = (await r.json()) as {
        repo: string;
        title: string;
        body: string;
      };
      expect(b.repo).toBe("acme/shop");
      expect(b.title).toBe("api/orders fails on staging since e4f5a6b");
      for (const s of [
        "fails on **staging** in project north",
        "First failing run: `r2`, at commit `e4f5a6b`",
        "Last passing run: `r1`, at commit `a1b2c3d`",
        "> POST /orders returned 500",
        "- `e4f5a6b` api: update database driver",
      ])
        expect(b.body).toContain(s);
    });
    expect(ghCalls).toEqual([]);
  });

  it("a person's send files it on the check's repo, as them", async () => {
    ghCalls.length = 0;
    await serve(deps(), async (base) => {
      const r = await post(`${base}${ISSUE}`, { env: "staging", send: true });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({
        ok: true,
        url: "https://github.com/acme/shop/issues/9",
        repo: "acme/shop",
      });
    });
    const create = ghCalls.find((c) => c.args[1] === "create")!;
    expect(create.args.slice(0, 4)).toEqual([
      "issue",
      "create",
      "-R",
      "acme/shop",
    ]);
    expect(create.stdin).toContain("First failing run: `r2`");
  });

  it("an agent can't send it here: it asks with verify_issue", async () => {
    ghCalls.length = 0;
    await serve(deps(), async (base) => {
      const r = await post(
        `${base}${ISSUE}`,
        { env: "staging", send: true },
        "helper",
      );
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toMatch(
        /verify_issue/,
      );
    });
    expect(ghCalls).toEqual([]);
  });

  it("a passing check has no range; a repo with no GitHub origin has no target", async () => {
    await serve(deps(), async (base) => {
      const passing = await post(
        `${base}/api/verify/modules/shop%3Aapi%2Fusers/issue`,
        { env: "staging" },
      );
      expect([
        passing.status,
        ((await passing.json()) as { code: string }).code,
      ]).toEqual([409, "no_range"]);
    });
    await serve(
      deps({
        git: { head: () => null, changedSince: () => [], origin: () => null },
      }),
      async (base) => {
        const r = await post(`${base}${ISSUE}`, { env: "staging" });
        expect([r.status, ((await r.json()) as { code: string }).code]).toEqual(
          [409, "no_github_repo"],
        );
      },
    );
  });
});

describe("issue 212: the held write verify_issue (an agent's ask)", () => {
  it("is critical: always the person's own Allow", () => {
    expect(CRITICAL_HELD_ACTIONS.has("verify_issue")).toBe(true);
    expect(isCriticalWrite("verify_issue", false)).toBe(true);
    const c = checkVerifyIssue(
      deps(),
      { module: "shop:api/orders", env: "staging" },
      { agent: "helper", project: "north" },
    );
    if (!c.ok) throw new Error(c.error);
    expect(c.personOnly).toBe(true);
    expect(c.params).toMatchObject({
      repo: "acme/shop",
      title: "api/orders fails on staging since e4f5a6b",
    });
    expect(c.args).toEqual({
      project: "north",
      module: "shop:api/orders",
      env: "staging",
    });
    expect(c.details.join("\n")).toContain("acme/shop");
  });

  it("allowed, it files the same issue as the person", async () => {
    ghCalls.length = 0;
    const r = await runVerifyIssue(deps(), {
      project: "north",
      module: "shop:api/orders",
      env: "staging",
    });
    expect(r).toMatchObject({
      ok: true,
      url: "https://github.com/acme/shop/issues/9",
    });
    expect(ghCalls.find((c) => c.args[1] === "create")!.args).toContain(
      "acme/shop",
    );
  });
});
