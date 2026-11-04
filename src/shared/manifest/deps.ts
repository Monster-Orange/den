/**
 * `depends_on` entry normalization.
 *
 * A dep can be:
 *   - a string: "shop/db"
 *   - an object: { service: "shop/db", wait: true }
 *
 * The object form lets a service opt into blocking startup until the dep's
 * health check is green (default behavior is the existing 5-second detach
 * window — no change for unflagged deps).
 */

import type { DependsOnEntry } from "../types/index.js";

export interface NormalizedDep {
  service: string;
  wait: boolean;
}

export function depService(dep: DependsOnEntry): string {
  return typeof dep === "string" ? dep : dep.service;
}

export function normalizeDep(dep: DependsOnEntry): NormalizedDep {
  if (typeof dep === "string") return { service: dep, wait: false };
  return { service: dep.service, wait: dep.wait ?? false };
}
