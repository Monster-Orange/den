/**
 * The routers in the distribution's included dynamic-config files (`edge
 * include`, e.g. `edge/dynamic/*.yml`): Traefik serves them beside the
 * routes Den generates, so `edge routes`, /api/edge and the Edge page list
 * them too, each marked by its source file (PL-SPEC §10, a consumer's review).
 *
 * Read-only: the files are parsed, never written, and only `http.routers`
 * is read. The same files `edge up` copies in (top-level YAML, not the
 * generated edge.yml, not a stack's own route file).
 *
 * Since 0.3.0-dev.32 (a consumer's finding) also the stacks' own route
 * files: Den writes `stack-<project>.yml` into the edge's dynamic directory
 * when a stack comes up, and those routers are neither Den's host routes
 * nor included files, so nothing listed them.
 */
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import { includeFiles, isOwnedElsewhere, isStackRoutes } from "./runtime.js";
import type { EdgeConfig } from "./types.js";

export interface IncludedRouter {
  /** The router's key under `http.routers`. */
  name: string;
  /** The included file it comes from (its name, as Traefik reads it). */
  file: string;
  rule: string;
  service: string;
  entryPoints: string[];
  /** The hosts its rule names (`Host(...)`), for links. */
  hosts: string[];
  tls: boolean;
  /**
   * Served over https: the router has TLS or is on the websecure
   * entrypoint (0.3.0-dev.33). Its URLs are https://, else http://.
   */
  secure: boolean;
  /**
   * Where it sends traffic: its service's loadBalancer server URL(s) when
   * the same file defines that service, else the service's name
   * (0.3.0-dev.33).
   */
  upstream: string;
}

/** A router's URLs: one per host, with its scheme; none without a Host(). */
export function routerUrls(r: Pick<IncludedRouter, "hosts" | "secure">) {
  const scheme = r.secure ? "https://" : "http://";
  return r.hosts.map((h) => scheme + h);
}

export interface IncludedRouters {
  routers: IncludedRouter[];
  /** Files that could not be read or parsed: listed, never fatal. */
  errors: { file: string; error: string }[];
}

/** The hosts a Traefik rule names: every quoted argument of Host(...). */
export function ruleHosts(rule: string): string[] {
  const out: string[] = [];
  for (const m of rule.matchAll(/\bHost\(([^)]*)\)/g))
    for (const q of m[1].matchAll(/[`"']([^`"']+)[`"']/g))
      if (!out.includes(q[1])) out.push(q[1]);
  return out;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The routers in one dynamic-config document's `http.routers`. */
export function routersOf(doc: unknown, file: string): IncludedRouter[] {
  const http = (
    doc as { http?: { routers?: unknown; services?: unknown } } | null
  )?.http;
  const routers = http?.routers;
  if (!routers || typeof routers !== "object" || Array.isArray(routers))
    return [];
  const services = obj(http?.services);
  return Object.entries(routers as Record<string, unknown>).map(([name, r]) => {
    const o = obj(r);
    const rule = str(o.rule);
    const service = str(o.service);
    const entryPoints = Array.isArray(o.entryPoints)
      ? o.entryPoints.filter((e): e is string => typeof e === "string")
      : [];
    const tls = o.tls !== undefined && o.tls !== null && o.tls !== false;
    return {
      name,
      file,
      rule,
      service,
      entryPoints,
      hosts: ruleHosts(rule),
      tls,
      secure: tls || entryPoints.includes("websecure"),
      upstream: serverUrls(services[service]).join(", ") || service,
    };
  });
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

/** A Traefik service's loadBalancer server URLs (none: not a load balancer). */
function serverUrls(svc: unknown): string[] {
  const servers = obj(obj(svc).loadBalancer).servers;
  return Array.isArray(servers)
    ? servers.map((x) => str(obj(x).url)).filter(Boolean)
    : [];
}

/** Every router in the edge's included files, in file then key order. */
export function includedRouters(cfg: EdgeConfig): IncludedRouters {
  const out: IncludedRouters = { routers: [], errors: [] };
  if (!cfg.include) return out;
  let files: string[];
  try {
    files = includeFiles(cfg.include).filter((f) => !isOwnedElsewhere(f));
  } catch (e) {
    out.errors.push({
      file: path.basename(cfg.include),
      error: (e as Error).message,
    });
    return out;
  }
  for (const file of files) {
    try {
      const doc: unknown = parse(
        fs.readFileSync(path.join(cfg.include, file), "utf-8"),
      );
      out.routers.push(...routersOf(doc, file));
    } catch (e) {
      out.errors.push({ file, error: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}

/**
 * Every router in the stacks' route files (`stack-*.yml` in the edge's
 * dynamic directory, which `stack up` writes and `stack down` removes), in
 * file then key order. No directory yet: none.
 */
export function stackRouters(cfg: EdgeConfig): IncludedRouters {
  const out: IncludedRouters = { routers: [], errors: [] };
  const dyn = path.join(cfg.stateDir, "dynamic");
  let files: string[];
  try {
    files = fs
      .readdirSync(dyn, { withFileTypes: true })
      .filter((e) => e.isFile() && isStackRoutes(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      const doc: unknown = parse(
        fs.readFileSync(path.join(dyn, file), "utf-8"),
      );
      out.routers.push(...routersOf(doc, file));
    } catch (e) {
      out.errors.push({ file, error: (e as Error).message.split("\n")[0] });
    }
  }
  return out;
}
