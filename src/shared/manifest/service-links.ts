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

/** The GitHub owner a repo is catalogued under ("acme"), or "". */
export function orgOf(repo: string, catalog: ServiceCatalog): string {
  const gh = catalog[repo]?.gh ?? "";
  const slash = gh.indexOf("/");
  return slash > 0 ? gh.slice(0, slash) : "";
}

export interface OrgDisplay {
  label?: string;
  color?: string;
}

/** Every org in the catalog with its display name, configured ones first. */
export function listOrgs(
  catalog: ServiceCatalog,
  configured: Record<string, OrgDisplay> = {},
): Array<{ id: string; label: string; color?: string }> {
  const ids = new Set<string>(Object.keys(configured));
  for (const repo of Object.keys(catalog)) {
    const o = orgOf(repo, catalog);
    if (o) ids.add(o);
  }
  return [...ids].map((id) => ({
    id,
    label: configured[id]?.label ?? id,
    ...(configured[id]?.color ? { color: configured[id].color } : {}),
  }));
}
