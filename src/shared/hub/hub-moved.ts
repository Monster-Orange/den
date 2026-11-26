import type { MovedProject } from "./hub-project-sync.js";

export interface ArchivedLink {
  ws: string;
  id: string;
  slug: string;
  name: string;
  fromOrigin: string;
}

export interface HubProjectSeen {
  id: string;
  slug: string;
  name: string;
  movedFrom: { hub: string } | null;
}

export interface RelinkDeps {
  lookup: (id: string) => Promise<HubProjectSeen | null>;
  linkedNow: (ws: string) => boolean;
}

export interface RelinkPlan {
  relink: { ws: string; link: { id: string; slug: string; name: string } }[];
  ask: string[];
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

export async function relinkMoved(
  links: ArchivedLink[],
  d: RelinkDeps,
): Promise<RelinkPlan> {
  const out: RelinkPlan = { relink: [], ask: [] };
  const open = links.filter((l) => !d.linkedNow(l.ws));
  const byId = new Map<string, ArchivedLink[]>();
  for (const l of open) byId.set(l.id, [...(byId.get(l.id) ?? []), l]);
  for (const [id, group] of byId) {
    let p: HubProjectSeen | null;
    try {
      p = await d.lookup(id);
    } catch {
      continue;
    }
    if (!p || p.id !== id) continue;
    const from = p.movedFrom ? originOf(p.movedFrom.hub) : "";
    const proven = group.every(
      (l) => !!from && from === originOf(l.fromOrigin),
    );
    if (group.length > 1 || !proven) {
      out.ask.push(...group.map((l) => l.ws));
      continue;
    }
    out.relink.push({
      ws: group[0].ws,
      link: { id: p.id, slug: p.slug, name: p.name },
    });
  }
  return out;
}

export function movedNote(m: MovedProject) {
  let host = m.movedTo.hub;
  try {
    host = new URL(m.movedTo.hub).host;
  } catch {
    host = m.movedTo.hub;
  }
  const hub = m.movedTo.hubName || host;
  return {
    kind: "decision" as const,
    subject: `record:hub-moved:${m.workspace}`,
    scope: `workspace/${m.workspace}`,
    text: `Project ${m.workspace} moved to ${hub}. Switch this install to that Hub to keep it linked.`,
    msg: { key: "bell.m.hubMoved", vars: { project: m.workspace, hub } },
    link: "/settings#agents.hub",
  };
}
