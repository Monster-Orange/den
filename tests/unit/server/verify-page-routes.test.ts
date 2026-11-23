/**
 * Issue 209: the routes the Verify page reads.
 *
 *   GET /api/verify/overview          the answer on each environment
 *   GET /api/verify/runs/:id          one run's record
 *   GET /api/verify/runs/:id/report   a module's kept output (text)
 *
 * A held run (staging) records the agent that asked and that a person
 * allowed it; a local run records who started it. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  heldActions,
  type HeldActionDeps,
} from "../../../src/ui/server/held-actions.js";
import {
  checkVerifyRun,
  handleVerifyRoutes,
  runVerify,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-page-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

const vdeps: VerifyServerDeps = {
  stateDir: () => stateDir,
  projectExists: (p) => p === "north" || p === "south",
  focusedProject: () => "north",
  environments: () => ["local", "staging", "production"],
  repos: () => [
    {
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
          },
        },
      },
    },
  ],
  git: { head: () => "e4f5a6b", changedSince: () => ["api/x.ts"] },
  runCmd: async (m, ctx) =>
    ctx.env === "staging" && m.name === "api/orders"
      ? { exitCode: 1, lines: ["POST /orders returned 500"] }
      : { exitCode: 0 },
  probe: async () => 200,
};

async function serve<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleVerifyRoutes(req, res, p, () => vdeps).then((done) => {
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

describe("issue 209: the Verify page's routes", () => {
  it("a held run records the agent that asked and that a person allowed it", async () => {
    const actions = heldActions({
      verifyRun: {
        check: (a: Record<string, unknown>, who?: { project?: string }) =>
          checkVerifyRun(vdeps, a, who),
        run: (
          a: Record<string, unknown>,
          asked?: { agent?: string; decidedBy?: string },
        ) => runVerify(vdeps, a, {}, asked),
      },
    } as unknown as HeldActionDeps);
    const c = await actions.verify_run.check({ env: "staging", scope: "all" });
    if (!c.ok) throw new Error(c.error);
    const r = (await actions.verify_run.run(c.args, {
      id: "ask-1",
      agent: "release-helper",
      decidedBy: "s-123",
    })) as { runId: string; verdict: string };
    expect(r.verdict).toBe("failed");

    await serve(async (base) => {
      const rec = (await (
        await fetch(`${base}/api/verify/runs/${r.runId}?project=north`)
      ).json()) as Record<string, unknown>;
      expect(rec).toMatchObject({
        ok: true,
        env: "staging",
        startedBy: { kind: "agent", name: "release-helper" },
        allowedBy: { kind: "person" },
      });
      const rep = await fetch(
        `${base}/api/verify/runs/${r.runId}/report?project=north&module=api/orders`,
      );
      expect(rep.status).toBe(200);
      expect(rep.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await rep.text()).toContain("POST /orders returned 500");
      const none = await fetch(
        `${base}/api/verify/runs/${r.runId}/report?project=north&module=web/checkout`,
      );
      expect(none.status).toBe(404);
      expect(
        (await fetch(`${base}/api/verify/runs/nope?project=north`)).status,
      ).toBe(404);
    });
  });

  it("GET /api/verify/overview answers each environment worst first", async () => {
    await runVerify(vdeps, { env: "local", scope: "all" });
    await serve(async (base) => {
      const res = await fetch(`${base}/api/verify/overview`);
      expect(res.status).toBe(200);
      const ov = (await res.json()) as {
        ok: boolean;
        project: string;
        modules: number;
        envs: {
          env: string;
          answer: string;
          failures: { module: string; report: boolean }[];
        }[];
      };
      expect(ov.ok).toBe(true);
      expect(ov.project).toBe("north");
      expect(ov.modules).toBe(2);
      expect(ov.envs.map((e) => [e.env, e.answer])).toEqual([
        ["staging", "failed"],
        ["production", "nothing"],
        ["local", "ready"],
      ]);
      expect(ov.envs[0].failures).toEqual([
        expect.objectContaining({ module: "api/orders", report: true }),
      ]);
      expect(
        (await fetch(`${base}/api/verify/overview?project=nowhere`)).status,
      ).toBe(400);
      expect(
        (await fetch(`${base}/api/verify/overview`, { method: "POST" })).status,
      ).toBe(405);
    });
  });
});

describe("issue 212: a module's history and a scan's findings", () => {
  const sdeps: VerifyServerDeps = {
    ...vdeps,
    repos: () => [
      {
        repo: "shop",
        repoPath: "/repos/shop",
        manifest: {
          name: "shop",
          verify: {
            modules: {
              "api/orders": { kind: "integration", cmd: "make contract" },
              "code/deps": { kind: "security", cmd: "make scan" },
            },
          },
        },
      },
    ],
    settings: () => ({
      retries: 1,
      failOn: "high",
      flakyWindow: 10,
      flakyMinRetries: 2,
      historyLimit: 30,
    }),
  };

  async function serveWith<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      void handleVerifyRoutes(req, res, p, () => sdeps).then((done) => {
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

  it("history: retried passes (verify.run.retries from settings) show the flaky mark", async () => {
    for (let i = 0; i < 2; i++) {
      let n = 0;
      await runVerify(
        { ...sdeps, runCmd: async () => ({ exitCode: ++n === 1 ? 1 : 0 }) },
        {
          project: "south",
          env: "local",
          scope: "all",
          modules: ["api/orders"],
        },
      );
    }
    await serveWith(async (base) => {
      const r = await fetch(
        `${base}/api/verify/modules/${encodeURIComponent("api/orders")}/history?project=south&env=local`,
      );
      expect(r.status).toBe(200);
      const h = (await r.json()) as {
        runs: { attempts?: string[] }[];
        flaky: { flaky: boolean; retried: number };
      };
      expect(h.runs).toHaveLength(2);
      expect(h.runs[0].attempts).toEqual(["failed", "passed"]);
      expect(h.flaky).toMatchObject({ flaky: true, retried: 2 });
      expect(
        (
          await fetch(
            `${base}/api/verify/modules/x/history?project=south&limit=0`,
          )
        ).status,
      ).toBe(400);
    });
  });

  it("history: the commits between the last good run and the first bad one, from git", async () => {
    let head = "aaa1111";
    const git = {
      head: () => head,
      changedSince: () => [],
      between: (repoPath: string, from: string, to: string, max: number) =>
        repoPath === "/repos/shop" && from === "aaa1111" && to === "ccc3333"
          ? [
              { commit: "bbb2222", subject: "orders: add discount codes" },
              { commit: "ccc3333", subject: "api: update database driver" },
            ].slice(0, max)
          : null,
    };
    const west: VerifyServerDeps = {
      ...sdeps,
      git,
      projectExists: (p) => p === "west",
    };
    const ask = {
      project: "west",
      env: "local",
      scope: "all",
      modules: ["api/orders"],
    };
    await runVerify({ ...west, runCmd: async () => ({ exitCode: 0 }) }, ask);
    head = "ccc3333";
    await runVerify({ ...west, runCmd: async () => ({ exitCode: 1 }) }, ask);
    const prev = { ...sdeps };
    Object.assign(sdeps, west);
    try {
      await serveWith(async (base) => {
        const h = (await (
          await fetch(
            `${base}/api/verify/modules/${encodeURIComponent("api/orders")}/history?project=west&env=local`,
          )
        ).json()) as {
          firstFailing: { lastGood: { commit: string } };
          commits: { commit: string; subject: string }[];
        };
        expect(h.firstFailing.lastGood.commit).toBe("aaa1111");
        expect(h.commits.map((c) => c.commit)).toEqual(["bbb2222", "ccc3333"]);
      });
    } finally {
      Object.assign(sdeps, prev);
    }
  });

  it("history: many runs of other modules never push a module's own runs out", async () => {
    const east: VerifyServerDeps = {
      ...sdeps,
      projectExists: (p) => p === "east",
      runCmd: async () => ({ exitCode: 0 }),
    };
    const ask = (m: string) => ({
      project: "east",
      env: "local",
      scope: "all",
      modules: [m],
    });
    for (let i = 0; i < 3; i++) await runVerify(east, ask("api/orders"));
    // More than the old read window (4 x the flaky window, 40 runs).
    for (let i = 0; i < 45; i++) await runVerify(east, ask("code/deps"));
    const prev = { ...sdeps };
    Object.assign(sdeps, east);
    try {
      await serveWith(async (base) => {
        const h = (await (
          await fetch(
            `${base}/api/verify/modules/${encodeURIComponent("api/orders")}/history?project=east&env=local&limit=1`,
          )
        ).json()) as { runs: unknown[] };
        // limit 1: the newest of its 3 runs, found behind 45 others.
        expect(h.runs).toHaveLength(1);
      });
    } finally {
      Object.assign(sdeps, prev);
    }
  });

  it("findings: by severity, with the threshold; 404 for a module that wrote none", async () => {
    const r = (await runVerify(
      {
        ...sdeps,
        runCmd: async (_m, ctx) => {
          fs.writeFileSync(
            path.join(ctx.resultsDir, "scan.sarif"),
            JSON.stringify({
              runs: [
                {
                  results: [
                    { ruleId: "R-1", level: "warning", message: { text: "m" } },
                  ],
                },
              ],
            }),
          );
          return { exitCode: 1 };
        },
      },
      { project: "south", env: "local", scope: "all" },
    )) as { runId: string };
    await serveWith(async (base) => {
      const res = await fetch(
        `${base}/api/verify/runs/${r.runId}/modules/${encodeURIComponent("code/deps")}/findings?project=south`,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        module: "code/deps",
        state: "passed",
        failOn: "high",
        counts: { critical: 0, high: 0, medium: 1, low: 0 },
        findings: [{ rule: "R-1", severity: "medium" }],
        // What the page needs for its report link (S6).
        project: "south",
        moduleId: "shop:code/deps",
        sarif: true,
      });
      // "Open report (SARIF)": the file the scan wrote, served as it is.
      const rep = await fetch(
        `${base}/api/verify/runs/${r.runId}/report?project=south&module=${encodeURIComponent("shop:code/deps")}&kind=sarif`,
      );
      expect(rep.status).toBe(200);
      expect(rep.headers.get("content-type")).toMatch(
        /^application\/sarif\+json/,
      );
      expect(rep.headers.get("x-content-type-options")).toBe("nosniff");
      expect(((await rep.json()) as { runs: unknown[] }).runs).toHaveLength(1);
      expect(
        (
          await fetch(
            `${base}/api/verify/runs/${r.runId}/report?project=south&module=${encodeURIComponent("web/none")}&kind=sarif`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(
            `${base}/api/verify/runs/${r.runId}/modules/${encodeURIComponent("api/orders")}/findings?project=south`,
          )
        ).status,
      ).toBe(404);
    });
  });
});
