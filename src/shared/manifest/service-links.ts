/**
 * Where a person opens a service, and which org a repo belongs to.
 *
 * A service's open URL for an environment is its manifest `urls.<env>`, else
 * the origin of that environment's HTTP health URL (health checks point at
 * /readyz or /api/health, never the app, so only the origin is kept). Shell
 * health checks and services with no HTTP check have no URL.
 */

import type {
  Environment,
  ServiceCatalog,
  ServiceManagementConfig,
} from "../types/index.js";
import { orgOfRepo, type WorkOrgsConfig } from "../org-sources.js";

export interface OpenLink {
  label: string;
  url: string;
}

function httpOrigin(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return `${u.origin}/`;
  } catch {
    return null;
  }
}

function httpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

export function openUrlFor(
  svc: ServiceManagementConfig | undefined,
  env: Environment,
): string | null {
  if (!svc) return null;
  const declared = httpUrl(svc.urls?.[env]);
  if (declared) return declared;
  const health = svc.health?.[env];
  if (!health || !("url" in health)) return null;
  return httpOrigin((health as { url?: string }).url);
}

export function linksFor(
  svc: ServiceManagementConfig | undefined,
  env: Environment,
): OpenLink[] {
  const out: OpenLink[] = [];
  for (const l of svc?.links ?? []) {
    const url = httpUrl(l.urls?.[env]);
    if (url && l.label) out.push({ label: l.label, url });
  }
  return out;
}

/**
 * The org a repo belongs to (ORG-1d): an org whose `repos` lists it, then an
 * org with a source that claims its owner, then (legacy) its bare GitHub
 * owner from `gh` ("acme"), else "". Without `orgs` (or with no ORG-1d keys
 * in it) this is the repo's GitHub owner, as before.
 */
export function orgOf(
  repo: string,
  catalog: ServiceCatalog,
  orgs: WorkOrgsConfig = {},
): string {
  return orgOfRepo(repo, catalog, orgs);
}

export interface OrgDisplay {
  label?: string;
  color?: string;
}

/**
 * Every org with its display name, configured ones first, then each
 * catalogued repo's org. An owner a source claims is not an org of its own,
 * so it is not listed.
 */
export function listOrgs(
  catalog: ServiceCatalog,
  configured: WorkOrgsConfig = {},
): Array<{ id: string; label: string; color?: string }> {
  const ids = new Set<string>(Object.keys(configured));
  for (const repo of Object.keys(catalog)) {
    const o = orgOf(repo, catalog, configured);
    if (o) ids.add(o);
  }
  return [...ids].map((id) => ({
    id,
    label: configured[id]?.label ?? id,
    ...(configured[id]?.color ? { color: configured[id].color } : {}),
  }));
}
