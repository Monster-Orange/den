/**
 * What the distribution's tracked config sets, for the Settings page's
 * read-only Distribution rows (R21, 0.3.0-dev.19). Read straight from the
 * org config file (product().configFile), never from config/local/user.yml,
 * so a row shows the distribution's value even when you override it.
 *
 * Read-only by design: nothing in the Settings page writes the
 * distribution's config (it is tracked in git). Your own override of the
 * same thing (a theme pick, `web.port` in user.yml) is a separate User row.
 */
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";
import { product } from "../../shared/product.js";

export interface DistributionSettings {
  /** The org config file, relative to the distribution root. */
  file: string;
  /** brand.name */
  brand: string | null;
  /** brand.theme: the theme drawn when you have chosen none. */
  theme: string | null;
  github_org: string | null;
  /** orgs: id → label (or the id when it has none). */
  orgs: Record<string, string>;
  /** web.port in the org config (your user.yml may override it). */
  web_port: number | null;
  environments: string[] | null;
  /** edge.domain */
  domain: string | null;
}

/** Your own `web.port` override in config/local/user.yml, or null. */
export function userWebPort(user: Record<string, unknown>): number | null {
  const p = (user.web as { port?: unknown } | undefined)?.port;
  return typeof p === "number" && Number.isInteger(p) ? p : null;
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

/** The distribution's values; an unreadable file reads as nothing set. */
export function distributionSettings(root: string): DistributionSettings {
  const file = product().configFile;
  let raw: Record<string, unknown> = {};
  try {
    raw =
      (yaml.parse(fs.readFileSync(path.join(root, file), "utf-8")) as Record<
        string,
        unknown
      > | null) ?? {};
  } catch {
    /* no or broken config: nothing set */
  }
  const brand = (raw.brand ?? {}) as Record<string, unknown>;
  const orgs: Record<string, string> = {};
  if (raw.orgs && typeof raw.orgs === "object" && !Array.isArray(raw.orgs))
    for (const [id, v] of Object.entries(raw.orgs as Record<string, unknown>))
      orgs[id] = str((v as { label?: unknown } | null)?.label) ?? id;
  const port = (raw.web as { port?: unknown } | undefined)?.port;
  const envs = Array.isArray(raw.environments)
    ? raw.environments.filter((e): e is string => typeof e === "string")
    : null;
  return {
    file,
    brand: str(brand.name),
    theme: str(brand.theme),
    github_org: str(raw.github_org),
    orgs,
    web_port: typeof port === "number" && Number.isInteger(port) ? port : null,
    environments: envs,
    domain: str((raw.edge as { domain?: unknown } | undefined)?.domain),
  };
}
