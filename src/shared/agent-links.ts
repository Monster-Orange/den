/**
 * Issue 1016: the full links an agent gives its person, all on the
 * install's address (web.url, D80). The person usually works from another
 * machine, so a link is never on localhost or 127.0.0.1, and never
 * guessed: with web.url unset there are no links at all, and the agent is
 * told where the person sets it.
 */
import { isServerScope } from "./agents/server-agent.js";
import { isLoopbackUrl } from "./web-url-check.js";
import { readWebUrl } from "./web-url.js";
import type { UserConfig } from "./den-config.js";

/** The Settings page where the address (web.url) is set. */
export const ADDRESS_SETTING_PAGE = "/settings#server.address";

/**
 * Where the person decides a held write: the asking agent's row, else any
 * page (the Allow opens on each). The bell's held-write item links here.
 */
export function allowPath(
  agent: string | undefined,
  project: string | undefined,
): string {
  if (!agent) return "/agents";
  const q = new URLSearchParams();
  if (project) q.set("project", project);
  q.set("agent", agent);
  return `/agents?${q.toString()}`;
}

/**
 * The one gate every link and the brief line go through: `url` as an
 * address people can open, or null. A loopback one (127.0.0.0/8, ::1,
 * localhost, *.localhost, 0.0.0.0) opens only on this machine, so it
 * counts as unset, whatever was stored.
 */
export function peopleAddress(url: string | null | undefined): string | null {
  if (typeof url !== "string" || !url.trim()) return null;
  return isLoopbackUrl(url) ? null : url;
}

/**
 * The install's web.url as an address people open (peopleAddress), or
 * null. Whoami, the start brief and the held-write Allow link read it
 * here, never readWebUrl directly. `read`: user.yml (tests pass one).
 */
export function peopleWebUrl(read?: () => UserConfig): string | null {
  return peopleAddress((read ? readWebUrl(read) : readWebUrl())?.url);
}

/** `url`'s full Allow link for agent `agent` in `project`; null without an address. */
export function allowLink(
  url: string | null | undefined,
  agent: string | undefined,
  project: string | undefined,
): string | null {
  const at = peopleAddress(url);
  return at ? fullLink(at, allowPath(agent, project)) : null;
}

/** `path` on the address `url` (an origin, no trailing slash). */
export function fullLink(url: string, path: string): string {
  return `${url.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The links an agent gives its person (issue 1016's whoami). */
export interface AgentLinks {
  /** This agent's own page. */
  agent: string;
  /** Its project's agents (absent for the server agent: no project). */
  project?: string;
  /** Where the person sets what reaches them (the bell is on every page). */
  notifications: string;
  /** Where the person Allows this agent's held writes. */
  allow: string;
}

/** Agent `id` in project `ws`'s links on `url`; null when it isn't an address people open. */
export function agentLinks(
  url: string | null | undefined,
  ws: string,
  id: string,
): AgentLinks | null {
  const at = peopleAddress(url);
  if (!at) return null;
  const server = isServerScope(ws);
  return {
    agent: fullLink(
      at,
      server
        ? "/server-agent"
        : `/p/${encodeURIComponent(ws)}/agents/${encodeURIComponent(id)}`,
    ),
    ...(server
      ? {}
      : {
          project: fullLink(
            at,
            `/agents?${new URLSearchParams({ project: ws }).toString()}`,
          ),
        }),
    notifications: fullLink(at, "/settings#notifications"),
    allow: fullLink(at, allowPath(id, server ? undefined : ws)),
  };
}

/** What an agent is told when the address isn't set. */
export function addressNotSetNote(): string {
  return `This Den's address for people (web.url) is not set, so there are no links to give. A person sets it in Settings (${ADDRESS_SETTING_PAGE}). Never give a localhost or 127.0.0.1 link: it works only on this machine.`;
}

/** Issue 1016: the start brief's one line about the address. */
export function addressBriefLine(url: string | null | undefined): string {
  const at = peopleAddress(url);
  return at
    ? `Den's address for people: ${at}. Give full links, never 127.0.0.1.`
    : `Den's address for people is not set (Settings, ${ADDRESS_SETTING_PAGE}): give no links, never 127.0.0.1.`;
}
