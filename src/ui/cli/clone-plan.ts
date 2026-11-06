/**
 * `<cli> setup --plan` and the clone half of `<cli> up --plan` (ORG-1a):
 * each repo's resolved org and the URL it would be cloned from. Read-only:
 * nothing is cloned, seeded or written (the catalog included).
 *
 * On a fresh machine (no workspace set up yet, a blueprint in the config)
 * the plan is what `<cli> workspace seed` and then setup would do, for every
 * blueprint workspace (`-w` narrows it). Otherwise it is the focused
 * workspace's repos, the ones setup works on, or the `-w` / `--all-active`
 * ones; repos only other workspaces hold are named in a hint.
 */
import * as fs from "fs";
import * as path from "path";
import {
  readCatalog,
  resolveRepoCloneSource,
} from "../../shared/environment-manager/catalog.js";
import {
  isGitRemote,
  redactRemote,
} from "../../shared/environment-manager/git-remote.js";
import { readDenConfig } from "../../shared/den-config.js";
import type { WorkOrgsConfig } from "../../shared/org-sources.js";
import {
  blueprintWorkspaces,
  catalogFill,
  isFreshWorkspaceSetup,
  isMultiBlueprint,
} from "../../shared/environment-manager/default-workspace.js";
import {
  DEN_SERVICES_DIR,
  getActiveWorkspace,
  parseAddress,
} from "../../shared/environment-manager/workspaces.js";
import { ghCloneUrl } from "../../shared/environment-manager/workspace-manager.js";
import {
  githubOrgFor,
  readOrgContext,
  resolveWorkspaceOrg,
  type OrgContext,
  type OrgSource,
} from "../../shared/environment-manager/workspace-org.js";
import { orgOf } from "../../shared/manifest/service-links.js";
import type { ServiceCatalog } from "../../shared/types/index.js";
import { plural } from "../../shared/plural.js";

export type ClonePlanState =
  | "cloned"
  | "would-clone"
  | "not-in-catalog"
  | "checkout"
  | "no-org";

export interface ClonePlanRow {
  repo: string;
  mode: "managed" | "dev-managed";
  branch: string;
  /** The GitHub owner the repo clones from (its slug's owner), or null. */
  owner: string | null;
  url: string | null;
  state: ClonePlanState;
  /** A dev-managed checkout's path, or a managed clone's directory. */
  path?: string;
}

export interface ClonePlanWorkspace {
  name: string;
  org: string | null;
  source: OrgSource | null;
  warnings: string[];
  rows: ClonePlanRow[];
}

export interface ClonePlan {
  /** True when planned from the blueprint (nothing seeded yet). */
  fromBlueprint: boolean;
  workspaces: ClonePlanWorkspace[];
  /** Repos held only by workspaces outside the plan, per workspace. */
  outside?: { workspace: string; repos: string[] }[];
}

/** Which workspaces `setup --plan` plans (default: the focused one). */
export interface PlanSelection {
  /** `-w <ws>`, repeatable. */
  workspaces?: readonly string[];
  /** `--all-active`: every active workspace (plus any `-w` one). */
  allActive?: boolean;
}

/**
 * The branch a checkout has out, read from its HEAD file (no git process):
 * the branch name, `detached <sha7>`, or null when it can't be read.
 */
export function checkoutBranch(dir: string): string | null {
  try {
    let gitDir = path.join(dir, ".git");
    if (fs.statSync(gitDir).isFile()) {
      // A worktree or submodule: .git names the real git dir.
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf-8"));
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf-8").trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    if (/^[0-9a-f]{40,64}$/.test(head)) return `detached ${head.slice(0, 7)}`;
    return null;
  } catch {
    return null;
  }
}

const ownerOf = (slug: string): string => slug.slice(0, slug.indexOf("/"));

function cloneDir(repo: string, branch: string): string {
  return path.join(DEN_SERVICES_DIR, repo, branch);
}

/**
 * What setup and up would clone `repo` from (a GitHub slug, or an ORG-1d
 * `remote:`), or null without an org. `owner` gives the slug's owner for a
 * repo with neither `gh` nor `remote`.
 */
function sourceFor(
  repo: string,
  catalog: ServiceCatalog,
  ctx: OrgContext,
  owner: () => string,
): string | null {
  try {
    return resolveRepoCloneSource(repo, catalog, owner, ctx.config.orgs);
  } catch {
    return null;
  }
}

function slugFor(
  repo: string,
  workspace: string,
  catalog: ServiceCatalog,
  ctx: OrgContext,
): string | null {
  return sourceFor(repo, catalog, ctx, () => githubOrgFor(workspace, ctx));
}

function managedRow(
  repo: string,
  branch: string,
  slug: string | null,
  inCatalog: boolean,
): ClonePlanRow {
  const dir = cloneDir(repo, branch);
  const cloned = fs.existsSync(dir);
  const remote = slug !== null && isGitRemote(slug);
  return {
    repo,
    mode: "managed",
    branch,
    owner: !slug ? null : remote ? null : ownerOf(slug),
    url: !slug ? null : remote ? redactRemote(slug) : ghCloneUrl(slug),
    state: cloned
      ? "cloned"
      : !slug
        ? "no-org"
        : inCatalog
          ? "would-clone"
          : "not-in-catalog",
    path: dir,
  };
}

/** The plan for one workspace on this machine, limited to `repos` when given. */
export function workspaceClonePlan(
  name: string,
  repos?: readonly string[],
  ctx: OrgContext = readOrgContext(),
): ClonePlanWorkspace {
  const resolved = resolveWorkspaceOrg(name, ctx);
  const ws = ctx.file.workspaces[name];
  const want = repos ? new Set(repos) : null;
  const rows: ClonePlanRow[] = [];
  const seen = new Set<string>();
  for (const [address, entry] of Object.entries(ws?.services ?? {})) {
    const { repoName } = parseAddress(address, ctx.catalog);
    if (seen.has(repoName)) continue;
    if (want && !want.has(repoName) && !want.has(address)) continue;
    seen.add(repoName);
    const branch = entry.branch ?? "main";
    if (entry.mode === "dev-managed") {
      const owner = orgOf(repoName, ctx.catalog);
      rows.push({
        repo: repoName,
        mode: "dev-managed",
        // Den doesn't set a checkout's branch: say what it has out.
        branch:
          (entry.path && checkoutBranch(entry.path)) || "(branch unknown)",
        owner: owner || null,
        url: null,
        state: "checkout",
        ...(entry.path ? { path: entry.path } : {}),
      });
      continue;
    }
    rows.push(
      managedRow(
        repoName,
        branch,
        slugFor(repoName, name, ctx.catalog, ctx),
        Boolean(ctx.catalog[repoName]),
      ),
    );
  }
  return { ...resolved, name, rows };
}

/** What `<cli> workspace seed` and then setup would clone, per blueprint workspace. */
function blueprintClonePlan(ctx: OrgContext): ClonePlanWorkspace[] {
  const multi = isMultiBlueprint();
  const bps = blueprintWorkspaces().map((b) => ({
    ...b,
    name: multi ? b.name : "default",
  }));
  let fill = new Map<string, string>();
  try {
    fill = catalogFill(bps, ctx.catalog, ctx);
  } catch {
    // No org for some repo: those rows say so below.
  }
  return bps.map((bp) => ({
    ...resolveWorkspaceOrg(bp.name, ctx),
    name: bp.name,
    rows: bp.repos.map((repo) =>
      managedRow(
        repo,
        bp.branch,
        sourceFor(repo, ctx.catalog, ctx, () => {
          const slug = fill.get(repo);
          if (!slug) throw new Error(`no org for ${repo}`);
          return ownerOf(slug);
        }),
        true, // seeding writes every blueprint repo into the catalog
      ),
    ),
  }));
}

/**
 * `<cli> setup --plan`: the plan for `names` (every repo when empty) in the
 * selected workspaces. Throws on a workspace that does not exist.
 */
export function buildSetupPlan(
  names: readonly string[] = [],
  sel: PlanSelection = {},
): ClonePlan {
  const ctx = readOrgContext();
  const want = [...new Set(sel.workspaces ?? [])];
  if (isFreshWorkspaceSetup(ctx.file) && blueprintWorkspaces().length > 0) {
    const all = blueprintClonePlan(ctx);
    const unknown = want.filter((n) => !all.some((w) => w.name === n));
    if (unknown.length)
      throw new Error(
        `no blueprint workspace named ${unknown.join(", ")} (the blueprint has ${all.map((w) => w.name).join(", ")})`,
      );
    return {
      fromBlueprint: true,
      workspaces: want.length ? all.filter((w) => want.includes(w.name)) : all,
    };
  }
  const focused = getActiveWorkspace()?.name;
  const planned = [
    ...new Set(
      sel.allActive
        ? [...ctx.file.active, ...want]
        : want.length
          ? want
          : focused
            ? [focused]
            : [],
    ),
  ];
  const unknown = planned.filter((n) => !ctx.file.workspaces[n]);
  if (unknown.length)
    throw new Error(
      `no workspace named ${unknown.join(", ")} (workspaces: ${Object.keys(ctx.file.workspaces).join(", ") || "none"})`,
    );
  const workspaces = planned.map((n) =>
    workspaceClonePlan(n, names.length ? names : undefined, ctx),
  );
  return {
    fromBlueprint: false,
    workspaces,
    outside: outsideRepos(ctx, planned, workspaces),
  };
}

/** Repos that only workspaces outside `planned` hold, per workspace. */
function outsideRepos(
  ctx: OrgContext,
  planned: readonly string[],
  workspaces: readonly ClonePlanWorkspace[],
): { workspace: string; repos: string[] }[] {
  const inPlan = new Set(workspaces.flatMap((w) => w.rows.map((r) => r.repo)));
  const out: { workspace: string; repos: string[] }[] = [];
  for (const [name, ws] of Object.entries(ctx.file.workspaces)) {
    if (planned.includes(name)) continue;
    const repos = [
      ...new Set(
        Object.keys(ws?.services ?? {}).map(
          (a) => parseAddress(a, ctx.catalog).repoName,
        ),
      ),
    ].filter((r) => !inPlan.has(r));
    if (repos.length) out.push({ workspace: name, repos });
  }
  return out;
}

const STATE_TEXT: Record<ClonePlanState, string> = {
  cloned: "cloned",
  "would-clone": "would clone",
  "not-in-catalog": "not in the catalog: setup skips it, up clones it",
  checkout: "your checkout (setup skips it without --force)",
  "no-org": "no org: set github_org, or org: on the workspace",
};

/** The plan as plain lines (the caller colours and prints them). */
export function renderClonePlan(
  plan: ClonePlan,
  cli: string,
  catalog: ServiceCatalog = readCatalog(),
  orgs: WorkOrgsConfig | undefined = readDenConfig().orgs,
): string[] {
  const out: string[] = [];
  if (plan.fromBlueprint)
    out.push(
      `From the blueprint: nothing is set up yet. \`${cli} workspace seed\` creates these workspaces.`,
      "",
    );
  if (plan.workspaces.length === 0) out.push("No workspace to plan.");
  for (const ws of plan.workspaces) {
    out.push(
      `Workspace ${ws.name}  org: ${ws.org ?? "(none)"}${ws.source ? ` (${ws.source})` : ""}`,
    );
    if (ws.rows.length === 0) out.push("  (no repos)");
    for (const r of ws.rows) {
      const where =
        r.state === "cloned" || r.state === "checkout"
          ? r.path
            ? `  ${r.path}`
            : ""
          : "";
      const owner = r.owner ?? orgOf(r.repo, catalog, orgs) ?? "";
      out.push(
        `  ${r.repo}  ${r.mode} ${r.branch}  org: ${owner || "(unknown)"}` +
          `${r.url ? `  ${r.url}` : ""}  ${STATE_TEXT[r.state]}${where}`,
      );
    }
    for (const w of ws.warnings) out.push(`  ⚠ ${w}`);
  }
  const outside = plan.outside ?? [];
  if (outside.length) {
    const n = new Set(outside.flatMap((o) => o.repos)).size;
    out.push(
      "",
      `Not in this plan: ${plural(n, "repo")} in other workspaces: ` +
        outside
          .map((o) => `${o.workspace} (${o.repos.join(", ")})`)
          .join(", ") +
        `. Plan them with -w <workspace> or --all-active.`,
    );
  }
  out.push("", "Plan only: nothing was cloned, seeded or written.");
  return out;
}
