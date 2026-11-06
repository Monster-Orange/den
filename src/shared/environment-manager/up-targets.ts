/**
 * What starting a repo runs (0.3.0-dev.35; backported to 0.2.8): the one
 * decision `up <repo>` (its dependency closure) and `up -a` / `-A` share.
 *
 *   - the repo's own `up`                → the repo
 *   - none, but its services have one    → those services: all of them, or,
 *                                          for a repo started only as a
 *                                          dependency, the ones its
 *                                          dependents name (`depends_on:
 *                                          [acme/api]`); every one when any
 *                                          dependent needs the repo as a
 *                                          whole
 *   - no up at all                       → skipped ("no local up command")
 *
 * A repo that can't be resolved in the workspace is passed through
 * unchanged, so the runner reports it as before. Reads manifests from disk:
 * call it once the start set's clones exist.
 */
import { readManifest } from "../manifest/read-manifest.js";
import { depService } from "../manifest/deps.js";
import type { DerivedGraph } from "./derivation/types.js";
import {
  getWorkspaceServices,
  previewServiceCommand,
  resolveService,
} from "./service-runner.js";

export interface UpTargets {
  /** The start order, a repo replaced by its services where it has no up. */
  order: string[];
  /** Repos with no up at all (said and skipped, never fatal). */
  skippedNoUp: string[];
  /** repo → the service addresses that start in its place. */
  expanded: Map<string, string[]>;
  /**
   * A list of dependency repos as the start set has them: an expanded repo
   * becomes its services, a skipped one is dropped (nothing to wait on).
   */
  depsAs(deps: string[]): string[];
}

/** The repo part of an address ("acme/api" → "acme"). */
export const repoOfAddress = (address: string): string => address.split("/")[0];

/**
 * @param order   repos in start order
 * @param opts.targets   repos started for their own sake (the seed, or every
 *                       `-a` candidate): all their services start
 * @param opts.graph     the derived graph: who depends on whom
 */
export function resolveUpTargets(
  order: string[],
  workspace: string,
  opts: { targets: ReadonlySet<string>; graph?: DerivedGraph },
): UpTargets {
  const services = getWorkspaceServices(workspace);
  const expanded = new Map<string, string[]>();
  const skippedNoUp: string[] = [];
  const out: string[] = [];
  const runs = (address: string): boolean =>
    previewServiceCommand(address, "up", workspace).kind === "run";
  for (const repo of order) {
    const own = previewServiceCommand(repo, "up", workspace).kind;
    if (
      own === "run" ||
      own === "via-repo" ||
      !resolveService(repo, workspace)
    ) {
      out.push(repo);
      continue;
    }
    const withUp = services
      .filter((s) => s.repoName === repo && s.address !== repo)
      .map((s) => s.address)
      .filter(runs);
    if (withUp.length === 0) {
      skippedNoUp.push(repo);
      continue;
    }
    const wanted = opts.targets.has(repo)
      ? null
      : namedByDependents(repo, order, workspace, opts.graph);
    const start = wanted ? withUp.filter((a) => wanted.has(a)) : withUp;
    const pick = start.length ? start : withUp;
    expanded.set(repo, pick);
    out.push(...pick);
  }
  const skipped = new Set(skippedNoUp);
  return {
    order: out,
    skippedNoUp,
    expanded,
    depsAs: (deps) =>
      deps.flatMap((d) => (skipped.has(d) ? [] : (expanded.get(d) ?? [d]))),
  };
}

/**
 * The services of `repo` its dependents in `order` name, or null when one
 * of them needs the repo as a whole (names it bare, or depends on it by a
 * derived edge with no `depends_on` naming a service of it).
 */
function namedByDependents(
  repo: string,
  order: string[],
  workspace: string,
  graph?: DerivedGraph,
): Set<string> | null {
  const named = new Set<string>();
  const dependents = new Set(
    (graph?.edges ?? [])
      .filter((e) => e.to === repo && e.from !== repo)
      .map((e) => e.from),
  );
  for (const dependent of order) {
    if (dependent === repo) continue;
    const resolved = resolveService(dependent, workspace);
    const manifest = resolved ? readManifest(resolved.repoPath) : null;
    let mine = 0;
    for (const s of Object.values(manifest?.services ?? {}))
      for (const dep of s?.depends_on ?? []) {
        const d = depService(dep);
        if (d === repo) return null;
        if (repoOfAddress(d) === repo) {
          named.add(d);
          mine++;
        }
      }
    if (dependents.has(dependent) && mine === 0) return null;
  }
  return named.size ? named : null;
}
