/**
 * Release service — deploy + verify for the web Release tab.
 *
 * A faithful TypeScript port of infra-scripts/release-all.sh, made self-contained
 * (den talks to `gh` directly, exactly like github-service.ts) and structured
 * so the web UI can render a sortable table and stream a live deploy.
 *
 * Two capabilities:
 *   - verifyEnv(env): read-only. For each configured repo, compare latest `main`
 *     against the currently-deployed commit for the env (via the GitHub
 *     Deployments API), including the deploy-run cross-check that the script
 *     relies on (see verifyOne). Returns structured rows.
 *   - deploy(plan): dispatch CD workflows wave-by-wave with a stagger, gate each
 *     wave on the previous concluding success, and monitor until terminal —
 *     streaming progress events to a callback (the SSE route forwards them).
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { GH_API_TIMEOUT_MS } from "../../shared/constants.js";
import {
  readDenConfig,
  readExplicitReleaseOrg,
  readReleaseConfig,
  releaseOwnerFor,
  type ReleaseConfig,
  type ReleaseRepo,
  type ResolvedReleaseTarget,
  resolveReleaseTarget,
} from "../../shared/den-config.js";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
import { orgOf } from "../../shared/manifest/service-links.js";
import {
  ghOwnerOf,
  isSourcedOrg,
  orgHasGithub,
} from "../../shared/org-sources.js";
import { listReposWithManifests } from "../../shared/manifest/workspace-manifests.js";

import { product } from "../../shared/product.js";
const execFileAsync = promisify(execFile);

const GH_MAX_BUFFER = 16 * 1024 * 1024;
/** Verify results are cached briefly so a page reload / sort doesn't re-hit gh. */
const VERIFY_CACHE_TTL_MS = 45_000;
/**
 * Live-run polling is deliberately short-lived — the Release page polls it to
 * keep "is this system deploying right now" fresh — but still cached so several
 * open tabs cost one round of gh calls rather than one each.
 */
const RUNS_CACHE_TTL_MS = 10_000;
/** GitHub needs a moment to register a workflow_dispatch before it's listable. */
const DISPATCH_SETTLE_MS = 5_000;

// ── Structured result types (consumed by the Release table + SSE stream) ──────

export type ReleaseStatusKind =
  | "up-to-date"
  | "behind"
  | "off-main"
  | "ahead"
  | "no-deploy"
  | "conflict"
  | "error";

export interface ReleaseStatus {
  kind: ReleaseStatusKind;
  /** Human text mirroring the script's STATUS column (with glyph). */
  text: string;
  aheadBy?: number;
  behindBy?: number;
  /** Soft "a newer deploy is failing/in-flight on top of the live one" note. */
  warn?: string;
}

export interface ReleaseRow {
  repo: string;
  gh: string; // "org/repo"
  wave: number;
  workflow: string;
  /** GitHub Environment checked (differs from the den env when mapped). */
  environment: string;
  /** Branch this env ships from; `mainSha` is its head. */
  sourceBranch: string;
  mainSha: string | null;
  mainShort: string | null;
  deployedSha: string | null;
  deployedShort: string | null;
  /** Deployed ref (branch or tag). */
  branch: string | null;
  /** ISO timestamp of the live deployment. */
  deployedAt: string | null;
  runId: string | null;
  runUrl: string | null;
  /** Where the deployed commit was read: version endpoint, GitHub deployment, workflow run. */
  source?: string;
  /**
   * GitHub login of whoever triggered the deploy — the CD run's
   * `triggering_actor` (falls back to the run `actor`, then the deployment's
   * `creator`). null when no run/creator can be resolved.
   */
  deployer: string | null;
  status: ReleaseStatus;
}

/** One repo to deploy, as resolved by the route from config + request. */
/** One CD workflow run, flattened to what the Release table needs. */
export interface CdRun {
  id: string;
  url: string;
  /** queued | in_progress | completed | … (GitHub's run status) */
  status: string;
  conclusion: string | null;
  title: string;
  event: string;
  createdAt: string;
  /**
   * Target environment, when it can be determined — else null.
   *
   * GitHub exposes NO environment on a run: not on the run object, not on the
   * jobs API, and `workflow_dispatch` inputs are not returned. The only signal
   * is the run's display title, which comes from the workflow's `run-name:`.
   * Repos that set one emit "… → sandbox" (control-plane, shop-web); the rest
   * show a commit subject or just "CD", and yield null here.
   *
   * Adding a `run-name:` carrying the environment to the remaining repos' cd.yml
   * would make this exact everywhere — and makes the Actions list readable as a
   * side effect.
   */
  envHint: string | null;
}

/**
 * Live CD state for one repo.
 *
 * NOTE: this is intentionally NOT filtered by environment. A run object does not
 * carry the environment it targets — `workflow_dispatch` inputs are not exposed
 * on the run, and only some repos encode it in `run-name` (control-plane emits
 * "[wf-dispatch] main → sandbox"; files-api shows the commit subject and
 * billing-api just "CD"). Guessing from the title would be wrong for most
 * repos, so a run in flight blocks redeploying that repo regardless of target:
 * dispatching a second CD run over a live one is unsafe either way, since they
 * share the repo and usually the same concurrency group.
 */
export interface RepoRunState {
  repo: string;
  /** Newest run that has not finished, if any. */
  running: CdRun | null;
  /** Newest finished run — used to retire a stale failure pill. */
  last: CdRun | null;
}

export interface DeployPlanEntry {
  repo: string;
  workflow: string;
  ref: string;
  wave: number;
  /** workflow_dispatch inputs; unset means `environment=<env>`. */
  inputs?: Record<string, string>;
}

export type ReleaseEvent =
  | { type: "log"; text: string; level?: "info" | "warn" | "error" }
  | { type: "phase"; name: string }
  | {
      type: "run";
      repo: string;
      runId: string | null;
      url: string | null;
      status: string; // queued | in_progress | completed | dispatching | skipped
      conclusion: string | null;
    }
  | { type: "done"; ok: boolean; summary: string };

type Emit = (ev: ReleaseEvent) => void;

// ── gh helpers (async so per-repo verify fans out in parallel) ────────────────

async function gh(
  args: string[],
  timeout = GH_API_TIMEOUT_MS,
): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    encoding: "utf-8",
    timeout,
    maxBuffer: GH_MAX_BUFFER,
  });
  return stdout.trim();
}

/** Like gh() but returns "" instead of throwing — for best-effort reads. */
async function ghSafe(
  args: string[],
  timeout = GH_API_TIMEOUT_MS,
): Promise<string> {
  try {
    return await gh(args, timeout);
  } catch {
    return "";
  }
}

/**
 * Best-effort environment for a run, from its display title.
 *
 * Repos that set a `run-name:` end it with the target, e.g.
 * "[wf-dispatch] main → sandbox" or "[main-merge] main → staging". Only a name
 * that matches a CONFIGURED environment is accepted, so a branch or commit
 * subject containing an arrow can't be mistaken for one. Returns null when the
 * title carries no usable environment, which the caller must treat as "unknown"
 * rather than "not this env".
 */
export function envFromTitle(
  title: string | null | undefined,
  environments: string[],
): string | null {
  const m = /→\s*([A-Za-z0-9_-]+)\s*$/.exec(title ?? "");
  if (!m) return null;
  const candidate = m[1].toLowerCase();
  return environments.some((e) => e.toLowerCase() === candidate)
    ? candidate
    : null;
}

const short = (sha: string | null): string | null =>
  sha ? sha.slice(0, 7) : null;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sleep in small slices so an aborted stream stops promptly mid-stagger/poll. */
async function abortableDelay(
  ms: number,
  aborted: () => boolean,
): Promise<void> {
  const step = 500;
  let waited = 0;
  while (waited < ms && !aborted()) {
    await delay(Math.min(step, ms - waited));
    waited += step;
  }
}

/** Why a deploy was refused when `release.deploy` is off. */
export const DEPLOYS_OFF_MESSAGE = `Deploys are off: the Release page is read-only. Set release.deploy: true in ${product().configFile} to enable them.`;

export class ReleaseService {
  private verifyCache = new Map<
    string,
    { rows: ReleaseRow[]; fetchedAt: number }
  >();

  private runsCache: { rows: RepoRunState[]; fetchedAt: number } | null = null;
  private runsInFlight: Promise<RepoRunState[]> | null = null;

  /**
   * The effective release config: config/den.yml + user.yml, plus every
   * workspace repo whose manifest has a `release:` block. Re-read each call
   * so edits apply.
   */
  config(): ReleaseConfig {
    const cfg = readReleaseConfig();
    const known = new Set(cfg.repos.map((r) => r.name));
    return {
      ...cfg,
      repos: releasableOnGithub([
        ...cfg.repos,
        ...manifestReleaseRepos().filter((r) => !known.has(r.name)),
      ]),
    };
  }

  /**
   * The owner a repo is released from (REL-1): an explicit `release.org`
   * (den.yml or user.yml) wins; otherwise the repo's own non-empty catalog
   * owner, so a client org's repo releases from its own org; `github_org`
   * (readReleaseConfig's fallback for `cfg.org`) last.
   */
  private ownerFor(repo: string, cfg: ReleaseConfig): string {
    return releaseOwnerFor({
      explicitOrg: readExplicitReleaseOrg(),
      // The repo's GitHub owner, never its ORG-1d org id (which needn't be one).
      catalogOwner: ghOwnerOf(readCatalog()[repo]),
      githubOrg: cfg.org,
    });
  }

  slug(repo: string, cfg = this.config()): string {
    const gh = cfg.repos.find((r) => r.name === repo)?.gh;
    return gh && gh.includes("/") ? gh : `${this.ownerFor(repo, cfg)}/${repo}`;
  }

  /**
   * Live CD-run state for every configured repo, for the Release page's poll.
   *
   * One gh call per repo returns the last few runs, from which we take the
   * newest unfinished run (a deploy is in flight — someone else's dispatch, a
   * push to main, or a re-run from the Actions tab) and the newest finished one
   * (so a stale failure pill can be retired once a later run succeeded).
   *
   * Cached for RUNS_CACHE_TTL_MS, and concurrent callers share one in-flight
   * fetch — several open tabs polling must not multiply the gh traffic against
   * the API rate limit.
   */
  async listRepoRuns(forceRefresh = false): Promise<RepoRunState[]> {
    const fresh =
      this.runsCache &&
      Date.now() - this.runsCache.fetchedAt < RUNS_CACHE_TTL_MS;
    if (!forceRefresh && fresh) return this.runsCache!.rows;
    if (this.runsInFlight) return this.runsInFlight;

    const cfg = this.config();
    const repos = (cfg.repos ?? []).filter(
      (r) => r.enabled !== false && r.workflow,
    );

    this.runsInFlight = Promise.all(
      repos.map(async (repo): Promise<RepoRunState> => {
        const slug = this.slug(repo.name, cfg);
        // Every workflow this repo deploys with, across environments.
        const workflows = [
          ...new Set(
            cfg.environments.flatMap(
              (e) => resolveReleaseTarget(repo, e, cfg).workflows,
            ),
          ),
        ];
        const runs: CdRun[] = [];
        for (const raw of await Promise.all(
          workflows.map((wf) =>
            ghSafe([
              "api",
              "-X",
              "GET",
              `repos/${slug}/actions/workflows/${encodeURIComponent(wf)}/runs?per_page=10`,
              "--jq",
              "[.workflow_runs[] | {id:(.id|tostring), url:.html_url, status:.status, conclusion:.conclusion, title:.display_title, event:.event, createdAt:.created_at}]",
            ]),
          ),
        )) {
          try {
            const parsed: unknown = JSON.parse(raw || "[]");
            if (Array.isArray(parsed))
              for (const r of parsed as CdRun[])
                runs.push({
                  ...r,
                  envHint: envFromTitle(r.title, cfg.environments),
                });
          } catch {
            /* gh error / non-JSON — treat as "nothing known", not as "idle" */
          }
        }
        runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          repo: repo.name,
          running: runs.find((r) => r.status !== "completed") ?? null,
          last: runs.find((r) => r.status === "completed") ?? null,
        };
      }),
    )
      .then((rows) => {
        this.runsCache = { rows, fetchedAt: Date.now() };
        return rows;
      })
      .finally(() => {
        this.runsInFlight = null;
      });

    return this.runsInFlight;
  }

  /**
   * Verify every configured repo for `env`, newest-main vs currently-deployed.
   * Cached for VERIFY_CACHE_TTL_MS unless forceRefresh is set. Repos are checked
   * concurrently — each is an independent sequence of gh reads.
   */
  async verifyEnv(env: string, forceRefresh = false): Promise<ReleaseRow[]> {
    const cached = this.verifyCache.get(env);
    if (
      !forceRefresh &&
      cached &&
      Date.now() - cached.fetchedAt < VERIFY_CACHE_TTL_MS
    ) {
      return cached.rows;
    }
    const cfg = this.config();
    // One row per GitHub environment a repo maps this env onto (one per
    // tenant for cell-per-customer repos).
    const rows = await Promise.all(
      cfg.repos.flatMap((repo) => {
        const target = resolveReleaseTarget(repo, env, cfg);
        return target.environments.map((ghEnv) =>
          this.verifyOne(env, repo, cfg, ghEnv, target),
        );
      }),
    );
    this.verifyCache.set(env, { rows, fetchedAt: Date.now() });
    return rows;
  }

  /** Invalidate the verify cache for an env (call after a deploy dispatches). */
  invalidate(env?: string): void {
    if (env) this.verifyCache.delete(env);
    else this.verifyCache.clear();
  }

  /**
   * Verify a single repo. Ported from release-all.sh verify_one_repo, including
   * the two conflict checks:
   *   1) HARD: the newest `success` deployment may belong to a CD run that
   *      ultimately FAILED (a late-failing run leaves stale success records) —
   *      resolve the owning run via the status log_url and check its conclusion.
   *   2) SOFT: a deployment newer than the live one exists but hasn't succeeded
   *      (a failed/in-flight redeploy) — the live SHA is still real, so annotate.
   */
  private async verifyOne(
    env: string,
    repo: ReleaseRepo,
    cfg: ReleaseConfig,
    ghEnv: string,
    target: ResolvedReleaseTarget,
  ): Promise<ReleaseRow> {
    const ghSlug = this.slug(repo.name, cfg);
    const src = target.branch;
    const base = {
      repo: repo.name,
      gh: ghSlug,
      wave: repo.wave,
      workflow: target.workflows[0],
      environment: ghEnv,
      sourceBranch: src,
    };
    const errorRow = (
      status: ReleaseStatus,
      mainSha: string | null = null,
      deployedSha: string | null = null,
      branch: string | null = null,
      deployedAt: string | null = null,
      runId: string | null = null,
      deployer: string | null = null,
    ): ReleaseRow => ({
      ...base,
      mainSha,
      mainShort: short(mainSha),
      deployedSha,
      deployedShort: short(deployedSha),
      branch,
      deployedAt,
      runId,
      runUrl: runId
        ? `https://github.com/${ghSlug}/actions/runs/${runId}`
        : null,
      deployer,
      status,
    });

    // --- latest main sha ---
    const mainSha = await ghSafe([
      "api",
      "-X",
      "GET",
      `repos/${ghSlug}/branches/${encodeURIComponent(src)}`,
      "--jq",
      ".commit.sha",
    ]);
    if (!mainSha || mainSha === "null") {
      return errorRow({ kind: "error", text: `could not read ${src} branch` });
    }

    // --- manifest sources: a version endpoint, else the release workflow's
    // newest successful run on the source branch. A `deployment` source (or a repo from
    // config/den.yml with no sources) reads GitHub deployments below.
    const source = repo.sources?.[env];
    if (repo.sources && !source) {
      return errorRow(
        {
          kind: "no-deploy",
          text: `? no release source for ${env} in ${product().manifestYml}`,
        },
        mainSha,
      );
    }
    if (source?.version) {
      const sha = await readVersionSha(source.version, source.field ?? "build");
      if (sha.ok) {
        return {
          ...errorRow({ kind: "up-to-date", text: "" }, mainSha, sha.sha),
          source: "version endpoint",
          status: await classifyAgainstMain(
            ghSlug,
            mainSha,
            sha.sha,
            undefined,
            src,
          ),
        };
      }
      if (!source.deployment && !repo.workflow) {
        return {
          ...errorRow(
            { kind: "error", text: `✗ version endpoint: ${sha.error}` },
            mainSha,
          ),
          source: "version endpoint",
        };
      }
    }
    if (source && !source.deployment) {
      const run = await ghSafe([
        "api",
        "-X",
        "GET",
        `repos/${ghSlug}/actions/workflows/${encodeURIComponent(repo.workflow)}/runs?branch=${encodeURIComponent(src)}&status=success&per_page=1`,
        "--jq",
        '.workflow_runs[0] | [(.head_sha // ""), (.created_at // ""), ((.id // "")|tostring), (.triggering_actor.login // .actor.login // "")] | @tsv',
      ]);
      const [sha = "", at = "", rid = "", actor = ""] = run.split("\t");
      if (!repo.workflow || !sha) {
        return {
          ...errorRow(
            { kind: "no-deploy", text: `? no successful deploy run on ${src}` },
            mainSha,
          ),
          source: "workflow run",
        };
      }
      return {
        ...errorRow(
          { kind: "up-to-date", text: "" },
          mainSha,
          sha,
          src,
          at || null,
          rid || null,
          actor || null,
        ),
        source: "workflow run",
        status: await classifyAgainstMain(ghSlug, mainSha, sha, undefined, src),
      };
    }
    // A `deployment` source names the GitHub environment outright.
    const deployEnv = source?.deployment ?? ghEnv;

    // --- deployments for env, newest first ---
    const deploymentsRaw = await ghSafe([
      "api",
      "-X",
      "GET",
      // Wider page: preview/CI deployment records can bury the real CD deploy, and
      // we filter to the CD workflow below, so fetch enough history to find it.
      `repos/${ghSlug}/deployments?environment=${encodeURIComponent(deployEnv)}&per_page=50`,
    ]);
    if (!deploymentsRaw) {
      return errorRow(
        { kind: "conflict", text: "✗ deployments API error" },
        mainSha,
      );
    }
    let deployments: Array<{
      id: number;
      sha: string;
      created_at: string;
      ref: string;
      creator?: { login?: string };
    }> = [];
    try {
      deployments = JSON.parse(deploymentsRaw);
    } catch {
      deployments = [];
    }

    // Scan deployments newest-first. CRITICAL: GitHub's Deployments API returns
    // records from EVERY workflow that touched this environment — including PR
    // "preview" CI. jobs-runtime's ci-pulumi-preview.yml, for example,
    // registers deployment records for sandbox+dev+staging+prod on a feature
    // branch (a `pulumi preview` dry-run), which are NOT real rollouts but whose
    // status is `success`. Trusting them shows a feature branch as "deployed"
    // when the real CD (cd.yml) shipped `main`. So we resolve each deployment's
    // owning run and keep ONLY those from this repo's configured CD workflow.
    // We track: the newest CD attempt of any state (for the soft "newer deploy
    // failing" note) and the newest CD deployment whose latest status is
    // `success` (the live one), plus that run's conclusion + deployer.
    let deployedSha = "";
    let deployedAt = "";
    let deployedRef = "";
    let deployedCreator = "";
    let runId: string | null = null;
    let runConcl = "";
    let runActor = "";
    let newestState = "";
    let newestAt = "";
    let firstCd = true;
    for (const d of deployments) {
      if (!d?.id) continue;
      const srow = await ghSafe([
        "api",
        "-X",
        "GET",
        `repos/${ghSlug}/deployments/${d.id}/statuses?per_page=1`,
        "--jq",
        '[(.[0].state // ""), (.[0].log_url // .[0].target_url // "")] | @tsv',
      ]);
      const [state = "", logurl = ""] = srow.split("\t");

      // Attribute the deployment to its owning workflow run; without a run id we
      // can't tell whether it's a real CD deploy, so skip it.
      const rm = logurl.match(/runs\/(\d+)/);
      if (!rm) continue;
      const rid = rm[1];
      // One call: run conclusion (cross-check), deployer, and workflow path.
      const runRow = await ghSafe([
        "api",
        "-X",
        "GET",
        `repos/${ghSlug}/actions/runs/${rid}`,
        "--jq",
        '[(.conclusion // .status // ""), (.triggering_actor.login // .actor.login // ""), (.path // "")] | @tsv',
      ]);
      const [rConcl = "", rActor = "", rPath = ""] = runRow.split("\t");
      // Keep only deployments from THIS repo's configured CD workflow; preview /
      // CI / other workflows that register env deployments are ignored.
      const rWorkflow = rPath.split("/").pop() || "";
      const wanted = target.workflows.filter(Boolean);
      // No workflow configured (a manifest-only repo): any deployment counts.
      if (wanted.length && !wanted.includes(rWorkflow)) continue;

      if (firstCd) {
        newestState = state;
        newestAt = d.created_at;
        firstCd = false;
      }
      // `success` = active; `inactive` = it DID deploy but was later superseded
      // (GitHub auto-inactivates the active deployment when a newer one lands —
      // including a dry-run preview, which doesn't actually change the env). Both
      // mean this CD ref rolled out; the run-conclusion cross-check below guards
      // validity. failure/in_progress/queued are not live and fall through.
      if (state === "success" || state === "inactive") {
        deployedSha = d.sha;
        deployedAt = d.created_at;
        deployedRef = d.ref;
        deployedCreator = d.creator?.login ?? "";
        runId = rid;
        runConcl = rConcl;
        runActor = rActor;
        base.workflow = rWorkflow;
        break;
      }
    }

    if (!deployedSha) {
      let note = `no successful ${repo.workflow || "CD"} deployment to ${deployEnv}`;
      if (newestState && newestState !== "success") {
        note = `last CD deploy ${newestState} (none succeeded)`;
      }
      return errorRow({ kind: "no-deploy", text: `? ${note}` }, mainSha);
    }

    // CONFLICT 1 (hard): reported success actually belongs to a failed run.
    if (runConcl && runConcl !== "success") {
      return errorRow(
        { kind: "conflict", text: `✗ deploy run ${runConcl} — NOT rolled out` },
        mainSha,
        deployedSha,
        deployedRef,
        deployedAt,
        runId,
        runActor || deployedCreator || null,
      );
    }

    // CONFLICT 2 (soft): a newer, not-yet-successful deploy sits on top.
    let warn: string | undefined;
    if (newestState && newestState !== "success" && newestAt > deployedAt) {
      warn = `⚠ newer deploy ${newestState} @ ${newestAt.slice(0, 19)}Z`;
    }

    // Classify deployed-vs-main.
    const status = await classifyAgainstMain(
      ghSlug,
      mainSha,
      deployedSha,
      warn,
      src,
    );

    return {
      ...base,
      mainSha,
      mainShort: short(mainSha),
      deployedSha,
      deployedShort: short(deployedSha),
      branch: deployedRef || null,
      deployedAt: deployedAt || null,
      runId,
      runUrl: runId
        ? `https://github.com/${ghSlug}/actions/runs/${runId}`
        : null,
      deployer: runActor || deployedCreator || null,
      source: "GitHub deployment",
      status,
    };
  }

  // ── Dispatch + monitor ──────────────────────────────────────────────────────

  /** List branches for a repo (for the deploy-time branch selector). */
  async listBranches(repo: string): Promise<string[]> {
    const ghSlug = this.slug(repo);
    const raw = await ghSafe([
      "api",
      "--paginate",
      `repos/${ghSlug}/branches?per_page=100`,
      "--jq",
      "[.[].name]",
    ]);
    if (!raw) return [];
    const names = raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return JSON.parse(line) as string[];
        } catch {
          return [];
        }
      });
    // main first, then the rest sorted.
    const rest = names.filter((n) => n !== "main").sort();
    return names.includes("main") ? ["main", ...rest] : rest;
  }

  /**
   * Dispatch one repo's CD workflow and resolve the run id.
   * Ports dispatch_entry: run the workflow, wait for GitHub to register it, then
   * find the workflow_dispatch run created at/after our start time.
   */
  private async dispatchOne(
    env: string,
    entry: DeployPlanEntry,
    cfg: ReleaseConfig,
    emit: Emit,
  ): Promise<string | null> {
    const ghSlug = this.slug(entry.repo, cfg);
    const startIso = new Date().toISOString();
    emit({
      type: "log",
      text: `[dispatch] ${entry.repo} @ ${entry.ref} → ${env}`,
    });
    emit({
      type: "run",
      repo: entry.repo,
      runId: null,
      url: null,
      status: "dispatching",
      conclusion: null,
    });

    try {
      await gh([
        "workflow",
        "run",
        entry.workflow,
        "--repo",
        ghSlug,
        "--ref",
        entry.ref,
        ...Object.entries(entry.inputs ?? { environment: env }).flatMap(
          ([k, v]) => ["-f", `${k}=${v}`],
        ),
      ]);
    } catch (e) {
      emit({
        type: "log",
        level: "error",
        text: `  [error] failed to dispatch ${entry.repo}: ${(e as Error).message}`,
      });
      emit({
        type: "run",
        repo: entry.repo,
        runId: null,
        url: null,
        status: "completed",
        conclusion: "dispatch-failed",
      });
      throw e;
    }

    await delay(DISPATCH_SETTLE_MS);

    const runId = await ghSafe([
      "run",
      "list",
      "--repo",
      ghSlug,
      "--workflow",
      entry.workflow,
      "--limit",
      "10",
      "--json",
      "databaseId,createdAt,event",
      "--jq",
      `[.[] | select(.event=="workflow_dispatch" and .createdAt >= "${startIso}")][0].databaseId`,
    ]);

    if (!runId || runId === "null") {
      emit({
        type: "log",
        level: "warn",
        text: `  [warn] could not resolve run id for ${entry.repo}; monitoring skipped.`,
      });
      emit({
        type: "run",
        repo: entry.repo,
        runId: null,
        url: null,
        status: "skipped",
        conclusion: null,
      });
      return null;
    }

    const url = `https://github.com/${ghSlug}/actions/runs/${runId}`;
    emit({ type: "log", text: `  → run ${runId} (${url})` });
    emit({
      type: "run",
      repo: entry.repo,
      runId,
      url,
      status: "queued",
      conclusion: null,
    });
    return runId;
  }

  /** gh run view → {status, conclusion, url}. */
  private async runStatus(
    repo: string,
    runId: string,
    cfg: ReleaseConfig,
  ): Promise<{ status: string; conclusion: string | null; url: string }> {
    const ghSlug = this.slug(repo, cfg);
    const row = await ghSafe([
      "run",
      "view",
      runId,
      "--repo",
      ghSlug,
      "--json",
      "status,conclusion,url",
      "--jq",
      '[.status, (.conclusion // ""), .url] | @tsv',
    ]);
    const [status = "unknown", conclusion = "", url = ""] = row.split("\t");
    return { status, conclusion: conclusion || null, url };
  }

  /**
   * Poll the given repo→runId map until every run reaches a terminal state,
   * emitting a `run` event per repo each poll. Returns the list of repos whose
   * runs did NOT conclude success (empty = all good). Repos with a null runId
   * are treated as failures (we can't confirm they deployed), matching the
   * script's gate behaviour.
   */
  private async monitor(
    runIds: Map<string, string | null>,
    cfg: ReleaseConfig,
    emit: Emit,
    aborted: () => boolean,
  ): Promise<string[]> {
    const failed: string[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (aborted()) return failed;
      let allTerminal = true;
      failed.length = 0;

      for (const [repo, runId] of runIds) {
        if (!runId) {
          emit({
            type: "run",
            repo,
            runId: null,
            url: null,
            status: "skipped",
            conclusion: "unresolved-run-id",
          });
          failed.push(repo);
          continue;
        }
        const { status, conclusion, url } = await this.runStatus(
          repo,
          runId,
          cfg,
        );
        emit({
          type: "run",
          repo,
          runId,
          url,
          status,
          conclusion,
        });
        if (status !== "completed") {
          allTerminal = false;
        } else if (conclusion && conclusion !== "success") {
          failed.push(repo);
        }
      }

      if (allTerminal) return failed;
      await abortableDelay(cfg.pollSeconds * 1000, aborted);
    }
  }

  /**
   * Execute a deploy plan wave-by-wave. Within a wave, dispatch each entry with
   * a stagger; after each non-final wave, gate on every run concluding success
   * (abort remaining waves on any failure); finally monitor the last wave until
   * terminal. Streams progress via `emit`. Returns true iff every run succeeded.
   */
  async deploy(
    env: string,
    plan: DeployPlanEntry[],
    emit: Emit,
    aborted: () => boolean,
  ): Promise<boolean> {
    const cfg = this.config();
    if (!cfg.deploy) {
      emit({
        type: "done",
        ok: false,
        summary: DEPLOYS_OFF_MESSAGE,
      });
      return false;
    }
    this.invalidate(env); // deployed state is about to change

    const waves = [...new Set(plan.map((p) => p.wave))].sort((a, b) => a - b);
    const allRunIds = new Map<string, string | null>();
    let lastFailed: string[] = [];

    for (let wi = 0; wi < waves.length; wi++) {
      if (aborted()) {
        emit({ type: "done", ok: false, summary: "Aborted." });
        return false;
      }
      const wave = waves[wi];
      const entries = plan.filter((p) => p.wave === wave);
      emit({
        type: "phase",
        name: `Wave ${wave} — dispatch (${entries.map((e) => e.repo).join(", ")})`,
      });

      const waveRunIds = new Map<string, string | null>();
      for (let i = 0; i < entries.length; i++) {
        if (aborted()) {
          emit({ type: "done", ok: false, summary: "Aborted." });
          return false;
        }
        let runId: string | null = null;
        try {
          runId = await this.dispatchOne(env, entries[i], cfg, emit);
        } catch {
          emit({
            type: "done",
            ok: false,
            summary: `Dispatch failed for ${entries[i].repo}; aborting.`,
          });
          return false;
        }
        waveRunIds.set(entries[i].repo, runId);
        allRunIds.set(entries[i].repo, runId);
        if (i < entries.length - 1) {
          emit({
            type: "log",
            text: `  (waiting ${cfg.staggerSeconds}s before next dispatch)`,
          });
          await abortableDelay(cfg.staggerSeconds * 1000, aborted);
        }
      }

      // Gate: wait for this wave to finish before the next dispatches.
      const isLast = wi === waves.length - 1;
      emit({
        type: "phase",
        name: isLast
          ? `Wave ${wave} — monitor`
          : `Wave ${wave} — gate (waiting for success before next wave)`,
      });
      const failed = await this.monitor(waveRunIds, cfg, emit, aborted);
      if (aborted()) {
        emit({ type: "done", ok: false, summary: "Aborted." });
        return false;
      }
      lastFailed = failed;
      if (failed.length > 0 && !isLast) {
        emit({
          type: "log",
          level: "error",
          text: `[gate] wave ${wave} failed: ${failed.join(", ")}. Aborting subsequent waves.`,
        });
        emit({
          type: "done",
          ok: false,
          summary: `Wave ${wave} failed (${failed.join(", ")}); later waves cancelled.`,
        });
        return false;
      }
    }

    // Earlier waves abort on failure, so the only outstanding failures are the
    // final wave's — and monitor() already counts unresolved run ids as failures.
    const ok = lastFailed.length === 0;
    emit({
      type: "done",
      ok,
      summary: ok
        ? `All ${allRunIds.size} deployment(s) succeeded.`
        : `${lastFailed.length} deployment(s) did not succeed: ${lastFailed.join(", ")}.`,
    });
    return ok;
  }
}

export const releaseService = new ReleaseService();

/** How a deployed commit relates to main (same / behind / ahead / off-main). */
export async function classifyAgainstMain(
  ghSlug: string,
  mainSha: string,
  deployedSha: string,
  warn?: string,
  /** The branch the env ships from ("behind <branch>"). */
  src = "main",
): Promise<ReleaseStatus> {
  let status: ReleaseStatus;
  if (deployedSha === mainSha) {
    status = { kind: "up-to-date", text: "✓ up-to-date", warn };
  } else {
    const cmpRaw = await ghSafe([
      "api",
      "-X",
      "GET",
      `repos/${ghSlug}/compare/${deployedSha}...${encodeURIComponent(src)}`,
    ]);
    if (!cmpRaw) {
      status = {
        kind: "conflict",
        text: "✗ drift (compare API error)",
        warn,
      };
    } else {
      let cmp: { status?: string; ahead_by?: number; behind_by?: number } = {};
      try {
        cmp = JSON.parse(cmpRaw);
      } catch {
        /* fall through to unknown */
      }
      const aheadBy = cmp.ahead_by ?? 0;
      const behindBy = cmp.behind_by ?? 0;
      switch (cmp.status) {
        case "ahead": // main is ahead → deployed is behind main
          status = {
            kind: "behind",
            text: `✗ behind ${src} by ${aheadBy} commit(s)`,
            aheadBy,
            warn,
          };
          break;
        case "diverged":
          status = {
            kind: "off-main",
            text: `⚠ off-${src} (${src} +${aheadBy}/-${behindBy})`,
            aheadBy,
            behindBy,
            warn,
          };
          break;
        case "behind": // main is behind → deployed is ahead of main
          status = {
            kind: "ahead",
            text: `⚠ ahead of ${src} by ${behindBy} commit(s)`,
            behindBy,
            warn,
          };
          break;
        default:
          status = {
            kind: "conflict",
            text: `✗ drift (status=${cmp.status ?? "?"})`,
            warn,
          };
      }
    }
  }
  return status;
}

/**
 * The commit a service reports at a JSON version endpoint (`field` names the
 * key; a nested key may use dots). A value that is not a hex SHA is an error:
 * a semver says which release, not which commit.
 */
export async function readVersionSha(
  url: string,
  field: string,
  timeoutMs = 10_000,
): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    if (res.status !== 200) return { ok: false, error: `HTTP ${res.status}` };
    let v: unknown = await res.json();
    for (const k of field.split(".")) {
      v =
        v && typeof v === "object"
          ? (v as Record<string, unknown>)[k]
          : undefined;
    }
    if (typeof v !== "string" || !/^[0-9a-f]{7,40}$/i.test(v))
      return { ok: false, error: `no commit SHA at "${field}"` };
    return { ok: true, sha: v.toLowerCase() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Release repos less those of an org with no GitHub source (ORG-1d): their
 * release flow needs GitHub, so the Release page hides them rather than
 * failing. With no ORG-1d keys every repo stays.
 */
export function releasableOnGithub(repos: ReleaseRepo[]): ReleaseRepo[] {
  const orgs = readDenConfig().orgs ?? {};
  if (!Object.values(orgs).some(isSourcedOrg)) return repos;
  const catalog = readCatalog();
  return repos.filter((r) => {
    const org = orgOf(r.name, catalog, orgs);
    return !org || orgHasGithub(org, orgs);
  });
}

/** Workspace repos whose manifest has a `release:` block, as release repos. */
export function manifestReleaseRepos(): ReleaseRepo[] {
  const catalog = readCatalog();
  return listReposWithManifests(null, catalog)
    .filter((r) => r.manifest.release)
    .map((r) => ({
      name: r.repo,
      gh: catalog[r.repo]?.gh,
      workflow: r.manifest.release?.workflow ?? "",
      wave: 0,
      sources: (r.manifest.release?.environments ??
        {}) as ReleaseRepo["sources"],
    }));
}
