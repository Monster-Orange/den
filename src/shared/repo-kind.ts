/**
 * Repo kinds: only a `service` has a runtime (up/down/status). A `module`
 * (bolt-on a host invokes) or `library` (imported code) contributes to other
 * repos instead.
 */
import { readManifest } from "./manifest/read-manifest.js";
import type { DerivedGraph } from "./environment-manager/derivation/types.js";
import type { RawManifest, RepoKind } from "./types/index.js";

export function repoKind(repoPath: string): RepoKind {
  return readManifest(repoPath)?.kind ?? "service";
}

export function hasRuntime(kind: RepoKind): boolean {
  return kind === "service";
}

/**
 * Issue 277: a repo that runs nothing (config, docs, rulesets, shared CI):
 * its manifest declares no services and no compose stack. A repo with no
 * manifest yet (a clone not made) is not one: Den can't tell.
 */
export function runsNothing(
  manifest: Pick<RawManifest, "services" | "compose"> | null | undefined,
): boolean {
  return (
    !!manifest &&
    Object.keys(manifest.services ?? {}).length === 0 &&
    !manifest.compose
  );
}

/**
 * Whether the repo at `repoPath` has a runtime of its own (up/down/health):
 * a `service` kind that runs something. Modules, libraries and repos that
 * run nothing are in the project for agents and worktrees only.
 */
export function repoHasRuntime(repoPath: string): boolean {
  const m = readManifest(repoPath);
  return hasRuntime(m?.kind ?? "service") && !runsNothing(m);
}

/** Why a repo has no runtime: its kind, or "runs nothing"; null if it has one. */
export function noRuntimeReason(
  repoPath: string,
): Exclude<RepoKind, "service"> | "runs nothing" | null {
  const m = readManifest(repoPath);
  const kind = m?.kind ?? "service";
  if (kind !== "service") return kind;
  return runsNothing(m) ? "runs nothing" : null;
}

/**
 * What a non-service repo contributes to: its declared `contributes_to`, plus
 * every repo that imports it (an SDK-import edge pointing at it).
 */
export function contributesTo(
  repo: string,
  repoPath: string,
  graph?: DerivedGraph,
): string[] {
  const declared = readManifest(repoPath)?.contributes_to ?? [];
  const importers = (graph?.edges ?? [])
    .filter((e) => e.to === repo && e.signal === "http:sdk-import")
    .map((e) => e.from);
  return [...new Set([...declared, ...importers])].filter((r) => r !== repo);
}
