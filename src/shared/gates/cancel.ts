/** Issue 585: stopping a cancelled run's process group (red-first stub). */
export interface StopDeps {
  alive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function stopRun(
  _runPid: number,
  _group: boolean,
  _graceMs: number,
  _d: StopDeps,
): Promise<boolean> {
  return false;
}
