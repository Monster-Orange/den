import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { hydrateTabs, tabsHtml } from "../../../packages/den-ui/src/tabs.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");

const ITEMS = [
  { id: "open", text: "Open", count: 12, href: "/list?state=open" },
  { id: "closed", text: "Closed", href: "/list?state=closed" },
  { id: "all", text: "All", href: "/list" },
];

const WORDS = {
  en: { label: "State", items: ["Open", "Closed", "All"] },
  es: { label: "Estado", items: ["Abiertas", "Cerradas", "Todas"] },
  ja: { label: "状態", items: ["未完了", "完了", "すべて"] },
};

const tag = (html: string, sel: RegExp) => html.match(sel)?.[0] ?? "";
const segs = (html: string) =>
  [...html.matchAll(/<(a|button)\b[^>]*class="den-tab"[^>]*>/g)].map((m) => {
    const t = m[0];
    const at = (n: string) => t.match(new RegExp(` ${n}="([^"]*)"`))?.[1];
    return {
      el: m[1],
      id: at("data-id"),
      href: at("href") ?? null,
      role: at("role") ?? null,
      current: at("aria-current") ?? null,
      pressed: at("aria-pressed") ?? null,
      selected: at("aria-selected") ?? null,
      controls: at("aria-controls") ?? null,
      tabindex: at("tabindex") ?? null,
      label: at("aria-label") ?? null,
      off: at("aria-disabled") === "true",
      alert: / data-alert\b/.test(t),
      domId: at("id") ?? null,
    };
  });
const options = (html: string) =>
  [...html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({
    value: m[1]!.match(/value="([^"]*)"/)?.[1],
    href: m[1]!.match(/data-href="([^"]*)"/)?.[1] ?? null,
    selected: / selected\b/.test(m[1]!),
    disabled: / disabled\b/.test(m[1]!),
    text: m[2],
  }));

describe("tabsHtml: page tabs (links)", () => {
  const html = tabsHtml({
    kind: "page",
    label: "State",
    items: ITEMS,
    chosen: "closed",
  });

  it("draws a labelled nav of links, the chosen one aria-current", () => {
    expect(tag(html, /<div class="den-tabs"[^>]*>/)).toBe(
      '<div class="den-tabs" data-den-tabs="page" data-size="auto" data-den-tabs-over="none">',
    );
    expect(html).toContain('<nav class="den-tabs-row" aria-label="State">');
    const s = segs(html);
    expect(s.map((x) => [x.el, x.id, x.href, x.current])).toEqual([
      ["a", "open", "/list?state=open", null],
      ["a", "closed", "/list?state=closed", "page"],
      ["a", "all", "/list", null],
    ]);
    expect(s.every((x) => x.role === null && x.tabindex === null)).toBe(true);
    expect(s.every((x) => x.pressed === null && x.selected === null)).toBe(
      true,
    );
  });

  it("names a counted tab with its count, and hides the count from readers", () => {
    expect(segs(html)[0]!.label).toBe("Open, 12");
    expect(html).toContain(
      '<span class="den-tab-n" aria-hidden="true">12</span>',
    );
    expect(segs(html)[1]!.label).toBeNull();
  });

  it("folds to a select with the same choices, links and visible label", () => {
    expect(html).toContain(
      '<label class="den-tabs-fold" hidden><span class="den-tabs-fold-l">State</span><select class="den-tabs-select">',
    );
    expect(options(html)).toEqual([
      {
        value: "open",
        href: "/list?state=open",
        selected: false,
        disabled: false,
        text: "Open (12)",
      },
      {
        value: "closed",
        href: "/list?state=closed",
        selected: true,
        disabled: false,
        text: "Closed",
      },
      {
        value: "all",
        href: "/list",
        selected: false,
        disabled: false,
        text: "All",
      },
    ]);
  });

  it("draws « and » hidden, out of the tab order and away from readers", () => {
    const edges = [
      ...html.matchAll(/<button[^>]*class="den-tabs-edge"[^>]*>([«»])/g),
    ];
    expect(edges.map((m) => m[1])).toEqual(["«", "»"]);
    for (const m of edges) {
      expect(m[0]).toContain('tabindex="-1"');
      expect(m[0]).toContain('aria-hidden="true"');
      expect(m[0]).toMatch(/ hidden>/);
    }
  });

  it("a disabled page tab is a link with no href", () => {
    const h = tabsHtml({
      kind: "page",
      label: "State",
      items: [ITEMS[0]!, { ...ITEMS[1]!, disabled: true }],
    });
    const off = segs(h)[1]!;
    expect(off.off).toBe(true);
    expect(off.href).toBeNull();
    expect(off.current).toBeNull();
  });

  it("a page tab with no href links to #", () => {
    const h = tabsHtml({
      kind: "page",
      label: "State",
      items: [
        { id: "a", text: "A" },
        { id: "b", text: "B" },
      ],
    });
    expect(segs(h).map((x) => x.href)).toEqual(["#", "#"]);
  });
});

describe("tabsHtml: a switch (buttons)", () => {
  const html = tabsHtml({
    label: "View",
    items: [
      { id: "list", text: "List" },
      { id: "board", text: "Board" },
      { id: "map", text: "Map", disabled: true },
    ],
    chosen: "board",
  });

  it("is the default kind: a labelled group of pressed buttons", () => {
    expect(html).toContain('data-den-tabs="switch"');
    expect(html).toContain(
      '<div class="den-tabs-row" role="group" aria-label="View">',
    );
    expect(
      segs(html).map((x) => [x.el, x.id, x.pressed, x.tabindex, x.off]),
    ).toEqual([
      ["button", "list", "false", "-1", false],
      ["button", "board", "true", "0", false],
      ["button", "map", "false", "-1", true],
    ]);
    expect(html).toMatch(/<button type="button" class="den-tab"/);
    expect(segs(html).every((x) => x.href === null)).toBe(true);
  });

  it("a disabled option stays in the select, disabled", () => {
    expect(options(html).map((o) => [o.value, o.disabled])).toEqual([
      ["list", false],
      ["board", false],
      ["map", true],
    ]);
  });

  it("an unknown kind is a switch", () => {
    expect(
      tabsHtml({ kind: "menu" as never, label: "View", items: ITEMS }),
    ).toContain('data-den-tabs="switch"');
  });
});

describe("tabsHtml: panel tabs (a tablist)", () => {
  const html = tabsHtml({
    kind: "panel",
    label: "Details",
    items: [
      { id: "about", text: "About" },
      { id: "logs", text: "Logs", panel: "logs-panel", alert: true },
      { id: "keys", text: "Keys", disabled: true },
    ],
  });

  it("draws a labelled tablist; each tab controls its panel", () => {
    expect(html).toContain(
      '<div class="den-tabs-row" role="tablist" aria-label="Details">',
    );
    expect(
      segs(html).map((x) => [
        x.role,
        x.domId,
        x.controls,
        x.selected,
        x.tabindex,
      ]),
    ).toEqual([
      ["tab", "den-tab-about", "about", "true", "0"],
      ["tab", "den-tab-logs-panel", "logs-panel", "false", "-1"],
      ["tab", "den-tab-keys", "keys", "false", "-1"],
    ]);
  });

  it("links each usable tab to ?tab=<id>, so it works with no script", () => {
    expect(segs(html).map((x) => x.href)).toEqual([
      "?tab=about",
      "?tab=logs",
      null,
    ]);
  });

  it("marks a tab with an alert", () => {
    expect(segs(html).map((x) => x.alert)).toEqual([false, true, false]);
  });
});

describe("tabsHtml: the model", () => {
  it("draws nothing with no label or fewer than two tabs", () => {
    expect(tabsHtml({ label: "", items: ITEMS })).toBe("");
    expect(tabsHtml({ label: "  ", items: ITEMS })).toBe("");
    expect(tabsHtml({ label: "View", items: [ITEMS[0]!] })).toBe("");
    expect(tabsHtml({} as never)).toBe("");
  });

  it("drops a tab with no id or no text", () => {
    const h = tabsHtml({
      label: "View",
      items: [
        { id: "a", text: "A" },
        { id: null as never, text: "None" },
        { id: "b", text: "  " },
        { id: "c", text: "C" },
      ],
    });
    expect(segs(h).map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("chooses the first usable tab when chosen is missing or disabled", () => {
    const items = [
      { id: "a", text: "A", disabled: true },
      { id: "b", text: "B" },
      { id: "c", text: "C" },
    ];
    const on = (h: string) =>
      segs(h)
        .filter((x) => x.pressed === "true")
        .map((x) => x.id);
    expect(on(tabsHtml({ label: "V", items }))).toEqual(["b"]);
    expect(on(tabsHtml({ label: "V", items, chosen: "a" }))).toEqual(["b"]);
    expect(on(tabsHtml({ label: "V", items, chosen: "zz" }))).toEqual(["b"]);
    expect(on(tabsHtml({ label: "V", items, chosen: "c" }))).toEqual(["c"]);
  });

  it("takes size m or l, else auto", () => {
    const size = (s: unknown) =>
      tabsHtml({ label: "V", items: ITEMS, size: s as never }).match(
        /data-size="(\w+)"/,
      )?.[1];
    expect([size("m"), size("l"), size("xl"), size(undefined)]).toEqual([
      "m",
      "l",
      "auto",
      "auto",
    ]);
  });

  it("escapes every host string", () => {
    const h = tabsHtml({
      kind: "page",
      label: 'A "b" <c>',
      items: [
        { id: 'x"y', text: "<b>One</b>", href: '/a?q="1"&r=2', count: "<9>" },
        { id: "z", text: "Two & three" },
      ],
    });
    expect(h).not.toMatch(/<b>|<c>|<9>/);
    expect(h).toContain('aria-label="A &quot;b&quot; &lt;c&gt;"');
    expect(h).toContain('data-id="x&quot;y"');
    expect(h).toContain('href="/a?q=&quot;1&quot;&amp;r=2"');
    expect(h).toContain("&lt;b&gt;One&lt;/b&gt;");
    expect(h).toContain("Two &amp; three");
  });

  it("encodes a panel tab's id in its ?tab= link", () => {
    const h = tabsHtml({
      kind: "panel",
      label: "V",
      items: [
        { id: "a b", text: "A" },
        { id: "c&d", text: "C" },
      ],
    });
    expect(segs(h).map((x) => x.href)).toEqual(["?tab=a%20b", "?tab=c%26d"]);
  });
});

describe("tabsHtml: every word is the host's (en, es, ja)", () => {
  it.each(Object.entries(WORDS))(
    "%s: the label and tab names are drawn as given, and nothing else",
    (_lang, w) => {
      const h = tabsHtml({
        kind: "panel",
        label: w.label,
        items: w.items.map((text, i) => ({ id: `t${i}`, text, count: i + 1 })),
      });
      expect(h).toContain(`aria-label="${w.label}"`);
      expect(h).toContain(`<span class="den-tabs-fold-l">${w.label}</span>`);
      const shown = [
        ...h.matchAll(/<span class="den-tab-t">([^<]*)<\/span>/g),
      ].map((m) => m[1]);
      expect(shown).toEqual(w.items);
      expect(options(h).map((o) => o.text)).toEqual(
        w.items.map((t, i) => `${t} (${i + 1})`),
      );
      const text = h
        .replace(/<[^>]*>/g, " ")
        .split(/\s+/)
        .filter(Boolean);
      const own = new Set([
        ...w.label.split(/\s+/),
        ...w.items.flatMap((t) => t.split(/\s+/)),
        "«",
        "»",
        "1",
        "2",
        "3",
        "(1)",
        "(2)",
        "(3)",
      ]);
      expect(text.filter((x) => !own.has(x))).toEqual([]);
    },
  );

  it("the kit's tabs files carry no words table and name no product", () => {
    for (const f of ["tabs.js", "tabs.css", "tabs.d.ts"]) {
      const src = fs.readFileSync(path.join(SRC, f), "utf-8");
      expect(src).not.toMatch(/\bkitT\b|\bLair\b|\bHub\b/);
    }
  });
});

describe("hydrateTabs: with nothing to hydrate", () => {
  it("returns a no-op handle", () => {
    const t = hydrateTabs(null);
    expect(t.chosen()).toBe("");
    expect(() => {
      t.set("a");
      t.destroy();
    }).not.toThrow();
  });
});
