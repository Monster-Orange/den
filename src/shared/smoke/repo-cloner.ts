/**
 * Smoke test repo cloner
 *
 * Manages .smoke-clones/{repoName}/{environment}/ — shallow clones of
 * registered repos checked out at the exact SHA deployed to each environment.
 *
 * Directory layout:
 *   .smoke-clones/
 *     api/
 *       staging/          ← shallow clone at deployed SHA
 *         .deployed-sha   ← cached SHA (avoids redundant re-clones)
 *
 * Freshness strategy:
 *   - Read .deployed-sha from disk
 *   - If it matches the target SHA → already up to date, return path immediately
 *   - If it differs (or file absent) → fetch + checkout + update stamp
 *
 * Git authentication:
 *   Uses `gh auth git-credential` as the git credential helper so the
 *   existing `gh` session covers private repos without separate SSH setup.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { DeployedRef } from "./branch-resolver.js";
import { getDistRoot } from "../paths.js";
import { assertSafeCloneDestination } from "../environment-manager/clone-guard.js";

// Anchored to the den root, NOT process.cwd() — this module CLONES repos,
// and a cwd-derived destination once bulk-cloned into an unrelated checkout.
const CLONES_DIR = path.resolve(getDistRoot(), ".smoke-clones");
const DEPLOYED_SHA_FILE = ".deployed-sha";

/** Absolute path to the clone directory for a repo+environment pair. */
export function cloneDirFor(repoName: string, environment: string): string {
  return path.join(CLONES_DIR, repoName, environment);
}

function run(cmd: string, cwd?: string): void {
  execSync(cmd, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      // Route git credentials through `gh` so private repos work without SSH
      GIT_CREDENTIAL_HELPER: "!gh auth git-credential",
    },
  });
}

function runCapture(cmd: string, cwd?: string): string {
  return execSync(cmd, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    env: {
      ...process.env,
      GIT_CREDENTIAL_HELPER: "!gh auth git-credential",
    },
  }).trim();
}

/**
 * Ensure the repo is cloned at the given SHA.
 * Returns the absolute path to the clone root.
 *
 * @param repoName   Short name (matches .den.yml `name` field, e.g. "api")
 * @param environment  Den environment key (e.g. "staging") — used for path only
 * @param originUrl  Git remote URL to clone from
 * @param ref        Deployed ref from branch-resolver
 */
export function ensureRepoAtSha(
  repoName: string,
  environment: string,
  originUrl: string,
  ref: DeployedRef,
): string {
  const cloneDir = cloneDirFor(repoName, environment);
  const shaFile = path.join(cloneDir, DEPLOYED_SHA_FILE);

  // Fast path: already at the right SHA
  if (fs.existsSync(shaFile)) {
    const cached = fs.readFileSync(shaFile, "utf-8").trim();
    if (cached === ref.sha) {
      console.log(
        `  ✓ ${repoName}@${environment}: already at ${ref.sha.slice(0, 8)} (${ref.ref})`,
      );
      return cloneDir;
    }
    console.log(
      `  ↻ ${repoName}@${environment}: updating ${cached.slice(0, 8)} → ${ref.sha.slice(0, 8)} (${ref.ref})`,
    );
  } else {
    console.log(
      `  ⬇ ${repoName}@${environment}: cloning at ${ref.sha.slice(0, 8)} (${ref.ref})`,
    );
  }

  if (!fs.existsSync(cloneDir)) {
    assertSafeCloneDestination(cloneDir, repoName);
    // Initial clone — shallow, blobless (history not needed, just the tree)
    fs.mkdirSync(cloneDir, { recursive: true });
    try {
      run(
        `git clone --filter=blob:none --depth=1 --branch "${ref.ref}" ` +
          `-c credential.helper="!gh auth git-credential" ` +
          `"${originUrl}" "${cloneDir}"`,
      );
    } catch {
      // Branch may not exist by that name (e.g. detached SHA) — try bare clone
      fs.rmSync(cloneDir, { recursive: true, force: true });
      fs.mkdirSync(cloneDir, { recursive: true });
      run(
        `git clone --filter=blob:none --depth=1 ` +
          `-c credential.helper="!gh auth git-credential" ` +
          `"${originUrl}" "${cloneDir}"`,
      );
    }
  }

  // Fetch the exact SHA (in case shallow clone landed on a different commit)
  const currentSha = runCapture("git rev-parse HEAD", cloneDir);
  if (currentSha !== ref.sha) {
    try {
      run(
        `git -c credential.helper="!gh auth git-credential" ` +
          `fetch --depth=1 origin "${ref.sha}"`,
        cloneDir,
      );
      run(`git checkout "${ref.sha}"`, cloneDir);
    } catch {
      // Some git servers don't allow fetching by SHA directly — fall back to
      // fetching the branch and checking out the SHA
      run(
        `git -c credential.helper="!gh auth git-credential" ` +
          `fetch --depth=1 origin "${ref.ref}"`,
        cloneDir,
      );
      run(`git checkout "${ref.sha}"`, cloneDir);
    }
  }

  // Write stamp file
  fs.writeFileSync(shaFile, ref.sha);

  console.log(
    `  ✓ ${repoName}@${environment}: ready at ${ref.sha.slice(0, 8)}`,
  );
  return cloneDir;
}
