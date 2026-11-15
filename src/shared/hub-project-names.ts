/**
 * 0.4.45: Hub's names reach Den. A project linked to a Hub project shows
 * Hub's name (projectDisplayName); the link keeps a copy of it, taken when
 * the project was linked. This brings the copy up to date: Den asks Hub
 * for its projects (the suggest route's list) and rewrites a link whose
 * Hub name or slug changed, matched by the Hub project's id.
 *
 * A Hub project missing from the list, or a Hub that doesn't answer,
 * changes nothing here: doctor speaks to a link that is lost.
 */
import * as fs from "fs";
import * as path from "path";
import type { HubProjectLink } from "./hub-project-link.js";

export interface HubNamesDeps {
  /** Every project linked to Hub, with its stored link. */
  linked: () => [string, HubProjectLink][];
  /** Hub's projects now, or null when it can't say. */
  hubProjects: () => Promise<
    { id: string; slug: string; name: string }[] | null
  >;
  write: (ws: string, link: HubProjectLink) => void;
  /** Issue 167: whether Hub answered this check (recordHubNamesCheck). */
  checked?: (ok: boolean) => void;
  /**
   * Issue 167: Hub's name now for each linked project it lists, changed or
   * not (a rename waiting in Hub ends when this brings its name).
   */
  named?: (ws: string, name: string) => void;
}

/** The projects whose link changed. */
export async function refreshHubNames(d: HubNamesDeps): Promise<string[]> {
  const linked = d.linked();
  if (!linked.length) return [];
  let hub: Awaited<ReturnType<HubNamesDeps["hubProjects"]>>;
  try {
    hub = await d.hubProjects();
  } catch {
    d.checked?.(false);
    return [];
  }
  d.checked?.(hub !== null && hub !== undefined);
  if (!hub?.length) return [];
  const byId = new Map(hub.map((p) => [p.id, p]));
  const changed: string[] = [];
  for (const [ws, link] of linked) {
    const now = byId.get(link.id);
    if (!now?.name?.trim()) continue;
    try {
      d.named?.(ws, now.name);
    } catch {
      /* the next check */
    }
    if (now.name === link.name && now.slug === link.slug) continue;
    try {
      d.write(ws, { id: link.id, slug: now.slug, name: now.name });
      changed.push(ws);
    } catch {
      /* the project went meanwhile: the next check */
    }
  }
  return changed;
}

/**
 * Issue 167 (mock v6 A6): when Hub last answered a check of its names, and
 * when it last didn't, in the state folder. The Name row says Hub can't be
 * reached when the failure is the newer, and how old the name is.
 */
export const HUB_NAMES_CHECK_FILE = "hub-names-check.json";

export interface HubNamesCheck {
  okAt?: string;
  failAt?: string;
}

const iso = (v: unknown): string | undefined =>
  typeof v === "string" && !Number.isNaN(Date.parse(v))
    ? new Date(v).toISOString()
    : undefined;

export function readHubNamesCheck(stateDir: string): HubNamesCheck {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(stateDir, HUB_NAMES_CHECK_FILE), "utf-8"),
    ) as Record<string, unknown>;
    const okAt = iso(v.okAt);
    const failAt = iso(v.failAt);
    return { ...(okAt ? { okAt } : {}), ...(failAt ? { failAt } : {}) };
  } catch {
    return {};
  }
}

export function recordHubNamesCheck(
  stateDir: string,
  ok: boolean,
  now: Date = new Date(),
): void {
  const next = {
    ...readHubNamesCheck(stateDir),
    [ok ? "okAt" : "failAt"]: now.toISOString(),
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const file = path.join(stateDir, HUB_NAMES_CHECK_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* the next check writes it */
  }
}
