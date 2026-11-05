/**
 * A short-lived cache for the web server's repeated reads (manifests, the
 * edge config, the derived graph), so a request does not re-stat and
 * re-read the same files dozens of times, and polls a few seconds apart
 * share one read.
 *
 * Off unless the web server enables it: a CLI command and the tests read
 * fresh every time, as before. The server clears it on every mutating
 * request, so a write made through the UI is seen by the very next read;
 * an edit made outside the server (an editor, the CLI) is seen within the
 * TTL. Values are cloned on the way out, so a caller that mutates its copy
 * never changes what the next caller gets.
 */

let ttlMs = 0;
const entries = new Map<string, { at: number; value: unknown }>();
/** cachedReadStale's values: kept across a clear, only marked stale. */
const stale = new Map<string, { at: number; value: unknown }>();
const refreshing = new Set<string>();

/** Turn the cache on (web server only). */
export function enableReadCache(ms: number): void {
  ttlMs = ms;
}

/** Drop every cached read (after a mutation, or in tests). */
export function clearReadCache(): void {
  entries.clear();
  for (const e of stale.values()) e.at = 0;
}

function copy<T>(v: T): T {
  return v !== null && typeof v === "object" ? structuredClone(v) : v;
}

/** `load()`'s value for `key`, reused for the TTL when the cache is on. */
export function cachedRead<T>(key: string, load: () => T): T {
  if (ttlMs <= 0) return load();
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return copy(hit.value as T);
  const value = load();
  entries.set(key, { at: Date.now(), value });
  return copy(value);
}

/**
 * Like cachedRead, but past the TTL it still answers with the last value at
 * once and recomputes after the current request (setImmediate), so no
 * request waits on the recompute. For expensive, slow-changing results
 * (the derived dependency graph) whose staleness only affects ordering.
 */
export function cachedReadStale<T>(
  key: string,
  maxAgeMs: number,
  load: () => T,
): T {
  if (ttlMs <= 0) return load();
  const hit = stale.get(key);
  if (!hit) {
    const value = load();
    stale.set(key, { at: Date.now(), value });
    return copy(value);
  }
  if (Date.now() - hit.at >= maxAgeMs && !refreshing.has(key)) {
    refreshing.add(key);
    setImmediate(() => {
      try {
        stale.set(key, { at: Date.now(), value: load() });
      } catch {
        /* keep the last good value */
      } finally {
        refreshing.delete(key);
      }
    });
  }
  return copy(hit.value as T);
}
