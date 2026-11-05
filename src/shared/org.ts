/**
 * The org this den instance serves: the root of
 * Org > Application > Repo > Services. One instance = one org.
 *
 *   org:
 *     id: globex      # defaults to edge.org
 *     title: Globex   # defaults to the github_org's `orgs:` label, then the id
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { getDistRoot } from "./paths.js";

import { product } from "./product.js";
export interface OrgConfig {
  id?: string;
  title?: string;
}

export interface Org {
  id: string;
  title: string;
}

/** Pure: the org from a parsed config/den.yml, or undefined if unnamed. */
export function resolveOrg(
  parsed: { org?: OrgConfig; edge?: { org?: string } } | null | undefined,
): Org | undefined {
  const id = parsed?.org?.id?.trim() || parsed?.edge?.org?.trim();
  if (!id) return undefined;
  return { id, title: parsed?.org?.title?.trim() || id };
}

function readParsed(root: string): unknown {
  return yaml.parse(
    fs.readFileSync(path.join(root, product().configFile), "utf-8"),
  );
}

export function readOrg(root: string = getDistRoot()): Org | undefined {
  try {
    return resolveOrg(readParsed(root) as Parameters<typeof resolveOrg>[0]);
  } catch {
    return undefined;
  }
}

/** Where the shell's org label came from (0.3.0-dev.18, additive). */
export type OrgTitleSource = "org.title" | "orgs" | "id";

/** The org as the shell labels it: `title` plus where it came from. */
export interface OrgView extends Org {
  title_source: OrgTitleSource;
}

/**
 * Pure: the org's display label for the top bar. `org.title` first, then
 * the `orgs:` label of the GitHub org (`github_org`, the label the
 * Environments page shows), then the id. A distribution with only
 * `edge.org: <id>` no longer shows its bare id when it has a label.
 */
export function resolveOrgView(
  parsed:
    | {
        org?: OrgConfig;
        edge?: { org?: string };
        github_org?: string;
        orgs?: Record<string, { label?: string } | null | undefined>;
      }
    | null
    | undefined,
): OrgView | undefined {
  const org = resolveOrg(parsed);
  if (!org) return undefined;
  if (parsed?.org?.title?.trim()) return { ...org, title_source: "org.title" };
  const gh =
    typeof parsed?.github_org === "string" ? parsed.github_org.trim() : "";
  const label = gh ? parsed?.orgs?.[gh]?.label : undefined;
  if (typeof label === "string" && label.trim())
    return { ...org, title: label.trim(), title_source: "orgs" };
  return { ...org, title_source: "id" };
}

export function readOrgView(root: string = getDistRoot()): OrgView | undefined {
  try {
    return resolveOrgView(
      readParsed(root) as Parameters<typeof resolveOrgView>[0],
    );
  } catch {
    return undefined;
  }
}
