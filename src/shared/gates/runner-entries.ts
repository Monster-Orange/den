/**
 * Issue 642, slice 1: CI runner entries on test boxes. Settings and a
 * plan only: nothing here starts a runner, reaches a box or calls GitHub.
 *
 *   runner_entries (gate settings.json): a list, empty by default. Each
 *     entry says one repo's CI jobs may run on one test box (issue 625's
 *     `boxes`): the repo, the runner labels its jobs ask for, the repo
 *     variable that routes its jobs to the box or to hosted runners, the
 *     box, how many of its jobs may run there at once, whether a job
 *     takes the box's heavy slot (its gate slots, `browser_slots`), and
 *     who answers for it.
 *
 * An entry widens what runs on a box, so an agent's add or change is a
 * held write the person Allows (gate_runner_entry_set); a person changes
 * them in Settings or with `gate runner`.
 *
 * planRunners is pure: given the queued jobs, the boxes, what runs now
 * and the entries, it says which job may start on which box, and why
 * each other one waits. The box's slot count is its "one heavy job at a
 * time" rule: two repos on a box with one heavy slot never run at once.
 */
import type { BoxCap } from "./boxes.js";
import { BOX_NAME_RE } from "./boxes.js";

/** One repo's runner entry on one box (settings.json, snake_case). */
export interface RunnerEntry {
  /** owner/name on the forge. */
  repo: string;
  /** The runner labels the repo's jobs ask for (runs-on). */
  labels: string[];
  /** The repo variable that routes jobs to the box or to hosted runners. */
  routing_variable: string;
  /** A test box's name (issue 625). */
  box: string;
  /** How many of this repo's jobs may run on the box at once. */
  slots: number;
  /** A job takes one of the box's gate slots (default: yes). */
  heavy: boolean;
  /** Who answers for it: a person, an agent or a team, in words. */
  owner: string;
}

export const RUNNER_ENTRY_LIMITS = {
  slots: { min: 1, max: 64 },
  labels: { min: 1, max: 20 },
} as const;

// The name may hold dots but is never "." or "..": a URL would fold them.
export const REPO_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A forge variable's name: letters, digits, underscore; not a digit first. */
const VAR_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
// eslint-disable-next-line no-control-regex
const OWNER_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;

/** The key of an entry: its repo and box, case-folded. */
export const entryKey = (e: { repo: string; box: string }) =>
  `${e.repo.toLowerCase()}@${e.box}`;

/** An entry from the web, the CLI, an agent or the file; or what is wrong. */
export function checkRunnerEntry(
  v: unknown,
): { ok: true; entry: RunnerEntry } | { ok: false; error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v))
    return { ok: false, error: "a runner entry is an object" };
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? o[k].trim() : "");
  const repo = s("repo");
  if (!REPO_RE.test(repo)) return { ok: false, error: "repo is owner/name" };
  const box = s("box");
  if (!BOX_NAME_RE.test(box))
    return { ok: false, error: `${repo}: box is a test box's name` };
  const rawLabels =
    typeof o.labels === "string"
      ? o.labels.split(",")
      : Array.isArray(o.labels)
        ? o.labels
        : [];
  const labels: string[] = [];
  for (const l of rawLabels) {
    const x = typeof l === "string" ? l.trim() : "";
    if (!x) continue;
    if (!LABEL_RE.test(x))
      return {
        ok: false,
        error: `${repo}: a label is letters, digits, dot, dash or underscore (at most 64)`,
      };
    if (!labels.includes(x)) labels.push(x);
  }
  const L = RUNNER_ENTRY_LIMITS.labels;
  if (labels.length < L.min || labels.length > L.max)
    return {
      ok: false,
      error: `${repo}: give ${L.min} to ${L.max} runner labels (the job's runs-on)`,
    };
  const routing_variable = s("routing_variable");
  if (!VAR_RE.test(routing_variable) || /^GITHUB_/i.test(routing_variable))
    return {
      ok: false,
      error: `${repo}: routing_variable is a repo variable's name (letters, digits, underscore; not GITHUB_…)`,
    };
  let slots = 1;
  if (o.slots !== undefined && o.slots !== null) {
    const n = o.slots;
    const l = RUNNER_ENTRY_LIMITS.slots;
    if (typeof n !== "number" || !Number.isInteger(n) || n < l.min || n > l.max)
      return {
        ok: false,
        error: `${repo}: slots is a whole number from ${l.min} to ${l.max}`,
      };
    slots = n;
  }
  let heavy = true;
  if (o.heavy !== undefined && o.heavy !== null) {
    if (typeof o.heavy !== "boolean")
      return { ok: false, error: `${repo}: heavy is true or false` };
    heavy = o.heavy;
  }
  const owner = s("owner");
  if (!OWNER_RE.test(owner))
    return {
      ok: false,
      error: `${repo}: owner says who answers for it (one line, at most 64)`,
    };
  return {
    ok: true,
    entry: { repo, labels, routing_variable, box, slots, heavy, owner },
  };
}

/** The entries a settings.json holds; a malformed or repeated one is left out. */
export function runnerEntriesOf(raw: unknown): RunnerEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: RunnerEntry[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    const c = checkRunnerEntry(v);
    if (!c.ok || seen.has(entryKey(c.entry))) continue;
    seen.add(entryKey(c.entry));
    out.push(c.entry);
  }
  return out;
}

/** A CI job waiting for a runner, oldest first as given. */
export interface QueuedJob {
  id: string;
  repo: string;
  /** Its runs-on labels: every one must be on the runner. */
  labels: string[];
}

/** A runner job already on a box (started by the plan earlier). */
export interface RunningJob {
  repo: string;
  box: string;
  heavy: boolean;
}

/**
 * A box as the plan sees it: its gate slots, how many are taken now (by
 * any gate holder on it, running heavy runner jobs included), and
 * whether it is open (not held, answering).
 */
export interface PlanBox extends BoxCap {
  used: number;
}

export type PlanWait =
  /** No entry for the job's repo carries all its labels. */
  | "no_entry"
  /** Every box it may use is held, unreachable or not set. */
  | "box_closed"
  /** A box it may use is open, but its slots (or the entry's) are taken. */
  | "full";

export interface RunnerPlan {
  start: { job: string; box: string; repo: string; heavy: boolean }[];
  wait: { job: string; why: PlanWait }[];
}

/** The entries a job may use: its repo, and every label it asks for. */
export function entriesFor(job: QueuedJob, entries: RunnerEntry[]) {
  const repo = job.repo.toLowerCase();
  return entries.filter(
    (e) =>
      e.repo.toLowerCase() === repo &&
      job.labels.every((l) => e.labels.includes(l)),
  );
}

/**
 * Which queued jobs may start now, and on which box. First come, first
 * served: each job, in the order given, takes the first entry (in the
 * entries' order) whose box is open with a free gate slot (for a heavy
 * entry) and whose own slot count is not reached.
 */
export function planRunners(
  jobs: QueuedJob[],
  boxes: PlanBox[],
  running: RunningJob[],
  entries: RunnerEntry[],
): RunnerPlan {
  const plan: RunnerPlan = { start: [], wait: [] };
  const used = new Map(boxes.map((b) => [b.name, b.used]));
  const perEntry = new Map<string, number>();
  for (const r of running) {
    const k = entryKey(r);
    perEntry.set(k, (perEntry.get(k) ?? 0) + 1);
  }
  for (const job of jobs) {
    const mine = entriesFor(job, entries);
    if (!mine.length) {
      plan.wait.push({ job: job.id, why: "no_entry" });
      continue;
    }
    let anyOpen = false;
    const e = mine.find((x) => {
      const b = boxes.find((y) => y.name === x.box);
      if (!b || !b.open) return false;
      anyOpen = true;
      if ((perEntry.get(entryKey(x)) ?? 0) >= x.slots) return false;
      return !x.heavy || (used.get(b.name) ?? 0) < b.slots;
    });
    if (!e) {
      plan.wait.push({ job: job.id, why: anyOpen ? "full" : "box_closed" });
      continue;
    }
    perEntry.set(entryKey(e), (perEntry.get(entryKey(e)) ?? 0) + 1);
    if (e.heavy) used.set(e.box, (used.get(e.box) ?? 0) + 1);
    plan.start.push({ job: job.id, box: e.box, repo: e.repo, heavy: e.heavy });
  }
  return plan;
}
