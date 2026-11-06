/**
 * Which work org a workspace belongs to (ORG-1a, ORG-SPEC §2).
 *
 * An org is a key of `orgs:` or a GitHub owner. An org with no `sources`
 * and no `repos` is the GitHub owner of the same name (ORG-1a); ORG-1d's
 * keys make it any name (org-sources.ts), and a repo's org is orgOf's.
 * `github_org` is the default org. A workspace's org resolves through this
 * chain, first match wins:
 *
 *   1. `org:` on the workspace in workspaces.yml (per machine)
 *   2. `org:` on the same-named blueprint workspace (`defaults.workspaces`)
 *   3. the single non-empty catalog owner of its repos (case-insensitive)
 *   4. `github_org`
 *
 * Computed on read and never written back to workspaces.yml, so an inferred
 * org never looks like an explicit one. Every rule broken here is a warning,
 * never an error (C1): an old config resolves as before, to `github_org`.
 */
import {
  readDenConfig,
  readWorkspaceBlueprints,
  requireGithubOrg,
  type DenConfig,
  type ResolvedWorkspaceBlueprint,
} from "../den-config.js";
import { readCatalog } from "./catalog.js";
import { parseAddress, readWorkspacesFile } from "./workspaces.js";
import { orgOf } from "../manifest/service-links.js";
import { githubOwnersOf, orgClaimingOwner } from "../org-sources.js";
import { cachedRead } from "../read-cache.js";
import type {
  ServiceCatalog,
  WorkspaceConfig,
  WorkspacesFile,
} from "../types/index.js";

/** Which step of the chain gave the org. */
export type OrgSource = "workspace" | "blueprint" | "catalog" | "default";

export interface WorkspaceOrg {
  workspace: string;
  /** The resolved org id (the `orgs:` key's spelling when one matches), or null. */
  org: string | null;
  source: OrgSource | null;
  /** Each broken org rule, as a sentence (C1: warnings, never errors). */
  warnings: string[];
}

export interface OrgContext {
  config: DenConfig;
  catalog: ServiceCatalog;
  file: WorkspacesFile;
  blueprints: ResolvedWorkspaceBlueprint[];
}

const lower = (s: string): string => s.toLowerCase();

/** The current config, catalog, workspaces.yml and blueprint. */
export function readOrgContext(): OrgContext {
  const config = readDenConfig();
  let blueprints: ResolvedWorkspaceBlueprint[] = [];
  try {
    blueprints = readWorkspaceBlueprints(config).workspaces;
  } catch {
    // A malformed blueprint is reported where seeding reads it; it must not
    // turn an org listing into a failure (C1).
  }
  return {
    config,
    catalog: readCatalog(),
    file: readWorkspacesFile(),
    blueprints,
  };
}

/**
 * `id` spelled as its `orgs:` key when one matches case-insensitively; a
 * GitHub owner an ORG-1d source claims (`github_org: acme` with a source
 * for acme) is that source's org.
 */
export function canonicalOrg(id: string, config: DenConfig): string {
  const key = Object.keys(config.orgs ?? {}).find(
    (k) => lower(k) === lower(id),
  );
  return key ?? orgClaimingOwner(id, config.orgs) ?? id;
}

/** The default org: `github_org`, or null when unset. */
export function defaultOrg(config: DenConfig): string | null {
  const d = config.github_org?.trim();
  return d ? canonicalOrg(d, config) : null;
}

/** The repos a workspace holds; a workspace not set up yet holds its blueprint's. */
function workspaceRepos(
  ws: WorkspaceConfig | undefined,
  bp: ResolvedWorkspaceBlueprint | undefined,
  catalog: ServiceCatalog,
): string[] {
  const held = [
    ...Object.keys(ws?.services ?? {}).map(
      (k) => parseAddress(k, catalog).repoName,
    ),
    ...Object.keys(ws?.repos ?? {}),
  ];
  return [...new Set(held.length > 0 ? held : (bp?.repos ?? []))];
}

/** Owners Den knows of: `orgs:` keys, catalog owners and `github_org`. */
function knownOrgs(ctx: OrgContext): Set<string> {
  const ids = new Set(Object.keys(ctx.config.orgs ?? {}).map(lower));
  for (const repo of Object.keys(ctx.catalog)) {
    const o = orgOf(repo, ctx.catalog, ctx.config.orgs);
    if (o) ids.add(lower(o));
  }
  const d = ctx.config.github_org?.trim();
  if (d) ids.add(lower(d));
  return ids;
}

/** Resolve one workspace's org through the chain. */
export function resolveWorkspaceOrg(
  name: string,
  ctx: OrgContext,
): WorkspaceOrg {
  const warnings: string[] = [];
  const ws = ctx.file.workspaces[name];
  const bp = ctx.blueprints.find((b) => b.name === name);
  const rawWsOrg = ws?.org as unknown;
  const wsOrg =
    typeof rawWsOrg === "string" && rawWsOrg.trim()
      ? rawWsOrg.trim()
      : undefined;
  if (rawWsOrg !== undefined && rawWsOrg !== null && !wsOrg)
    warnings.push(
      `workspace ${name}: org in workspaces.yml is not an org id; ignored`,
    );

  const repos = workspaceRepos(ws, bp, ctx.catalog);
  const owners = new Map<string, string>(); // lowercased → first spelling
  for (const repo of repos) {
    const o = orgOf(repo, ctx.catalog, ctx.config.orgs);
    if (o && !owners.has(lower(o))) owners.set(lower(o), o);
  }

  let org: string | null = null;
  let source: OrgSource | null = null;
  if (wsOrg) {
    org = wsOrg;
    source = "workspace";
    if (bp?.org && lower(bp.org) !== lower(wsOrg))
      warnings.push(
        `workspace ${name}: org ${wsOrg} in workspaces.yml overrides the blueprint's org ${bp.org}`,
      );
  } else if (bp?.org) {
    org = bp.org;
    source = "blueprint";
  } else if (owners.size === 1) {
    org = [...owners.values()][0];
    source = "catalog";
  } else {
    org = ctx.config.github_org?.trim() || null;
    source = org ? "default" : null;
    if (owners.size > 1)
      warnings.push(
        `workspace ${name}: its repos belong to several owners (${[...owners.values()].join(", ")}); ` +
          `using ${org ?? "no org"}. Set org: on the workspace to choose one`,
      );
  }
  if (org) org = canonicalOrg(org, ctx.config);

  if (
    org &&
    (source === "workspace" || source === "blueprint") &&
    !knownOrgs(ctx).has(lower(org))
  )
    warnings.push(
      `workspace ${name}: org ${org} is not in orgs:, the catalog or github_org`,
    );

  // A repo in another owner than its workspace's org. A mixed workspace with
  // no org of its own already said so above.
  if (
    org &&
    (owners.size <= 1 || source === "workspace" || source === "blueprint")
  )
    for (const repo of repos) {
      const o = orgOf(repo, ctx.catalog, ctx.config.orgs);
      if (o && lower(o) !== lower(org))
        warnings.push(
          `workspace ${name}: repo ${repo} belongs to ${o}, not the workspace's org ${org}`,
        );
    }

  return { workspace: name, org, source, warnings };
}

/** Every workspace on this machine, then blueprint workspaces not set up yet. */
function workspaceNames(ctx: OrgContext): string[] {
  return [
    ...new Set([
      ...Object.keys(ctx.file.workspaces),
      ...ctx.blueprints.map((b) => b.name),
    ]),
  ];
}

/** Every workspace's resolved org (cached for the web server's read TTL). */
export function resolveAllWorkspaceOrgs(ctx?: OrgContext): WorkspaceOrg[] {
  const compute = (c: OrgContext) =>
    workspaceNames(c).map((n) => resolveWorkspaceOrg(n, c));
  if (ctx) return compute(ctx);
  return cachedRead("workspace-orgs", () => compute(readOrgContext()));
}

/**
 * The GitHub owner to clone and register a workspace's repos under: its
 * resolved org, which for a legacy org is that GitHub owner. An org with
 * ORG-1d `sources` gives its first GitHub source's owner, and one with no
 * GitHub source throws (its repos clone from `remote:`; discovery is off).
 * With no org at all (no org anywhere and no `github_org`) this throws
 * exactly as requireGithubOrg does, so an old config fails as before.
 */
export function githubOrgFor(workspace: string, ctx?: OrgContext): string {
  const hit = ctx
    ? resolveWorkspaceOrg(workspace, ctx)
    : (resolveAllWorkspaceOrgs().find((w) => w.workspace === workspace) ??
      resolveWorkspaceOrg(workspace, readOrgContext()));
  if (!hit.org) return requireGithubOrg(ctx?.config);
  const orgs = (ctx?.config ?? readDenConfig()).orgs;
  const owner = githubOwnersOf(hit.org, orgs)[0];
  if (owner) return owner;
  throw new Error(
    `org ${hit.org} has no GitHub source (orgs.${hit.org}.sources): ` +
      `give workspace ${workspace}'s repos a remote: in the service catalog`,
  );
}

export interface OrgEntry {
  id: string;
  label: string;
  color?: string;
}

/**
 * The org listing with `default` and `workspaces` added to each entry and
 * nothing else changed (C3): same entries, same order, same fields. Only
 * workspaces on this machine (workspaces.yml) are listed.
 */
export function withOrgMembership<T extends OrgEntry>(
  orgs: T[],
  resolved: WorkspaceOrg[],
  file: WorkspacesFile,
  config: DenConfig,
): Array<T & { default: boolean; workspaces: string[] }> {
  // The listing can hold one owner twice in different case (catalog owners
  // are listed as spelled); an org lands on the entry spelled exactly like
  // it, else the first that matches case-insensitively.
  const entryFor = (id: string): number => {
    const exact = orgs.findIndex((o) => o.id === id);
    return exact !== -1
      ? exact
      : orgs.findIndex((o) => lower(o.id) === lower(id));
  };
  const d = defaultOrg(config);
  const defaultAt = d === null ? -1 : entryFor(d);
  const members = orgs.map((): string[] => []);
  const local = new Set(Object.keys(file.workspaces));
  for (const w of resolved) {
    if (!w.org || !local.has(w.workspace)) continue;
    const at = entryFor(w.org);
    if (at !== -1) members[at].push(w.workspace);
  }
  return orgs.map((o, i) => ({
    ...o,
    default: i === defaultAt,
    workspaces: members[i],
  }));
}
