/**
 * Issue 482 (model A): Terminals, a page of its own at /terminals. It is
 * served from agents.html (the same list column and terminal panes) with
 * the shell's page id and the <title> swapped; agents-page.js reads the
 * page id and lists plain shells only there, agents only on /agents.
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
 * Issue 482: an older link to a terminal on Agents (/agents?terminal=1,
 * the rail's and a project's before this release) lands on Terminals,
 * with the rest of its query. Null for any other /agents link.
 */
export function terminalsRedirect(search: URLSearchParams): string | null {
  if (search.get("terminal") !== "1") return null;
  const q = search.toString().replace(/%2C/gi, ",");
  return `/terminals?${q}`;
}
