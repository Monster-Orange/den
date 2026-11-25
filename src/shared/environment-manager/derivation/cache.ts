/**
 * Per-repo derivation cache.
 *
 * Discovery runs on every `den up`/`graph`, but a repo only needs re-parsing
 * when its input files change. We fingerprint each repo's input file set by
 * `mtime+size` (a cheap `stat`, no read) and cache the edges that scanning that
 * repo produced. Warm runs are near-instant; the graph still always reflects
 * current repo state. The cache is an optimization, never a source of truth —
 * deleting it just forces a cold derive.
 */

import * as crypto from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { getDistRoot } from "../../paths.js";
import type { DerivedEdge } from "./types.js";
import { repoInputFiles } from "./scan.js";
import { writeFileAtomic } from "../../atomic-write.js";
import { statSettled } from "../../stat-settled.js";

// Bump whenever derivation RULES change (signals, alias handling, edge
// classification) — the fingerprint only tracks repo inputs, so without a
// bump every clone keeps serving graphs derived under the old rules.
const CACHE_VERSION = 3;
/**
 * Where the cache lives, read on each use: the distribution's config/local
 * (DEN_ROOT as it is now, never as it was when this module loaded).
 */
const cachePath = () =>
  path.join(getDistRoot(), "config", "local", ".graph-cache.json");

interface CacheEntry {
  fingerprint: string;
  edges: DerivedEdge[];
}

interface CacheFile {
  version: number;
  /** Keyed by `repoName@absoluteCheckoutPath` (a repo name is not unique across workspaces). */
  repos: Record<string, CacheEntry>;
}

/**
 * Stable fingerprint of a repo's input files (`mtime+size`, no content
 * read). Issue 1598: a file written within a clock tick of now (statSettled)
 * may yet change with the same stamps, so the fingerprint then names this
 * moment and matches no cache: the edges are derived again until it settles.
 */
export function repoFingerprint(repoPath: string): string {
  const hash = crypto.createHash("sha1");
  const now = Date.now();
  for (const abs of repoInputFiles(repoPath)) {
    try {
      const s = fs.statSync(abs);
      hash.update(`${abs}:${s.mtimeMs}:${s.size}\n`);
      if (!statSettled({ mtimeMs: s.mtimeMs }, now))
        hash.update(`unsettled:${now}:${crypto.randomUUID()}\n`);
    } catch {
      /* file vanished between listing and stat — ignore */
    }
  }
  return hash.digest("hex");
}

export function readGraphCache(): CacheFile {
  try {
    const raw = fs.readFileSync(cachePath(), "utf-8");
    const parsed = JSON.parse(raw) as CacheFile;
    if (parsed.version !== CACHE_VERSION)
      return { version: CACHE_VERSION, repos: {} };
    return parsed;
  } catch {
    return { version: CACHE_VERSION, repos: {} };
  }
}

export function writeGraphCache(cache: CacheFile): void {
  try {
    const dir = path.dirname(cachePath());
    fs.mkdirSync(dir, { recursive: true });
    // Written whole (atomic-write), so a concurrent reader (another den
    // up/graph) never observes a half-written cache file.
    writeFileAtomic(cachePath(), JSON.stringify(cache));
  } catch {
    /* cache is best-effort — never fail a command because it couldn't write */
  }
}

export function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, repos: {} };
}
