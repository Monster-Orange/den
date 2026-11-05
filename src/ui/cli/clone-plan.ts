/**
 * `<cli> setup --plan` and the clone half of `<cli> up --plan` (ORG-1a):
 * each repo's resolved org and the URL it would be cloned from. Read-only:
 * nothing is cloned, seeded or written (the catalog included).
 *
 * On a fresh machine (no workspace set up yet, a blueprint in the config)
 * the plan is what `<cli> workspace seed` and then setup would do, for every
 * blueprint workspace. Otherwise it is the focused workspace's repos, the
 * ones setup works on.
 */
import * as fs from "fs";
import * as path from "path";
import { readCatalog } from "../../shared/environment-manager/catalog.js";
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
}

const ownerOf = (slug: string): string => slug.slice(0, slug.indexOf("/"));

function cloneDir(repo: string, branch: string): string {
  return path.join(DEN_SERVICES_DIR, repo, branch);
}

/** The slug setup and up would clone `repo` from, or null without an org. */
function slugFor(
  repo: string,
  workspace: string,
  catalog: ServiceCatalog,
  ctx: OrgContext,
): string | null {
  const gh = catalog[repo]?.gh?.trim();
  if (gh) return gh;
  try {
    return `${githubOrgFor(workspace, ctx)}/${repo}`;
  } catch {
    return null;
  }
}

function managedRow(
  repo: string,
  branch: string,
  slug: string | null,
  inCatalog: boolean,
): ClonePlanRow {
  const dir = cloneDir(repo, branch);
  const cloned = fs.existsSync(dir);
  return {
    repo,
    mode: "managed",
    branch,
    owner: slug ? ownerOf(slug) : null,
    url: slug ? ghCloneUrl(slug) : null,
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
        branch,
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
        ctx.catalog[repo]?.gh?.trim() || fill.get(repo) || null,
        true, // seeding writes every blueprint repo into the catalog
      ),
    ),
  }));
}

/** `<cli> setup --plan`: the plan for `names` (every repo when empty). */
export function buildSetupPlan(names: readonly string[] = []): ClonePlan {
  const ctx = readOrgContext();
  if (isFreshWorkspaceSetup(ctx.file) && blueprintWorkspaces().length > 0)
    return { fromBlueprint: true, workspaces: blueprintClonePlan(ctx) };
  const ws = getActiveWorkspace();
  if (!ws) return { fromBlueprint: false, workspaces: [] };
  return {
    fromBlueprint: false,
    workspaces: [
      workspaceClonePlan(ws.name, names.length ? names : undefined, ctx),
    ],
  };
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
      const owner = r.owner ?? orgOf(r.repo, catalog) ?? "";
      out.push(
        `  ${r.repo}  ${r.mode} ${r.branch}  org: ${owner || "(unknown)"}` +
          `${r.url ? `  ${r.url}` : ""}  ${STATE_TEXT[r.state]}${where}`,
      );
    }
    for (const w of ws.warnings) out.push(`  ⚠ ${w}`);
  }
  out.push("", "Plan only: nothing was cloned, seeded or written.");
  return out;
}
