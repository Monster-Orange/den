/**
 * Manifest reader — supports .den.yml (preferred) and .den.json (fallback).
 *
 * Import this helper instead of calling fs.readFileSync('.den.json') directly
 * so all callers automatically get YAML support.
 *
 * A repo's own manifest always wins. When a checkout has none, Den's own
 * copy is used: `manifests/<github-repo>.den.yml` in the Den repo, keyed by
 * the checkout's `origin` repo name. That covers repos whose manifest is not
 * merged yet and repos Den should not commit to.
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { getDistRoot } from "../paths.js";
import { parse as parseYaml } from "yaml";
import type { RawManifest } from "../types/index.js";

import { product } from "../product.js";
/** Names probed in order. First match wins. */
const MANIFEST_NAMES = [
  `${product().manifestYml}`,
  `${product().manifestJson}`,
] as const;

/** The repo's own manifest file, or null. */
export function repoManifestPath(repoPath: string): string | null {
  for (const name of MANIFEST_NAMES) {
    const p = path.join(repoPath, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Den-held manifests ───────────────────────────────────────────────────
// For a repo that doesn't carry a manifest yet (one we don't commit to, or
// whose PR hasn't merged), den keeps one in manifests/<repo>.den.yml,
// keyed by the git origin's repo name (falling back to the folder name). The
// repo's own file always wins.

const originCache = new Map<string, string | null>();

/** Repo name of `repoPath`'s git origin (`…/<name>.git`), cached. */
export function originRepoName(repoPath: string): string | null {
  if (originCache.has(repoPath)) return originCache.get(repoPath)!;
  let name: string | null = null;
  try {
    const url = execFileSync(
      "git",
      ["-C", repoPath, "config", "--get", "remote.origin.url"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 },
    ).trim();
    name =
      url
        .replace(/\.git$/, "")
        .split(/[/:]/)
        .pop() || null;
  } catch {
    /* not a git checkout, or no origin */
  }
  originCache.set(repoPath, name);
  return name;
}

/** Directory of den-held manifests (override: DEN_MANIFESTS_DIR). */
export function heldManifestsDir(): string {
  return process.env.DEN_MANIFESTS_DIR ?? path.join(getDistRoot(), "manifests");
}

/** The repo name of a `.den-services/<repo>/<branch>` path, else null. */
function managedCloneRepo(repoPath: string): string | null {
  const parent = path.dirname(repoPath);
  return path.basename(path.dirname(parent)) === `${product().servicesDir}`
    ? path.basename(parent)
    : null;
}

/** The den-held manifest for `repoPath`, or null. */
export function heldManifestPath(repoPath: string): string | null {
  const keys = [
    originRepoName(repoPath),
    // A managed clone lives at .den-services/<repo>/<branch>,
    // and need not be cloned yet.
    managedCloneRepo(repoPath),
    path.basename(repoPath),
  ];
  for (const key of keys) {
    if (!key) continue;
    const p = path.join(heldManifestsDir(), `${key}${product().manifestYml}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Resolve the manifest for `repoPath`: the repo's own .den.yml (or
 * .json), else the one den holds for it. Returns null if neither exists.
 */
export function resolveManifestPath(repoPath: string): string | null {
  return repoManifestPath(repoPath) ?? heldManifestPath(repoPath);
}

/** Where `repoPath`'s manifest comes from. */
export function manifestSource(repoPath: string): "repo" | "held" | null {
  if (repoManifestPath(repoPath)) return "repo";
  return heldManifestPath(repoPath) ? "held" : null;
}

/**
 * Read and parse the manifest from `repoPath`.
 * Supports both YAML and JSON.
 * Returns null if no manifest file exists or parsing fails.
 */
export function readManifest(repoPath: string): RawManifest | null {
  const filePath = resolveManifestPath(repoPath);
  if (!filePath) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = filePath.endsWith(".yml") ? parseYaml(raw) : JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null; // scalar/array/empty manifest is not usable
    }
    return parsed as RawManifest;
  } catch {
    return null;
  }
}

/**
 * Async version of readManifest.
 */
export async function readManifestAsync(
  repoPath: string,
): Promise<RawManifest | null> {
  const filePath = resolveManifestPath(repoPath);
  if (!filePath) return null;
  try {
    const { readFile } = await import("fs/promises");
    const raw = await readFile(filePath, "utf-8");
    const parsed = filePath.endsWith(".yml") ? parseYaml(raw) : JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null; // scalar/array/empty manifest is not usable
    }
    return parsed as RawManifest;
  } catch {
    return null;
  }
}

/** The canonical manifest filename for display/error messages. */
export const MANIFEST_DISPLAY_NAME = `${product().manifestYml}`;
