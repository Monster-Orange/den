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
