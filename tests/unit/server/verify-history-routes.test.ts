/**
 * Issue 212: a module's history (S5) and a scan's SARIF report (S6), as
 * the page and agents read them.
 *
 *   GET /api/verify/modules/:id/history?env=   runs oldest first (at most
 *       verify.history.limit), the flaky mark, the first failing range
 *       and the commits in between
 *   GET /api/verify/runs/:id/report?module=&kind=sarif   the scan's SARIF
 *
 * Settings come from deps.settings (the org's verify:). Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { writeRunRecord } from "../../../src/shared/verify/records.js";
import { VERIFY_SETTINGS_DEFAULTS } from "../../../src/shared/verify/settings.js";
import {
  handleVerifyRoutes,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-hist-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

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
            "code/deps": { kind: "security", cmd: "make audit" },
          },
        },
      },
    },
  ],
  git: {
    head: () => "e4f5a6b",
    changedSince: () => [],
    between: (_p, from, to) =>
      from === "a1b2c3d" && to === "e4f5a6b"
        ? [
            { commit: "b7c8d9e", subject: "orders: add discount codes" },
            { commit: "e4f5a6b", subject: "api: update database driver" },
          ]
        : null,
  },
  ...over,
});

async function serve<T>(d: VerifyServerDeps, fn: (b: string) => Promise<T>) {
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

const mod = (state: string, over: Record<string, unknown> = {}) => ({
  id: "shop:api/orders",
  name: "api/orders",
  repo: "shop",
  layer: "api",
  kind: "integration",
  mark: "declared-read-only",
  state,
  ms: 100,
  ...over,
});
const seq: [string, string, Record<string, unknown>?][] = [
  ["p", "c0ffee1", { flaky: true }],
  ["p", "a1b2c3d", { flaky: true }],
  ["f", "e4f5a6b"],
];
seq.forEach(([s, commit, over], i) =>
  writeRunRecord(stateDir, {
    runId: `r${i}`,
    project: "north",
    env: "staging",
    scope: "all",
    verdict: s === "p" ? "passed" : "failed",
    exitCode: s === "p" ? 0 : 1,
    startedAt: `2026-11-1${i}T10:00:00Z`,
    endedAt: `2026-11-1${i}T10:05:00Z`,
    commit,
    modules: [mod(s === "p" ? "passed" : "failed", over)],
  }),
);

describe("issue 212: GET /api/verify/modules/:id/history", () => {
  it("runs oldest first, the flaky mark, the range and the commits in between", async () => {
    await serve(deps(), async (base) => {
      const r = await fetch(
        `${base}/api/verify/modules/${encodeURIComponent("shop:api/orders")}/history?env=staging&project=north`,
      );
      expect(r.status).toBe(200);
      const b = (await r.json()) as Record<string, unknown> & {
        runs: { runId: string }[];
      };
      expect(b.runs.map((x) => x.runId)).toEqual(["r0", "r1", "r2"]);
      expect(b.flaky).toEqual({ mark: true, count: 2, window: 10, min: 2 });
      expect(b.range).toEqual({
        lastPassed: { runId: "r1", commit: "a1b2c3d" },
        firstFailed: { runId: "r2", commit: "e4f5a6b" },
      });
      expect(b.commits).toEqual([
        { commit: "b7c8d9e", subject: "orders: add discount codes" },
        { commit: "e4f5a6b", subject: "api: update database driver" },
      ]);
      expect(b).toMatchObject({ name: "api/orders", kind: "integration" });
    });
  });

  it("the settings decide the mark and the length", async () => {
    await serve(
      deps({
        settings: () => ({
          ...VERIFY_SETTINGS_DEFAULTS,
          flakyMinRetries: 3,
          historyLimit: 2,
        }),
      }),
      async (base) => {
        const b = (await (
          await fetch(
            `${base}/api/verify/modules/shop%3Aapi%2Forders/history?env=staging`,
          )
        ).json()) as { runs: unknown[]; flaky: { mark: boolean } };
        expect(b.runs).toHaveLength(2);
        expect(b.flaky.mark).toBe(false);
      },
    );
  });

  it("an unknown module or environment is refused", async () => {
    await serve(deps(), async (base) => {
      const none = await fetch(
        `${base}/api/verify/modules/shop%3Aapi%2Fnope/history?env=staging`,
      );
      expect(none.status).toBe(404);
      const env = await fetch(
        `${base}/api/verify/modules/shop%3Aapi%2Forders/history?env=moon`,
      );
      expect(env.status).toBe(400);
    });
  });
});

describe("issue 212: a scan's SARIF report", () => {
  it("serves the file the scan wrote, as JSON that runs nothing", async () => {
    const dir = path.join(
      stateDir,
      "verify",
      "north",
      "runs",
      "r-scan",
      "shop_code_deps",
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "deps.sarif"),
      '{"version":"2.1.0","runs":[]}',
    );
    writeRunRecord(stateDir, {
      runId: "r-scan",
      project: "north",
      env: "local",
      scope: "all",
      verdict: "passed",
      exitCode: 0,
      startedAt: "2026-11-15T10:00:00Z",
      endedAt: "2026-11-15T10:01:00Z",
      modules: [
        {
          id: "shop:code/deps",
          name: "code/deps",
          repo: "shop",
          layer: "code",
          kind: "security",
          mark: "reads-code-only",
          state: "passed",
          ms: 10,
          findings: {
            counts: { critical: 0, high: 0, medium: 0, low: 0 },
            list: [],
            failOn: "high",
            report: "deps.sarif",
          },
        },
      ],
    });
    await serve(deps(), async (base) => {
      const r = await fetch(
        `${base}/api/verify/runs/r-scan/report?module=code%2Fdeps&kind=sarif`,
      );
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/application\/json/);
      expect(r.headers.get("content-security-policy")).toMatch(/sandbox/);
      expect(await r.text()).toContain('"2.1.0"');
      const none = await fetch(
        `${base}/api/verify/runs/r0/report?module=api%2Forders&kind=sarif`,
      );
      expect(none.status).toBe(404);
    });
  });
});
