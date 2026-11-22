/**
 * Issue 786 clause 5: save on shutdown. When macOS (launchd, at logout or
 * shutdown) or Linux (systemd) stops Den, it sends SIGTERM; a closed
 * terminal sends SIGHUP. Den's processes end through process.exit, and
 * every pending save registered here runs first, synchronously, on the
 * process's "exit" event: every exit path, a signal's included, reaches it.
 *
 * A save is a plain function. One that throws never stops the others, and
 * each runs once per process.
 */

const pending = new Map<string, () => void>();
let installed = false;
let flushed = false;

/** Register (or replace) the save named `name`; returns the way to drop it. */
export function onShutdownFlush(name: string, save: () => void): () => void {
  pending.set(name, save);
  return () => {
    if (pending.get(name) === save) pending.delete(name);
  };
}

/** Run every registered save now, once. Returns the names that failed. */
export function flushPendingState(): string[] {
  if (flushed) return [];
  flushed = true;
  const failed: string[] = [];
  for (const [name, save] of pending) {
    try {
      save();
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

/** Flush on this process's exit, whatever ends it (installed once). */
export function installExitFlush(proc: NodeJS.Process = process): void {
  if (installed) return;
  installed = true;
  proc.on("exit", () => {
    flushPendingState();
  });
}

/** Tests: forget every save and let a flush run again. */
export function resetShutdownFlushForTests(): void {
  pending.clear();
  flushed = false;
}
