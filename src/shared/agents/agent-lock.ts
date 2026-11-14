/**
 * Review M1 (0.4.46): one change to an agent at a time. Start, stop,
 * resume and relaunch of one agent queue behind each other in this
 * process, so two overlapping starts can't both pass the "is running"
 * check on a stale record. Re-entrant along one call chain (a restart
 * stops, then resumes, under the one lock).
 *
 * In-process only: the web server makes these calls. A CLI in another
 * process still meets the host's own checks.
 */
import { AsyncLocalStorage } from "async_hooks";

const held = new AsyncLocalStorage<ReadonlySet<string>>();
const tails = new Map<string, Promise<void>>();

export async function withAgentLock<T>(
  stateDir: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${stateDir}\0${id}`;
  const mine = held.getStore();
  if (mine?.has(key)) return fn();
  const before = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((r) => (release = r));
  const tail = before.then(() => done);
  tails.set(key, tail);
  await before;
  try {
    return await held.run(new Set([...(mine ?? []), key]), fn);
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}
