/**
 * Smoke Test Staging Setup
 *
 * Creates .smoke-run/{repo}-{service}/ before each test run:
 *
 *   1. Copies all *.smoke.ts files from the repo's testDir
 *   2. Creates node_modules/@playwright/test → den's playwright
 *   3. Creates node_modules/playwright → den's playwright
 *
 * Why: service repos usually have their own @playwright/test in
 * node_modules. If Playwright's test runner loads test files from those
 * directories, Node resolves @playwright/test to the repo's copy — which is
 * a different module instance than the runner's, causing the "Requiring
 * @playwright/test second time" error.
 *
 * Staging the files inside den (with a node_modules shim) ensures
 * there is exactly one @playwright/test instance: den's.
 *
 * The staged dir is gitignored (.smoke-run/) and re-created fresh each run.
 */

import * as fs from "fs";
import * as path from "path";
import { findManifest, resolveRepoPath, resolveService } from "./discover.js";
import { stageSmokeTree } from "./staging.js";
import type { Environment } from "../../shared/types/index.js";
import { getDistRoot } from "../../shared/paths.js";
import { smokeRepoName } from "./smoke-repo.js";

import { product } from "../../shared/product.js";
// Den-root anchored, NOT process.cwd(): this stages (rm -rf + mkdir +
// symlink + tree-copy) .smoke-run, and CLI-spawned runs inherit the user's cwd.
const PROJECT_ROOT = getDistRoot();
const SMOKE_RUN_DIR = path.resolve(PROJECT_ROOT, ".smoke-run");
const ENGINE_MODULES = path.resolve(PROJECT_ROOT, "node_modules");

async function main() {
  const serviceName = process.env.SMOKE_SERVICE || "api";
  const repoName = smokeRepoName();
  const environment = (process.env.E2E_ENVIRONMENT || "local") as Environment;
  const useLocalCheckout = process.env.USE_LOCAL_CHECKOUT === "1";

  const discovered = findManifest(repoName);
  if (!discovered) {
    console.error(
      `❌ No manifest found for repo "${repoName}" in .${product().name}/`,
    );
    console.error(`   Run: make smoke-link repo=${repoName}`);
    process.exit(1);
  }

  // Non-local smoke runs stage from the deployed clone by default. Set
  // USE_LOCAL_CHECKOUT=1 to stage from the registered checkout instead.
  let repoPath: string;
  try {
    repoPath = resolveRepoPath(discovered, environment, useLocalCheckout);
  } catch (err) {
    console.error(`❌ ${(err as Error).message}`);
    process.exit(1);
  }

  // Re-resolve the service from the selected staging root so testDir points
  // into either the deployed clone or the registered checkout.
  const envDiscovered = { ...discovered, repoPath };
  const svc = resolveService(envDiscovered, serviceName);
  if (!svc) {
    const available = Object.keys(discovered.manifest.smoke ?? {}).join(", ");
    console.error(
      `❌ Service "${serviceName}" not found in ${repoName}/${product().manifestJson}`,
    );
    console.error(`   Available: ${available}`);
    process.exit(1);
  }

  const stagingDir = path.join(SMOKE_RUN_DIR, `${repoName}-${serviceName}`);

  // Clean and recreate staging dir
  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // ── Node modules shim ──────────────────────────────────────────────────
  // Symlink den's playwright into the staging dir's node_modules so
  // that any @playwright/test import in copied test files resolves to the
  // runner's copy, not the repo's own copy.
  const nmDir = path.join(stagingDir, "node_modules");
  const pwScopeDir = path.join(nmDir, "@playwright");
  fs.mkdirSync(pwScopeDir, { recursive: true });

  const pwTestSrc = path.join(ENGINE_MODULES, "@playwright", "test");
  const pwTestDst = path.join(pwScopeDir, "test");
  fs.symlinkSync(pwTestSrc, pwTestDst);

  const pwSrc = path.join(ENGINE_MODULES, "playwright");
  const pwDst = path.join(nmDir, "playwright");
  fs.symlinkSync(pwSrc, pwDst);

  // ── Copy test tree ─────────────────────────────────────────────────────
  // Copy the full testDir so smoke tests can import shared helper modules
  // that do not themselves match `testMatch`.
  const result = stageSmokeTree(svc.testDir, stagingDir, svc.testMatch);
  if (result.matchedTestFiles === 0) {
    console.warn(
      `  ⚠  No files matching "${svc.testMatch}" found in ${svc.testDir}`,
    );
  }

  console.log(
    `✅ Staged ${result.matchedTestFiles} smoke test file(s) and ${result.copiedFiles} total file(s) → .smoke-run/${repoName}-${serviceName}/`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
