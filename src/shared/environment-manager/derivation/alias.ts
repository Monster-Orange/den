/**
 * Alias normalization for dependency derivation.
 *
 * Service references in code/config use many spellings — `shop-api`, `backend`,
 * `shop.backend`, `files-sdk`, `job-runner`, … — that all point at one
 * canonical repo-system. The alias map (built-in defaults merged with
 * `config/den.yml` `graph.aliases`) collapses those tokens to repo names,
 * and its keys define the universe of known repo-systems.
 */

import type { GraphConfig } from "../../den-config.js";

/**
 * Built-in topology: none. Den ships no repo map of its own; the graph's
 * repo-systems come from `config/den.yml` `graph.aliases`.
 */
export const DEFAULT_ALIASES: Record<string, string[]> = {};

export interface AliasResolver {
  /** Canonical repo-system names known to the graph. */
  knownRepos: Set<string>;
  /** The shared local-infra repo (`graph.infra.repo`), or null. */
  infraRepo: string | null;
  /** `graph.infra.signals`, compiled. */
  infraSignals: RegExp[];
  /** Resolve a raw token to a canonical repo name, or null if unknown. */
  resolve(token: string): string | null;
  /**
   * Repos that are EVENT SINKS — you publish events to them (EventBridge) rather
   * than call them synchronously. Detected by a `*-events` alias token (e.g.
   * notes-api's `notes-events` SDK). Edges into these are reclassified to
   * `event` so producer→sink flows show as events, not http.
   */
  eventSinks: Set<string>;
  /** GitHub orgs whose Go modules count as SDK imports (`graph.sdk_orgs`). */
  sdkOrgs: string[];
  /** npm scopes, without `@`, whose packages count as SDK imports (`graph.npm_scopes`). */
  npmScopes: string[];
}

/** Normalize a raw token to the form used for lookups. */
function norm(token: string): string {
  return token.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Build a resolver from the built-in defaults merged with config overrides.
 * For a canonical repo, config aliases are ADDED to the defaults (not replaced)
 * so partial config entries don't drop built-in spellings.
 */
export function buildAliasResolver(
  config?: GraphConfig,
  extraRepos: Iterable<string> = [],
): AliasResolver {
  const merged: Record<string, string[]> = {};
  for (const [repo, tokens] of Object.entries(DEFAULT_ALIASES)) {
    merged[repo] = [...tokens];
  }
  for (const [repo, tokens] of Object.entries(config?.aliases ?? {})) {
    merged[repo] = [...(merged[repo] ?? []), ...tokens];
  }
  // Every catalogued repo is a graph node, alias or not: with no built-in
  // topology, a repo known only to the catalog would otherwise never appear
  // and any edge to it (graph.edges included) would be dropped.
  for (const repo of extraRepos) merged[repo] ??= [];

  const lookup = new Map<string, string>();
  const eventSinks = new Set<string>();
  for (const repo of Object.keys(merged)) {
    // The canonical name and its bare-name fragments resolve to itself.
    lookup.set(norm(repo), repo);
    for (const token of merged[repo]) lookup.set(norm(token), repo);
    // A `*-events` alias token marks an event sink (its SDK publishes events).
    if ([repo, ...merged[repo]].some((t) => /-events$/.test(norm(t)))) {
      eventSinks.add(repo);
    }
  }

  return {
    knownRepos: new Set(Object.keys(merged)),
    infraRepo: config?.infra?.repo?.trim() || null,
    infraSignals: (config?.infra?.signals ?? []).map((s) => new RegExp(s)),
    resolve(token: string): string | null {
      return lookup.get(norm(token)) ?? null;
    },
    eventSinks,
    sdkOrgs: config?.sdk_orgs ?? [],
    npmScopes: (config?.npm_scopes ?? []).map((s) => s.replace(/^@/, "")),
  };
}
