/**
 * Smoke Test Environment Setup
 *
 * For non-local environments: resolves the exact deployed SHA from the GitHub
 * Deployments API and ensures the repo is cloned at that SHA inside
 * .smoke-clones/{repo}/{env}/.
 *
 * For local: no-op — the local sibling repo is already linked via .den/.
 *
 * Usage (called by buildCommand before the staging step):
 *   npx tsx src/pillars/smoke/setup-env.ts --env staging [--repo api]
 *
 * Multiple --repo flags are accepted for global runs:
 *   npx tsx src/pillars/smoke/setup-env.ts --env staging --repo api --repo other-repo
 *
 * If --repo is omitted, all registered repos with smoke tests are resolved.
 */

import { discoverRepos, findManifest } from "./discover.js";
import { resolveDeployedRef } from "../../shared/smoke/branch-resolver.js";
import { ensureRepoAtSha } from "../../shared/smoke/repo-cloner.js";
import {
  getGitHubCoords,
  getGitRemoteOrigin,
} from "../../shared/smoke/git-remote.js";
import type { Environment } from "../../shared/types/index.js";

const LOCAL_ENV: Environment = "local";

function parseArgs(): { environment: Environment; repoNames: string[] } {
  const args = process.argv.slice(2);
  let environment: Environment = LOCAL_ENV;
  const repoNames: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env" && args[i + 1]) {
      environment = args[++i] as Environment;
    } else if (args[i] === "--repo" && args[i + 1]) {
      repoNames.push(args[++i]);
    }
  }

  return { environment, repoNames };
}

async function main() {
  const { environment, repoNames } = parseArgs();

  if (environment === LOCAL_ENV) {
    // Nothing to do — local tests use the sibling repo via .den/ symlink
    console.log("  ℹ  local environment: using linked repo (no clone needed)");
    return;
  }

  // Gather repos to resolve
  let repos = discoverRepos().filter(
    (r) =>
      Object.keys(r.manifest.smoke ?? {}).length > 0 || !!r.manifest.synthetics,
  );

  if (repoNames.length > 0) {
    const filtered = repoNames.map((name) => {
      const found = findManifest(name);
      if (!found) {
        console.error(`❌ Repo "${name}" not found. Run: make register-repos`);
        process.exit(1);
      }
      return found;
    });
    repos = filtered;
  }

  if (!repos.length) {
    console.error(
      "❌ No repos with smoke tests registered. Run: make register-repos",
    );
    process.exit(1);
  }

  console.log(
    `\n🔍 Resolving deployed branch for ${repos.map((r) => r.repoName).join(", ")} @ ${environment}\n`,
  );

  for (const repo of repos) {
    // Derive GitHub owner/repo from the local repo's git remote
    const coords = getGitHubCoords(repo.repoPath);
    if (!coords) {
      console.error(
        `❌ Cannot determine GitHub owner/repo for "${repo.repoName}". ` +
          `No git remote origin found at ${repo.repoPath}`,
      );
      process.exit(1);
    }

    // Allow .den.yml to override the GitHub environment name
    const githubEnv =
      repo.manifest.github?.environments?.[environment] ?? environment;

    let ref;
    try {
      ref = await resolveDeployedRef(coords.owner, coords.repo, githubEnv);
    } catch (err) {
      console.error(`❌ ${(err as Error).message}`);
      process.exit(1);
    }

    console.log(
      `  📦 ${repo.repoName}: ${coords.owner}/${coords.repo}@${githubEnv} → ` +
        `${ref.sha.slice(0, 8)} (${ref.ref}, deployed ${new Date(ref.deployedAt).toLocaleString()})`,
    );

    // Get the git remote URL from the local symlinked/registered copy
    const originUrl = getGitRemoteOrigin(repo.repoPath);
    if (!originUrl) {
      console.error(
        `❌ Cannot get git remote origin URL for "${repo.repoName}" at ${repo.repoPath}`,
      );
      process.exit(1);
    }

    ensureRepoAtSha(repo.repoName, environment, originUrl, ref);
  }

  console.log(
    `\n✅ All repos cloned/updated for environment "${environment}"\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
