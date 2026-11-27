/**
 * Issue 482: the Terminals page (model A, as mocked and approved): the
 * person's terminals in their own list, at /terminals. It is served from
 * agents.html with the shell's page id and the <title> swapped: the same
 * panes, layouts and project filter, no second copy of them. With page id
 * "terminal" (the rail item's id) agents-page.js lists shells only, and
 * the Agents page lists agents only.
 */

const SHELL = '<div id="den-shell" data-page="agents"';
const TITLE = "· Agents</title>";

/** agents.html → the Terminals page. Throws when the markers are gone. */
export function terminalsPageHtml(agents: string): string {
  if (!agents.includes(SHELL) || !agents.includes(TITLE))
    throw new Error("agents.html: the Terminals page's markers are missing");
  return agents
    .replace(SHELL, '<div id="den-shell" data-page="terminal"')
    .replace(TITLE, "· Terminals</title>");
}

/**
 * Issue 482: an older Terminal link (/agents?terminal=1, from a bookmark
 * or a page built before the Terminals page) goes to the Terminals page
 * with its query, so nothing it asked for is lost. Null: no redirect.
 */
export function terminalLinkRedirect(
  pathname: string,
  query: URLSearchParams,
): string | null {
  if (pathname !== "/agents" && pathname !== "/agents.html") return null;
  if (query.get("terminal") !== "1") return null;
  return `/terminals?${query.toString()}`;
}
