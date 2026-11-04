/**
 * Unit tests for ReleaseService — verify, live-run polling, branch listing,
 * and the wave/gate deploy machinery.
 *
 * Every gh call funnels through execFile("gh", args…), so the tests install a
 * route table keyed on the joined argv: each test declares exactly the GitHub
 * responses its scenario needs, and anything unrouted answers "" (which is
 * what ghSafe yields on a real failure — the service must treat it as
 * "unknown", never as "idle"/"fine").
 */

import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("child_process", () => ({ execFile: jest.fn() }));
jest.mock("../../../src/shared/den-config.js", () => ({
  ...jest.requireActual<object>("../../../src/shared/den-config.js"),
  readReleaseConfig: jest.fn(),
}));
// config() adds workspace repos with a manifest `release:` block; the tests
// declare those themselves instead of reading this machine's workspace.
jest.mock("../../../src/shared/manifest/workspace-manifests.js", () => ({
  listReposWithManifests: jest.fn(() => []),
}));
jest.mock("../../../src/shared/environment-manager/catalog.js", () => ({
  readCatalog: jest.fn(() => ({})),
}));

import { execFile } from "child_process";
import { listReposWithManifests } from "../../../src/shared/manifest/workspace-manifests.js";
import { readCatalog } from "../../../src/shared/environment-manager/catalog.js";
import {
  readReleaseConfig,
  resolveReleaseTarget,
  type ReleaseConfig,
} from "../../../src/shared/den-config.js";
import {
  ReleaseService,
  DEPLOYS_OFF_MESSAGE,
  type ReleaseEvent,
  type DeployPlanEntry,
} from "../../../src/ui/server/release-service.js";

const mockExecFile = execFile as unknown as jest.Mock;
const mockReadReleaseConfig = readReleaseConfig as jest.MockedFunction<
  typeof readReleaseConfig
>;

// ── gh route table ────────────────────────────────────────────────────────────

type Route = {
  match: string | RegExp;
  out?: string | ((args: string[]) => string);
  err?: string;
};
let routes: Route[] = [];

/** Respond to any gh argv whose joined form contains/matches `match`. */
const on = (match: string | RegExp, out: string | ((a: string[]) => string)) =>
  routes.push({ match, out });
/** Make matching gh argv fail (rejects gh(), yields "" from ghSafe()). */
const onErr = (match: string | RegExp, err = "gh exploded") =>
  routes.push({ match, err });

type ExecCb = (e: Error | null, v?: { stdout: string; stderr: string }) => void;

function installGhMock(): void {
  mockExecFile.mockImplementation((...callArgs: unknown[]) => {
    const args = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as ExecCb;
    const joined = args.join(" ");
    const r = routes.find((rt) =>
      typeof rt.match === "string"
        ? joined.includes(rt.match)
        : rt.match.test(joined),
    );
    if (!r) return cb(null, { stdout: "", stderr: "" });
    if (r.err) return cb(new Error(r.err));
    const out = typeof r.out === "function" ? r.out(args) : (r.out ?? "");
    return cb(null, { stdout: out, stderr: "" });
  });
}

const ghCalls = (): string[] =>
  mockExecFile.mock.calls.map((c) => (c[1] as string[]).join(" "));

// ── Config fixture ────────────────────────────────────────────────────────────

const cfg = (over: Partial<ReleaseConfig> = {}): ReleaseConfig => ({
  deploy: true,
  org: "TestOrg",
  environments: ["dev", "sandbox"],
  staggerSeconds: 0,
  pollSeconds: 0,
  repos: [{ name: "files-api", workflow: "cd.yml", wave: 0 }],
  ...over,
});

let svc: ReleaseService;

beforeEach(() => {
  routes = [];
  mockExecFile.mockReset();
  installGhMock();
  mockReadReleaseConfig.mockReset();
  mockReadReleaseConfig.mockReturnValue(cfg());
  svc = new ReleaseService();
});

// ── verifyOne fixtures ────────────────────────────────────────────────────────

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const dep = (
  id: number,
  sha: string,
  createdAt: string,
  creator: string | null = "creator-c",
) => ({
  id,
  sha,
  created_at: createdAt,
  ref: "main",
  ...(creator ? { creator: { login: creator } } : {}),
});

/** Registers the 4-call happy chain: main → deployments → status → run. */
function happyRoutes(sha = MAIN): void {
  on("branches/main", MAIN);
  on(
    "deployments?environment=dev",
    JSON.stringify([dep(1, sha, "2026-01-02T00:00:00Z")]),
  );
  on(
    "deployments/1/statuses",
    "success\thttps://github.com/TestOrg/files-api/actions/runs/999",
  );
  on("actions/runs/999", "success\tactor-a\t.github/workflows/cd.yml");
}

describe("verifyEnv — status classification (per repo)", () => {
  const row = async () => (await svc.verifyEnv("dev"))[0];

  it("errors when the main branch cannot be read", async () => {
    // No route: ghSafe returns "" for everything.
    const r = await row();
    expect(r.status).toEqual({
      kind: "error",
      text: "could not read main branch",
    });
    expect(r.mainSha).toBeNull();
    expect(r.runUrl).toBeNull();
  });

  it('errors when gh emits the literal string "null" for main', async () => {
    on("branches/main", "null");
    const r = await row();
    expect(r.status.kind).toBe("error");
  });

  it("flags a deployments API error as conflict, never as clean", async () => {
    on("branches/main", MAIN);
    onErr("deployments?environment=dev");
    const r = await row();
    expect(r.status).toEqual({
      kind: "conflict",
      text: "✗ deployments API error",
    });
    expect(r.mainSha).toBe(MAIN);
  });

  it("treats unparseable deployments JSON as no-deploy", async () => {
    on("branches/main", MAIN);
    on("deployments?environment=dev", "certainly-not-json");
    const r = await row();
    expect(r.status).toEqual({
      kind: "no-deploy",
      text: "? no successful cd.yml deployment to dev",
    });
  });

  it("skips null / id-less / run-less / non-CD deployment records", async () => {
    on("branches/main", MAIN);
    on(
      "deployments?environment=dev",
      JSON.stringify([
        null, // no object
        { sha: MAIN, created_at: "x", ref: "main" }, // no id
        dep(11, MAIN, "2026-01-05T00:00:00Z"), // status has no run url
        dep(12, MAIN, "2026-01-04T00:00:00Z"), // status row empty
        dep(13, MAIN, "2026-01-03T00:00:00Z"), // owned by a NON-CD workflow
      ]),
    );
    on("deployments/11/statuses", "success\thttps://example.com/no-run-here");
    on("deployments/12/statuses", "");
    on(
      "deployments/13/statuses",
      "success\thttps://github.com/TestOrg/files-api/actions/runs/700",
    );
    // A pulumi-preview style record: state success but owned by ci-preview.yml.
    on(
      "actions/runs/700",
      "success\tactor-a\t.github/workflows/ci-preview.yml",
    );
    const r = await row();
    expect(r.status.kind).toBe("no-deploy");
  });

  it("reports the newest CD attempt's state when none ever succeeded", async () => {
    on("branches/main", MAIN);
    on(
      "deployments?environment=dev",
      JSON.stringify([dep(1, MAIN, "2026-01-02T00:00:00Z")]),
    );
    on(
      "deployments/1/statuses",
      "failure\thttps://github.com/TestOrg/files-api/actions/runs/999",
    );
    on("actions/runs/999", "failure\tactor-a\t.github/workflows/cd.yml");
    const r = await row();
    expect(r.status).toEqual({
      kind: "no-deploy",
      text: "? last CD deploy failure (none succeeded)",
    });
  });

  it("reports up-to-date when the live CD deployment matches main", async () => {
    happyRoutes();
    const r = await row();
    expect(r.status.kind).toBe("up-to-date");
    expect(r.status.warn).toBeUndefined();
    expect(r).toMatchObject({
      repo: "files-api",
      gh: "TestOrg/files-api",
      mainShort: MAIN.slice(0, 7),
      deployedShort: MAIN.slice(0, 7),
      branch: "main",
      deployedAt: "2026-01-02T00:00:00Z",
      runId: "999",
      runUrl: "https://github.com/TestOrg/files-api/actions/runs/999",
      deployer: "actor-a",
    });
  });

  it("hard-conflicts when the 'successful' deployment belongs to a failed run", async () => {
    // A late-failing CD run leaves a stale success deployment record behind —
    // trusting it would report a rollout that never happened.
    on("branches/main", MAIN);
    on(
      "deployments?environment=dev",
      JSON.stringify([dep(1, OTHER, "2026-01-02T00:00:00Z")]),
    );
    on(
      "deployments/1/statuses",
      "success\thttps://github.com/TestOrg/files-api/actions/runs/999",
    );
    on("actions/runs/999", "failure\t\t.github/workflows/cd.yml");
    const r = await row();
    expect(r.status).toEqual({
      kind: "conflict",
      text: "✗ deploy run failure — NOT rolled out",
    });
    // Actor was empty → falls back to the deployment creator.
    expect(r.deployer).toBe("creator-c");
  });

  it("accepts an inactive (superseded) deployment and classifies behind-main", async () => {
    on("branches/main", MAIN);
    on(
      "deployments?environment=dev",
      JSON.stringify([dep(1, OTHER, "2026-01-02T00:00:00Z", null)]),
    );
    on(
      "deployments/1/statuses",
      "inactive\thttps://github.com/TestOrg/files-api/actions/runs/999",
    );
    on("actions/runs/999", "success\t\t.github/workflows/cd.yml");
    on(
      `compare/${OTHER}...main`,
      JSON.stringify({ status: "ahead", ahead_by: 3 }),
    );
    const r = await row();
    expect(r.status).toMatchObject({
      kind: "behind",
      text: "✗ behind main by 3 commit(s)",
      aheadBy: 3,
    });
    // No actor and no creator on the deployment → deployer unknown.
    expect(r.deployer).toBeNull();
  });

  it("classifies diverged as off-main with both counts", async () => {
    happyRoutes(OTHER);
    on(
      `compare/${OTHER}...main`,
      JSON.stringify({ status: "diverged", ahead_by: 2, behind_by: 1 }),
    );
    const r = await row();
    expect(r.status).toMatchObject({
      kind: "off-main",
      text: "⚠ off-main (main +2/-1)",
      aheadBy: 2,
      behindBy: 1,
    });
  });

  it("classifies deployed-ahead-of-main", async () => {
    happyRoutes(OTHER);
    on(
      `compare/${OTHER}...main`,
      JSON.stringify({ status: "behind", behind_by: 2 }),
    );
    const r = await row();
    expect(r.status).toMatchObject({
      kind: "ahead",
      text: "⚠ ahead of main by 2 commit(s)",
      behindBy: 2,
    });
  });

  it("reports drift when the compare API errors, returns junk, or a weird status", async () => {
    happyRoutes(OTHER);
    onErr(`compare/${OTHER}...main`);
    expect((await row()).status.text).toBe("✗ drift (compare API error)");

    routes = routes.filter(
      (r) => !(r.err && String(r.match).includes("compare")),
    );
    on(`compare/${OTHER}...main`, "not-json");
    expect((await svc.verifyEnv("dev", true))[0].status.text).toBe(
      "✗ drift (status=?)",
    );

    routes = routes.filter((r) => !String(r.match).includes("compare"));
    on(`compare/${OTHER}...main`, JSON.stringify({ status: "weird" }));
    expect((await svc.verifyEnv("dev", true))[0].status.text).toBe(
      "✗ drift (status=weird)",
    );
  });

  it("warns when a newer CD attempt is failing on top of the live deploy", async () => {
    on("branches/main", MAIN);
    on(
      "deployments?environment=dev",
      JSON.stringify([
        dep(2, OTHER, "2026-01-03T00:00:00Z"), // newest CD attempt: failing
        dep(1, MAIN, "2026-01-02T00:00:00Z"), // live deploy: success, == main
      ]),
    );
    on(
      "deployments/2/statuses",
      "failure\thttps://github.com/TestOrg/files-api/actions/runs/1000",
    );
    on("actions/runs/1000", "failure\tactor-b\t.github/workflows/cd.yml");
    on(
      "deployments/1/statuses",
      "success\thttps://github.com/TestOrg/files-api/actions/runs/999",
    );
    on("actions/runs/999", "success\tactor-a\t.github/workflows/cd.yml");
    const r = await row();
    expect(r.status.kind).toBe("up-to-date");
    expect(r.status.warn).toBe("⚠ newer deploy failure @ 2026-01-03T00:00:00Z");
  });
});

describe("verifyEnv — caching", () => {
  it("serves a fresh cache without re-hitting gh; forceRefresh bypasses", async () => {
    happyRoutes();
    await svc.verifyEnv("dev");
    const afterFirst = mockExecFile.mock.calls.length;
    const again = await svc.verifyEnv("dev");
    expect(mockExecFile.mock.calls.length).toBe(afterFirst); // pure cache hit
    expect(again[0].status.kind).toBe("up-to-date");

    await svc.verifyEnv("dev", true);
    expect(mockExecFile.mock.calls.length).toBe(afterFirst * 2);
  });

  it("invalidate(env) evicts one env; invalidate() evicts all", async () => {
    happyRoutes();
    await svc.verifyEnv("dev");
    const afterFirst = mockExecFile.mock.calls.length;

    svc.invalidate("sandbox"); // different env — dev cache untouched
    await svc.verifyEnv("dev");
    expect(mockExecFile.mock.calls.length).toBe(afterFirst);

    svc.invalidate("dev");
    await svc.verifyEnv("dev");
    expect(mockExecFile.mock.calls.length).toBe(afterFirst * 2);

    svc.invalidate();
    await svc.verifyEnv("dev");
    expect(mockExecFile.mock.calls.length).toBe(afterFirst * 3);
  });
});

// ── listRepoRuns ──────────────────────────────────────────────────────────────

const runJson = (
  id: string,
  status: string,
  conclusion: string | null,
  title: string,
) => ({
  id,
  url: `https://github.com/TestOrg/x/actions/runs/${id}`,
  status,
  conclusion,
  title,
  event: "workflow_dispatch",
  createdAt: "2026-01-01T00:00:00Z",
});

describe("listRepoRuns — live CD state for the Release page poll", () => {
  it("splits newest unfinished vs newest finished, with env hints from titles", async () => {
    on(
      "actions/workflows/cd.yml/runs",
      JSON.stringify([
        runJson("3", "in_progress", null, "[wf-dispatch] main → sandbox"),
        runJson("2", "completed", "failure", "CD"),
        runJson("1", "completed", "success", "CD"),
      ]),
    );
    const [state] = await svc.listRepoRuns();
    expect(state.repo).toBe("files-api");
    expect(state.running).toMatchObject({ id: "3", envHint: "sandbox" });
    // Newest FINISHED run (not the newest overall, not the oldest).
    expect(state.last).toMatchObject({
      id: "2",
      conclusion: "failure",
      envHint: null,
    });
  });

  it("skips repos disabled in config", async () => {
    mockReadReleaseConfig.mockReturnValue(
      cfg({
        repos: [
          { name: "files-api", workflow: "cd.yml", wave: 0 },
          { name: "muted", workflow: "cd.yml", wave: 0, enabled: false },
        ],
      }),
    );
    const rows = await svc.listRepoRuns();
    expect(rows.map((r) => r.repo)).toEqual(["files-api"]);
    expect(ghCalls().some((c) => c.includes("repos/TestOrg/muted/"))).toBe(
      false,
    );
  });

  it("treats gh failure / junk / non-array JSON as unknown, not idle", async () => {
    onErr("repos/TestOrg/broken/");
    on("repos/TestOrg/junk/", "not-json");
    on("repos/TestOrg/object/", JSON.stringify({ nope: true }));
    mockReadReleaseConfig.mockReturnValue(
      cfg({
        repos: [
          { name: "broken", workflow: "cd.yml", wave: 0 },
          { name: "junk", workflow: "cd.yml", wave: 0 },
          { name: "object", workflow: "cd.yml", wave: 0 },
        ],
      }),
    );
    const rows = await svc.listRepoRuns();
    for (const r of rows) {
      expect(r.running).toBeNull();
      expect(r.last).toBeNull();
    }
  });

  it("caches for the TTL and shares one in-flight fetch across callers", async () => {
    on("actions/workflows/cd.yml/runs", "[]");
    const [a, b] = await Promise.all([svc.listRepoRuns(), svc.listRepoRuns()]);
    expect(b).toBe(a); // concurrent callers share the single fetch
    expect(mockExecFile.mock.calls.length).toBe(1);

    await svc.listRepoRuns(); // within TTL → cache
    expect(mockExecFile.mock.calls.length).toBe(1);

    await svc.listRepoRuns(true); // forceRefresh → refetch
    expect(mockExecFile.mock.calls.length).toBe(2);
  });
});

// ── listBranches ──────────────────────────────────────────────────────────────

describe("listBranches", () => {
  it("returns [] when gh fails", async () => {
    onErr("branches?per_page");
    expect(await svc.listBranches("files-api")).toEqual([]);
  });

  it("merges paginated lines, drops junk lines, and puts main first", async () => {
    on("branches?per_page", '["zeta","main"]\nnot-json\n["alpha"]');
    expect(await svc.listBranches("files-api")).toEqual([
      "main",
      "alpha",
      "zeta",
    ]);
  });

  it("sorts plainly when main is absent (and tolerates a missing org)", async () => {
    mockReadReleaseConfig.mockReturnValue(cfg({ org: undefined }));
    on("branches?per_page", '["z","a"]');
    expect(await svc.listBranches("files-api")).toEqual(["a", "z"]);
    // org ?? "" → slug degrades to "/repo" rather than "undefined/repo".
    expect(ghCalls()[0]).toContain("repos//files-api/branches");
  });
});

// ── deploy ────────────────────────────────────────────────────────────────────

const entry = (repo: string, wave: number): DeployPlanEntry => ({
  repo,
  workflow: "cd.yml",
  ref: "main",
  wave,
});

/** Routes for one repo's full dispatch→resolve→monitor chain. */
function deployRoutes(
  repo: string,
  runId: string,
  view:
    | string
    | ((a: string[]) => string) = `completed\tsuccess\thttps://u/${runId}`,
): void {
  on(`workflow run cd.yml --repo TestOrg/${repo}`, "");
  on(`run list --repo TestOrg/${repo}`, runId);
  on(`run view ${runId} --repo TestOrg/${repo}`, view);
}

describe("deploy — release.deploy off", () => {
  it("refuses without calling gh", async () => {
    mockReadReleaseConfig.mockReturnValue(cfg({ deploy: false }));
    const events: ReleaseEvent[] = [];
    const ok = await svc.deploy(
      "dev",
      [{ repo: "files-api", workflow: "cd.yml", wave: 0, ref: "main" }],
      (ev) => events.push(ev),
      () => false,
    );
    expect(ok).toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(events).toEqual([
      { type: "done", ok: false, summary: DEPLOYS_OFF_MESSAGE },
    ]);
  });
});

describe("deploy — waves, gates, aborts", () => {
  let events: ReleaseEvent[];
  const emit = (ev: ReleaseEvent) => events.push(ev);
  const texts = () =>
    events
      .filter((e) => e.type === "log")
      .map((e) => (e as { text: string }).text);
  const doneEv = () =>
    events.find((e) => e.type === "done") as
      | { ok: boolean; summary: string }
      | undefined;
  const phases = () =>
    events
      .filter((e) => e.type === "phase")
      .map((e) => (e as { name: string }).name);

  beforeEach(() => {
    events = [];
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const runDeploy = async (
    plan: DeployPlanEntry[],
    aborted: () => boolean = () => false,
  ): Promise<boolean> => {
    const p = svc.deploy("dev", plan, emit, aborted);
    await jest.runAllTimersAsync(); // drains the dispatch-settle delays
    return p;
  };

  it("dispatches wave-by-wave, gates on success, reports all-green", async () => {
    deployRoutes("files-api", "111");
    deployRoutes("shop", "222");
    const ok = await runDeploy([entry("files-api", 0), entry("shop", 1)]);
    expect(ok).toBe(true);
    expect(doneEv()).toEqual({
      type: "done",
      ok: true,
      summary: "All 2 deployment(s) succeeded.",
    });
    expect(phases()).toEqual([
      "Wave 0 — dispatch (files-api)",
      "Wave 0 — gate (waiting for success before next wave)",
      "Wave 1 — dispatch (shop)",
      "Wave 1 — monitor",
    ]);
    // Wave 1 dispatches only after wave 0's gate.
    const calls = ghCalls();
    expect(calls.findIndex((c) => c.includes("run view 111"))).toBeLessThan(
      calls.findIndex((c) =>
        c.includes("workflow run cd.yml --repo TestOrg/shop"),
      ),
    );
  });

  it("dispatches a target's own inputs instead of environment=<env>", async () => {
    deployRoutes("files-api", "111");
    deployRoutes("shop", "222");
    const ok = await runDeploy([
      { ...entry("files-api", 0), inputs: {} },
      { ...entry("shop", 0), inputs: { stage: "cell-dev" } },
    ]);
    expect(ok).toBe(true);
    const run = (repo: string) =>
      ghCalls().find((c) =>
        c.includes(`workflow run cd.yml --repo TestOrg/${repo}`),
      );
    expect(run("files-api")).not.toContain("-f");
    expect(run("shop")).toContain("-f stage=cell-dev");
    expect(run("shop")).not.toContain("environment=");
  });

  it("staggers between entries of the same wave", async () => {
    deployRoutes("files-api", "111");
    deployRoutes("shop", "222");
    const ok = await runDeploy([entry("files-api", 0), entry("shop", 0)]);
    expect(ok).toBe(true);
    expect(
      texts().filter((t) => t.includes("waiting 0s before next dispatch")),
    ).toHaveLength(1); // between the two, not after the last
  });

  it("aborts the whole deploy when a dispatch fails", async () => {
    onErr("workflow run cd.yml --repo TestOrg/files-api", "boom");
    const ok = await runDeploy([entry("files-api", 0), entry("shop", 1)]);
    expect(ok).toBe(false);
    expect(doneEv()?.summary).toBe("Dispatch failed for files-api; aborting.");
    expect(
      texts().some((t) => t.includes("failed to dispatch files-api")),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.type === "run" && e.conclusion === "dispatch-failed",
      ),
    ).toBe(true);
    // shop never dispatched.
    expect(ghCalls().some((c) => c.includes("--repo TestOrg/shop"))).toBe(
      false,
    );
  });

  it("treats an unresolvable run id as a failure it cannot confirm", async () => {
    on("workflow run cd.yml --repo TestOrg/files-api", "");
    on("run list --repo TestOrg/files-api", "null");
    const ok = await runDeploy([entry("files-api", 0)]);
    expect(ok).toBe(false);
    expect(texts().some((t) => t.includes("could not resolve run id"))).toBe(
      true,
    );
    expect(doneEv()?.summary).toBe(
      "1 deployment(s) did not succeed: files-api.",
    );
  });

  it("cancels later waves when a gated wave fails", async () => {
    deployRoutes("files-api", "111", "completed\tfailure\thttps://u/111");
    deployRoutes("shop", "222");
    const ok = await runDeploy([entry("files-api", 0), entry("shop", 1)]);
    expect(ok).toBe(false);
    expect(doneEv()?.summary).toBe(
      "Wave 0 failed (files-api); later waves cancelled.",
    );
    expect(texts().some((t) => t.includes("[gate] wave 0 failed"))).toBe(true);
    expect(ghCalls().some((c) => c.includes("--repo TestOrg/shop"))).toBe(
      false,
    );
  });

  it("keeps polling until runs reach a terminal state", async () => {
    mockReadReleaseConfig.mockReturnValue(cfg({ pollSeconds: 0.002 }));
    let polls = 0;
    deployRoutes("files-api", "111", () =>
      ++polls < 2
        ? "in_progress\t\thttps://u/111"
        : "completed\tsuccess\thttps://u/111",
    );
    const ok = await runDeploy([entry("files-api", 0)]);
    expect(ok).toBe(true);
    expect(polls).toBe(2);
    const statuses = events
      .filter((e) => e.type === "run" && e.runId === "111")
      .map((e) => (e as { status: string }).status);
    expect(statuses).toEqual(["queued", "in_progress", "completed"]);
  });

  it("does nothing when aborted before the first dispatch", async () => {
    const ok = await runDeploy([entry("files-api", 0)], () => true);
    expect(ok).toBe(false);
    expect(doneEv()?.summary).toBe("Aborted.");
    expect(mockExecFile.mock.calls.length).toBe(0);
  });

  it("stops before monitoring when aborted during dispatch", async () => {
    let flag = false;
    on("workflow run cd.yml --repo TestOrg/files-api", "");
    on("run list --repo TestOrg/files-api", () => {
      flag = true; // user hits abort while the dispatch settles
      return "111";
    });
    const ok = await runDeploy([entry("files-api", 0)], () => flag);
    expect(ok).toBe(false);
    expect(doneEv()?.summary).toBe("Aborted.");
    // Monitoring never polled the run.
    expect(ghCalls().some((c) => c.includes("run view"))).toBe(false);
  });

  it("stops mid-wave when aborted between staggered dispatches", async () => {
    mockReadReleaseConfig.mockReturnValue(cfg({ staggerSeconds: 0.002 }));
    let flag = false;
    on("workflow run cd.yml --repo TestOrg/files-api", "");
    on("run list --repo TestOrg/files-api", () => {
      flag = true;
      return "111";
    });
    deployRoutes("shop", "222");
    const ok = await runDeploy(
      [entry("files-api", 0), entry("shop", 0)],
      () => flag,
    );
    expect(ok).toBe(false);
    expect(doneEv()?.summary).toBe("Aborted.");
    expect(
      ghCalls().some((c) =>
        c.includes("workflow run cd.yml --repo TestOrg/shop"),
      ),
    ).toBe(false);
  });
});

// ── Per-environment targets ───────────────────────────────────────────────────

describe("per-environment release targets", () => {
  const smb = cfg({
    environments: ["dev", "staging"],
    profiles: {
      cdk: {
        dev: {
          environment: "dev-cdk-deploy",
          workflow: "deploy-dev.yml",
          branch: "dev",
        },
      },
      cells: {
        staging: {
          environment: ["a-staging-deploy", "b-staging-deploy"],
          workflow: "deploy-aws.yml",
        },
      },
    },
    repos: [
      {
        name: "core",
        workflow: "deploy-dev.yml",
        wave: 0,
        profile: "cdk",
        targets: {
          dev: { workflow: ["deploy-dev.yml", "deploy-dev-base.yml"] },
        },
      },
    ],
  });

  it("defaults to the env name, the repo workflow and main, dispatching environment=<env>", () => {
    expect(
      resolveReleaseTarget(
        { name: "x", workflow: "cd.yml", wave: 0 },
        "dev",
        {},
      ),
    ).toEqual({
      environments: ["dev"],
      workflows: ["cd.yml"],
      branch: "main",
      inputs: { environment: "dev" },
    });
  });

  it("merges the repo's target over its profile, with no default inputs", () => {
    expect(resolveReleaseTarget(smb.repos[0], "dev", smb)).toEqual({
      environments: ["dev-cdk-deploy"],
      workflows: ["deploy-dev.yml", "deploy-dev-base.yml"],
      branch: "dev",
      inputs: {},
    });
  });

  it("checks the mapped GitHub environment, any listed workflow, and the env's branch", async () => {
    mockReadReleaseConfig.mockReturnValue(smb);
    on("branches/dev", MAIN);
    on(
      "deployments?environment=dev-cdk-deploy",
      JSON.stringify([dep(1, OTHER, "2026-01-02T00:00:00Z")]),
    );
    on(
      "deployments/1/statuses",
      "success\thttps://github.com/TestOrg/core/actions/runs/5",
    );
    on(
      "actions/runs/5",
      "success\tactor-a\t.github/workflows/deploy-dev-base.yml",
    );
    on(
      `compare/${OTHER}...dev`,
      JSON.stringify({ status: "ahead", ahead_by: 3 }),
    );
    const [r] = await svc.verifyEnv("dev");
    expect(r).toEqual(
      expect.objectContaining({
        environment: "dev-cdk-deploy",
        sourceBranch: "dev",
        workflow: "deploy-dev-base.yml",
        deployedSha: OTHER,
        status: expect.objectContaining({
          kind: "behind",
          text: "✗ behind dev by 3 commit(s)",
        }),
      }),
    );
    expect(ghCalls().some((c) => c.includes("branches/main"))).toBe(false);
  });

  it("gives one row per GitHub environment when an env maps onto several", async () => {
    mockReadReleaseConfig.mockReturnValue({
      ...smb,
      repos: [
        { name: "web", workflow: "deploy-aws.yml", wave: 0, profile: "cells" },
      ],
    });
    const rows = await svc.verifyEnv("staging");
    expect(rows.map((r) => r.environment)).toEqual([
      "a-staging-deploy",
      "b-staging-deploy",
    ]);
  });
});

// ── Manifest release sources (version endpoint, workflow run, none) ─────────

describe("verifyEnv — manifest release sources", () => {
  const mockRepos = listReposWithManifests as jest.MockedFunction<
    typeof listReposWithManifests
  >;
  const mockCatalog = readCatalog as jest.MockedFunction<typeof readCatalog>;
  const realFetch = global.fetch;

  const manifestRepo = (release: object) => {
    mockReadReleaseConfig.mockReturnValue(
      cfg({ repos: [], environments: ["beta", "prod"] }),
    );
    mockCatalog.mockReturnValue({ shop: { gh: "OtherOrg/shop" } });
    mockRepos.mockReturnValue([
      {
        repo: "shop",
        repoPath: "/x/shop",
        org: "OtherOrg",
        manifest: { name: "shop", release } as never,
      },
    ]);
  };
  const fetchReturns = (status: number, body: unknown) => {
    global.fetch = jest.fn(async () => ({
      status,
      json: async () => body,
    })) as unknown as typeof fetch;
  };

  afterEach(() => {
    global.fetch = realFetch;
    mockRepos.mockReturnValue([]);
  });

  it("joins manifest repos under their own org", () => {
    manifestRepo({ workflow: "deploy.yml", environments: { beta: {} } });
    expect(svc.config().repos.map((r) => r.name)).toEqual(["shop"]);
    expect(svc.slug("shop")).toBe("OtherOrg/shop");
  });

  it("reads the deployed commit from a version endpoint", async () => {
    manifestRepo({
      workflow: "deploy.yml",
      environments: {
        beta: { version: "https://beta.shop.test/v", field: "build" },
      },
    });
    fetchReturns(200, { build: OTHER });
    on("repos/OtherOrg/shop/branches/main", MAIN);
    on(
      "compare/" + OTHER + "...main",
      JSON.stringify({ status: "ahead", ahead_by: 3 }),
    );
    const [r] = await svc.verifyEnv("beta");
    expect(r.source).toBe("version endpoint");
    expect(r.deployedSha).toBe(OTHER);
    expect(r.status.kind).toBe("behind");
    // No GitHub deployments were read for a version-sourced env.
    expect(ghCalls().some((c) => c.includes("deployments"))).toBe(false);
  });

  it("does not take a semver for a commit", async () => {
    manifestRepo({
      environments: { beta: { version: "https://beta.shop.test/v" } },
    });
    fetchReturns(200, { build: "1.8.3" });
    on("branches/main", MAIN);
    const [r] = await svc.verifyEnv("beta");
    expect(r.status.text).toMatch(/no commit SHA at "build"/);
    expect(r.deployedSha).toBeNull();
  });

  it("falls back to the newest successful workflow run on main", async () => {
    manifestRepo({ workflow: "deploy-beta.yml", environments: { beta: {} } });
    on("branches/main", MAIN);
    on(
      "workflows/deploy-beta.yml/runs?branch=main&status=success",
      `${MAIN}\t2026-11-01T00:00:00Z\t42\tsam`,
    );
    const [r] = await svc.verifyEnv("beta");
    expect(r.source).toBe("workflow run");
    expect(r.status.kind).toBe("up-to-date");
    expect(r.runUrl).toBe("https://github.com/OtherOrg/shop/actions/runs/42");
  });

  it("says when the manifest names no source for the env", async () => {
    manifestRepo({ workflow: "release.yml", environments: {} });
    on("branches/main", MAIN);
    const [r] = await svc.verifyEnv("prod");
    expect(r.status).toEqual({
      kind: "no-deploy",
      text: "? no release source for prod in .den.yml",
    });
  });
});
