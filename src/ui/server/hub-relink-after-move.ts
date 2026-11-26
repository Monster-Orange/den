import * as fs from "fs";
import * as path from "path";
import { hubOrigin, listPreviousHubs } from "../../shared/hub-binding.js";
import { relinkMoved, type ArchivedLink } from "../../shared/hub-moved.js";
import {
  parseHubProjectLink,
  type HubProjectLink,
} from "../../shared/hub-project-link.js";

export interface RelinkAfterMoveDeps {
  stateDir: () => string;
  lookup: (id: string) => Promise<{
    id: string;
    slug: string;
    name: string;
    movedFrom: { hub: string } | null;
  } | null>;
  linkOf: (ws: string) => { id: string } | null;
  link: (ws: string, l: HubProjectLink) => void;
  picked: (n: number) => void;
}

function archivedLinks(stateDir: string, origin: string): ArchivedLink[] {
  const a = listPreviousHubs(stateDir)
    .filter((x) => x.to.url && hubOrigin(x.to.url) === origin && x.from)
    .at(-1);
  if (!a?.from) return [];
  let links: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(a.dir, "from.json"), "utf-8"),
    ) as { links?: Record<string, unknown> } | null;
    links = raw?.links ?? {};
  } catch {
    return [];
  }
  const fromOrigin = a.from.origin;
  return Object.entries(links).flatMap(([ws, v]) => {
    const l = parseHubProjectLink(v);
    return l ? [{ ws, id: l.id, slug: l.slug, name: l.name, fromOrigin }] : [];
  });
}

export async function relinkAfterMove(
  hubUrl: string,
  company: string | undefined,
  d: RelinkAfterMoveDeps,
): Promise<{ relinked: string[]; ask: string[] }> {
  const origin = hubOrigin(hubUrl);
  const links = archivedLinks(d.stateDir(), origin);
  if (!links.length) return { relinked: [], ask: [] };
  const plan = await relinkMoved(links, {
    lookup: d.lookup,
    linkedNow: (ws) => {
      try {
        return !!d.linkOf(ws);
      } catch {
        return true;
      }
    },
  });
  const relinked: string[] = [];
  for (const r of plan.relink) {
    try {
      d.link(r.ws, {
        ...r.link,
        hub: { origin, ...(company ? { company } : {}) },
      });
      relinked.push(r.ws);
    } catch {
      plan.ask.push(r.ws);
    }
  }
  if (relinked.length) d.picked(relinked.length);
  return { relinked, ask: plan.ask };
}
