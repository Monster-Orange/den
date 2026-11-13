/**
 * 0.4.44: the Hub links this install has had, so doctor can say when one
 * went missing. Every write of workspaces.yml notes the projects linked
 * then; only an unlink the person asked for (setHubProject(ws, null))
 * forgets one. A project that had a link, still exists, and has none now
 * lost it some other way: doctor warns.
 *
 * <state>/hub/links-seen.json: { "<ws>": { id, slug, at } }. Ids and slugs
 * only, no secrets.
 */
import * as fs from "fs";
import * as path from "path";
import { getStateDir } from "./paths.js";

export interface LinkSeen {
  id: string;
  slug: string;
  at: string;
}

const file = () => path.join(getStateDir(), "hub", "links-seen.json");

export function readLinksSeen(): Record<string, LinkSeen> {
  try {
    const v = JSON.parse(fs.readFileSync(file(), "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, LinkSeen>) : {};
  } catch {
    return {};
  }
}

function write(v: Record<string, LinkSeen>): void {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, f);
}

/** Note the projects linked in `workspaces` (best effort). */
export function noteLinksSeen(
  workspaces: Record<string, { hub_project?: unknown } | undefined>,
): void {
  try {
    const seen = readLinksSeen();
    let changed = false;
    for (const [ws, cfg] of Object.entries(workspaces)) {
      const l = cfg?.hub_project as { id?: unknown; slug?: unknown } | undefined;
      if (!l || typeof l.id !== "string") continue;
      const slug = typeof l.slug === "string" ? l.slug : l.id;
      if (seen[ws]?.id === l.id && seen[ws]?.slug === slug) continue;
      seen[ws] = { id: l.id, slug, at: new Date().toISOString() };
      changed = true;
    }
    if (changed) write(seen);
  } catch {
    /* best effort */
  }
}

/** The person unlinked `ws`: no warning for it. */
export function forgetLinkSeen(ws: string): void {
  try {
    const seen = readLinksSeen();
    if (!(ws in seen)) return;
    delete seen[ws];
    write(seen);
  } catch {
    /* best effort */
  }
}

/**
 * Projects that had a Hub link and, still here, have none: [{ws, was}].
 */
export function lostHubLinks(
  workspaces: Record<string, { hub_project?: unknown } | undefined>,
): { ws: string; was: LinkSeen }[] {
  const seen = readLinksSeen();
  return Object.entries(seen)
    .filter(([ws]) => {
      const cfg = workspaces[ws];
      if (!cfg) return false;
      const l = cfg.hub_project as { id?: unknown } | undefined;
      return !l || typeof l.id !== "string";
    })
    .map(([ws, was]) => ({ ws, was }));
}
