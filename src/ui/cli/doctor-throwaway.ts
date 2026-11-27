/**
 * Issue 1263: doctor's row for throwaway containers (den.ephemeral=1) left
 * over from gate runs. One whose run has no live slot is ⚠: Den's sweeper
 * removes it within minutes of the run's end, so one still here means Den
 * isn't running, or docker refused. One started outside a gate run (no run
 * label) is listed, never removed and never a warning: it may be a test
 * running now. Issue 1289: a kept container (den.ephemeral=stop) stopped is
 * counted apart, never as left over; one running with no live run from its
 * checkout is listed (someone's own use outside the gate, or one the
 * sweeper is about to stop), never a warning. Doctor only reads; it
 * removes nothing.
 */
import type { OnboardCheck } from "./doctor-onboard.js";
import type { Throwaway } from "../../shared/gates/ephemeral.js";

export function throwawayLines(
  list: Throwaway[] | null,
  live: Set<string>,
  /** This machine's slot store tag: another store's runs aren't judged. */
  tag?: string,
  /** Issue 1289: the checkouts with a live slot. */
  liveCheckouts: Set<string> = new Set(),
  sweep = true,
): { lines: string[]; check: OnboardCheck } {
  const id = "gate_throwaway_containers";
  const off = sweep
    ? ""
    : "the sweep is off (gate.throwaway_sweep 0), so Den removes none; ";
  if (list === null)
    return {
      lines: [],
      check: {
        id,
        status: "ok",
        detail: `${off}docker didn't answer: throwaway containers not checked`,
      },
    };
  const mine = (b: Throwaway) => !tag || !b.store || b.store === tag;
  const kept = list.filter((b) => b.mode === "stop");
  const removable = list.filter((b) => b.mode !== "stop");
  const left = removable.filter((b) => b.run && mine(b) && !live.has(b.run));
  const loose = removable.filter((b) => !b.run);
  const stopped = kept.filter((b) => b.state !== "running");
  const idle = kept.filter(
    (b) =>
      b.state === "running" &&
      b.checkout &&
      mine(b) &&
      !liveCheckouts.has(b.checkout),
  );
  const keptNote = stopped.length ? `; ${stopped.length} kept (stopped)` : "";
  const lines = [
    ...idle.map(
      (b) =>
        `  · ${b.id} ${b.image}: kept, running with no gate run from its checkout (stopped by the sweeper if a run left it; left alone if started since)`,
    ),
    ...left.map(
      (b) => `  ⚠ ${b.id} ${b.image}: its gate run ${b.run} has ended`,
    ),
    ...loose.map(
      (b) =>
        `  · ${b.id} ${b.image}: no gate run${b.created ? ` (created ${b.created})` : ""}; remove it by hand when its test is done`,
    ),
  ];
  if (left.length)
    return {
      lines,
      check: {
        id,
        status: "warn",
        detail: `${off}${left.length} left over from ended gate runs${keptNote}`,
        fix: sweep
          ? "start Den (it removes left-over ones and stops idle kept ones within minutes), or docker rm -f the left-over ids and docker stop the kept ones"
          : "turn the sweep on (gate settings --throwaway-sweep 1, or gate.throwaway_sweep in Settings), or docker rm -f the left-over ids and docker stop the kept ones",
      },
    };
  return {
    lines,
    check: {
      id,
      status: "ok",
      detail:
        off +
        (idle.length
          ? `${idle.length} kept and running outside a gate run; `
          : "") +
        (loose.length
          ? `none left over from gate runs; ${loose.length} started outside one`
          : "none left over") +
        keptNote,
    },
  };
}
