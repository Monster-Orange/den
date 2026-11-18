/**
 * Issue 271: create a Hub project for a Den project from Den, and link it
 * once an owner allows it in Hub. Settings › Project › Hub project and the
 * server agent's held write (hub_project_create) run this same code.
 *
 *   askHubCreate     asks Hub with its project plan path (hubPlanCreate:
 *                    POST /api/projects/plan, a create an owner decides in
 *                    Hub) and keeps the ask next to the project:
 *                    `<ws>.hub_create: {held, name, slug, url?, askedAt,
 *                    by, agent?, outcome?}` in config/local/workspaces.yml
 *   settleHubCreate  reads what became of it (hubPlanOutcome). applied:
 *                    links by the new project's hidden id (projects[].id,
 *                    no lookup) and drops the ask; declined or superseded:
 *                    keeps the ask with its outcome, so Settings can say
 *                    so, and a new ask may be made
 *
 * 1:1 (0.4.45, Projects follow Connect): a project already linked, or one
 * with an ask waiting, is refused before Hub is asked.
 */
import type { HubCaller, HubPlanAsk, HubPlanOutcome } from "./hub.js";
import type { HubProjectLink } from "./hub-project-link.js";

/** What became of an ask, once Hub decided (none: still waiting). */
export type HubCreateOutcome = "declined" | "superseded";

/** A create asked of Hub, kept next to the project. */
export interface HubCreate {
  /** Hub's held change id. */
  held: string;
  /** The name and short name asked for. */
  name: string;
  slug: string;
  /** Hub's page where an owner allows it (http(s) only). */
  url?: string;
  askedAt: string;
  /** A person in Settings, or an agent (the held write). */
  by: "person" | "agent";
  /** The agent's id, when an agent asked. */
  agent?: string;
  /** Set once Hub declined it, or it was superseded (ask again). */
  outcome?: HubCreateOutcome;
}

const plain = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        .replace(/[^\x20-\x7e\u00a0-\uffff]/g, "")
        .trim()
        .slice(0, max)
    : "";

/** A kept ask, checked: null when missing or bad. */
export function parseHubCreate(v: unknown): HubCreate | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const held = plain(o.held, 100);
  const name = plain(o.name, 200);
  const slug = plain(o.slug, 100);
  if (!held || !name || !slug) return null;
  const url = plain(o.url, 2048);
  const at = typeof o.askedAt === "string" ? Date.parse(o.askedAt) : NaN;
  const agent = plain(o.agent, 100);
  return {
    held,
    name,
    slug,
    ...(/^https?:\/\//.test(url) ? { url } : {}),
    askedAt: new Date(Number.isNaN(at) ? 0 : at).toISOString(),
    by: o.by === "agent" ? "agent" : "person",
    ...(agent ? { agent } : {}),
    ...(o.outcome === "declined" || o.outcome === "superseded"
      ? { outcome: o.outcome }
      : {}),
  };
}

export interface HubCreateDeps {
  exists: (ws: string) => boolean;
  linked: (ws: string) => HubProjectLink | null;
  /** The ask kept for `ws`, or null. */
  asked: (ws: string) => HubCreate | null;
  /** Hub's address and this install's token; null: not connected. */
  hub: () => Promise<{ url: string; token: string } | null>;
  /** The short names Hub's projects have now (skipped when proposing). */
  taken: () => Promise<string[]>;
  /** Keep the ask for `ws`, or drop it (null). `by`: the audit row. */
  keep: (ws: string, c: HubCreate | null, by?: string) => void;
  /** Link `ws` to the new Hub project (setHubProject). */
  link: (ws: string, l: HubProjectLink, by?: string) => void;
  /** After a link: send the project list again (agents see it). */
  changed: () => void;
  /** Hub's calls (the defaults: shared/hub.ts). */
  plan?: (
    url: string,
    token: string,
    ask: {
      name: string;
      reason: string;
      taken?: readonly string[];
      caller?: HubCaller;
    },
  ) => Promise<HubPlanAsk>;
  outcome?: (
    url: string,
    token: string,
    held: string,
  ) => Promise<HubPlanOutcome>;
  now?: () => Date;
}

export type HubCreateRefusal = {
  ok: false;
  status: number;
  code: "missing" | "name" | "linked" | "waiting" | "offline" | "hub";
  error: string;
};

/** Issue 271: the longest name Hub takes for a project. */
const NAME_MAX = 80;

/**
 * Ask Hub for a new project named `name` for Den project `ws`. A person
 * asks from Settings; an agent through the held write, with its id and
 * name (`agent`), so Hub's answer reaches it.
 */
export async function askHubCreate(
  d: HubCreateDeps,
  a: {
    ws: string;
    name: string;
    by: "person" | "agent";
    agent?: { id: string; name: string };
    /** Who asked, for the audit row. */
    auditBy?: string;
  },
): Promise<{ ok: true; ask: HubCreate } | HubCreateRefusal> {
  const no = (
    status: number,
    code: HubCreateRefusal["code"],
    error: string,
  ): HubCreateRefusal => ({ ok: false, status, code, error });
  if (!d.exists(a.ws))
    return no(404, "missing", `there is no project "${a.ws}"`);
  const name = String(a.name ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > NAME_MAX)
    return no(400, "name", `name: 1 to ${NAME_MAX} characters`);
  const linked = d.linked(a.ws);
  if (linked)
    return no(
      409,
      "linked",
      `"${a.ws}" is already linked to the Hub project ${linked.name}: one Hub project per project.`,
    );
  const was = d.asked(a.ws);
  if (was && !was.outcome)
    return no(
      409,
      "waiting",
      `Hub has an ask for "${was.name}" waiting for an owner; Den links it when they allow it.`,
    );
  const at = await d.hub().catch(() => null);
  if (!at)
    return no(
      409,
      "offline",
      "This install isn't connected to Hub. Connect it first.",
    );
  const taken = await d.taken().catch(() => [] as string[]);
  const reason =
    a.by === "agent"
      ? `Asked by the agent ${a.agent?.name ?? "Den"} in Den, for project "${a.ws}"`
      : `Asked in Den, Settings › Project › Hub project, for "${a.ws}"`;
  const plan: NonNullable<HubCreateDeps["plan"]> =
    d.plan ?? (await import("./hub.js")).hubPlanCreate;
  let held: HubPlanAsk;
  try {
    held = await plan(at.url, at.token, {
      name,
      reason,
      taken,
      ...(a.agent
        ? {
            caller: {
              agent: a.agent.name,
              agentId: a.agent.id,
              session: `held-${a.agent.id}`,
              workspace: a.ws,
              repos: [],
            },
          }
        : {}),
    });
  } catch (e) {
    return no(502, "hub", (e as Error).message);
  }
  const ask: HubCreate = {
    held: held.held,
    name: held.name,
    slug: held.slug,
    ...(held.url ? { url: held.url } : {}),
    askedAt: (d.now?.() ?? new Date()).toISOString(),
    by: a.by,
    ...(a.agent ? { agent: a.agent.id } : {}),
  };
  d.keep(
    a.ws,
    ask,
    a.auditBy ?? `asked Hub to create the project ${held.slug}`,
  );
  return { ok: true, ask };
}

export type HubCreateSettled =
  | { state: "none" | "pending" | HubCreateOutcome }
  | { state: "applied"; hub: HubProjectLink };

/**
 * What became of `ws`'s ask, read from Hub; applied: linked here. Hub not
 * answering leaves it pending. A project linked meanwhile drops the ask.
 */
export async function settleHubCreate(
  d: HubCreateDeps,
  ws: string,
): Promise<HubCreateSettled> {
  const ask = d.asked(ws);
  if (!ask) return { state: "none" };
  if (ask.outcome) return { state: ask.outcome };
  if (d.linked(ws)) {
    d.keep(ws, null, "Hub (the project was linked meanwhile)");
    return { state: "none" };
  }
  const at = await d.hub().catch(() => null);
  if (!at) return { state: "pending" };
  const read: NonNullable<HubCreateDeps["outcome"]> =
    d.outcome ?? (await import("./hub.js")).hubPlanOutcome;
  let o: HubPlanOutcome;
  try {
    o = await read(at.url, at.token, ask.held);
  } catch {
    return { state: "pending" };
  }
  if (o.state === "pending") return { state: "pending" };
  if (o.state === "applied") {
    const made =
      o.projects.find((p) => p.id && p.slug === ask.slug) ??
      o.projects.find((p) => p.id);
    if (!made?.id) return { state: "pending" };
    const hub = { id: made.id, slug: made.slug, name: made.name };
    d.link(ws, hub, "Hub (an owner allowed the new project)");
    d.keep(ws, null, "Hub (the new project is linked)");
    d.changed();
    return { state: "applied", hub };
  }
  d.keep(
    ws,
    { ...ask, outcome: o.state },
    `Hub (the new project was ${o.state})`,
  );
  return { state: o.state };
}
