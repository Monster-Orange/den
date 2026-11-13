/**
 * Stop a session the way closing its terminal does: HUP (an interactive
 * shell ignores TERM, not HUP), then, if it is still running after
 * `graceMs`, KILL. Used by `sessions kill` (no --signal) and the page's
 * Close.
 *
 * A session host started before 0.4.40 doesn't know HUP and refuses it
 * (bad-request): it gets TERM instead, then KILL after the same grace, so
 * an upgrade needs no host restart (the 0.4.40 gate's item g).
 */
import { HostError, type HostClient } from "./client.js";

export type StopResult = "stopped" | "killed" | "gone";

export async function stopSession(
  c: Pick<HostClient, "kill" | "list">,
  id: string,
  graceMs: number,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  /** Told which signal went first: HUP, or TERM on an older host. */
  onSent?: (signal: "HUP" | "TERM") => void,
): Promise<StopResult> {
  const running = async () =>
    (await c.list()).some((s) => s.ref.id === id && !s.exited);
  if (!(await running())) return "gone";
  try {
    await c.kill(id, "HUP");
    onSent?.("HUP");
  } catch (e) {
    if (!(e instanceof HostError && e.code === "bad-request")) throw e;
    await c.kill(id, "TERM");
    onSent?.("TERM");
  }
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
