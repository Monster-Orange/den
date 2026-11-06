/**
 * `<cli> org list` (ORG-1a): every org with its label, its workspaces on
 * this machine, whether it is the default (`github_org`), and the org
 * warnings (C1). The orgs are `/api/orgs`'s (catalog owners plus `orgs:`),
 * then the default org and any workspace's org that list does not name.
 *
 * `--org <id>` (on `org list` and `workspace list`) keeps one org's rows.
 */
import chalk from "chalk";
import { product } from "../../shared/product.js";
import { listOrgs } from "../../shared/manifest/service-links.js";
import { githubOwnersOf } from "../../shared/org-sources.js";
import { readDenConfig } from "../../shared/den-config.js";
import {
  defaultOrg,
  githubOrgFor,
  readOrgContext,
  resolveAllWorkspaceOrgs,
  withOrgMembership,
  type OrgContext,
  type WorkspaceOrg,
} from "../../shared/environment-manager/workspace-org.js";
import { newTable } from "./table.js";

/** `--org <id>`'s value from `args` (also `--org=<id>`), or undefined. */
export function orgFlag(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--org") return args[i + 1];
    if (a.startsWith("--org=")) return a.slice("--org=".length);
  }
  return undefined;
}

/** `args` without `--org <id>` / `--org=<id>`. */
export function withoutOrgFlag(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org") {
      i++;
      continue;
    }
    if (args[i].startsWith("--org=")) continue;
    out.push(args[i]);
  }
  return out;
}

export const sameOrg = (a: string | null, b: string): boolean =>
  a !== null && a.toLowerCase() === b.toLowerCase();

export interface OrgListRow {
  id: string;
  label: string;
  default: boolean;
  workspaces: string[];
}

/** The rows `org list` prints, and every workspace's warnings. */
export function orgListRows(ctx: OrgContext = readOrgContext()): {
  rows: OrgListRow[];
  warnings: string[];
  resolved: WorkspaceOrg[];
} {
  const resolved = resolveAllWorkspaceOrgs(ctx);
  const listed = withOrgMembership(
    listOrgs(ctx.catalog, ctx.config.orgs ?? {}),
    resolved,
    ctx.file,
    ctx.config,
  ).map((o) => ({
    id: o.id,
    label: o.label,
    default: o.default,
    workspaces: o.workspaces,
  }));
  const local = new Set(Object.keys(ctx.file.workspaces));
  const extra = new Map<string, OrgListRow>();
  const add = (id: string, isDefault: boolean): void => {
    if (listed.some((r) => sameOrg(r.id, id))) return;
    const key = id.toLowerCase();
    if (!extra.has(key))
      extra.set(key, { id, label: id, default: isDefault, workspaces: [] });
  };
  const d = defaultOrg(ctx.config);
  if (d) add(d, true);
  for (const w of resolved)
    if (w.org && local.has(w.workspace)) {
      add(w.org, sameOrg(d, w.org));
      extra.get(w.org.toLowerCase())?.workspaces.push(w.workspace);
    }
  return {
    rows: [...listed, ...extra.values()],
    warnings: resolved
      .filter((w) => local.has(w.workspace))
      .flatMap((w) => w.warnings),
    resolved,
  };
}

/**
 * The GitHub org `register` lists repos from: `--org <id>`, else the
 * workspace's resolved org. Never Den's own checkout or remote (SEC-0).
 * Undefined when there is none, or it is not a GitHub owner name.
 */
export function registerOrg(
  workspace: string,
  orgArg?: string,
  ctx?: OrgContext,
): string | undefined {
  let org = orgArg?.trim();
  if (org) {
    // ORG-1d: an org id names its first GitHub source's owner; an org with
    // no GitHub source has nothing to list.
    org = githubOwnersOf(org, (ctx?.config ?? readDenConfig()).orgs)[0];
    if (!org) return undefined;
  } else {
    try {
      org = githubOrgFor(workspace, ctx);
    } catch {
      return undefined;
    }
  }
  return /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(org) ? org : undefined;
}

/** Print the org warnings under a listing. */
export function printOrgWarnings(warnings: readonly string[]): void {
  for (const w of warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
  if (warnings.length) console.log();
}

export function cmdOrg(args: string[]): void {
  const sub = args[0] ?? "list";
  if (sub !== "list") {
    console.log(chalk.red(`Usage: ${product().cli} org list [--org <id>]`));
    process.exitCode = 1;
    return;
  }
  const only = orgFlag(args.slice(1));
  const { rows, warnings, resolved } = orgListRows();
  const shown = only ? rows.filter((r) => sameOrg(r.id, only)) : rows;
  const table = newTable({
    head: ["Org", "Label", "Default", "Workspaces"],
    style: { head: ["cyan"] },
  });
  for (const r of shown)
    table.push([
      chalk.bold(r.id),
      r.label,
      r.default ? chalk.green("✓") : "",
      r.workspaces.join(", ") || chalk.gray("none"),
    ]);
  console.log(table.toString());
  if (only && shown.length === 0)
    console.log(chalk.yellow(`  No org ${only}.`));
  const inScope = only
    ? new Set(
        resolved.filter((w) => sameOrg(w.org, only)).map((w) => w.workspace),
      )
    : null;
  printOrgWarnings(
    inScope
      ? warnings.filter((w) =>
          [...inScope].some((n) => w.startsWith(`workspace ${n}:`)),
        )
      : warnings,
  );
}
