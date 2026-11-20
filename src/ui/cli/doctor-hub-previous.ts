/**
 * Issue 726: doctor's rows for state from an earlier Hub. Read from Den's
 * files only (no server, no Hub, never a token):
 *
 *   hub previous  ✓ archived state (which Hub, when, the project links it
 *                   took, and the folder), or ⚠ state still bound to
 *                   another Hub than hub.url (a change Den hasn't applied:
 *                   it does at its next start).
 *   hub token     ⚠ a token an earlier Hub couldn't revoke (which Hub, when
 *                   and why). Den tries again at each start.
 */
import type {
  ArchivedHub,
  HubBinding,
  UnrevokedToken,
} from "../../shared/hub-binding.js";
import { hubOrigin } from "../../shared/hub-binding.js";
import type { OnboardCheck } from "./doctor-onboard.js";

const hubName = (b: HubBinding | null) =>
  b ? `${b.origin}${b.company ? ` (${b.company})` : ""}` : "an earlier Hub";

export function previousHubLines(o: {
  /** hub.url now, or null. */
  current: string | null;
  bound: HubBinding | null;
  previous: ArchivedHub[];
  unrevoked: UnrevokedToken[];
}): { lines: string[]; checks: OnboardCheck[] } {
  const lines: string[] = [];
  const checks: OnboardCheck[] = [];
  const now = o.current ? hubOrigin(o.current) : "";
  const leftover = !!(o.bound && now && o.bound.origin !== now);
  let detail: string;
  if (leftover)
    detail = `this install's Hub state (comment delivery, project links) is still ${hubName(o.bound)}'s, not ${now}'s: restart Den, and it archives that state and offers the projects again`;
  else if (o.previous.length) {
    const last = o.previous[o.previous.length - 1];
    const n = last.projects.length;
    detail = `state from ${o.previous.length === 1 ? "an earlier Hub" : `${o.previous.length} earlier Hubs`} is archived; the last, ${hubName(last.from)}, at ${last.at}, with ${n} project link${n === 1 ? "" : "s"}, in ${last.dir}`;
  } else detail = "no state from an earlier Hub";
  lines.push(`  hub previous  ${leftover ? "⚠" : "✓"}  ${detail}`);
  checks.push({
    id: "hub:previous",
    status: leftover ? "warn" : "ok",
    detail,
  });
  if (o.unrevoked.length) {
    const rows = o.unrevoked.map(
      (u) =>
        `a token for ${u.url} couldn't be revoked there (${u.why}, ${u.at}); it was removed here, and Den tries the revoke again at each start. An admin of that Hub can revoke this install there now`,
    );
    for (const r of rows) lines.push(`  hub token  ⚠  ${r}`);
    checks.push({
      id: "hub:unrevoked",
      status: "warn",
      detail: rows.join("; "),
    });
  } else
    checks.push({
      id: "hub:unrevoked",
      status: "ok",
      detail: "no token from an earlier Hub waits on a revoke",
    });
  return { lines, checks };
}

/** The rows for this install, from its state dir and hub.url. */
export async function previousHubDoctor(
  stateDir: string,
  current: string | null,
): Promise<ReturnType<typeof previousHubLines>> {
  const m = await import("../../shared/hub-binding.js");
  return previousHubLines({
    current,
    bound: m.readHubBinding(stateDir),
    previous: m.listPreviousHubs(stateDir),
    unrevoked: m.readUnrevoked(stateDir),
  });
}
