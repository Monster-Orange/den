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
