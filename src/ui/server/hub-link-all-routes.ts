/**
 * #68: link projects to Hub's suggestion (Settings › Agents › Unclear
 * matches, issue 167; `<cli> hub link --suggested` sends the person
 * there).
 *
 *   GET  /api/hub/link-suggestions → { connected, projects: [{project,
 *        hub, suggestion, unclear?, reason?}] }: each project, its Hub
 *        project (or null), and Hub's first suggestion for an unlinked one
 *        (the same repos, then the same name); one Den can't match lists
 *        each choice (unclear) and why (reason, unclearReason). Nothing is
 *        written.
 *   POST { links: [{project, hub: <Hub project id>}] } → { linked,
 *        skipped }: links each pair that is still that project's
 *        suggestion and still unlinked; the rest are skipped, saying why.
 *        One sync to Hub after. Each link is audited. A person's only: an
 *        agent's token or an MCP caller is refused.
 */
import type * as http from "http";
import type {
  HubProjectChoice,
  HubProjectLink,
} from "../../shared/hub-project-link.js";
import { isCatchAllProject } from "../../shared/catch-all-project.js";
import type { NotificationStore } from "../../shared/notifications.js";
import { readBody, sendJson } from "./http-helpers.js";
import { agentPrincipalOf, auditActorOf } from "./request-guard.js";

export const HUB_LINK_ALL_PATH = "/api/hub/link-suggestions";

type Suggestion = HubProjectChoice & { why?: "repo" | "name" };

export interface HubLinkAllDeps {
  /** Every project here (the server agent's scope is never one). */
  projects: () => string[];
  /** Hub's projects and suggestions for `ws`; null: Hub isn't connected. */
  choices: (ws: string) => Promise<{
    suggestions: Suggestion[];
    projects: HubProjectChoice[];
  } | null>;
  read: (ws: string) => HubProjectLink | null;
  write: (ws: string, link: HubProjectLink) => void;
  /** After any link: send the project list to Hub again. */
  changed: () => void;
  /** One line per link, for the audit trail. */
  audit: (line: string) => void;
  /**
   * Issue 167: `n` projects Den couldn't match were just picked; the
   * bell's "N projects need your pick" counts down (pickDone).
   */
  picked?: (n: number) => void;
}

const MAX_LINKS = 200;

/**
 * Issue 649: the projects Den may link on Hub's suggestion. Never the
 * catch-all project: a person links it by hand in Project setup.
 */
const linkable = (d: HubLinkAllDeps) =>
  d.projects().filter((p) => !isCatchAllProject(p));

/**
 * 0.4.45: which Hub project fits a project, from Hub's suggestions. Clear:
 * one by its repos (a name pointing there too is fine), or, with none by
 * repos, one by its name. Unclear: two by repos, or its repos and its name
 * point to different ones; a person picks. None: Hub suggests nothing.
 */
export function hubMatchOf(
  suggestions: Suggestion[],
): { clear: Suggestion } | { unclear: Suggestion[] } | { none: true } {
  const seen = new Set<string>();
  const all = suggestions.filter((s) => !seen.has(s.id) && seen.add(s.id));
  if (!all.length) return { none: true };
  const byRepo = all.filter((s) => s.why === "repo");
  if (byRepo.length === 1 && all.length === 1) return { clear: byRepo[0] };
  if (byRepo.length === 0 && all.length === 1) return { clear: all[0] };
  return { unclear: all };
}

/**
 * Issue 167: why a match is unclear, for Settings › Agents › Unclear
 * matches. repos: two Hub projects share its repos. split: its repos
 * match one Hub project, its name another. names: two have its name.
 */
export function unclearReason(
  unclear: Suggestion[],
): "repos" | "split" | "names" {
  const byRepo = unclear.filter((s) => s.why === "repo").length;
  return byRepo >= 2 ? "repos" : byRepo === 1 ? "split" : "names";
}

/**
 * 0.4.45 (projects follow Connect): link every unlinked project whose Hub
 * project is clear; the unclear ones wait for a person's pick. Hub can't
 * suggest (an older Hub, or it doesn't answer): nothing is linked.
 */
export async function linkClearProjects(
  d: HubLinkAllDeps,
): Promise<{ linked: string[]; unclear: string[] } | { cannot: true }> {
  const todo = linkable(d).filter((p) => !d.read(p));
  const found: { project: string; m: ReturnType<typeof hubMatchOf> }[] = [];
  for (const project of todo) {
    const c = await d.choices(project).catch(() => null);
    if (c === null) return { cannot: true };
    found.push({ project, m: hubMatchOf(c.suggestions) });
  }
  const linked: string[] = [];
  const unclear: string[] = [];
  for (const { project, m } of found) {
    if ("clear" in m) {
      const link = { id: m.clear.id, slug: m.clear.slug, name: m.clear.name };
      d.write(project, link);
      d.audit(`${project} → ${link.slug} (on Connect)`);
      linked.push(project);
    } else if ("unclear" in m) unclear.push(project);
  }
  if (linked.length) d.changed();
  return { linked, unclear };
}

export async function hubLinkAllRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  d: HubLinkAllDeps,
): Promise<true> {
  const method = (req.method ?? "GET").toUpperCase();
  const projects = linkable(d);

  if (method === "GET" || method === "HEAD") {
    let connected = true;
    const rows = await Promise.all(
      projects.map(async (project) => {
        const hub = d.read(project);
        if (hub) return { project, hub, suggestion: null };
        const c = await d.choices(project).catch(() => null);
        if (c === null) connected = false;
        // 0.4.45: an unclear one offers each choice and ticks none.
        const m = c ? hubMatchOf(c.suggestions) : null;
        if (m && "unclear" in m)
          return {
            project,
            hub: null,
            suggestion: null,
            reason: unclearReason(m.unclear),
            unclear: m.unclear.map((x) => ({
              id: x.id,
              slug: x.slug,
              name: x.name,
              ...(x.why ? { why: x.why } : {}),
            })),
          };
        const s = c?.suggestions[0];
        return {
          project,
          hub: null,
          suggestion: s
            ? {
                id: s.id,
                slug: s.slug,
                name: s.name,
                ...(s.why ? { why: s.why } : {}),
              }
            : null,
        };
      }),
    );
    // With every project linked, ask Hub once whether it is there at all.
    if (rows.every((r) => r.hub) && projects.length)
      connected = (await d.choices(projects[0]).catch(() => null)) !== null;
    sendJson(res, { ok: true, connected, projects: rows });
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
  let links: { project: string; hub: string }[];
  try {
    const raw = await readBody(req);
    const b = (raw ? JSON.parse(raw) : {}) as { links?: unknown };
    if (
      !Array.isArray(b.links) ||
      b.links.length > MAX_LINKS ||
      !b.links.every(
        (l) =>
          l &&
          typeof (l as { project?: unknown }).project === "string" &&
          typeof (l as { hub?: unknown }).hub === "string",
      )
    )
      throw new Error("bad");
    links = b.links as { project: string; hub: string }[];
  } catch {
    sendJson(
      res,
      {
        ok: false,
        error: `links: a list of {project, hub} (at most ${MAX_LINKS})`,
      },
      400,
    );
    return true;
  }
  const known = new Set(projects);
  const linked: { project: string; hub: HubProjectLink }[] = [];
  let picks = 0;
  // code: what the page translates; why: the same in words, for the CLI.
  const skipped: {
    project: string;
    code: "unknown" | "linked" | "offline" | "stale";
    why: string;
  }[] = [];
  for (const { project, hub } of links) {
    if (!known.has(project)) {
      skipped.push({ project, code: "unknown", why: "no such project" });
      continue;
    }
    if (d.read(project)) {
      skipped.push({ project, code: "linked", why: "already linked" });
      continue;
    }
    // Checked against Hub now: only what Hub still suggests for it.
    const c = await d.choices(project).catch(() => null);
    if (c === null) {
      skipped.push({ project, code: "offline", why: "Hub didn't answer" });
      continue;
    }
    const s = c.suggestions.find((x) => x.id === hub);
    if (!s) {
      skipped.push({
        project,
        code: "stale",
        why: "not Hub's suggestion for it",
      });
      continue;
    }
    const link = { id: s.id, slug: s.slug, name: s.name };
    d.write(project, link);
    d.audit(`${project} → ${s.slug}`);
    linked.push({ project, hub: link });
    if ("unclear" in hubMatchOf(c.suggestions)) picks++;
  }
  if (linked.length) d.changed();
  if (picks) d.picked?.(picks);
  sendJson(res, { ok: true, linked, skipped });
  return true;
}

/**
 * The deps on this install's own files: the projects in workspaces.yml
 * (never the server agent's scope), Hub's suggestions, and the link in
 * each project's entry. `why` names who linked, for the file's note.
 */
export async function defaultLinkAllDeps(
  why: string,
  audit: (line: string) => void,
): Promise<HubLinkAllDeps> {
  const [hp, link, w, sa] = await Promise.all([
    import("./hub-project-routes.js"),
    import("../../shared/hub-project-link.js"),
    import("../../shared/environment-manager/workspaces.js"),
    import("../../shared/agents/server-agent.js"),
  ]);
  return {
    projects: () => {
      try {
        return Object.keys(w.readWorkspacesFile().workspaces ?? {})
          .filter((k) => !sa.isServerScope(k))
          .sort();
      } catch {
        return [];
      }
    },
    choices: hp.defaultChoices,
    read: (ws) => link.hubProjectOf(ws),
    write: (ws, l) => link.setHubProject(ws, l, why),
    changed: hp.defaultChanged,
    audit,
    picked: (n) =>
      void import("./notification-service.js")
        .then((m) => pickDone(m.notificationDeps().store, n))
        .catch(() => undefined),
  };
}

/** Where a person picks: Settings › Agents › Unclear matches. */
export const HUB_PICK_LINK = "/settings#agents.hub_link_all";

const PICK_SUBJECT = "record:hub-pick";

/** The bell's one pick item: "N projects need your pick" (0.4.45). */
export function pickNote(n: number) {
  return {
    kind: "decision" as const,
    subject: PICK_SUBJECT,
    scope: "workspace/den-server",
    text: `${n} project${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} your pick`,
    msg: { key: "bell.m.pick", vars: { n } },
    link: HUB_PICK_LINK,
  };
}

/**
 * Issue 167 (mock v6 B3): `n` picks were made: the unread pick item counts
 * down, and goes at the last. None waiting: nothing changes.
 */
export function pickDone(
  store: Pick<NotificationStore, "list" | "add" | "withdraw">,
  n: number,
): void {
  const item = store
    .list()
    .find(
      (x) => !x.read && x.subject === PICK_SUBJECT && x.kind === "decision",
    );
  if (!item) return;
  const was = Number(item.msg?.vars?.n);
  const left = (Number.isFinite(was) ? was : 0) - n;
  if (left > 0) store.add(pickNote(left));
  else store.withdraw(PICK_SUBJECT, "decision");
}

/**
 * 0.4.45: what Connect runs once connected: link the clear projects, and
 * put "N projects need your pick" in the bell for the unclear ones.
 */
export async function defaultLinkAfter(): Promise<
  Awaited<ReturnType<typeof linkClearProjects>>
> {
  const { recordAction } = await import("./audit.js");
  const d = await defaultLinkAllDeps("Connect to Hub", (line) =>
    recordAction(null, { verb: "hub-link", detail: line.slice(0, 400) }),
  );
  const r = await linkClearProjects(d);
  // The ones linked before: Hub's names now (a rename while apart).
  void import("./hub-sync-service.js")
    .then((m) => m.refreshHubNamesNow())
    .catch(() => undefined);
  if ("unclear" in r) {
    const { notificationDeps } = await import("./notification-service.js");
    const store = notificationDeps().store;
    // Issue 726: after a Hub change the bell offered every project that
    // had a link; now the count is what still needs a pick (none: it goes).
    if (r.unclear.length) store.add(pickNote(r.unclear.length));
    else store.withdraw(PICK_SUBJECT, "decision");
  }
  return r;
}
