/**
 * Synthetic Test Staging Setup
 *
 * Creates .synth-run/{repo}/ before each test run:
 *
 *   1. Copies all *.spec.ts files + fixture assets from the repo's testDir
 *   2. Creates node_modules/@playwright/test → den's playwright
 *   3. Creates node_modules/@den/test → den's pillars/browser/fixtures/
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
 * The @den/test shim lets test files import from `@den/test`
 * instead of fragile relative paths like `../../fixtures/index.js`.
 *
 * The staged dir is gitignored (.synth-run/) and re-created fresh each run.
 */

import * as fs from "fs";
import * as path from "path";
import {
  discoverRepos,
  findManifest,
  resolveRepoPath,
} from "../smoke/discover.js";
import type { Environment } from "../../shared/types/index.js";
import { getDistRoot } from "../../shared/paths.js";

import { product } from "../../shared/product.js";
// Den-root anchored, NOT process.cwd(): stages (rm -rf + mkdir + symlink
// + copy) .synth-run, and CLI-spawned runs inherit the user's cwd.
const PROJECT_ROOT = getDistRoot();

const SYNTH_RUN_DIR = path.resolve(PROJECT_ROOT, ".synth-run");
const ENGINE_MODULES = path.resolve(PROJECT_ROOT, "node_modules");
const SYNTHETIC_FIXTURES = path.resolve(
  PROJECT_ROOT,
  "src/pillars/browser/fixtures",
);
interface SyntheticsManifest {
  testDir: string;
  testMatch: string;
  baseUrlKey: "api" | "web";
  auth: ("admin" | "user")[];
}

interface SyntheticsManifest {
  name?: string;
  synthetics?: SyntheticsManifest;
}

function findSyntheticsManifest(
  repoName: string,
): { repoPath: string; synthetics: SyntheticsManifest; name: string } | null {
  // Use workspace-aware discovery (active workspace when Local Dev is enabled,
  // registered-repos.json + .den/ symlinks otherwise).
  const discovered = findManifest(repoName);
  if (!discovered) return null;

  const manifest = discovered.manifest as SyntheticsManifest | null;
  if (!manifest?.synthetics) return null;
  return {
    repoPath: discovered.repoPath,
    synthetics: manifest.synthetics,
    name: manifest.name ?? repoName,
  };
}

// SPEC_RE matches .spec.ts files but not .spec.ts.skip files
const SPEC_RE = /\.spec\.ts$/;

// Asset extensions that should be copied alongside spec files (fixtures)
const ASSET_RE =
  /\.(png|jpg|jpeg|gif|webp|pdf|glb|npy|zip|json|txt|csv|mp4|mp3|wav|svg)$/i;

function copyDir(src: string, dst: string): number {
  let count = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;

    if (entry.isDirectory()) {
      const subDst = path.join(dst, entry.name);
      fs.mkdirSync(subDst, { recursive: true });
      count += copyDir(path.join(src, entry.name), subDst);
    } else if (
      SPEC_RE.test(entry.name) ||
      entry.name === "manifest.yml" ||
      ASSET_RE.test(entry.name)
    ) {
      fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name));
      count++;
    }
  }
  return count;
}

/**
 * Auto-detect which discovered repo has a synthetics section with a valid
 * testDir. Returns the first match, or null if none found.
 */
function autoDetectSyntheticsRepo(): {
  repoPath: string;
  synthetics: SyntheticsManifest;
  name: string;
} | null {
  for (const repo of discoverRepos()) {
    const manifest = repo.manifest as SyntheticsManifest | null;
    if (!manifest?.synthetics) continue;
    const testDir = path.resolve(repo.repoPath, manifest.synthetics.testDir);
    if (fs.existsSync(testDir)) {
      return {
        repoPath: repo.repoPath,
        synthetics: manifest.synthetics,
        name: manifest.name ?? repo.repoName,
      };
    }
  }
  return null;
}

async function main() {
  const explicitRepo = process.env.SYNTH_REPO;
  const environment = (process.env.E2E_ENVIRONMENT || "local") as Environment;

  // If SYNTH_REPO is set, look up that specific repo. Otherwise auto-detect
  // from the active workspace (or registered repos) by finding the first repo
  // whose synthetics.testDir actually exists on disk.
  const discovered = explicitRepo
    ? findSyntheticsManifest(explicitRepo)
    : autoDetectSyntheticsRepo();

  if (!discovered) {
    const hint = explicitRepo
      ? `repo "${explicitRepo}"`
      : "any discovered repo";
    console.error(`❌ No synthetics config found in ${hint}.`);
    console.error(
      `   Ensure the repo is in your active workspace or registered via make register-repos,`,
    );
    console.error(
      `   and that its ${product().manifestYml} contains a "synthetics" section with a valid testDir.`,
    );
    process.exit(1);
  }

  const repoName = discovered.name;

  // For non-local environments, read test files from the SHA-pinned clone
  // so tests always match the deployed code (no drift).
  // setup-env.ts must have been run first to create the clone.
  let repoPath = discovered.repoPath;
  if (environment !== "local") {
    const repo = findManifest(repoName);
    if (repo) {
      try {
        repoPath = resolveRepoPath(repo, environment);
      } catch (err) {
        console.error(`❌ ${(err as Error).message}`);
        process.exit(1);
      }
    }
  }

  const { synthetics } = discovered;
  const testDir = path.resolve(repoPath, synthetics.testDir);

  if (!fs.existsSync(testDir)) {
    console.error(`❌ Synthetics testDir not found: ${testDir}`);
    process.exit(1);
  }

  const stagingDir = path.join(SYNTH_RUN_DIR, repoName);

  // Clean the entire .synth-run/ dir (not just this repo's subdir) so that
  // stale dirs from a previous repo don't confuse auto-detection downstream.
  fs.rmSync(SYNTH_RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(stagingDir, { recursive: true });

  // ── Node modules shim ──────────────────────────────────────────────────────
  // @playwright/test → den's playwright (prevents "second time" error)
  // @den/test  → den's pillars/browser/fixtures/ (clean fixture import)
  const nmDir = path.join(stagingDir, "node_modules");
  const pwScopeDir = path.join(nmDir, "@playwright");
  const denScopeDir = path.join(nmDir, `@${product().cli}`);
  fs.mkdirSync(pwScopeDir, { recursive: true });
  fs.mkdirSync(denScopeDir, { recursive: true });

  const pwTestSrc = path.join(ENGINE_MODULES, "@playwright", "test");
  const pwTestDst = path.join(pwScopeDir, "test");
  fs.symlinkSync(pwTestSrc, pwTestDst);

  const pwSrc = path.join(ENGINE_MODULES, "playwright");
  const pwDst = path.join(nmDir, "playwright");
  fs.symlinkSync(pwSrc, pwDst);

  // @den/test — current import name
  const denTestDst = path.join(denScopeDir, "test");
  fs.symlinkSync(SYNTHETIC_FIXTURES, denTestDst);

  // ── Copy test files + assets ───────────────────────────────────────────────
  const count = copyDir(testDir, stagingDir);
  if (count === 0) {
    console.warn(`  ⚠  No .spec.ts or asset files found in ${testDir}`);
  }

  console.log(`✅ Staged ${count} file(s) → .synth-run/${repoName}/`);
  console.log(
    `   Shims: @playwright/test → ${product().cli}/node_modules, @${product().cli}/test → pillars/browser/fixtures/`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
