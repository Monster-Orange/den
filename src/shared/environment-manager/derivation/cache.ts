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

// Bump whenever derivation RULES change (signals, alias handling, edge
// classification) — the fingerprint only tracks repo inputs, so without a
// bump every clone keeps serving graphs derived under the old rules.
const CACHE_VERSION = 3;
const CACHE_PATH = path.join(
  getDistRoot(),
  "config",
  "local",
  ".graph-cache.json",
);

interface CacheEntry {
  fingerprint: string;
  edges: DerivedEdge[];
}

interface CacheFile {
  version: number;
  /** Keyed by `repoName@absoluteCheckoutPath` (a repo name is not unique across workspaces). */
  repos: Record<string, CacheEntry>;
}

/** Stable fingerprint of a repo's input files (`mtime+size`, no content read). */
export function repoFingerprint(repoPath: string): string {
  const hash = crypto.createHash("sha1");
  for (const abs of repoInputFiles(repoPath)) {
    try {
      const s = fs.statSync(abs);
      hash.update(`${abs}:${s.mtimeMs}:${s.size}\n`);
    } catch {
      /* file vanished between listing and stat — ignore */
    }
  }
  return hash.digest("hex");
}

export function readGraphCache(): CacheFile {
  try {
    const raw = fs.readFileSync(CACHE_PATH, "utf-8");
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
    const dir = path.dirname(CACHE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    // Temp-then-rename so a concurrent reader (another den up/graph) never
    // observes a half-written cache file. Unique temp name avoids writer
    // collisions; rename is atomic within the same directory/filesystem.
    const tmp = path.join(
      dir,
      `.graph-cache.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
    );
    try {
      fs.writeFileSync(tmp, JSON.stringify(cache), "utf-8");
      fs.renameSync(tmp, CACHE_PATH);
    } catch (err) {
      // Don't leave an orphaned temp file behind when the write/rename fails.
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup failure */
      }
      throw err;
    }
  } catch {
    /* cache is best-effort — never fail a command because it couldn't write */
  }
}

export function emptyCache(): CacheFile {
  return { version: CACHE_VERSION, repos: {} };
}
