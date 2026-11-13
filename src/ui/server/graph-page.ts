/**
 * The Graph page (R22, 0.3.0-dev.32, Ward 2026-11-05): the workspace graph
 * alone, full width, at /graph. It is served from local-dev.html (the
 * Projects page, R24) with the shell's page id and the <title> swapped:
 * the same graph, actions and details panel, no second copy of them. With
 * page id "graph" the page hides the workspace list and draws only the
 * graph.
 */

const SHELL = '<div id="den-shell" data-page="local-dev"';
const TITLE = "· Projects</title>";

/** local-dev.html → the Graph page. Throws when the markers are gone. */
export function graphPageHtml(localDev: string): string {
  if (!localDev.includes(SHELL) || !localDev.includes(TITLE))
    throw new Error("local-dev.html: the Graph page's markers are missing");
  return localDev
    .replace(SHELL, '<div id="den-shell" data-page="graph"')
    .replace(TITLE, "· Graph</title>");
}
