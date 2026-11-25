/**
 * Rail pins (issue 402): a pin is an item (a repo or repo/service) and the
 * project picked when it was made, or none. Read by the web server's
 * shell preferences (src/ui/server/shell-prefs.ts) and by doctor, which
 * reports old pins no project holds (issue 1217), so both read a stored
 * list the same way.
 */
import { WORKSPACE_NAME_RE } from "./agent-actor.js";

/**
 * Issue 402 (the model set on 11-18): a pin is (company, project or none,
 * person, item). This store is one person's (user.yml), in one install of
 * one company, so a stored pin carries the rest: the item (`repo` or
 * `repo/service`) and the project picked when it was made, or null (none:
 * pinned under All projects). One item pinned in two projects is two pins.
 */
export interface Pin {
  item: string;
  project: string | null;
}

/**
 * The projects whose repos include an item's repo (index.ts builds it from
 * workspaces.yml): an old id-only pin takes the one project, else none.
 */
export type PinProjects = (item: string) => readonly string[];

/** How many pins the rail keeps (an item in two projects is two). */
export const MAX_PINS = 96;
const PIN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Issue 402, clause 6: a pin saved before the tuple (a bare id) takes the
 * project its repo is in. Issue 1217: in two or more, one pin in each; in
 * none, kept with no project.
 */
function migratePin(item: string, projectsOf?: PinProjects): Pin[] {
  // Issue 1217: never dropped. In each project its repo is in; in none,
  // kept with no project (shown under All).
  const owners = projectsOf ? [...new Set(projectsOf(item))] : [];
  return owners.length
    ? owners.map((project) => ({ item, project }))
    : [{ item, project: null }];
}

/**
 * Issue 402: the projects an item's repo is in (a project's services, or
 * its managed repos), from the projects file's `workspaces`. Shared by the
 * server and doctor, so both move old pins the same way.
 */
export function pinProjectsOf(
  all: Record<string, { services?: object; repos?: object } | undefined>,
): PinProjects {
  return (item) => {
    const repo = item.split("/")[0];
    return Object.entries(all)
      .filter(([, ws]) => {
        const repos = new Set(
          Object.keys(ws?.services ?? {}).map((k) => k.split("/")[0]),
        );
        for (const r of Object.keys(ws?.repos ?? {})) repos.add(r);
        return repos.has(repo);
      })
      .map(([name]) => name);
  };
}

/** One stored or posted entry: its pins, or why it isn't one. */
function entryPins(
  p: unknown,
  projectsOf?: PinProjects,
): { ok: true; value: Pin[] } | { ok: false; error: string } {
  if (typeof p === "string") {
    if (!PIN.test(p))
      return {
        ok: false,
        error: `shell.pins: "${p}" is not a repo or repo/service name`,
      };
    return { ok: true, value: migratePin(p, projectsOf) };
  }
  if (isObject(p)) {
    if (typeof p.item !== "string" || !PIN.test(p.item))
      return {
        ok: false,
        error: `shell.pins: "${String(p.item)}" is not a repo or repo/service name`,
      };
    const project = p.project ?? null;
    if (
      project !== null &&
      (typeof project !== "string" || !WORKSPACE_NAME_RE.test(project))
    )
      return {
        ok: false,
        error: `shell.pins: "${String(project)}" is not a project`,
      };
    return { ok: true, value: [{ item: p.item, project }] };
  }
  return { ok: false, error: `shell.pins: "${String(p)}" is not a pin` };
}

/**
 * A posted list is checked whole: one bad entry, or more than `cap`
 * (MAX_PINS, or the stored list's length when that is more), refuses the
 * save. A stored list (`loading`) is read entry by entry (issue 1217): a
 * bad entry is skipped (pinNotes names it) and no cap is applied, so the
 * person's pins never vanish for one bad line.
 */
export function checkPins(
  v: unknown,
  projectsOf?: PinProjects,
  loading = false,
  cap = MAX_PINS,
): { ok: true; value: Pin[] } | { ok: false; error: string } {
  if (!Array.isArray(v))
    return { ok: false, error: "shell.pins must be a list" };
  const out: Pin[] = [];
  for (const p of v) {
    const e = entryPins(p, projectsOf);
    if (!e.ok) {
      if (loading) continue;
      return e;
    }
    for (const pin of e.value)
      if (!out.some((q) => q.item === pin.item && q.project === pin.project))
        out.push(pin);
  }
  if (!loading && out.length > cap)
    return { ok: false, error: `shell.pins: at most ${cap}` };
  return { ok: true, value: out };
}

/**
 * Issue 1217, for doctor: the stored list's old id-only pins that no
 * project holds (`kept`, shown under All) and the entries skipped as not
 * pins (`skipped`, each as JSON, cut at 80 characters).
 */
export function pinNotes(
  stored: unknown,
  projectsOf?: PinProjects,
): { kept: string[]; skipped: string[] } {
  const out = { kept: [] as string[], skipped: [] as string[] };
  const pins = isObject(stored) ? stored.pins : undefined;
  if (!Array.isArray(pins)) return out;
  for (const p of pins) {
    const e = entryPins(p, projectsOf);
    if (!e.ok) {
      let j: string;
      try {
        j = JSON.stringify(p) ?? String(p);
      } catch {
        j = String(p);
      }
      out.skipped.push(j.length > 80 ? `${j.slice(0, 79)}…` : j);
    } else if (
      typeof p === "string" &&
      e.value.every((x) => x.project === null) &&
      !out.kept.includes(p)
    )
      out.kept.push(p);
  }
  return out;
}

/** Issue 402: the items pinned, each once, whatever their project. */
export function pinnedItems(pins: readonly Pin[]): string[] {
  return [...new Set(pins.map((p) => p.item))];
}
