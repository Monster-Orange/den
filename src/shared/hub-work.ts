/**
 * Issue 754, "Den shows the work": what Hub knows about the work, read
 * through this install's Hub connection, for the home page's Work in Hub
 * card and the Agents page's rows. Den stores none of it: the last answer
 * is kept in memory only, to draw the page while Hub is briefly away.
 *
 * CONTRACT per den#754; confirm with Hub (its routes ship in Hub 0.2.32,
 * not built when this was written). Every Hub shape Den reads is here:
 *
 *   GET <hub>/api/projects/:project/work   (:project = Hub's project id)
 *     → { needs_you, building, blocked, visions: [{ id, title, url, done, total }] }
 *       each count is { count, url } (a bare number is read as a count with
 *       no link).
 *   GET <hub>/api/agents/current?agent_ids=<id>,<id>   (Den's agent ids,
 *       the X-Den-Agent-Id Den already sends)
 *     → [{ agent_id, item: { id, title, kind, url } | null,
 *          vision: { id, title, url } | null,
 *          source: "working" | "recent", since }]
 *       (or { agents: [...] }).
 *
 * Hub's refusals are { error, code }: `code` is the machine's word,
 * `error` is text for people. A 403 means no card: a plan code (such as
 * "groups_not_in_plan") shows the quiet plan line; any other 403 shows
 * "Hub refused: <error>". No Hub connected: the quiet line to Connect. A
 * 404 is a Hub that hasn't the route yet: nothing shows.
 */
import {
  HubCallError,
  hubAgentsCurrent,
  hubProjectWork,
  readHubConfig,
  readHubToken,
  type HubConfig,
} from "./hub.js";
import { hubProjectOf, type HubProjectLink } from "./hub-project-link.js";

export interface WorkCount {
  count: number;
  /** Where it opens on Hub; null when Hub gave no http(s) link. */
  url: string | null;
}

export interface WorkVision {
  id: string;
  title: string;
  url: string | null;
  done: number;
  total: number;
}

export interface ProjectWork {
  needsYou: WorkCount;
  building: WorkCount;
  blocked: WorkCount;
  visions: WorkVision[];
}

export interface HubRef {
  id: string;
  title: string;
  url: string | null;
}

export interface AgentCurrent {
  item: (HubRef & { kind: string }) | null;
  vision: HubRef | null;
  source: "working" | "recent";
  since: string | null;
}

/**
 * Hub's 403, as Den's page is told it: `plan` when Hub's machine `code`
 * says the plan doesn't include it (the quiet plan line); otherwise Hub's
 * `error` words ("Hub refused: …"). No card either way.
 */
export interface HubRefused {
  hub: "refused";
  plan: boolean;
  code?: string;
  error?: string;
}

/** A plan refusal's code, as Hub writes them ("groups_not_in_plan"). */
export const isPlanCode = (code: string): boolean =>
  /(^|_)plan(_|$)/.test(code);

/** What Den's page is told: no Hub, Hub said no, or Hub's answer. */
export type HubWorkAnswer =
  | { hub: "none" }
  | HubRefused
  | {
      hub: "ok";
      projects: { project: string; work: ProjectWork | null; linked?: false }[];
    };

export type AgentsCurrentAnswer =
  | { hub: "none" }
  | HubRefused
  | { hub: "ok"; agents: Record<string, AgentCurrent> };

/** At most this many projects or agents per ask (a page's worth). */
export const HUB_WORK_MAX = 200;

const text = (v: unknown, max = 300): string =>
  typeof v === "string"
    ? v
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, max)
    : "";
const link = (v: unknown): string | null => {
  const s = text(v, 2000);
  return /^https?:\/\//i.test(s) ? s : null;
};
const whole = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function readCount(v: unknown): WorkCount {
  if (typeof v === "number") return { count: whole(v), url: null };
  const o = obj(v);
  return { count: whole(o?.count), url: link(o?.url) };
}

function readRef(v: unknown): HubRef | null {
  const o = obj(v);
  const id = text(o?.id, 200);
  const title = text(o?.title);
  if (!o || !(id || title)) return null;
  return { id, title: title || id, url: link(o.url) };
}

/** Hub's project work answer, checked; null when it isn't the shape. */
export function readProjectWork(v: unknown): ProjectWork | null {
  const o = obj(v);
  if (!o) return null;
  const visions = (Array.isArray(o.visions) ? o.visions : [])
    .slice(0, 50)
    .map((x): WorkVision | null => {
      const r = readRef(x);
      if (!r) return null;
      const total = whole(obj(x)?.total);
      return { ...r, done: Math.min(whole(obj(x)?.done), total), total };
    })
    .filter((x): x is WorkVision => x !== null);
  return {
    needsYou: readCount(o.needs_you),
    building: readCount(o.building),
    blocked: readCount(o.blocked),
    visions,
  };
}

/** Hub's batch answer, by Den agent id; a row Den can't read is left out. */
export function readAgentsCurrent(v: unknown): Record<string, AgentCurrent> {
  const rows = Array.isArray(v)
    ? v
    : Array.isArray(obj(v)?.agents)
      ? (obj(v)!.agents as unknown[])
      : [];
  const out: Record<string, AgentCurrent> = {};
  for (const x of rows.slice(0, HUB_WORK_MAX)) {
    const o = obj(x);
    const id = text(o?.agent_id, 200);
    const source = o?.source;
    if (!o || !id || (source !== "working" && source !== "recent")) continue;
    const ref = readRef(o.item);
    out[id] = {
      item: ref ? { ...ref, kind: text(obj(o.item)?.kind, 40) } : null,
      vision: readRef(o.vision),
      source,
      since: text(o.since, 40) || null,
    };
  }
  return out;
}

/** An agent id Den sends: its own record ids are plain. */
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/;

type FetchFn = typeof fetch;

export interface HubWorkDeps {
  /** Hub's address and this install's token; null: no Hub connected. */
  hub?: () => Promise<{ url: string; token: string } | null>;
  /** A Den project's Hub project (its stored link); null: not linked. */
  projectOf?: (ws: string) => HubProjectLink | null;
  fetch?: FetchFn;
  timeoutMs?: number;
}

async function connectedHub(): Promise<{ url: string; token: string } | null> {
  let cfg: HubConfig | null;
  try {
    cfg = readHubConfig();
  } catch {
    return null;
  }
  if (!cfg) return null;
  const token = await readHubToken(cfg);
  return token ? { url: cfg.url, token } : null;
}

/** Hub's 403 (a plan refusal, or any other): no card, the quiet line. */
const refusedOf = (e: unknown): HubRefused | null => {
  if (!(e instanceof HubCallError && e.kind === "forbidden")) return null;
  // Hub's refusals are { error, code }: `code` is the machine's word,
  // `error` is text for people. Never read a code from `error`.
  const code = text(e.body?.code, 80);
  const error = text(e.body?.error, 300);
  return {
    hub: "refused",
    plan: isPlanCode(code),
    ...(code ? { code } : {}),
    ...(error ? { error } : {}),
  };
};
/** Hub's 404: a Hub without the route yet. */
const missing = (e: unknown) => e instanceof HubCallError && e.status === 404;

/**
 * Reads both routes for Den's pages, through hub.ts's client. Memory
 * only: the last good answer per project (and per agent) is drawn when
 * Hub can't be reached.
 */
export class HubWorkReader {
  private readonly lastWork = new Map<string, ProjectWork>();
  private readonly lastAgents = new Map<string, AgentCurrent>();

  constructor(private readonly deps: HubWorkDeps = {}) {}

  private get opts() {
    return {
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.timeoutMs ? { timeoutMs: this.deps.timeoutMs } : {}),
    };
  }

  /** The Work in Hub card's numbers, one entry per Den project asked. */
  async projectWork(names: readonly string[]): Promise<HubWorkAnswer> {
    const hub = await (this.deps.hub ?? connectedHub)();
    if (!hub) return { hub: "none" };
    const projectOf = this.deps.projectOf ?? ((ws) => hubProjectOf(ws));
    const projects: {
      project: string;
      work: ProjectWork | null;
      linked?: false;
    }[] = [];
    for (const ws of [...new Set(names)].slice(0, HUB_WORK_MAX)) {
      const p = projectOf(ws);
      if (!p) {
        projects.push({ project: ws, work: null, linked: false });
        continue;
      }
      let work: ProjectWork | null;
      try {
        work = readProjectWork(
          await hubProjectWork(hub.url, hub.token, p.id, this.opts),
        );
        if (work) this.lastWork.set(p.id, work);
        else this.lastWork.delete(p.id);
      } catch (e) {
        const refused = refusedOf(e);
        if (refused) return refused;
        // 404: an older Hub. Unreachable: the last answer, if any.
        if (missing(e)) this.lastWork.delete(p.id);
        work = this.lastWork.get(p.id) ?? null;
      }
      projects.push({ project: ws, work });
    }
    return { hub: "ok", projects };
  }

  /** Each agent's current Hub item, in one ask for the page. */
  async agentsCurrent(ids: readonly string[]): Promise<AgentsCurrentAnswer> {
    const hub = await (this.deps.hub ?? connectedHub)();
    if (!hub) return { hub: "none" };
    const want = [...new Set(ids)]
      .filter((id) => AGENT_ID_RE.test(id))
      .slice(0, HUB_WORK_MAX);
    if (want.length === 0) return { hub: "ok", agents: {} };
    let got: Record<string, AgentCurrent> = {};
    try {
      got = readAgentsCurrent(
        await hubAgentsCurrent(hub.url, hub.token, want, this.opts),
      );
      for (const id of want) {
        if (got[id]) this.lastAgents.set(id, got[id]);
        else this.lastAgents.delete(id);
      }
    } catch (e) {
      const refused = refusedOf(e);
      if (refused) return refused;
      if (missing(e)) return { hub: "ok", agents: {} };
      for (const id of want) {
        const l = this.lastAgents.get(id);
        if (l) got[id] = l;
      }
    }
    return { hub: "ok", agents: got };
  }
}

let processReader: HubWorkReader | null = null;
/** The server's one reader (its memory lasts as long as the process). */
export function hubWorkReader(): HubWorkReader {
  return (processReader ??= new HubWorkReader());
}
