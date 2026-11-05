/**
 * The routers in the distribution's included dynamic-config files (`edge
 * include`, e.g. `edge/dynamic/*.yml`): Traefik serves them beside the
 * routes Den generates, so `edge routes`, /api/edge and the Edge page list
 * them too, each marked by its source file (PL-SPEC §10, a consumer's review).
 *
 * Read-only: the files are parsed, never written, and only `http.routers`
 * is read. The same files `edge up` copies in (top-level YAML, not the
 * generated edge.yml, not a stack's own route file).
 */
import * as fs from "fs";
import * as path from "path";
import { parse } from "yaml";
import { includeFiles, isOwnedElsewhere } from "./runtime.js";
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
  const http = (doc as { http?: { routers?: unknown } } | null)?.http;
  const routers = http?.routers;
  if (!routers || typeof routers !== "object" || Array.isArray(routers))
    return [];
  return Object.entries(routers as Record<string, unknown>).map(([name, r]) => {
    const o = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
    const rule = str(o.rule);
    return {
      name,
      file,
      rule,
      service: str(o.service),
      entryPoints: Array.isArray(o.entryPoints)
        ? o.entryPoints.filter((e): e is string => typeof e === "string")
        : [],
      hosts: ruleHosts(rule),
      tls: o.tls !== undefined && o.tls !== null && o.tls !== false,
    };
  });
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
