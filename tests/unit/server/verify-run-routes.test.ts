/**
 * Issue 210: runs that go on in the background, with Cancel (screen S3).
 *
 *   POST /api/verify/run { background: true }   local: starts, answers the
 *                                               run id at once (202)
 *   POST /api/verify/runs/:id/cancel            stops it: "cancelled",
 *                                               exit 4, never a pass (T6)
 *
 * One run at a time per project and environment (verify.run.concurrency:
 * 1). A held run (staging) starts when it is allowed and answers its run
 * id at once, so Allow never waits for the whole run. A record left
 * "running" by a restart says it is no longer live. Invented names only.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { ActiveRuns } from "../../../src/shared/verify/active.js";
import { writeRunRecord } from "../../../src/shared/verify/records.js";
import {
  handleVerifyRoutes,
  startVerify,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-bg-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

/** Commands wait here until the test lets them finish (or Cancel stops them). */
let release: (() => void) | null = null;
const gate = () => new Promise<void>((r) => (release = r));

function deps(active: ActiveRuns, dir = stateDir): VerifyServerDeps {
  return {
    stateDir: () => dir,
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
            layers: { api: {} },
            modules: {
              "api/orders": {
                kind: "integration",
                cmd: "make contract",
                environments: ["local", "staging"],
              },
            },
          },
        },
      },
    ],
    git: { head: () => "e4f5a6b", changedSince: () => ["api/x.ts"] },
    runCmd: (_m, ctx) =>
      new Promise((resolve) => {
        ctx.signal?.addEventListener("abort", () =>
          resolve({ exitCode: null, lines: ["stopped"] }),
        );
        void gate().then(() => resolve({ exitCode: 0, lines: ["ok"] }));
      }),
    probe: async () => 200,
    active,
  };
}

async function serve<T>(
  d: VerifyServerDeps,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const server = http.createServer((req, res) => {
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

const post = (url: string, body: unknown = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

async function until<T>(f: () => Promise<T | null>): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await f();
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("never happened");
}

describe("issue 210: background runs and Cancel", () => {
  it("local: background answers the run id at once; the record says running, then the verdict", async () => {
    const active = new ActiveRuns();
    await serve(deps(active), async (base) => {
      const res = await post(`${base}/api/verify/run`, {
        scope: "all",
        background: true,
      });
      expect(res.status).toBe(202);
      const b = (await res.json()) as { runId: string; running: boolean };
      expect(b.running).toBe(true);
      const rec = (await (
        await fetch(`${base}/api/verify/runs/${b.runId}?project=north`)
      ).json()) as {
        verdict: string;
        live: boolean;
        modules: { state: string }[];
      };
      expect(rec.verdict).toBe("running");
      expect(rec.live).toBe(true);
      expect(rec.modules[0].state).toBe("running");

      // One run at a time on an environment: the second is told which.
      const again = await post(`${base}/api/verify/run`, {
        scope: "all",
        background: true,
      });
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({
        code: "run_going",
        runId: b.runId,
      });

      release!();
      const done = await until(async () => {
        const r = (await (
          await fetch(`${base}/api/verify/runs/${b.runId}?project=north`)
        ).json()) as { verdict: string; live?: boolean };
        return r.verdict === "running" ? null : r;
      });
      expect(done.verdict).toBe("passed");
      expect(done.live).toBeUndefined();
    });
  });

  it("T6: Cancel ends it as cancelled (exit 4), says who cancelled, and never passes", async () => {
    const active = new ActiveRuns();
    await serve(deps(active), async (base) => {
      const b = (await (
        await post(`${base}/api/verify/run`, { scope: "all", background: true })
      ).json()) as { runId: string };
      const c = await post(
        `${base}/api/verify/runs/${b.runId}/cancel?project=north`,
      );
      expect(c.status).toBe(200);
      const done = await until(async () => {
        const r = (await (
          await fetch(`${base}/api/verify/runs/${b.runId}?project=north`)
        ).json()) as {
          verdict: string;
          exitCode: number;
          cancelledBy?: { kind: string };
          cancelledAt?: string;
          modules: { state: string }[];
        };
        return r.verdict === "running" ? null : r;
      });
      expect(done.verdict).toBe("cancelled");
      expect(done.exitCode).toBe(4);
      expect(done.cancelledBy).toEqual({ kind: "person" });
      expect(typeof done.cancelledAt).toBe("string");
      expect(done.modules.map((m) => m.state)).toEqual(["cancelled"]);

      // A run that has ended can't be cancelled; one that never was, 404.
      const late = await post(
        `${base}/api/verify/runs/${b.runId}/cancel?project=north`,
      );
      expect(late.status).toBe(409);
      expect((await late.json()) as { code: string }).toMatchObject({
        code: "not_running",
      });
      const none = await post(
        `${base}/api/verify/runs/no-such-run/cancel?project=north`,
      );
      expect(none.status).toBe(404);
    });
  });

  it("a held run starts when allowed and answers its run id at once", async () => {
    const active = new ActiveRuns();
    const d = deps(active);
    const r = await startVerify(
      d,
      { env: "staging", scope: "all", modules: ["shop:api/orders"] },
      {},
      { id: "ask-1", agent: "release-helper", decidedBy: "s-1" },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r).toMatchObject({ env: "staging", running: true });
    expect(active.isLive("north", r.runId)).toBe(true);
    release!();
    const end = await active.done(r.runId);
    expect(end?.verdict).toBe("passed");
    expect(active.isLive("north", r.runId)).toBe(false);
  });

  it("the plan carries each module's estimate: the average of its last runs here", async () => {
    // Its own state: the other tests' runs on staging must not count.
    const own = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-est-"));
    for (const [id, ms] of [
      ["r-est1", 60_000],
      ["r-est2", 120_000],
    ] as const)
      writeRunRecord(own, {
        runId: id,
        project: "north",
        env: "staging",
        scope: "all",
        verdict: "passed",
        exitCode: 0,
        startedAt: "2026-11-14T10:00:00Z",
        endedAt: "2026-11-14T10:05:00Z",
        modules: [
          {
            id: "shop:api/orders",
            name: "api/orders",
            repo: "shop",
            layer: "api",
            kind: "integration",
            mark: "declared-read-only",
            state: "passed",
            ms,
          },
        ],
      });
    await serve(deps(new ActiveRuns(), own), async (base) => {
      const p = (await (
        await post(`${base}/api/verify/plan`, { env: "staging", scope: "all" })
      ).json()) as { estimates: Record<string, number> };
      expect(p.estimates).toEqual({ "shop:api/orders": 90_000 });
    }).finally(() => fs.rmSync(own, { recursive: true, force: true }));
  });

  it("a record left running by a restart is not live, and Cancel says so", async () => {
    writeRunRecord(stateDir, {
      runId: "r-orphan",
      project: "north",
      env: "local",
      scope: "all",
      verdict: "running",
      exitCode: null,
      startedAt: "2026-11-15T10:00:00Z",
      modules: [],
    });
    await serve(deps(new ActiveRuns()), async (base) => {
      const rec = (await (
        await fetch(`${base}/api/verify/runs/r-orphan?project=north`)
      ).json()) as { verdict: string; live: boolean };
      expect(rec).toMatchObject({ verdict: "running", live: false });
      const c = await post(
        `${base}/api/verify/runs/r-orphan/cancel?project=north`,
      );
      expect(c.status).toBe(409);
    });
  });
});
