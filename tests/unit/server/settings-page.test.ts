/**
 * The Settings page's search and URL (R21, settings-page.js): a row
 * matches on its label, description and keywords (every word); a match
 * stays under its category; empty categories go; the URL keeps
 * #<category> and ?q=.
 */
import { describe, expect, it } from "@jest/globals";
import {
  countText,
  readLocation,
  rowMatches,
  scopeText,
  sections,
  settingsUrl,
} from "../../../src/ui/server/public/settings-page.js";
import {
  DEN_SETTINGS,
  DEN_SETTING_CATEGORIES,
} from "../../../src/ui/server/public/settings-registry.js";

const cats = DEN_SETTING_CATEGORIES.slice().sort((a, b) => a.order - b.order);
const ids = (q: string) =>
  sections(cats, DEN_SETTINGS, q).map((s) => [
    s.category.id,
    s.rows.map((r) => r.id),
  ]);

describe("search", () => {
  it("no query: every category, in order, with all its rows", () => {
    const all = sections(cats, DEN_SETTINGS, "");
    expect(all.map((s) => s.category.id)).toEqual([
      "appearance",
      "editor",
      "navigation",
      "graph",
      "workspace",
      "cli",
      "distribution",
    ]);
    expect(all.reduce((n, s) => n + s.rows.length, 0)).toBe(
      DEN_SETTINGS.length,
    );
  });

  it("matches the label, the description and the keywords; matches stay under their heading", () => {
    // "terminal" is a label (Default terminal) and a keyword (Terminal
    // tabs): each match keeps its category.
    expect(ids("terminal")).toEqual([
      ["editor", ["terminal"]],
      ["cli", ["cli.cli_tabs"]],
    ]);
    // A description word: "stack.yml" is in Per-language IDE's.
    expect(ids("stack.yml")).toEqual([["editor", ["editor_overrides"]]]);
    // A keyword only: "dark" is in Mode's keywords.
    expect(ids("dark")).toEqual([["appearance", ["appearance.mode"]]]);
    // Every word must match, in any order, any case.
    expect(ids("RAIL hide")).toEqual([["navigation", ["shell.pages"]]]);
  });

  it("nothing matches: no sections, and the count says so", () => {
    expect(sections(cats, DEN_SETTINGS, "zzzz-nothing")).toEqual([]);
    expect(countText(0)).toBe("No settings match");
    expect(countText(1)).toBe("1 setting matches");
    expect(countText(3)).toBe("3 settings match");
  });

  it("a row whose category isn't registered waits for it", () => {
    const rows = [
      {
        id: "x.one",
        category: "later",
        label: "One",
        description: "",
        keywords: [],
      },
    ];
    expect(sections(cats, rows, "")).toEqual([]);
    expect(
      sections([...cats, { id: "later", label: "Later", order: 99 }], rows, "")
        .length,
    ).toBe(1);
    expect(rowMatches(rows[0], "one")).toBe(true);
  });
});

describe("the URL keeps #category and ?q=", () => {
  it("reads them", () => {
    expect(
      readLocation({ search: "?q=dark%20mode&ws=b", hash: "#appearance" }),
    ).toEqual({ category: "appearance", q: "dark mode" });
    expect(readLocation({ search: "", hash: "" })).toEqual({
      category: null,
      q: "",
    });
  });
  it("writes them, keeping other params", () => {
    const loc = { pathname: "/settings", search: "?ws=b", hash: "" };
    expect(settingsUrl(loc, { category: "graph", q: "dir" })).toBe(
      "/settings?ws=b&q=dir#graph",
    );
    expect(
      settingsUrl({ ...loc, search: "?q=x" }, { category: "editor", q: "" }),
    ).toBe("/settings#editor");
  });
});

describe("scope tags", () => {
  it("User, Workspace · <ws>, Distribution · read-only", () => {
    expect(scopeText({ scope: "user" }, "a")).toBe("User");
    expect(scopeText({ scope: "workspace" }, "ws-b")).toBe("Workspace · ws-b");
    expect(scopeText({ scope: "distribution" }, "a")).toBe(
      "Distribution · read-only",
    );
  });
});
