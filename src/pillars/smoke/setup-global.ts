/**
 * Smoke Test Staging Setup — All Repos
 *
 * Stages smoke test files for every service in every registered repo.
 * Used by: make test-smk-global
 */

import * as fs from "fs";
import * as path from "path";
import { discoverRepos, resolveRepoPath, resolveService } from "./discover.js";
import { stageSmokeTree } from "./staging.js";
import type { Environment } from "../../shared/types/index.js";
import { getDistRoot } from "../../shared/paths.js";

// Den-root anchored, NOT process.cwd() — bulk writer of .smoke-run (see setup.ts).
const PROJECT_ROOT = getDistRoot();
const SMOKE_RUN_DIR = path.resolve(PROJECT_ROOT, ".smoke-run");
const DEN_MODULES = path.resolve(PROJECT_ROOT, "node_modules");

/** Separator used in staging dir names — must not appear in repo or service names. */
export const STAGING_SEP = "__";

/** Canonical staging dir for a repo+service pair. */
export function stagingDirFor(repoName: string, svcName: string): string {
  return path.join(SMOKE_RUN_DIR, `${repoName}${STAGING_SEP}${svcName}`);
}

async function main() {
  const environment = (process.env.E2E_ENVIRONMENT || "local") as Environment;
  const useLocalCheckout = process.env.USE_LOCAL_CHECKOUT === "1";
  const repos = discoverRepos();
  if (!repos.length) {
    console.error("❌ No repos registered. Run: make register-repos");
    process.exit(1);
  }

  let total = 0;
  const staged: Array<{
    repo: string;
    svc: string;
    dir: string;
    testMatch: string;
    baseUrlKey: string;
  }> = [];

  for (const repo of repos) {
    const services = Object.keys(repo.manifest.smoke ?? {});
    if (!services.length) continue;

    // Resolve the staging root for this run: deployed clone by default for
    // cloud envs, or the registered checkout when explicitly requested.
    let repoPath: string;
    try {
      repoPath = resolveRepoPath(repo, environment, useLocalCheckout);
    } catch (err) {
      console.error(`❌ ${(err as Error).message}`);
      process.exit(1);
    }
    const envRepo = { ...repo, repoPath };

    for (const svcName of services) {
      const svc = resolveService(envRepo, svcName);
      if (!svc) continue;

      const stagingDir = stagingDirFor(repo.repoName, svcName);
      fs.rmSync(stagingDir, { recursive: true, force: true });
      fs.mkdirSync(stagingDir, { recursive: true });

      // Node modules shim — point @playwright/test to den's copy
      const pwScopeDir = path.join(stagingDir, "node_modules", "@playwright");
      fs.mkdirSync(pwScopeDir, { recursive: true });
      fs.symlinkSync(
        path.join(DEN_MODULES, "@playwright", "test"),
        path.join(pwScopeDir, "test"),
      );
      fs.symlinkSync(
        path.join(DEN_MODULES, "playwright"),
        path.join(stagingDir, "node_modules", "playwright"),
      );

      let count = 0;
      try {
        const result = stageSmokeTree(svc.testDir, stagingDir, svc.testMatch);
        count = result.matchedTestFiles;
        if (result.matchedTestFiles === 0) {
          console.warn(
            `  ⚠  No files matching "${svc.testMatch}" in ${svc.testDir}`,
          );
        }
        console.log(
          `✅ ${repo.repoName}/${svcName}: staged ${result.matchedTestFiles} smoke test file(s) and ${result.copiedFiles} total file(s) → ${path.basename(stagingDir)}/`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          console.warn(`  ⚠  testDir not found, skipping: ${svc.testDir}`);
          continue;
        }
        throw error;
      }
      staged.push({
        repo: repo.repoName,
        svc: svcName,
        dir: stagingDir,
        testMatch: svc.testMatch,
        baseUrlKey: svc.baseUrlKey ?? "api",
      });
      total += count;
    }
  }

  // Write a manifest so playwright-global.config.ts reads exactly what was staged
  // (avoids a second discoverRepos() call that could diverge)
  fs.writeFileSync(
    path.join(SMOKE_RUN_DIR, "global-manifest.json"),
    JSON.stringify(staged, null, 2),
  );

  console.log(
    `\n  Total: ${total} smoke test file(s) staged across ${repos.length} repo(s)\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
