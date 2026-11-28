/**
 * A short-lived, keyed cache whose builds are single-flight: callers asking for
 * a key while it builds share that build; a settled result is reused for
 * `ttlMs`; a failed build is never cached. For routes every open tab polls.
 *
 * Past `maxKeys` the oldest settled keys go; a key still building is kept, so
 * many builds at once can hold the cache above `maxKeys` until they settle.
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
  maxKeys = Infinity,
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
      entries.delete(key);
      entries.set(key, entry);
      for (const [k, e] of entries) {
        if (entries.size <= maxKeys) break;
        if (k !== key && e.settledAt !== null) entries.delete(k);
      }
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
