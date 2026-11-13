/**
 * Stop a session the way closing its terminal does: HUP (an interactive
 * shell ignores TERM, not HUP), then, if it is still running after
 * `graceMs`, KILL. Used by `sessions kill` (no --signal) and the page's
 * Close.
 */
import type { HostClient } from "./client.js";

export type StopResult = "stopped" | "killed" | "gone";

export async function stopSession(
  c: Pick<HostClient, "kill" | "list">,
  id: string,
  graceMs: number,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<StopResult> {
  const running = async () =>
    (await c.list()).some((s) => s.ref.id === id && !s.exited);
  if (!(await running())) return "gone";
  await c.kill(id, "HUP");
  const end = Date.now() + graceMs;
  while (Date.now() < end) {
    await sleep(Math.min(100, Math.max(1, end - Date.now())));
    if (!(await running())) return "stopped";
  }
  if (!(await running())) return "stopped";
  try {
    await c.kill(id, "KILL");
  } catch {
    // It ended between the look and the signal.
    return "stopped";
  }
  return "killed";
}
