/**
 * The Graph page (R22, 0.3.0-dev.32, Ward 2026-11-05): the workspace graph
 * alone, full width, at /graph. It is Local Dev's own page in its graph
 * view (the same graph, actions and details panel; no second copy of
 * them): served from local-dev.html with the shell's page id and the
 * <title> swapped, and the page hides the workspace list, the workspace
 * header, the action row and the tabs when its page id is "graph".
 */

const SHELL = '<div id="den-shell" data-page="local-dev"';
const TITLE = "· Local Dev</title>";

/** local-dev.html → the Graph page. Throws when the markers are gone. */
export function graphPageHtml(localDev: string): string {
  if (!localDev.includes(SHELL) || !localDev.includes(TITLE))
    throw new Error("local-dev.html: the Graph page's markers are missing");
  return localDev
    .replace(SHELL, '<div id="den-shell" data-page="graph"')
    .replace(TITLE, "· Graph</title>");
}
