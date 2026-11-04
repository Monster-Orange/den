/**
 * Filesystem scanning helpers for dependency derivation.
 *
 * Discovery reads a small, fixed allow-list of files per repo (manifests, SDK
 * descriptors, env config, root Makefile, IaC) — never a full-repo walk — so a
 * cold derive of one repo is a few dozen small reads (tens of ms). The same
 * file list is the cache fingerprint key (see cache.ts).
 */

import {
  heldManifestPath,
  repoManifestPath,
} from "../../manifest/read-manifest.js";
import * as fs from "fs";
import * as path from "path";
import type { ScannedFile, ScannedRepo } from "./types.js";

import { product } from "../../product.js";
/** Root-relative files probed in every repo (those that exist are read). */
const ROOT_CANDIDATES = [
  `${product().manifestYml}`,
  `${product().manifestJson}`,
  "package.json",
  "go.mod",
  "pyproject.toml",
  "stack.yml",
  "Makefile",
  ".env",
  ".env.example",
  ".env.local.example",
  ".env.op",
  // shop keeps its backend config one level down.
  "apps/backend/.env",
  "apps/backend/.env.example",
  "apps/backend/env.example",
  "apps/backend/stack.yml",
] as const;

/** Directories whose `.py` files carry IaC (Pulumi/EventBridge) signals. */
const IAC_DIRS: Array<{ dir: string; depth: number }> = [
  { dir: "pulumi", depth: 1 },
  { dir: "infra", depth: 2 },
];

/**
 * Conventional, DEDICATED readiness/health-handler files (stack layout). A peer
 * service referenced here is a startup gate (see rules-readiness.ts). We list
 * exact paths — never broad files like main.py — to avoid false positives. The
 * Python package dir varies, so it is resolved with a one-level `src/*` glob.
 */
const GO_HEALTH_HANDLERS = [
  "internal/apis/health/health.go",
  "internal/apis/health/readyz_get.go",
  "internal/apis/health/healthz_get.go",
  "internal/apis/shop/readyz_get.go",
  "internal/apis/shop/healthz_get.go",
];
const PY_HEALTH_HANDLERS = [
  "internal/apis/health/readyz_get.py",
  "internal/apis/health/healthz_get.py",
  "internal/routers/health_router.py",
];

function healthHandlerFiles(repoPath: string): string[] {
  const out: string[] = [];
  for (const rel of GO_HEALTH_HANDLERS) {
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs)) out.push(abs);
  }
  let pkgs: fs.Dirent[];
  try {
    pkgs = fs.readdirSync(path.join(repoPath, "src"), { withFileTypes: true });
  } catch {
    pkgs = [];
  }
  for (const pkg of pkgs) {
    if (!pkg.isDirectory()) continue;
    for (const rel of PY_HEALTH_HANDLERS) {
      const abs = path.join(repoPath, "src", pkg.name, rel);
      if (fs.existsSync(abs)) out.push(abs);
    }
  }
  return out;
}

/** A repo "exists" for graph purposes if it has any of these markers. */
export function hasRepoMarker(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, `${product().manifestYml}`)) ||
    fs.existsSync(path.join(dir, `${product().manifestJson}`)) ||
    (fs.existsSync(dir) && heldManifestPath(dir) !== null) ||
    fs.existsSync(path.join(dir, "Makefile")) ||
    fs.existsSync(path.join(dir, ".git"))
  );
}

export function readFileSafe(abs: string): string | null {
  try {
    return fs.readFileSync(abs, "utf-8");
  } catch {
    return null;
  }
}

function listPyFiles(dir: string, depth: number): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) out.push(...listPyFiles(p, depth - 1));
    } else if (e.isFile() && e.name.endsWith(".py")) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Absolute paths of the input files that exist for a repo — the exact set the
 * rules read and the cache fingerprints. Order is stable for a given tree.
 */
export function repoInputFiles(repoPath: string): string[] {
  const files: string[] = [];
  for (const rel of ROOT_CANDIDATES) {
    const abs = path.join(repoPath, rel);
    if (fs.existsSync(abs)) files.push(abs);
  }
  for (const { dir, depth } of IAC_DIRS) {
    files.push(...listPyFiles(path.join(repoPath, dir), depth));
  }
  files.push(...healthHandlerFiles(repoPath));
  // A den-held manifest stands in for a missing .den.yml.
  if (!repoManifestPath(repoPath)) {
    const held = heldManifestPath(repoPath);
    if (held) files.push(held);
  }
  return files;
}

/** Read all of a repo's input files into memory for the rules to scan. */
export function scanRepo(repoName: string, repoPath: string): ScannedRepo {
  const files: ScannedFile[] = [];
  for (const abs of repoInputFiles(repoPath)) {
    const content = readFileSafe(abs);
    if (content === null) continue;
    // A held manifest lives outside the repo; rules see it as .den.yml.
    const rel = abs.startsWith(repoPath + path.sep)
      ? path.relative(repoPath, abs)
      : `${product().manifestYml}`;
    files.push({ abs, rel, content });
  }
  return { repoName, repoPath, files };
}
