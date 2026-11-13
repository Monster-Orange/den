/**
 * H5: `<cli> hub link -p <project> [<hub project> | --none] [--json]`.
 * Shows, sets or clears the Hub project a project works on. With no Hub
 * project named, it shows the link and Hub's suggestions (the same repo,
 * then the same name). Den never links on its own: the person names one.
 * A person's ask only: refused inside an agent's session.
 *
 * #68: `<cli> hub link --suggested [--json]` lists every unlinked project
 * with Hub's suggestion and gives the Settings link that links the ticked
 * ones in one go. It never links by itself.
 */
import { isAgentTokenEnv } from "../../shared/actor-token.js";
import {
  hubProjectOf,
  pickHubProject,
  setHubProject,
  type HubProjectChoice,
  type HubProjectLink,
} from "../../shared/hub-project-link.js";
import { product } from "../../shared/product.js";

export const HUB_LINK_USAGE =
  "hub link -p <project> [<hub project> | --none] [--json] | hub link --suggested [--json]";

/** Where Settings links every suggestion in one confirm (#68). */
export const HUB_LINK_ALL_PAGE = "/settings#agents.hub_link_all";

export interface HubLinkDeps {
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The project key `typed` names (its key, name or slug), or null. */
  resolveProject?: (typed: string) => string | null;
  /** Hub's projects and suggestions for a project; null: Hub isn't connected. */
  choices?: (ws: string) => Promise<{
    suggestions: HubProjectChoice[];
    projects: HubProjectChoice[];
  } | null>;
  read?: (ws: string) => HubProjectLink | null;
  write?: (ws: string, link: HubProjectLink | null) => void;
  /** Every project here, for --suggested (the server agent's scope isn't one). */
  projects?: () => string[] | Promise<string[]>;
  /** This install's page for `path`, or null when its address isn't set. */
  link?: (path: string) => string | null;
}

async function defaultProjects(): Promise<string[]> {
  const w = await import("../../shared/environment-manager/workspaces.js");
  const sa = await import("../../shared/agents/server-agent.js");
  return Object.keys(w.readWorkspacesFile().workspaces ?? {})
    .filter((k) => !sa.isServerScope(k))
    .sort();
}

async function defaultChoices(ws: string) {
  const hub = await import("../../shared/hub.js");
  const cfg = hub.readHubConfig();
  if (!cfg) return null;
  const token = await hub.readHubToken(cfg);
  if (!token) return null;
  const { projectRepos } = await import("../../shared/project-repos.js");
  return hub.hubProjectChoices(cfg.url, token, {
    workspace: ws,
    repos: projectRepos(ws),
  });
}

async function defaultResolve(typed: string): Promise<string | null> {
  const ws = await import("../../shared/environment-manager/workspaces.js");
  const key = ws.resolveWorkspaceInput(typed);
  try {
    return ws.readWorkspacesFile().workspaces[key] ? key : null;
  } catch {
    return null;
  }
}

const label = (p: { name: string; slug: string }) =>
  p.name === p.slug ? p.slug : `${p.name} (${p.slug})`;

export async function cmdHubLink(
  args: readonly string[],
  deps: HubLinkDeps = {},
): Promise<number> {
  const cli = product().cli;
  const out = deps.out ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = deps.env ?? process.env;
  const where = `${cli} hub link`;
  const usage = () => {
    err(`usage: ${cli} ${HUB_LINK_USAGE}`);
    return 2;
  };
  let typedProject: string | undefined;
  let hubTyped: string | undefined;
  let none = false;
  let json = false;
  let suggested = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--suggested") suggested = true;
    else if (a === "--none") none = true;
    else if (
      a === "-p" ||
      a === "--project" ||
      a === "-w" ||
      a === "--workspace"
    )
      typedProject = args[++i];
    else if (a.startsWith("--project=")) typedProject = a.slice(10);
    else if (a.startsWith("-") || hubTyped !== undefined) return usage();
    else hubTyped = a;
  }
  if (suggested) {
    if (typedProject !== undefined || hubTyped !== undefined || none)
      return usage();
    return suggestedAll(json, deps, { cli, where, out, err });
  }
  if (!typedProject?.trim() || (none && hubTyped !== undefined)) return usage();
  if (isAgentTokenEnv(env) && (hubTyped !== undefined || none)) {
    err(
      `${where}: linking a project to Hub is a person's ask; an agent can't. Ask your person to run it, or to pick it in Settings › Project setup.`,
    );
    return 2;
  }
  const ws = deps.resolveProject
    ? deps.resolveProject(typedProject)
    : await defaultResolve(typedProject);
  if (!ws) {
    err(`${where}: there is no project "${typedProject}"`);
    return 1;
  }
  const read = deps.read ?? ((w: string) => hubProjectOf(w));
  const write = deps.write ?? setHubProject;
  const now = read(ws);

  if (none) {
    write(ws, null);
    if (json) out(JSON.stringify({ ok: true, project: ws, hub: null }));
    else
      out(
        `✓ ${ws} is no longer linked to a Hub project${now ? ` (was ${label(now)})` : ""}. Hub files its agents' work in Unfiled.`,
      );
    return 0;
  }

  let choices: Awaited<ReturnType<NonNullable<HubLinkDeps["choices"]>>>;
  try {
    choices = await (deps.choices ?? defaultChoices)(ws);
  } catch (e) {
    err(`${where}: Hub didn't list its projects: ${(e as Error).message}`);
    return 1;
  }
  if (!choices) {
    err(
      `${where}: this install isn't connected to Hub. Connect it first: Settings › Hub › Connect.`,
    );
    return 1;
  }

  if (hubTyped === undefined) {
    if (json) {
      out(
        JSON.stringify({
          ok: true,
          project: ws,
          hub: now,
          suggestions: choices.suggestions,
          projects: choices.projects,
        }),
      );
      return 0;
    }
    out(
      now
        ? `${ws} is linked to Hub project ${label(now)}.`
        : `${ws} is not linked to a Hub project: Hub files its agents' work in Unfiled.`,
    );
    const why = (w?: string) =>
      w === "repo" ? "it has this project's repos" : "same name";
    const offer = choices.suggestions.filter((s) => s.id !== now?.id);
    if (offer.length) {
      out("  Suggested:");
      for (const s of offer)
        out(
          `    ${label(s)}: ${why(s.why)}. Link: ${cli} hub link -p ${ws} ${s.slug}`,
        );
    }
    const rest = choices.projects.filter(
      (p) => p.id !== now?.id && !offer.some((s) => s.id === p.id),
    );
    if (rest.length) {
      out("  Your company's other Hub projects:");
      for (const p of rest) out(`    ${label(p)}`);
    }
    if (!choices.projects.length)
      out("  Your company has no Hub projects yet.");
    return 0;
  }

  const pick = pickHubProject(hubTyped, choices.projects);
  if (!pick) {
    err(
      `${where}: your company has no Hub project "${hubTyped}". See them: ${cli} hub link -p ${ws}`,
    );
    return 1;
  }
  const link = { id: pick.id, slug: pick.slug, name: pick.name };
  write(ws, link);
  if (json) out(JSON.stringify({ ok: true, project: ws, hub: link }));
  else
    out(
      `✓ ${ws} is linked to Hub project ${label(link)}. Its agents' Hub work is filed there from their next call.`,
    );
  return 0;
}

/** #68: every unlinked project and Hub's suggestion; the page links them. */
async function suggestedAll(
  json: boolean,
  deps: HubLinkDeps,
  io: {
    cli: string;
    where: string;
    out: (l: string) => void;
    err: (l: string) => void;
  },
): Promise<number> {
  const { cli, where, out, err } = io;
  const read = deps.read ?? ((w: string) => hubProjectOf(w));
  const choicesOf = deps.choices ?? defaultChoices;
  const projects = await (deps.projects ?? defaultProjects)();
  const rows: {
    project: string;
    hub: HubProjectLink | null;
    suggestion: HubProjectChoice | null;
  }[] = [];
  for (const project of projects) {
    const hub = read(project);
    if (hub) {
      rows.push({ project, hub, suggestion: null });
      continue;
    }
    let c: Awaited<ReturnType<typeof choicesOf>>;
    try {
      c = await choicesOf(project);
    } catch (e) {
      err(`${where}: Hub didn't list its projects: ${(e as Error).message}`);
      return 1;
    }
    if (!c) {
      err(
        `${where}: this install isn't connected to Hub. Connect it first: Settings › Hub › Connect.`,
      );
      return 1;
    }
    rows.push({ project, hub: null, suggestion: c.suggestions[0] ?? null });
  }
  const page = deps.link
    ? deps.link(HUB_LINK_ALL_PAGE)
    : (await import("../../shared/web-url.js")).publicLink(HUB_LINK_ALL_PAGE);
  if (json) {
    out(JSON.stringify({ ok: true, projects: rows, page }));
    return 0;
  }
  const todo = rows.filter((r) => !r.hub && r.suggestion);
  const lone = rows.filter((r) => !r.hub && !r.suggestion);
  if (!todo.length) {
    out(
      rows.length
        ? "Nothing to link: every project is linked, or Hub has no suggestion for it."
        : "No projects here yet.",
    );
  } else {
    out(`Hub suggests (${todo.length}):`);
    for (const r of todo) out(`  ${r.project} → ${label(r.suggestion!)}`);
    out(
      `Link them in one go: ${page ?? "Settings › Agents › Link projects to Hub"}`,
    );
    out(`Or one at a time: ${cli} hub link -p <project> <hub project>`);
  }
  for (const r of lone)
    out(`  ${r.project}: no suggestion; see ${cli} hub link -p ${r.project}`);
  return 0;
}
