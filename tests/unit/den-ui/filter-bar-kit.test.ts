/**
 * den-ui: the filter bar (filter-bar.js, issue 552), the checks that need
 * no browser. filterBarHtml is pure: it runs in Node.
 *
 *   - shape: one Filters button ("Filters (n)" while n values are chosen)
 *     that discloses the facet panel (aria-expanded, aria-controls); the
 *     panel is a named group, hidden until opened; one group per facet,
 *     its options toggle buttons (aria-pressed) with their counts
 *   - chips: one per chosen value, in facet order, each a button named
 *     "Remove <facet>: <value>", then Clear all; none when nothing is chosen
 *   - a facet with a choice has its own Clear, named for the facet
 *   - an option with a count of 0 can't be chosen, unless it is chosen
 *   - the host's labels are data: escaped, and never in an attribute the
 *     kit words; no inline style or handler (strict CSP)
 *   - the words: en, es and ja; counts in the language's digits
 *
 * The browser half (keys, focus, widths, themes) is
 * list-bars-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as strings from "../../../packages/den-ui/src/strings.js";
import {
  filterBarHtml,
  chosenCount,
} from "../../../packages/den-ui/src/filter-bar.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;

const FACETS = [
  {
    id: "kind",
    label: "Kind",
    options: [
      { value: "doc", label: "Docs", count: 12 },
      { value: "mock", label: "Mocks", count: 0 },
    ],
  },
  {
    id: "status",
    label: "Status",
    options: [
      { value: "draft", label: "Draft", count: 2 },
      { value: "paused", label: "Paused", count: 0 },
      { value: "done", label: "Done", count: 12345 },
    ],
  },
];

/** The markup as a DOM-free list of tags: enough to check attributes. */
const tags = (html: string, cls: string) =>
  [...html.matchAll(/<[a-z]+\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((t) =>
      new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(t),
    );
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
/** The inner HTML of the first element with class `cls` (no nesting of the same tag). */
function inner(html: string, cls: string): string {
  const m = html.match(
    new RegExp(
      `<([a-z]+)\\b[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>`,
    ),
  );
  if (!m) return "";
  const tag = m[1]!;
  let depth = 1;
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
  re.lastIndex = m.index! + m[0].length;
  for (let x = re.exec(html); x; x = re.exec(html)) {
    depth += x[1] ? -1 : 1;
    if (depth === 0) return html.slice(m.index! + m[0].length, x.index);
  }
  return "";
}

describe("filterBarHtml: the Filters button and the panel", () => {
  it("is one button that discloses a hidden, named panel", () => {
    const html = filterBarHtml({ id: "fb", facets: FACETS, selected: {} });
    const [toggle, ...more] = tags(html, "den-fb-toggle");
    expect(more).toEqual([]);
    expect(toggle).toMatch(/^<button\b/);
    expect(attr(toggle!, "type")).toBe("button");
    expect(attr(toggle!, "aria-expanded")).toBe("false");
    expect(attr(toggle!, "aria-controls")).toBe("fb-panel");
    expect(text(inner(html, "den-fb-toggle"))).toBe("Filters");
    const [panel] = tags(html, "den-fb-panel");
    expect(attr(panel!, "id")).toBe("fb-panel");
    expect(attr(panel!, "role")).toBe("group");
    expect(attr(panel!, "aria-label")).toBe("Filters");
    expect(panel).toMatch(/\shidden(\s|>)/);
  });

  it("drawn open: aria-expanded true and the panel shown", () => {
    const html = filterBarHtml({ id: "fb", facets: FACETS, open: true });
    expect(attr(tags(html, "den-fb-toggle")[0]!, "aria-expanded")).toBe("true");
    expect(tags(html, "den-fb-panel")[0]).not.toMatch(/\shidden(\s|>)/);
  });

  it('says "Filters (n)" while n values are chosen', () => {
    const selected = { status: ["draft", "done"], kind: ["doc"] };
    expect(chosenCount(selected)).toBe(3);
    const html = filterBarHtml({ id: "fb", facets: FACETS, selected });
    expect(text(inner(html, "den-fb-toggle"))).toBe("Filters (3)");
  });

  it("one named group per facet; options are toggle buttons with counts", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected: { status: ["paused"] },
    });
    const groups = tags(html, "den-fb-facet");
    expect(groups.map((g) => attr(g, "data-facet"))).toEqual([
      "kind",
      "status",
    ]);
    for (const g of groups) {
      expect(attr(g, "role")).toBe("group");
      const named = attr(g, "aria-labelledby")!;
      expect(html).toContain(`id="${named}"`);
    }
    const opts = tags(html, "den-fb-opt");
    expect(opts.map((o) => attr(o, "data-value"))).toEqual([
      "doc",
      "mock",
      "draft",
      "paused",
      "done",
    ]);
    expect(opts.map((o) => attr(o, "aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
      "true",
      "false",
    ]);
    // A count of 0 can't be chosen; a chosen one with 0 can be let go.
    expect(opts.map((o) => /\sdisabled(\s|>|=)/.test(o))).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(
      [...html.matchAll(/class="den-fb-n"[^>]*>([^<]*)</g)].map((m) => m[1]),
    ).toEqual(["12", "0", "2", "0", "12,345"]);
  });

  it("an option with no count draws none", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: [{ id: "a", label: "A", options: [{ value: "x", label: "X" }] }],
    });
    expect(html).not.toContain("den-fb-n");
  });
});

describe("filterBarHtml: the chosen chips", () => {
  it("one chip per chosen value, in facet order, then Clear all", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected: { status: ["done", "draft"], kind: ["doc"] },
    });
    const [list] = tags(html, "den-fb-chips");
    expect(list).toMatch(/^<ul\b/);
    expect(attr(list!, "aria-label")).toBe("Chosen filters");
    const chips = tags(html, "den-fb-chip");
    expect(chips.map((c) => attr(c, "aria-label"))).toEqual([
      "Remove Kind: Docs",
      "Remove Status: Done",
      "Remove Status: Draft",
    ]);
    for (const c of chips) {
      expect(c).toMatch(/^<button\b/);
      expect(attr(c, "type")).toBe("button");
    }
    expect(text(inner(html, "den-fb-chips"))).toBe(
      "Kind: Docs × Status: Done × Status: Draft × Clear all",
    );
    const [all] = tags(html, "den-fb-clear-all");
    expect(all).toMatch(/^<button\b/);
  });

  it("nothing chosen: no chips and no Clear all", () => {
    const html = filterBarHtml({ id: "fb", facets: FACETS, selected: {} });
    expect(tags(html, "den-fb-chip")).toEqual([]);
    expect(tags(html, "den-fb-clear-all")).toEqual([]);
  });

  it("a chosen value the host has no option for shows as itself", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected: { status: ["gone"] },
    });
    expect(attr(tags(html, "den-fb-chip")[0]!, "aria-label")).toBe(
      "Remove Status: gone",
    );
  });

  it("a facet with a choice has its own Clear, named for it", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected: { status: ["draft"] },
    });
    const clears = tags(html, "den-fb-facet-clear");
    expect(clears.map((c) => attr(c, "data-facet"))).toEqual(["status"]);
    expect(attr(clears[0]!, "aria-label")).toBe("Clear Status");
  });
});

describe("filterBarHtml: the host's labels are data", () => {
  it("escapes every label and value; no inline style or handler", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: [
        {
          id: 'a"b',
          label: "<b>Made</b> by",
          options: [{ value: "x'y", label: "<i>Me</i>", count: 1 }],
        },
      ],
      selected: { 'a"b': ["x'y"] },
    });
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<i>");
    expect(html).toContain("&lt;b&gt;Made&lt;/b&gt; by");
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("a host's words for the kit's own parts are not used", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected: { kind: ["doc"] },
      // Not part of the API: the kit owns these words.
      ...({ label: "Narrow", clearAll: "Reset" } as object),
    });
    expect(html).not.toContain("Narrow");
    expect(html).not.toContain("Reset");
  });
});

describe("filterBarHtml: en, es and ja", () => {
  const selected = { status: ["draft", "done"] };
  it("es", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected,
      lang: "es",
    });
    expect(text(inner(html, "den-fb-toggle"))).toBe("Filtros (2)");
    expect(attr(tags(html, "den-fb-chips")[0]!, "aria-label")).toBe(
      es["kit.filter.chosen"],
    );
    expect(attr(tags(html, "den-fb-chip")[0]!, "aria-label")).toBe(
      "Quitar Status: Draft",
    );
    expect(text(inner(html, "den-fb-clear-all"))).toBe(
      es["kit.filter.clearAll"],
    );
    expect(
      [...html.matchAll(/class="den-fb-n"[^>]*>([^<]*)</g)].map((m) => m[1]),
    ).toContain("12.345");
  });
  it("ja", () => {
    const html = filterBarHtml({
      id: "fb",
      facets: FACETS,
      selected,
      lang: "ja",
    });
    expect(text(inner(html, "den-fb-toggle"))).toBe("絞り込み（2）");
    expect(attr(tags(html, "den-fb-chip")[0]!, "aria-label")).toBe(
      "Status：Draft を外す",
    );
    expect(attr(tags(html, "den-fb-panel")[0]!, "aria-label")).toBe(
      ja["kit.filter.button"],
    );
  });
  it("every kit.filter word is in all three", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("kit.filter."));
    expect(keys.length).toBeGreaterThanOrEqual(7);
    for (const k of keys) {
      expect([k, typeof es[k]]).toEqual([k, "string"]);
      expect([k, typeof ja[k]]).toEqual([k, "string"]);
    }
  });
});
