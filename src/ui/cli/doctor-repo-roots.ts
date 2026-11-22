/**
 * Issue 583, clause 3: doctor's row for the projects' configured repo
 * roots. A root that is far too broad (broadRootReason: the whole disk, a
 * top-level folder, the home folder or one holding it, the state folder or
 * one holding it) is refused by Validate, which would otherwise read
 * anything under it; ✗ names each one, its project and why. A root that
 * is there but not in a sound git checkout is skipped by Validate too: ⚠.
 */
import type { OnboardCheck } from "./doctor-onboard.js";
import * as fs from "fs";
import {
  broadRootReason,
  rootRefusal,
  type BroadRootOptions,
} from "../../shared/manifest/contained-read.js";

export interface RepoRoot {
  project: string;
  repoPath: string;
}

export function repoRootLines(
  roots: readonly RepoRoot[],
  opts: BroadRootOptions = {},
): { lines: string[]; check: OnboardCheck; problem: boolean } {
  const seen = new Set<string>();
  const broad: string[] = [];
  const notRepo: string[] = [];
  for (const { project, repoPath } of roots) {
    const key = `${project}\0${repoPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const why = broadRootReason(repoPath, opts);
    if (why) broad.push(`${project}: ${repoPath} (${why})`);
    // A root not there yet (a clone still to come) is fine.
    else if (fs.existsSync(repoPath)) {
      const refused = rootRefusal(repoPath, opts);
      if (refused) notRepo.push(`${project}: ${repoPath} (${refused})`);
    }
  }
  const parts: string[] = [];
  if (broad.length)
    parts.push(
      `Validate refuses ${broad.length === 1 ? "this repo root" : "these repo roots"}, far too broad to read inside: ${broad.join("; ")}; fix: point the project's repo at the repo's own folder`,
    );
  if (notRepo.length)
    parts.push(
      `Validate skips ${notRepo.length === 1 ? "this repo root" : "these repo roots"}: ${notRepo.join("; ")}`,
    );
  const status = broad.length ? "fail" : notRepo.length ? "warn" : "ok";
  const detail = parts.length
    ? parts.join("; ")
    : "every repo root is a repo's own folder";
  const mark = status === "fail" ? "✗" : status === "warn" ? "⚠" : "✓";
  return {
    lines: [`  Repo roots  ${mark}  ${detail}`],
    check: { id: "repo_roots", status, detail },
    problem: status === "fail",
  };
}

/** Every project's configured repo roots (none when none can be read). */
export async function defaultRepoRoots(): Promise<RepoRoot[]> {
  try {
    const { readWorkspacesFile, listWorkspaceServices } =
      await import("../../shared/environment-manager/workspaces.js");
    const { readCatalog } =
      await import("../../shared/environment-manager/catalog.js");
    const catalog = readCatalog();
    return Object.entries(readWorkspacesFile().workspaces ?? {}).flatMap(
      ([project, config]) =>
        listWorkspaceServices(config, catalog, project)
          .filter((s) => !!s.repoPath)
          .map((s) => ({ project, repoPath: s.repoPath })),
    );
  } catch {
    return [];
  }
}
