/**
 * Issue 647: the held write hub_link. An agent asks to link a project to
 * an existing Hub project; the person allows it; then Den links it, as
 * `hub link` and Settings › Project setup › Hub project do (the same
 * write, setHubProject, and the same sync to Hub after).
 *
 * The Hub project is named by its id or its slug, never its name, and is
 * checked against the connected Hub's list of this company's projects
 * before anyone is asked: one the Hub doesn't list (an id from another
 * Hub, or one removed since) is refused, saying so. The run checks again
 * at the Allow (createApprovalQueue), so one gone since is refused then
 * and nothing is written. The approval's audit rows record who asked and
 * who allowed.
 */
import type {
  HubProjectChoice,
  HubProjectLink,
} from "../../shared/hub-project-link.js";
import { isServerScope } from "../../shared/agents/server-agent.js";
import type { HeldAsker, HeldCheck } from "./approval-routes.js";
import type { AskedBy } from "./approvals.js";
import { hubMatchOf } from "./hub-link-all-routes.js";
import { isPersonal } from "../../shared/agents/sandbox-rollout.js";

export interface HubLinkHeldDeps {
  /** Whether project `ws` exists here. */
  exists: (ws: string) => boolean;
  /** Its Hub project now, or null. */
  read: (ws: string) => HubProjectLink | null;
  /** The connected Hub's projects and suggestions; null: not connected. */
  choices: (ws: string) => Promise<{
    suggestions: HubProjectChoice[];
    projects: HubProjectChoice[];
  } | null>;
  /** `by`: who asked, for the audit row. */
  write: (ws: string, link: HubProjectLink, by?: string) => void;
  /** After a link: send the project list to Hub again. */
  changed: () => void;
  /** Issue 167: a project Den couldn't match was just linked. */
  picked?: (n: number) => void;
  /** Issue 1403: the install is personal. Unknown: strict. */
  personal?: () => boolean;
}

/**
 * Issue 1403 (Den Builder): on a personal install hub_link is routine only
 * to the Hub project Connect pairs this project with (hubMatchOf's clear
 * match). Any other target may be someone else's: the person's.
 */
function pairedTarget(
  suggestions: HubProjectChoice[],
  pick: HubProjectChoice,
): boolean {
  const m = hubMatchOf(suggestions);
  return "clear" in m && m.clear.id === pick.id;
}

const label = (p: { name: string; slug: string }) =>
  p.name === p.slug ? p.slug : `${p.name} (${p.slug})`;

/** The Hub project `typed` names: its id, else its slug. Never its name. */
function byIdOrSlug(
  typed: string,
  projects: HubProjectChoice[],
): HubProjectChoice | null {
  const t = typed.toLowerCase();
  return (
    projects.find((p) => p.id === typed) ??
    projects.find((p) => p.slug.toLowerCase() === t) ??
    null
  );
}

/**
 * hub_link's check, for the Allow: the project (a project's agent its own
 * only; Den's own agent any), the Hub project as the connected Hub lists
 * it, and what the link is now and will be.
 */
export async function checkHubLinkHeld(
  d: HubLinkHeldDeps,
  a: Record<string, unknown>,
  who: HeldAsker = {},
): Promise<HeldCheck> {
  const no = (error: string) => ({ ok: false as const, error });
  const ws = typeof a.project === "string" ? a.project.trim() : "";
  if (!ws) return no("project: the project to link to a Hub project");
  if (isServerScope(ws))
    return no(`${ws} is Den's own agent's place, not a project`);
  if (!d.exists(ws)) return no(`no project "${ws}"`);
  if (who.project && !isServerScope(who.project) && who.project !== ws)
    return no(
      `${who.agent ?? "this agent"} works in project ${who.project}: it can link that project only, not project ${ws}`,
    );
  const typed = typeof a.hub === "string" ? a.hub.trim() : "";
  if (!typed) return no("hub: the Hub project's id or slug");
  let c: Awaited<ReturnType<HubLinkHeldDeps["choices"]>>;
  try {
    c = await d.choices(ws);
  } catch (e) {
    return no(`Hub didn't list its projects: ${(e as Error).message}`);
  }
  if (!c)
    return no(
      "this Den isn't connected to Hub: a person connects it in Settings › Hub first",
    );
  const pick = byIdOrSlug(typed, c.projects);
  if (!pick)
    return no(
      `the connected Hub has no Hub project "${typed}" for this company: an id from another Hub, or one removed since. Name one by its id or slug as this Hub lists it`,
    );
  const now = d.read(ws);
  if (now?.id === pick.id)
    return no(
      `project ${ws} is already linked to the Hub project ${label(pick)}`,
    );
  const then = label(pick);
  const lines: [string, { key: string; vars?: Record<string, string> }][] = [
    [`Project: ${ws}`, { key: "ap.hl.project", vars: { project: ws } }],
    now
      ? [`Now: ${label(now)}`, { key: "ap.hl.now", vars: { hub: label(now) } }]
      : ["Now: not linked to a Hub project", { key: "ap.hl.nowNone" }],
    [`Then: ${then}`, { key: "ap.hl.then", vars: { hub: then } }],
    [
      "Its agents' Hub work is filed there from their next call.",
      { key: "ap.hl.filed" },
    ],
  ];
  const personOnly =
    isPersonal(d.personal) && !pairedTarget(c.suggestions, pick);
  return {
    ok: true,
    ...(personOnly ? { personOnly: true as const } : {}),
    summary: `link project ${ws} to the Hub project ${then}`,
    params: { project: ws, hub: then },
    details: lines.map(([l]) => l),
    detailKeys: lines.map(([, k]) => k),
    args: { project: ws, hub: pick.id, slug: pick.slug, name: pick.name },
  };
}

/**
 * hub_link's run, after the Allow and the check again: the same write as
 * `hub link`, then the sync to Hub. A pick Den couldn't make counts down
 * the bell's "N projects need your pick", as Settings does.
 */
export async function runHubLinkHeld(
  d: HubLinkHeldDeps,
  a: Record<string, unknown>,
  asked?: AskedBy,
): Promise<unknown> {
  const ws = String(a.project ?? "");
  const link = {
    id: String(a.hub ?? ""),
    slug: String(a.slug ?? ""),
    name: String(a.name ?? ""),
  };
  const wasUnlinked = !d.read(ws);
  d.write(ws, link, `hub_link, allowed (${asked?.agent ?? "agent"})`);
  d.changed();
  if (wasUnlinked && d.picked)
    try {
      const c = await d.choices(ws);
      if (c && "unclear" in hubMatchOf(c.suggestions)) d.picked(1);
    } catch {
      /* the bell is best effort */
    }
  return {
    ok: true,
    project: ws,
    hub: link,
    next: `Project ${ws} is linked to the Hub project ${label(link)}. Its agents' Hub work is filed there from their next call.`,
  };
}

/** The deps on this install's own files and its connected Hub. */
export async function defaultHubLinkHeldDeps(): Promise<HubLinkHeldDeps> {
  const [hp, link, w] = await Promise.all([
    import("./hub-project-routes.js"),
    import("../../shared/hub-project-link.js"),
    import("../../shared/environment-manager/workspaces.js"),
  ]);
  return {
    exists: (ws) => {
      try {
        return Boolean(w.readWorkspacesFile().workspaces[ws]);
      } catch {
        return false;
      }
    },
    read: (ws) => link.hubProjectOf(ws),
    choices: hp.defaultChoices,
    write: (ws, l, by) => link.setHubProject(ws, l, by),
    changed: hp.defaultChanged,
    picked: (n) =>
      void Promise.all([
        import("./hub-link-all-routes.js"),
        import("./notification-service.js"),
      ])
        .then(([la, ns]) => la.pickDone(ns.notificationDeps().store, n))
        .catch(() => undefined),
  };
}
