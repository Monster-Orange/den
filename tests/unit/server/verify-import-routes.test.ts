/**
 * Issue 441: an imported environment on the routes the Verify page reads.
 *
 *   GET /api/verify/overview   lists verify.environments after the org's,
 *                              each answered from its newest import
 *   POST /api/verify/plan      refuses an imported environment: Den runs
 *                              nothing there, its results are imported
 *   a bad verify: block        hides only the imported environments: the
 *                              org's own still answer and plan, and the
 *                              overview names the key (importError)
 *   a name the org uses        stays the org's: never answered from imports
 *   50 newer runs              the newest import still answers
 *
 * Invented names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  importRecord,
  parseGateVerdict,
  IMPORT_DEFAULTS,
} from "../../../src/shared/verify/imports.js";
import { writeRunRecord } from "../../../src/shared/verify/records.js";
import {
  handleVerifyRoutes,
  type VerifyServerDeps,
} from "../../../src/ui/server/verify-routes.js";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-verify-imp-r-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

let verifyBlock: unknown = { environments: ["bed"] };
const deps: VerifyServerDeps = {
  stateDir: () => stateDir,
  projectExists: (p) => p === "north",
  focusedProject: () => "north",
  environments: () => ["local", "staging"],
  verifyConfig: () => verifyBlock,
  repos: () => [
    {
      repo: "shop",
      repoPath: "/repos/shop",
      manifest: {
        name: "shop",
        verify: {
          modules: { "api/orders": { kind: "integration", cmd: "make x" } },
        },
      },
    },
  ],
  git: { head: () => "e4f5a6b", changedSince: () => [] },
};

const v = parseGateVerdict(
  JSON.stringify({
    tag: "v9.9.9-dev.1",
    sha: "e4f5a6b",
    startedAt: "2026-11-17T21:36:24Z",
    endedAt: "2026-11-17T21:39:56Z",
    clauses: [
      { issue: 7, clause: "a person signs in", verdict: "PASS", ms: 5 },
      {
        issue: 7,
        clause: "a person answers",
        verdict: "NOT_RUN",
        ms: 5,
        note: "skip: person",
      },
    ],
  }),
  IMPORT_DEFAULTS,
);
if (!v.ok) throw new Error(v.error);
writeRunRecord(stateDir, importRecord("north", "bed", v.verdict));

async function serve<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url ?? "/", "http://x").pathname;
    void handleVerifyRoutes(req, res, p, () => deps).then((done) => {
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

describe("issue 441: an imported environment", () => {
  it("the overview lists it after the org's, answered from its import", async () => {
    verifyBlock = { environments: ["bed"] };
    await serve(async (base) => {
      const b = (await (await fetch(`${base}/api/verify/overview`)).json()) as {
        envOrder: string[];
        envs: {
          env: string;
          answer: string;
          imported?: true;
          needsPerson?: unknown[];
          run?: { tag?: string };
        }[];
        checks: { module: string; states: Record<string, string> }[];
      };
      expect(b.envOrder).toEqual(["local", "staging", "bed"]);
      const bed = b.envs.find((e) => e.env === "bed")!;
      expect(bed).toMatchObject({
        answer: "ready",
        imported: true,
        run: { tag: "v9.9.9-dev.1" },
      });
      expect(bed.needsPerson).toHaveLength(1);
      expect(b.checks.map((c) => [c.module, c.states])).toEqual([
        ["api/orders", { local: "none", staging: "off", bed: "off" }],
        ["gate/7", { local: "off", staging: "off", bed: "passed" }],
      ]);
    });
  });

  it("Den runs nothing there: a plan on it is refused", async () => {
    await serve(async (base) => {
      const r = await fetch(`${base}/api/verify/plan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ env: "bed" }),
      });
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(
        /imported.*verify import/,
      );
    });
  });

  const overview = async (base: string) =>
    (await (await fetch(`${base}/api/verify/overview`)).json()) as {
      ok: boolean;
      importError?: string;
      envOrder: string[];
      envs: { env: string; imported?: true; run?: { tag?: string } }[];
    };
  const plan = (base: string, env: string) =>
    fetch(`${base}/api/verify/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ env }),
    });

  it("a bad verify: block hides only the imported environments, and names the key", async () => {
    verifyBlock = { environments: ["Staging"] };
    try {
      await serve(async (base) => {
        const b = await overview(base);
        expect(b.ok).toBe(true);
        expect(b.envOrder).toEqual(["local", "staging"]);
        expect(b.importError).toMatch(/verify\.environments/);
        expect((await plan(base, "local")).status).toBe(200);
      });
    } finally {
      verifyBlock = { environments: ["bed"] };
    }
  });

  it("an imported name the org already uses stays the org's", async () => {
    verifyBlock = { environments: ["local", "bed"] };
    try {
      await serve(async (base) => {
        const b = await overview(base);
        expect(b.envOrder).toEqual(["local", "staging", "bed"]);
        expect(b.envs.find((e) => e.env === "local")?.imported).toBeUndefined();
        expect(b.importError).toMatch(
          /"local" is one of Den's own environments: verify\.environments can't name it/,
        );
        expect((await plan(base, "local")).status).toBe(200);
      });
    } finally {
      verifyBlock = { environments: ["bed"] };
    }
  });

  it("the newest import still answers after 50 newer runs", async () => {
    for (let n = 0; n < 51; n++)
      writeRunRecord(stateDir, {
        runId: `local-${n}`,
        project: "north",
        env: "local",
        scope: "all",
        verdict: "passed",
        exitCode: 0,
        startedAt: `2026-11-20T10:${String(n).padStart(2, "0")}:00.000Z`,
        endedAt: `2026-11-20T10:${String(n).padStart(2, "0")}:30.000Z`,
        modules: [],
      } as never);
    try {
      await serve(async (base) => {
        const bed = (await overview(base)).envs.find((e) => e.env === "bed");
        expect(bed?.run?.tag).toBe("v9.9.9-dev.1");
      });
    } finally {
      for (let n = 0; n < 51; n++)
        fs.rmSync(
          path.join(stateDir, "verify", "north", "runs", `local-${n}`),
          {
            recursive: true,
            force: true,
          },
        );
    }
  });
});
