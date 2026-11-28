import { describe, expect, it } from "@jest/globals";
import { tabsHtml } from "../../../packages/den-ui/src/tabs.js";

const attr = (tag: string, n: string) =>
  tag.match(new RegExp(` ${n}="([^"]*)"`))?.[1] ?? null;
const tabTag = (html: string, id: string) =>
  html.match(
    new RegExp(`<(a|button)\\b[^>]*class="den-tab"[^>]*data-id="${id}"[^>]*>`),
  )?.[0] ?? "";
const closeTag = (html: string, id: string) =>
  html.match(
    new RegExp(`<button\\b[^>]*data-den-tab-close="${id}"[^>]*>`),
  )?.[0] ?? "";

const RUNS = {
  kind: "panel" as const,
  label: "Runs",
  min: 1,
  items: [
    {
      id: "r1",
      text: "up web",
      panel: "out",
      close: "Close up web",
      dot: { state: "run", text: "Running" },
    },
    {
      id: "r2",
      text: "logs <db>",
      panel: "out",
      close: 'Close "logs"',
      dot: { state: "bad", text: "Failed after 3 s" },
    },
    { id: "r3", text: "plain", panel: "out" },
  ],
};

describe("tabsHtml: a closable tab", () => {
  const html = tabsHtml(RUNS);

  it("draws a × beside the tab, out of the tab order, named by the host", () => {
    const x = closeTag(html, "r1");
    expect(x).not.toBe("");
    expect(attr(x, "type")).toBe("button");
    expect(attr(x, "tabindex")).toBe("-1");
    expect(attr(x, "aria-label")).toBe("Close up web");
    expect(attr(x, "title")).toBe("Close up web");
  });

  it("says Delete closes it, and only on a closable tab", () => {
    expect(attr(tabTag(html, "r1"), "aria-keyshortcuts")).toBe("Delete");
    expect(attr(tabTag(html, "r3"), "aria-keyshortcuts")).toBeNull();
    expect(closeTag(html, "r3")).toBe("");
  });

  it("escapes the close label", () => {
    expect(attr(closeTag(html, "r2"), "aria-label")).toBe(
      "Close &quot;logs&quot;",
    );
  });
});

describe("tabsHtml: a status dot", () => {
  const html = tabsHtml(RUNS);

  it("draws the kit's dot before the words, hidden from readers", () => {
    const seg = html.slice(html.indexOf('data-id="r1"'));
    expect(seg).toMatch(
      /^[^>]*>\s*<span class="den-dot run" aria-hidden="true"><\/span><span class="den-tab-t">up web<\/span>/,
    );
  });

  it("puts the dot's words in the tab's name and its tooltip", () => {
    const t = tabTag(html, "r2");
    expect(attr(t, "aria-label")).toBe("logs &lt;db&gt;, Failed after 3 s");
    expect(attr(t, "title")).toBe("Failed after 3 s");
  });

  it("takes run, ok, bad and off, and anything else is off", () => {
    for (const [state, cls] of [
      ["run", "run"],
      ["ok", "ok"],
      ["bad", "bad"],
      ["off", "off"],
      ["weird", "off"],
    ]) {
      const h = tabsHtml({
        ...RUNS,
        items: [{ id: "a", text: "A", dot: { state, text: "w" } }],
      });
      expect(h).toContain(`<span class="den-dot ${cls}" aria-hidden="true">`);
    }
  });

  it("a tab with no dot has no dot and no tooltip", () => {
    const t = tabTag(html, "r3");
    expect(attr(t, "title")).toBeNull();
    expect(html.slice(html.indexOf('data-id="r3"'))).not.toMatch(
      /^[^<]*>\s*<span class="den-dot/,
    );
  });
});

describe("tabsHtml: min", () => {
  it("draws one tab when the host allows it, and never none", () => {
    const one = { ...RUNS, items: [RUNS.items[0]!] };
    expect(tabsHtml(one)).toContain('data-id="r1"');
    expect(tabsHtml({ ...one, min: undefined })).toBe("");
    expect(tabsHtml({ ...RUNS, items: [] })).toBe("");
  });
});
