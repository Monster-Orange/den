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
 *   hub token     ⚠ a kept token whose record is gone: named by id (never
 *                   its value), revoked at its Hub by a person, then
 *                   cleared by hub_token_forget (their Allow). No retry.
 */
import type {
  ArchivedHub,
  HubBinding,
  OrphanToken,
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
  /** Kept tokens without a record Den can read (default: none). */
  orphans?: OrphanToken[];
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
  const orphans = o.orphans ?? [];
  if (orphans.length) {
    // Where to look: the earlier Hubs this install's archive names.
    const earlier = [
      ...new Set(
        o.previous.map((p) => p.from?.origin).filter((x): x is string => !!x),
      ),
    ];
    const look = earlier.length
      ? ` (earlier Hubs this install was on: ${earlier.join(", ")})`
      : "";
    const rows = orphans.map((t) =>
      t.stuck
        ? // Reviewer C: the record may name the Hub, so Den never forgets it.
          `a Hub token Den kept to revoke later has a record Den can't read or move (id ${t.id}, kept ${t.at}): hub/unrevoked/${t.id}.json in the state folder. It may name the Hub${look}: revoke this install's token on that Hub's tokens page, then remove that file, and Den's agent can forget the token (hub_token_forget, id ${t.id}; you Allow it)`
        : `a Hub token Den kept to revoke later has lost its record (id ${t.id}, kept ${t.at}), so Den doesn't know which Hub it is for and leaves it alone.${t.kept ? ` A copy of the record Den couldn't read is in backup/${t.kept} in the state folder, and may name the Hub.` : ""} Revoke this install's token on that Hub's tokens page${look}, then have Den's agent forget it (hub_token_forget, id ${t.id}; you Allow it)`,
    );
    for (const r of rows) lines.push(`  hub token  ⚠  ${r}`);
    checks.push({
      id: "hub:orphan-token",
      status: "warn",
      detail: rows.join("; "),
    });
  } else
    checks.push({
      id: "hub:orphan-token",
      status: "ok",
      detail: "every kept Hub token has its record",
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
    orphans: m.readOrphanTokens(stateDir),
  });
}
