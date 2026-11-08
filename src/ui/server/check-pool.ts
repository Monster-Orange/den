/**
 * How health checks run (0.4.17): at most CHECK_CONCURRENCY at once, each
 * given at most CHECK_TIMEOUT_MS. A check that runs over its time gets the
 * caller's stand-in result ("timed out after 10 s") rather than holding up
 * the run, and the run never waits on it again.
 */

/** The most checks in flight at once. */
export const CHECK_CONCURRENCY = 12;
/** The longest one check may take, whatever its kind. */
export const CHECK_TIMEOUT_MS = 10_000;

/** What a check that ran out of time says. */
export function timedOutText(ms: number): string {
  return `timed out after ${Math.round(ms / 1000)} s`;
}

/**
 * `p`, or `late()` once `ms` passes first. A late `p` that later settles
 * is ignored, and so is its rejection.
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  late: () => T,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(late());
    }, ms);
    timer.unref?.();
    p.then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * `fn` over `items`, at most `limit` at a time, the results in the items'
 * order. Each starts as soon as a slot frees up.
 */
export async function runCapped<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
