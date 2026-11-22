/**
 * Issue 646: Connect's one review (shape B in the mock "Connecting Den to
 * the right Hub company: Den's side", v4), in Settings › Hub.
 *
 *   GET  /api/hub/connect-review → { connected, projects, rows }
 *        A row per project: its link on the connected Hub (with why Hub
 *        suggests it), or a proposal: the Hub project with the same repo,
 *        then the same name ({kind: "link", hub, why}); "Create <name>"
 *        when none fits ({kind: "create", name}); a pick when two fit
 *        ({kind: "pick", choices}). A link to another Hub or company
 *        (`elsewhere`), the link archived on the last Hub change (`was`),
 *        and a new Hub project waiting for an owner's Apply (`waiting`)
 *        are said. `projects`: every Hub project of the company, for the
 *        row's picker (Change). Nothing is written.
 *   POST { rows: [{project, hub: <id>} | {project, create: <name>}] } →
 *        { linked, creating, plan, skipped }: Connect and link all. Each
 *        link applies at once (any of the company's projects; Hub needs no
 *        approval for a link). Every create goes to Hub as ONE plan an
 *        owner applies once in Hub (hubPlanCreates); Den links each when
 *        it is applied (settleHubCreate). One sync to Hub after. A
 *        person's only: an agent's token or an MCP caller is refused.
 */
import type * as http from "http";
import type { HubCreate } from "../../shared/hub-project-create.js";
import type {
  HubProjectChoice,
  HubProjectLink,
} from "../../shared/hub-project-link.js";
import { isCatchAllProject } from "../../shared/catch-all-project.js";
import { readBody, sendJson } from "./http-helpers.js";
import { hubMatchOf } from "./hub-link-all-routes.js";
import { agentPrincipalOf, auditActorOf } from "./request-guard.js";

export const HUB_REVIEW_PATH = "/api/hub/connect-review";

type Suggestion = HubProjectChoice & { why?: "repo" | "name" };
type Plain = { id: string; slug: string; name: string };
const plain = (p: Plain): Plain => ({ id: p.id, slug: p.slug, name: p.name });

export interface HubReviewDeps {
  /** The projects Connect links (never the server agent's scope). */
  projects: () => string[];
  /** The name project `ws` shows (Create's default). */
  name: (ws: string) => string;
  /** Hub's projects and suggestions for `ws`; null: Hub didn't answer. */
  choices: (ws: string) => Promise<{
    suggestions: Suggestion[];
    projects: HubProjectChoice[];
  } | null>;
  /** The link on the connected Hub, or null. */
  read: (ws: string) => HubProjectLink | null;
  /** A link to another Hub or company (hubLinkElsewhere), or null. */
  elsewhere: (ws: string) => HubProjectLink | null;
  /** The link archived on the last Hub change (previousLinkOf), or null. */
  was: (
    ws: string,
  ) => { name: string; origin: string; company?: string } | null;
  /** A new Hub project asked for `ws`, still waiting; null: none. */
  waiting: (ws: string) => HubCreate | null;
  write: (ws: string, link: HubProjectLink, by: string) => void;
  keepCreate: (ws: string, c: HubCreate | null, by: string) => void;
  /** One plan in Hub for every name: its held id, page, and the slugs. */
  plan: (
    names: string[],
    reason: string,
  ) => Promise<{
    held: string;
    url?: string;
    made: { name: string; slug: string }[];
  }>;
  /** After any change: send the project list to Hub again. */
  changed: () => void;
  audit: (line: string) => void;
  /** `n` projects waiting for the review were settled (the bell counts down). */
  picked?: (n: number) => void;
  now?: () => Date;
}

export type ReviewProposal =
  | { kind: "link"; hub: Plain; why: "repo" | "name" }
  | { kind: "create"; name: string }
  | { kind: "pick"; choices: Suggestion[] };

export interface ReviewRow {
  project: string;
  name: string;
  linked: (Plain & { why?: "repo" | "name" }) | null;
  elsewhere?: { name: string; origin: string; company?: string };
  was?: { name: string; origin: string; company?: string };
  waiting?: { name: string; url?: string };
  /** What Connect and link all does for it; null: nothing to do. */
  proposal: ReviewProposal | null;
}

const MAX_ROWS = 200;
/** How many projects Den asks Hub about at a time (a review, a count). */
const HUB_AT_ONCE = 6;

/** `f` over `xs`, at most `n` at a time; results in the order of `xs`. */
async function inTurn<T, R>(
  xs: T[],
  n: number,
  f: (x: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const lane = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, () => lane()),
  );
  return out;
}

const projectsOf = (d: HubReviewDeps) =>
  d.projects().filter((p) => !isCatchAllProject(p));

/** The review: a row per project, and the company's projects. */
export async function reviewRows(d: HubReviewDeps): Promise<{
  connected: boolean;
  projects: Plain[];
  rows: ReviewRow[];
}> {
  const names = projectsOf(d).slice(0, MAX_ROWS);
  const found = await inTurn(names, HUB_AT_ONCE, (ws) =>
    d.choices(ws).catch(() => null),
  );
  const connected = found.every((c) => c !== null) && found.length > 0;
  const company = new Map<string, Plain>();
  for (const c of found)
    for (const p of c?.projects ?? []) company.set(p.id, plain(p));
  const rows = names.map((project, i): ReviewRow => {
    const c = found[i];
    const link = d.read(project);
    const away = link ? null : d.elsewhere(project);
    const was = link || away ? null : d.was(project);
    const wait = link ? null : d.waiting(project);
    const why = link
      ? c?.suggestions.find((s) => s.id === link.id)?.why
      : undefined;
    let proposal: ReviewProposal | null = null;
    if (!link && !wait && c) {
      const m = hubMatchOf(c.suggestions);
      proposal =
        "clear" in m
          ? {
              kind: "link",
              hub: plain(m.clear),
              why: m.clear.why === "repo" ? "repo" : "name",
            }
          : "unclear" in m
            ? { kind: "pick", choices: m.unclear }
            : { kind: "create", name: d.name(project) };
    }
    return {
      project,
      name: d.name(project),
      linked: link ? { ...plain(link), ...(why ? { why } : {}) } : null,
      ...(away?.hub
        ? {
            elsewhere: {
              name: away.name,
              origin: away.hub.origin,
              ...(away.hub.company ? { company: away.hub.company } : {}),
            },
          }
        : {}),
      ...(was ? { was } : {}),
      ...(wait
        ? {
            waiting: {
              name: wait.name,
              ...(wait.url ? { url: wait.url } : {}),
            },
          }
        : {}),
      proposal,
    };
  });
  return { connected, projects: [...company.values()], rows };
}

export type ReviewAsk = { project: string; hub?: string; create?: string };

export interface ReviewSkip {
  project: string;
  code:
    | "unknown"
    | "duplicate"
    | "linked"
    | "offline"
    | "stale"
    | "waiting"
    | "hub"
    | "name";
  why: string;
}

/** Connect and link all: links at once, the creates as one plan in Hub. */
export async function applyReview(
  d: HubReviewDeps,
  asks: ReviewAsk[],
  by: string,
): Promise<{
  linked: { project: string; hub: Plain; why: "repo" | "name" | "picked" }[];
  creating: { project: string; name: string; slug: string }[];
  plan: { url?: string } | null;
  skipped: ReviewSkip[];
}> {
  const known = new Set(projectsOf(d));
  const linked: {
    project: string;
    hub: Plain;
    why: "repo" | "name" | "picked";
  }[] = [];
  const skipped: ReviewSkip[] = [];
  const creates: { project: string; name: string }[] = [];
  const seen = new Set<string>();
  let picks = 0;
  for (const a of asks) {
    const project = a.project;
    if (seen.has(project)) {
      skipped.push({ project, code: "duplicate", why: "listed twice" });
      continue;
    }
    if (!known.has(project)) {
      skipped.push({ project, code: "unknown", why: "no such project" });
      continue;
    }
    seen.add(project);
    const now = d.read(project);
    if (typeof a.create === "string") {
      const name = a.create.replace(/\s+/g, " ").trim();
      if (!name || name.length > 80) {
        skipped.push({
          project,
          code: "name",
          why: "name: 1 to 80 characters",
        });
        continue;
      }
      if (now) {
        skipped.push({ project, code: "linked", why: "already linked" });
        continue;
      }
      if (d.waiting(project)) {
        skipped.push({
          project,
          code: "waiting",
          why: "a new Hub project is already waiting for an owner",
        });
        continue;
      }
      creates.push({ project, name });
      continue;
    }
    const id = String(a.hub ?? "");
    if (now && now.id === id) {
      skipped.push({ project, code: "linked", why: "already linked" });
      continue;
    }
    const c = await d.choices(project).catch(() => null);
    if (c === null) {
      skipped.push({ project, code: "offline", why: "Hub didn't answer" });
      continue;
    }
    const hub = c.projects.find((p) => p.id === id);
    if (!hub) {
      skipped.push({
        project,
        code: "stale",
        why: "not one of the company's Hub projects",
      });
      continue;
    }
    const s = c.suggestions.find((x) => x.id === id);
    const m = hubMatchOf(c.suggestions);
    const why: "repo" | "name" | "picked" =
      s && "clear" in m && m.clear.id === id
        ? s.why === "repo"
          ? "repo"
          : "name"
        : "picked";
    d.write(project, plain(hub), by);
    d.audit(`${project} → ${hub.slug} (Connect's review)`);
    linked.push({ project, hub: plain(hub), why });
    // The bell counts the projects waiting for this review: one less.
    if (!now) picks++;
  }
  const creating: { project: string; name: string; slug: string }[] = [];
  let plan: { url?: string } | null = null;
  if (creates.length) {
    try {
      const p = await d.plan(
        creates.map((c) => c.name),
        `Asked in Den, Settings › Hub (Connect's review), for ${creates.length === 1 ? `"${creates[0]!.project}"` : `${creates.length} projects`}`,
      );
      const askedAt = (d.now?.() ?? new Date()).toISOString();
      creates.forEach((c, i) => {
        const made = p.made[i] ?? { name: c.name, slug: c.name };
        const ask: HubCreate = {
          held: p.held,
          name: made.name,
          slug: made.slug,
          ...(p.url ? { url: p.url } : {}),
          askedAt,
          by: "person",
        };
        d.keepCreate(c.project, ask, by);
        d.audit(`${c.project}: asked Hub for ${made.slug} (Connect's review)`);
        creating.push({ project: c.project, name: made.name, slug: made.slug });
        picks++;
      });
      plan = p.url ? { url: p.url } : {};
    } catch (e) {
      for (const c of creates)
        skipped.push({
          project: c.project,
          code: "hub",
          why: (e as Error).message,
        });
    }
  }
  if (linked.length || creating.length) d.changed();
  if (picks) d.picked?.(picks);
  return { linked, creating, plan, skipped };
}

export async function hubReviewRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: HubReviewDeps,
  by: string,
): Promise<true> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    sendJson(res, { ok: true, ...(await reviewRows(d)) });
    return true;
  }
  if (method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    sendJson(res, { ok: false, error: "use GET or POST" }, 405);
    return true;
  }
  if (agentPrincipalOf(req) || auditActorOf(req)) {
    sendJson(
      res,
      {
        ok: false,
        code: "person_only",
        error: "Linking projects to Hub is a person's ask; an agent can't.",
      },
      403,
    );
    return true;
  }
  let asks: ReviewAsk[];
  try {
    const raw = await readBody(req);
    const b = (raw ? JSON.parse(raw) : {}) as { rows?: unknown };
    if (
      !Array.isArray(b.rows) ||
      b.rows.length > MAX_ROWS ||
      !b.rows.every((r) => {
        const o = (r ?? {}) as Record<string, unknown>;
        return (
          typeof o.project === "string" &&
          (typeof o.hub === "string") !== (typeof o.create === "string")
        );
      })
    )
      throw new Error("bad");
    asks = (b.rows as Record<string, unknown>[]).map((o) => ({
      project: o.project as string,
      ...(typeof o.hub === "string" ? { hub: o.hub } : {}),
      ...(typeof o.create === "string" ? { create: o.create } : {}),
    }));
  } catch {
    sendJson(
      res,
      {
        ok: false,
        error: `rows: a list of {project, hub} or {project, create} (at most ${MAX_ROWS})`,
      },
      400,
    );
    return true;
  }
  sendJson(res, { ok: true, ...(await applyReview(d, asks, by)) });
  return true;
}

/** The deps on this install's own files and its Hub. */
export async function defaultHubReviewDeps(
  audit: (line: string) => void,
): Promise<HubReviewDeps> {
  const [la, link, w, name, binding, paths, hub, sync] = await Promise.all([
    import("./hub-link-all-routes.js"),
    import("../../shared/hub-project-link.js"),
    import("../../shared/environment-manager/workspaces.js"),
    import("../../shared/workspace-name.js"),
    import("../../shared/hub-binding.js"),
    import("../../shared/paths.js"),
    import("../../shared/hub.js"),
    import("./hub-sync-service.js"),
  ]);
  const all = await la.defaultLinkAllDeps("Connect's review", audit);
  return {
    projects: all.projects,
    name: (ws) => {
      try {
        return name.workspaceDisplayName(
          ws,
          w.readWorkspacesFile().workspaces[ws],
        );
      } catch {
        return ws;
      }
    },
    choices: all.choices,
    read: (ws) => link.hubProjectOf(ws),
    elsewhere: (ws) => link.hubLinkElsewhere(ws),
    was: (ws) => binding.previousLinkOf(paths.getStateDir(), ws),
    waiting: (ws) => {
      const c = link.hubCreateOf(ws);
      return c && !c.outcome ? c : null;
    },
    write: (ws, l, by) => link.setHubProject(ws, l, by),
    keepCreate: (ws, c, by) => link.setHubCreate(ws, c, by),
    plan: async (names, reason) => {
      const at = await sync.hubAndToken();
      if (!at) throw new Error("This install isn't connected to Hub.");
      // The company's short names now, so new ones don't clash.
      const first = all.projects()[0];
      const c = first ? await all.choices(first).catch(() => null) : null;
      return hub.hubPlanCreates(at.url, at.token, {
        names,
        reason,
        taken: (c?.projects ?? []).map((p) => p.slug),
      });
    },
    changed: all.changed,
    audit,
    picked: all.picked,
  };
}

/**
 * Issue 646: how many rows wait for Connect and link all (a proposal, or
 * a pick); `cannot` when Hub didn't list its projects.
 */
export async function reviewCount(
  d: HubReviewDeps,
): Promise<{ review: number } | { cannot: true }> {
  const r = await reviewRows(d);
  if (!r.connected && r.rows.length) return { cannot: true };
  return { review: r.rows.filter((x) => x.proposal).length };
}

/** Where the bell's pick item opens: Settings › Hub, Connect's review. */
export const HUB_REVIEW_LINK = "/settings#agents.hub";

/**
 * Issue 646: what Connect runs once connected. Nothing is linked: the bell
 * says "N projects need your pick", opening Settings › Hub's review; none
 * waiting, it goes. Hub's names for projects linked before are read again.
 */
export async function defaultReviewAfter(): Promise<
  { review: number } | { cannot: true }
> {
  const { recordAction } = await import("./audit.js");
  const d = await defaultHubReviewDeps((line) =>
    recordAction(null, { verb: "hub-link", detail: line.slice(0, 400) }),
  );
  const r = await reviewCount(d);
  void import("./hub-sync-service.js")
    .then((m) => m.refreshHubNamesNow())
    .catch(() => undefined);
  if ("review" in r) {
    const [{ notificationDeps }, la] = await Promise.all([
      import("./notification-service.js"),
      import("./hub-link-all-routes.js"),
    ]);
    const store = notificationDeps().store;
    if (r.review)
      store.add({ ...la.pickNote(r.review), link: HUB_REVIEW_LINK });
    else store.withdraw("record:hub-pick", "decision");
  }
  return r;
}
