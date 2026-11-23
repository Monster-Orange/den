/**
 * Issue 1263: doctor's row for throwaway containers (den.ephemeral=1) left
 * over from gate runs. One whose run has no live slot is ⚠: Den's sweeper
 * removes it within minutes of the run's end, so one still here means Den
 * isn't running, or docker refused. One started outside a gate run (no run
 * label) is listed, never removed and never a warning: it may be a test running
 * now. Doctor only reads; it removes nothing.
 */
import type { OnboardCheck } from "./doctor-onboard.js";
import type { Throwaway } from "../../shared/gates/ephemeral.js";

export function throwawayLines(
  list: Throwaway[] | null,
  live: Set<string>,
  /** This machine's slot store tag: another store's runs aren't judged. */
  tag?: string,
): { lines: string[]; check: OnboardCheck } {
  const id = "gate_throwaway_containers";
  if (list === null)
    return {
      lines: [],
      check: {
        id,
        status: "ok",
        detail: "docker didn't answer: throwaway containers not checked",
      },
    };
  const mine = (b: Throwaway) => !tag || !b.store || b.store === tag;
  const left = list.filter((b) => b.run && mine(b) && !live.has(b.run));
  const loose = list.filter((b) => !b.run);
  const lines = [
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
        detail: `${left.length} left over from ended gate runs`,
        fix: "start Den (it removes them within minutes), or docker rm -f the ids listed",
      },
    };
  return {
    lines,
    check: {
      id,
      status: "ok",
      detail: loose.length
        ? `none left over from gate runs; ${loose.length} started outside one`
        : "none left over",
    },
  };
}
