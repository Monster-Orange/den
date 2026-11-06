/**
 * The Graph page (R22, 0.3.0-dev.32): Local Dev's file at /graph, with the
 * shell's page id and the <title> swapped, so the rail marks Graph and the
 * page shows the graph alone. If local-dev.html loses either marker, the
 * swap fails loudly instead of serving Local Dev as "Graph".
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
        "Local Dev".length +
        "Graph".length,
    );
  });

  it("refuses a page without the markers", () => {
    expect(() => graphPageHtml("<html></html>")).toThrow(/markers/);
  });

  it("local-dev.html hides the list, header, actions and tabs on the Graph page", () => {
    for (const sel of [
      ".page-main > .sidebar",
      ".content-header",
      ".cmd-bar",
      ".ctab-bar",
    ])
      expect(LOCAL_DEV).toContain(`body.den-page-graph ${sel}`);
  });
});
