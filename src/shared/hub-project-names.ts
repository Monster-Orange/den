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
import type { HubProjectLink } from "./hub-project-link.js";

export interface HubNamesDeps {
  /** Every project linked to Hub, with its stored link. */
  linked: () => [string, HubProjectLink][];
  /** Hub's projects now, or null when it can't say. */
  hubProjects: () => Promise<
    { id: string; slug: string; name: string }[] | null
  >;
  write: (ws: string, link: HubProjectLink) => void;
}

/** The projects whose link changed. */
export async function refreshHubNames(d: HubNamesDeps): Promise<string[]> {
  const linked = d.linked();
  if (!linked.length) return [];
  let hub: Awaited<ReturnType<HubNamesDeps["hubProjects"]>>;
  try {
    hub = await d.hubProjects();
  } catch {
    return [];
  }
  if (!hub?.length) return [];
  const byId = new Map(hub.map((p) => [p.id, p]));
  const changed: string[] = [];
  for (const [ws, link] of linked) {
    const now = byId.get(link.id);
    if (!now?.name?.trim()) continue;
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
