/**
 * #176: what the self-update's pin step did for a version
 * (<state>/server-agent/update/pin.json). Written by the running Den
 * (src/ui/server/pin-commit.ts), read by it and by doctor (the CLI).
 */
import * as path from "path";
import { readStateJson } from "./state-backup.js";

/**
 * Issue 1189: why a pin set to push went to a pull request: the branch's
 * rules need one ("rules"), or a push was rejected by one ("rejected").
 * Issue 1195: or the checkout has commits the remote doesn't ("ahead").
 */
export type PinVia = "rules" | "rejected" | "ahead";

export interface PinRecord {
  version: string;
  state:
    | "pushed"
    | "push_failed"
    | "commit_failed"
    | "clean"
    | "held"
    | "branch_pushed"
    | "pr_opened";
  sha?: string;
  /** pr: the pin's own branch, and the pull request's address. */
  branch?: string;
  branchWhy?: string;
  url?: string;
  why?: string;
  /** Issue 1189: set to push, it went to a pull request, and why. */
  via?: PinVia;
  /** The bell has said this failure already. */
  noted?: boolean;
  at: string;
}

export const pinRecordFile = (stateDir: string): string =>
  path.join(stateDir, "server-agent", "update", "pin.json");

export function readPinRecord(stateDir: string): PinRecord | null {
  try {
    const read = readStateJson(stateDir, pinRecordFile(stateDir));
    if (!read.ok) return null;
    const r = read.value as PinRecord;
    return typeof r?.version === "string" && typeof r.state === "string"
      ? r
      : null;
  } catch {
    return null;
  }
}

/** A pull request's number from its address, or null. */
export const pullNumber = (url: string | undefined): string | null =>
  url?.match(/\/pull\/(\d+)/)?.[1] ?? null;

/**
 * Doctor's words for the pin step, or null when there is nothing to say
 * (pushed, nothing to commit, no record). Issue 1189: a fallback to a
 * pull request always says why.
 */
export function pinDoctorText(r: PinRecord | null): string | null {
  if (!r) return null;
  const v = r.version;
  const need =
    r.via === "rules" || r.via === "rejected"
      ? "the branch needs a pull request; "
      : r.via === "ahead"
        ? "the checkout has commits not pushed, so the pin went to a pull request; "
        : "";
  const named =
    r.branchWhy && r.branch
      ? `; its branch is ${r.branch}: ${r.branchWhy}`
      : "";
  switch (r.state) {
    case "pr_opened": {
      const n = pullNumber(r.url);
      const also = r.why ? `; ${r.why}` : "";
      return `pin ${v}: ${need}opened ${n ? `#${n} ` : ""}(${r.url ?? r.branch ?? ""})${also}${named}`;
    }
    case "pushed":
      // Issue 1202: pushed, but the checkout couldn't catch up to it.
      return r.why
        ? `pin ${v}: pushed (${(r.sha ?? "").slice(0, 12)}); ${r.why}`
        : null;
    case "branch_pushed":
      return `pin ${v}: ${need}its branch ${r.branch ?? ""} is pushed, but no pull request yet (${r.why ?? ""})${named}`;
    case "push_failed":
      return `pin ${v}: committed (${(r.sha ?? "").slice(0, 12)}), the push failed; tried again at the next check (${r.why ?? ""})${named}`;
    case "commit_failed":
      return `pin ${v}: not committed; tried again at the next check (${r.why ?? ""})`;
    case "held":
      return `pin ${v}: waits for the person's Allow`;
    default:
      return null;
  }
}
