/**
 * A test run's outcome, one table for every kind, the CLI and MCP
 * (VERIFY-SPEC section 5, issue 207):
 *
 * | Code | Verdict                                         |
 * |------|-------------------------------------------------|
 * | 0    | passed                                          |
 * | 1    | failed (a check failed, errored or was blocked) |
 * | 3    | nothing ran                                     |
 * | 4    | cancelled                                       |
 *
 * Nothing ran and cancelled are never a pass (0.4.45 did this for suites
 * only). The seven old kinds keep their own process exit codes for now;
 * {@link verdictOf} maps them to this table (VERIFY-SPEC section 4).
 */
import type { Pillar } from "./types/index.js";

export const PASSED_EXIT = 0;
export const FAILED_EXIT = 1;
/** Nothing ran: every module was skipped, or none was declared. */
export const NOTHING_RAN_EXIT = 3;
/** A person or an agent stopped the run. */
export const CANCELLED_EXIT = 4;

export type Verdict = "passed" | "failed" | "nothing ran" | "cancelled";

/** The one exit code for each verdict. */
export const VERDICT_EXIT: Readonly<Record<Verdict, number>> = {
  passed: PASSED_EXIT,
  failed: FAILED_EXIT,
  "nothing ran": NOTHING_RAN_EXIT,
  cancelled: CANCELLED_EXIT,
};

/** The seven old test kinds (today's pillars). */
export const OLD_KINDS: readonly Pillar[] = [
  "smoke",
  "synthetic",
  "integration",
  "performance",
  "journeys",
  "security",
  "suites",
];

/**
 * Each old kind's own process codes that are not "failed" (VERIFY-SPEC
 * section 4). Everything else non-zero is failed.
 * - suites, journeys (no specs) and security (no targets) exit 3 when
 *   nothing ran; their own "failed" codes (journeys 2, security 2) are 1 now.
 * - performance runs k6, which exits 105 when it is stopped from outside.
 * - Playwright kinds (smoke, synthetic, integration) exit 0 or 1.
 */
const OLD_EXITS: Readonly<
  Record<
    Pillar,
    { nothingRan: readonly number[]; cancelled: readonly number[] }
  >
> = {
  smoke: { nothingRan: [], cancelled: [] },
  synthetic: { nothingRan: [], cancelled: [] },
  integration: { nothingRan: [], cancelled: [] },
  performance: { nothingRan: [], cancelled: [105] },
  journeys: { nothingRan: [NOTHING_RAN_EXIT], cancelled: [] },
  security: { nothingRan: [NOTHING_RAN_EXIT], cancelled: [] },
  suites: { nothingRan: [NOTHING_RAN_EXIT], cancelled: [] },
};

/** A shell's code for a process stopped by SIGINT (130) or SIGTERM (143). */
const STOPPED_BY_SIGNAL = [130, 143, CANCELLED_EXIT];
const STOP_SIGNALS: readonly string[] = ["SIGINT", "SIGTERM", "SIGHUP"];

export interface ExitFacts {
  /** The signal that ended the process, when one did. */
  signal?: NodeJS.Signals | string | null;
  /** The run was stopped on purpose (Ctrl-C in the CLI, a Cancel). */
  cancelled?: boolean;
}

/**
 * The verdict for a run of `kind` whose process ended with `exitCode`.
 * Works for every kind, old or new; an unknown kind reads the one table.
 */
export function verdictOf(
  kind: Pillar | string,
  exitCode: number | null | undefined,
  facts: ExitFacts = {},
): Verdict {
  if (facts.cancelled) return "cancelled";
  if (facts.signal && STOP_SIGNALS.includes(facts.signal)) return "cancelled";
  if (exitCode === PASSED_EXIT) return "passed";
  if (exitCode === null || exitCode === undefined) return "failed";
  if (STOPPED_BY_SIGNAL.includes(exitCode)) return "cancelled";
  const old = OLD_EXITS[kind as Pillar];
  if (old) {
    if (old.nothingRan.includes(exitCode)) return "nothing ran";
    if (old.cancelled.includes(exitCode)) return "cancelled";
    return "failed";
  }
  if (exitCode === NOTHING_RAN_EXIT) return "nothing ran";
  return "failed";
}

/** The one-table exit code for a run of `kind` that ended with `exitCode`. */
export function exitCodeOf(
  kind: Pillar | string,
  exitCode: number | null | undefined,
  facts: ExitFacts = {},
): number {
  return VERDICT_EXIT[verdictOf(kind, exitCode, facts)];
}

/**
 * Whether a run of `kind` that ended with `exitCode` ran nothing. Every
 * kind, not only suites (issue 207).
 */
export function nothingRan(
  kind: Pillar | string,
  exitCode: number | null | undefined,
): boolean {
  return verdictOf(kind, exitCode) === "nothing ran";
}

/** Whether a run of `kind` that ended with `exitCode` was cancelled. */
export function wasCancelled(
  kind: Pillar | string,
  exitCode: number | null | undefined,
  facts: ExitFacts = {},
): boolean {
  return verdictOf(kind, exitCode, facts) === "cancelled";
}

/**
 * The new form of each old kind (VERIFY-SPEC section 4). A module's name
 * is `<layer>/<name>`; suites become repo checks, not Verify modules.
 */
export const NEW_FORM: Readonly<Record<Pillar, string>> = {
  smoke: "<layer>/<service> with kind smoke",
  synthetic: "<layer>/<name> with kind synthetic and playwright: { config }",
  integration:
    "<layer>/<name> with kind integration, declared in the project's repo",
  performance: "<layer>/<name> with kind performance and k6: { script }",
  journeys:
    "<layer>/<name> with kind synthetic and journey: <file>.journey.yml",
  security: "<layer>/<name> with kind security and zap: { mode, openapi }",
  suites: "a repo check (unit tests and lint), shown apart from Verify",
};

/**
 * The warning an old kind prints when it runs: it still works, and names
 * its new form. Undefined for a kind that is not one of the seven.
 */
export function oldKindWarning(kind: Pillar | string): string | undefined {
  const form = NEW_FORM[kind as Pillar];
  if (!form) return undefined;
  return `⚠ The test kind "${kind}" is retiring. It still runs for now. Its new form is ${form}.`;
}
