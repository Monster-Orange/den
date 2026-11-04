/**
 * Which repos a sync may touch. Sync discards local changes (`git restore .`)
 * and fast-forwards, so it runs on managed clones only: never on a
 * dev-managed checkout, the engineer's own, which Den never modifies. That
 * holds even when a managed entry somewhere resolves to the same path as a
 * dev-managed one (or to a directory holding or inside one).
 */
import * as path from "path";
import type { ResolvedService, WorkspacesFile } from "../types/index.js";

/** Every workspace's dev-managed checkout paths, resolved. */
export function devManagedPaths(wsFile: WorkspacesFile): Set<string> {
  const out = new Set<string>();
  for (const ws of Object.values(wsFile.workspaces ?? {}))
    for (const entry of Object.values(ws.services ?? {}))
      if (entry.mode === "dev-managed" && entry.path)
        out.add(path.resolve(entry.path));
  return out;
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
}

export interface SyncSelection {
  targets: ResolvedService[];
  /** Repos left alone, with why (reported, never silently skipped). */
  refused: { repoName: string; reason: string }[];
}

export function selectSyncTargets(
  services: readonly ResolvedService[],
  opts: { onlyRepo?: string | null; devManaged: ReadonlySet<string> },
): SyncSelection {
  const targets: ResolvedService[] = [];
  const refused: SyncSelection["refused"] = [];
  const seen = new Set<string>();
  const refuse = (repoName: string, reason: string): void => {
    if (!refused.some((r) => r.repoName === repoName))
      refused.push({ repoName, reason });
  };
  for (const s of services) {
    if (opts.onlyRepo && s.repoName !== opts.onlyRepo) continue;
    if (s.mode !== "managed") {
      if (opts.onlyRepo)
        refuse(
          s.repoName,
          "it is dev-managed (your own checkout); sync only updates managed clones",
        );
      continue;
    }
    const repoPath = path.resolve(s.repoPath);
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const clash = [...opts.devManaged].find((p) => overlaps(repoPath, p));
    if (clash) {
      refuse(
        s.repoName,
        `its path ${repoPath} overlaps the dev-managed checkout ${clash}; sync never touches one`,
      );
      continue;
    }
    targets.push(s);
  }
  return { targets, refused };
}
