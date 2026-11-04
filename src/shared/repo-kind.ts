/**
 * Repo kinds: only a `service` has a runtime (up/down/status). A `module`
 * (bolt-on a host invokes) or `library` (imported code) contributes to other
 * repos instead.
 */
import { readManifest } from "./manifest/read-manifest.js";
import type { DerivedGraph } from "./environment-manager/derivation/types.js";
import type { RepoKind } from "./types/index.js";

export function repoKind(repoPath: string): RepoKind {
  return readManifest(repoPath)?.kind ?? "service";
}

export function hasRuntime(kind: RepoKind): boolean {
  return kind === "service";
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
