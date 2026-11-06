/**
 * MD-2 (0.3.0-dev.38): the engine a running web server loaded against the
 * engine on disk. A pin that upgrades Den rewrites node_modules under a
 * server that keeps the old code in memory while it serves the new pages
 * from disk, so the new pages' routes 404. The server records the engine's
 * version and build id at startup; page requests compare them with the
 * engine's package.json now (cached for a few seconds).
 *
 * The build id is a short hash of that package.json: it changes with any
 * re-pin, even one that keeps the version string (a git-sha pin).
 */
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface EngineStamp {
  version: string | null;
  buildId: string | null;
}

/** The engine's version and build id from its package.json, now. */
export function readEngineStamp(engineRoot: string): EngineStamp {
  try {
    const raw = fs.readFileSync(path.join(engineRoot, "package.json"));
    const pkg = JSON.parse(raw.toString("utf-8")) as { version?: unknown };
    return {
      version: typeof pkg.version === "string" ? pkg.version : null,
      buildId: createHash("sha256").update(raw).digest("hex").slice(0, 12),
    };
  } catch {
    return { version: null, buildId: null };
  }
}

export interface EngineCheck {
  loaded: EngineStamp;
  onDisk: EngineStamp;
  /** The engine on disk is not the one this server runs. */
  stale: boolean;
}

/** How long a comparison is reused. */
export const ENGINE_CHECK_TTL_MS = 3_000;

/**
 * The loaded stamp (read once, now) and a cached comparison with the disk.
 * An unreadable package.json on disk is never "stale": nothing is known.
 */
export function engineWatch(
  engineRoot: () => string,
  opts: { ttlMs?: number; now?: () => number } = {},
): { loaded: EngineStamp; check(): EngineCheck } {
  const ttl = opts.ttlMs ?? ENGINE_CHECK_TTL_MS;
  const now = opts.now ?? Date.now;
  const loaded = readEngineStamp(engineRoot());
  let cache: { at: number; value: EngineCheck } | null = null;
  return {
    loaded,
    check() {
      const t = now();
      if (cache && t - cache.at < ttl) return cache.value;
      const onDisk = readEngineStamp(engineRoot());
      const stale =
        onDisk.buildId !== null &&
        loaded.buildId !== null &&
        onDisk.buildId !== loaded.buildId;
      cache = { at: t, value: { loaded, onDisk, stale } };
      return cache.value;
    },
  };
}

/** The restart message (pages, 404s, MCP): both versions and the command. */
export function engineStaleMessage(c: EngineCheck, cli: string): string {
  const same = c.onDisk.version === c.loaded.version;
  const v = (s: EngineStamp) =>
    (s.version ?? "an unknown version") +
    (same && s.buildId ? ` (build ${s.buildId})` : "");
  return (
    `Den was updated to ${v(c.onDisk)}. This server is still running ${v(c.loaded)}. ` +
    `Restart it: ${cli} web restart (or your service restart).`
  );
}
