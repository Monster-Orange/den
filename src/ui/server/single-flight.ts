/**
 * A short-lived, keyed cache whose builds are single-flight: callers that ask
 * for the same key while a build is running share it instead of starting their
 * own, and a settled result is reused for `ttlMs`. A failed build is never
 * cached, so the next caller retries.
 *
 * For server routes the UI polls from every open tab (/api/services,
 * /api/health): N tabs cost one build, not N.
 */
export interface SingleFlight<T> {
  /** The cached or in-flight value for `key`; `fresh` forces a new build. */
  get(key: string, build: () => Promise<T>, fresh?: boolean): Promise<T>;
  /** Drop every entry (after a change the cached value may not reflect). */
  clear(): void;
}

export function singleFlight<T>(
  ttlMs: number,
  now: () => number = Date.now,
): SingleFlight<T> {
  const entries = new Map<
    string,
    { promise: Promise<T>; settledAt: number | null }
  >();
  return {
    get(key, build, fresh = false) {
      const hit = entries.get(key);
      if (
        !fresh &&
        hit &&
        (hit.settledAt === null || now() - hit.settledAt < ttlMs)
      )
        return hit.promise;
      const entry: { promise: Promise<T>; settledAt: number | null } = {
        promise: Promise.resolve().then(build),
        settledAt: null,
      };
      entries.set(key, entry);
      entry.promise.then(
        () => {
          entry.settledAt = now();
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        },
      );
      return entry.promise;
    },
    clear() {
      entries.clear();
    },
  };
}
