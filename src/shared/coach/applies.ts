/**
 * Issue 110, Coach Apply: which held write a finding's Apply asked for.
 *
 * A person's Apply asks for the finding's proposal as a held write
 * (POST /api/coach/apply). Den keeps the link, finding id → held write id
 * and when, in coach/applies.json (0600), the newest Apply's per finding.
 * The finding's row then shows its held write's state:
 *
 *   waiting   pending, or running after the Allow
 *   applied   done, and its run worked
 *   denied    denied, expired or taken back: nobody allowed it
 *   failed    done but its run failed, lost, or a held write Den no
 *             longer knows
 *
 * A waiting finding can't be applied again or dismissed.
 */
import * as fs from "fs";
import * as path from "path";
import { writePrivate } from "../agents/records.js";

export interface ApplyLink {
  /** The held write's id (POST /api/approvals). */
  approval: string;
  /** When the person pressed Apply. */
  at: string;
}

export type ApplyState = "waiting" | "applied" | "denied" | "failed";

function appliesFile(stateDir: string): string {
  return path.join(stateDir, "coach", "applies.json");
}

const isLink = (v: unknown): v is ApplyLink =>
  !!v &&
  typeof v === "object" &&
  typeof (v as ApplyLink).approval === "string" &&
  typeof (v as ApplyLink).at === "string";

const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Every finding's link; {} when none, or the file is unreadable. */
export function readApplyLinks(stateDir: string): Record<string, ApplyLink> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(appliesFile(stateDir), "utf-8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  // No prototype, and no key that could be one: a hand-edited file can't
  // set one (Reviewer B, issue 110).
  const out: Record<string, ApplyLink> = Object.create(null);
  for (const [id, v] of Object.entries(raw as Record<string, unknown>))
    if (!BAD_KEYS.has(id) && isLink(v))
      out[id] = { approval: v.approval, at: v.at };
  return out;
}

/** One finding's link, or null. */
export function applyLinkOf(stateDir: string, id: string): ApplyLink | null {
  const links = readApplyLinks(stateDir);
  return Object.hasOwn(links, id) ? links[id] : null;
}

/** Keep finding `id`'s newest Apply: its held write and when. */
export function linkApply(
  stateDir: string,
  id: string,
  approval: string,
  at: string,
): void {
  if (BAD_KEYS.has(id)) return;
  const links = readApplyLinks(stateDir);
  links[id] = { approval, at };
  fs.mkdirSync(path.dirname(appliesFile(stateDir)), { recursive: true });
  writePrivate(appliesFile(stateDir), JSON.stringify(links, null, 2) + "\n");
}

/** A held write's state as its finding's row shows it. */
export function applyStateOf(
  a: { state: string; result?: unknown } | null,
): ApplyState {
  if (!a) return "failed";
  if (a.state === "pending" || a.state === "running") return "waiting";
  if (a.state === "done")
    return (a.result as { ok?: unknown } | undefined)?.ok === false
      ? "failed"
      : "applied";
  if (a.state === "denied" || a.state === "expired" || a.state === "withdrawn")
    return "denied";
  return "failed";
}
