/**
 * The Graph page (R22, 0.3.0-dev.32): the Workspaces page's file
 * (local-dev.html, R24) at /graph, with the shell's page id and the
 * <title> swapped, so the rail marks Graph and the page shows the graph
 * alone. If local-dev.html loses either marker, the swap fails loudly
 * instead of serving Workspaces as "Graph".
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { graphPageHtml } from "../../../src/ui/server/graph-page.js";

const LOCAL_DEV = fs.readFileSync(
  path.join(process.cwd(), "src", "ui", "server", "public", "local-dev.html"),
  "utf-8",
);

describe("graphPageHtml", () => {
  it("names the page graph, in the shell and the title", () => {
    const html = graphPageHtml(LOCAL_DEV);
    expect(html).toContain('<div id="den-shell" data-page="graph"');
    expect(html).not.toContain('data-page="local-dev"');
    expect(html).toContain("<title>__DEN_TITLE__ · Graph</title>");
    // Nothing else changes.
    expect(html.length).toBe(
      LOCAL_DEV.length -
        "local-dev".length +
        "graph".length -
        "Workspaces".length +
        "Graph".length,
    );
  });

  it("refuses a page without the markers", () => {
    expect(() => graphPageHtml("<html></html>")).toThrow(/markers/);
  });

  it("local-dev.html hides the list on the Graph page, and draws the graph alone there", () => {
    expect(LOCAL_DEV).toContain("body.den-page-graph .page-main > .sidebar");
    // The Graph page's branch draws the graph panel and returns: no
    // workspace header, action row or repo table (R24).
    const branch = LOCAL_DEV.slice(
      LOCAL_DEV.indexOf("if (GRAPH_PAGE) {\n            content.innerHTML"),
    );
    expect(branch.slice(0, 600)).toMatch(
      /<div class="graph-panel" id="graph-panel">[\s\S]*renderDepGraph\([^)]*\);\s*return;/,
    );
    expect(LOCAL_DEV).not.toMatch(/\bctab/);
  });
});
