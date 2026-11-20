/**
 * den-ui: the bulk bar (bulk-bar.js, issue 553), the checks that need no
 * browser. bulkBarHtml is pure: it runs in Node.
 *
 *   - shape: a region named "{n} selected", the count, Clear, then the
 *     host's actions as buttons ("{label} {n}"), each with its id; a
 *     disabled action is a disabled button
 *   - nothing selected: the bar is drawn hidden
 *   - the host's labels are data: escaped; no inline style or handler
 *   - the words: en, es (one and other) and ja
 *
 * The browser half (sticky, keys, focus, a host's dialog, widths, themes)
 * is list-bars-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as strings from "../../../packages/den-ui/src/strings.js";
import { bulkBarHtml } from "../../../packages/den-ui/src/bulk-bar.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;

const ACTIONS = [
  { id: "pause", label: "Pause", count: 3 },
  { id: "wont", label: "Won’t do", count: 3 },
  { id: "replace", label: "Replaced by…", count: 3, disabled: true },
  { id: "export", label: "Export" },
];

const tags = (html: string, cls: string) =>
  [...html.matchAll(/<[a-z]+\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((t) =>
      new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(t),
    );
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
const texts = (html: string, cls: string) =>
  [
    ...html.matchAll(
      new RegExp(
        `<button\\b[^>]*class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"[^>]*>([^<]*)<`,
        "g",
      ),
    ),
  ].map((m) =>
    m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"),
  );

describe("bulkBarHtml", () => {
  it("is a region named for the count: the count, Clear, the actions", () => {
    const html = bulkBarHtml({ count: 3, actions: ACTIONS });
    const [bar] = tags(html, "den-bulk");
    expect(attr(bar!, "role")).toBe("region");
    expect(attr(bar!, "aria-label")).toBe("3 selected");
    expect(bar).not.toMatch(/\shidden(\s|>)/);
    expect(html).toMatch(/class="den-bulk-count"[^>]*>3 selected</);
    expect(texts(html, "den-bulk-clear")).toEqual(["Clear"]);
    const acts = tags(html, "den-bulk-act");
    expect(acts.map((a) => attr(a, "data-action"))).toEqual([
      "pause",
      "wont",
      "replace",
      "export",
    ]);
    for (const a of acts) expect(attr(a, "type")).toBe("button");
    expect(texts(html, "den-bulk-act")).toEqual([
      "Pause 3",
      "Won’t do 3",
      "Replaced by… 3",
      "Export",
    ]);
    expect(acts.map((a) => /\sdisabled(\s|>|=)/.test(a))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    // Clear comes before the actions.
    expect(html.indexOf("den-bulk-clear")).toBeLessThan(
      html.indexOf("den-bulk-act"),
    );
  });

  it("nothing selected: drawn hidden", () => {
    const html = bulkBarHtml({ count: 0, actions: ACTIONS });
    expect(tags(html, "den-bulk")[0]).toMatch(/\shidden(\s|>)/);
  });

  it("escapes the host's labels and ids; no inline style or handler", () => {
    const html = bulkBarHtml({
      count: 2,
      actions: [{ id: 'a"b', label: "<b>Go</b>", count: 2 }],
    });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;b&gt;Go&lt;/b&gt; 2");
    expect(html).toContain('data-action="a&quot;b"');
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("es: one and other", () => {
    const one = bulkBarHtml({ count: 1, actions: [], lang: "es" });
    expect(attr(tags(one, "den-bulk")[0]!, "aria-label")).toBe(
      "1 seleccionado",
    );
    const many = bulkBarHtml({ count: 1200, actions: [], lang: "es" });
    expect(attr(tags(many, "den-bulk")[0]!, "aria-label")).toBe(
      "1200 seleccionados",
    );
    expect(texts(many, "den-bulk-clear")).toEqual([es["kit.bulk.clear"]]);
  });

  it("ja", () => {
    const html = bulkBarHtml({
      count: 3,
      actions: [{ id: "p", label: "一時停止", count: 3 }],
      lang: "ja",
    });
    expect(attr(tags(html, "den-bulk")[0]!, "aria-label")).toBe("3 件を選択中");
    expect(texts(html, "den-bulk-act")).toEqual(["一時停止（3）"]);
    expect(texts(html, "den-bulk-clear")).toEqual([ja["kit.bulk.clear"]]);
  });

  it("every kit.bulk word is in all three", () => {
    const keys = Object.keys(en).filter((k) => k.startsWith("kit.bulk."));
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const k of keys) {
      expect([k, typeof es[k]]).toEqual([k, "string"]);
      expect([k, typeof ja[k]]).toEqual([k, "string"]);
    }
  });
});
