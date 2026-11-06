/**
 * A deterministic guard for event-loop stalls: wall-clock tests pass on a
 * quiet machine while the same code stalls for seconds on a loaded one. So
 * count instead of time. The server runs with a preload (helpers/
 * sync-spy.mjs) that records every synchronous fs and child_process call a
 * request makes, through its whole async continuation. After a warm-up
 * request, a second request to each hot route must make:
 *
 * - no synchronous spawn (spawnSync / execSync / execFileSync), and
 * - no synchronous directory walk (readdirSync / opendirSync),
 *
 * and any other sync call must be on the allowlist below: single reads of
 * bounded config files.
 *
 * The fixture is shaped like a distribution whose repos use held manifests
 * (no manifest file in the repo itself), checked out under repos_root with
 * source trees of their own.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  gitRepo,
  startSlowGitServer,
  write,
  type SlowGitServer,
} from "./helpers/slow-git-server.js";

const REPOS = ["alpha", "beta", "gamma", "delta"];
let tmp = "";
let srv: SlowGitServer;

interface SyncCall {
  fn: string;
  arg: string;
  caller: string;
}

/**
 * Sync calls a request may still make: each reads one small config file,
 * once or twice per request, and none walks a directory or spawns.
 */
const ALLOWED: { fn: string; caller: RegExp; why: string }[] = [
  {
    fn: "readFileSync",
    caller: /^readDenConfig |^readUserConfig /,
    why: "config/<product>.yml and config/local/user.yml",
  },
  {
    fn: "statSync",
    caller: /^assertDenConfigValid /,
    why: "config/<product>.yml, one stat: its validation is memoised on mtime and size",
  },
  {
    fn: "readFileSync",
    caller: /^assertDenConfigValid /,
    why: "config/<product>.yml, only when it changed since the last request",
  },
  {
    fn: "readFileSync",
    caller: /^readWorkspacesFile /,
    why: "config/local/workspaces.yml (written by this server; never cached)",
  },
  {
    fn: "readFileSync",
    caller: /^readCatalog /,
    why: "config/local/service-catalog.yml",
  },
  {
    fn: "existsSync",
    caller: /^readDaemonsFile /,
    why: "the daemon registry file, one check",
  },
  {
    fn: "readFileSync",
    caller: /^readDaemonsFile /,
    why: "the daemon registry file",
  },
];

const SPAWNS = new Set(["spawnSync", "execSync", "execFileSync"]);
const WALKS = new Set(["readdirSync", "opendirSync"]);

/** The sync calls the second of two requests to `route` makes. */
async function syncCallsOf(route: string): Promise<SyncCall[]> {
  await srv.timed(route); // warm-up: first-request caches are fine
  await srv.timed("/__sync-spy"); // clear
  const r = await srv.timed(route, { "x-sync-spy": "1" });
  expect(r.status).toBe(200);
  return JSON.parse((await srv.timed("/__sync-spy")).body) as SyncCall[];
}

function summary(calls: SyncCall[]): string[] {
  const by = new Map<string, number>();
  for (const c of calls) {
    const k = `${c.fn} <- ${c.caller}`;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by].map(([k, n]) => `${n}× ${k}`);
}

function expectNoStallingCalls(calls: SyncCall[]): void {
  expect(summary(calls.filter((c) => SPAWNS.has(c.fn)))).toEqual([]);
  expect(summary(calls.filter((c) => WALKS.has(c.fn)))).toEqual([]);
  const unexpected = calls.filter(
    (c) => !ALLOWED.some((a) => a.fn === c.fn && a.caller.test(c.caller)),
  );
  expect(summary(unexpected)).toEqual([]);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-sync-spy-"));
  const root = path.join(tmp, "dist");
  const repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    `environments: [local]\nrepos_root: ${repos}\n`,
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    REPOS.map((n) => `${n}:\n  gh: acme/acme-${n}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...REPOS.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  for (const n of REPOS) {
    const dir = path.join(repos, n);
    gitRepo(dir, `git@github.com:acme/acme-${n}.git`);
    // A source tree: what a walk that descends into repos would read.
    for (const sub of ["src/app/lib", "src/app/web", "docs/guide/a"])
      write(path.join(dir, sub, "index.ts"), "export {};\n");
    // Held manifest, keyed by the origin repo name.
    write(
      path.join(root, "manifests", `acme-${n}.den.yml`),
      `name: ${n}\nservices:\n  ${n}:\n    commands:\n      local:\n        up: "true"\n`,
    );
  }

  srv = await startSlowGitServer({
    tmp,
    root,
    slow: [],
    delayS: 0,
    preload: [path.join(__dirname, "helpers", "sync-spy.mjs")],
  });
}, 40_000);

afterAll(async () => {
  await srv?.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("no sync spawns or directory walks on the request path", () => {
  it("GET /api/workspaces/available-repos?refresh=1", async () => {
    expectNoStallingCalls(
      await syncCallsOf("/api/workspaces/available-repos?refresh=1"),
    );
  }, 30_000);

  it("GET /api/health/stream (one full cycle)", async () => {
    expectNoStallingCalls(
      await syncCallsOf("/api/health/stream?env=local&refresh=1"),
    );
  }, 30_000);

  it("the spy sees sync calls at all (control)", async () => {
    // /api/server-info scans Den's sources for staleness on a cold cache:
    // a sync directory walk the spy must catch, or the guard proves nothing.
    await new Promise((r) => setTimeout(r, 2_100)); // past its 2s cache
    await srv.timed("/__sync-spy");
    await srv.timed("/api/server-info", { "x-sync-spy": "1" });
    const calls = JSON.parse(
      (await srv.timed("/__sync-spy")).body,
    ) as SyncCall[];
    expect(calls.some((c) => c.fn === "readdirSync")).toBe(true);
  }, 30_000);
});
