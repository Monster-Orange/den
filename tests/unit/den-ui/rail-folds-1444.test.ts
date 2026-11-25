/**
 * Issue 1444: the rail's sections fold. The checks that need no browser:
 *
 *   - railHtml draws a folded section as data-folded, its entries in
 *     div.den-gb#den-gb-<id>, and its header still the plain heading (no
 *     script: nothing hides, nothing is a button);
 *   - a section holding the current page is never drawn folded;
 *   - the kit's words for the header's name, in en, es and ja;
 *   - the default store (localStorage): a list of section ids, every
 *     failure read as "all open";
 *   - the toggle's list, and the folded count's sum;
 *   - Den keeps the folded sections in the person's own shell settings.
 *
 * The browser half (click, Enter, Space, aria-expanded, the chevron, the
 * count on a folded header, kept across a reload) is
 * rail-folds-1444.browser.test.ts. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  foldCount,
  railFoldStore,
  toggleFolded,
} from "../../../packages/den-ui/src/shell-client.js";
import {
  railGroupHtml,
  railHtml,
} from "../../../packages/den-ui/src/shell-html.js";
import * as strings from "../../../packages/den-ui/src/strings.js";
import {
  mergeShellPrefs,
  shellPrefs,
  SHELL_DEFAULTS,
  storedShell,
} from "../../../src/ui/server/shell-prefs.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const { kitT } = strings as unknown as {
  kitT: (l: string, k: string, v?: object) => string;
};

const groups = [
  { id: "work", label: "Work" },
  { id: "tools", label: "Tools" },
];
const nav = [
  { id: "a", label: "Alpha", href: "#a", group: "work", current: true },
  { id: "b", label: "Beta", href: "#b", group: "tools", badge: { n: 2 } },
  { id: "c", label: "Gamma", href: "#c", group: "tools", badge: { n: 3 } },
];

/** The opening tag of the section with this id. */
const groupTag = (html: string, id: string) =>
  html.match(
    new RegExp(
      `<div class="den-rail-group"[^>]*aria-labelledby="den-gh-${id}"[^>]*>`,
    ),
  )?.[0] ?? "";

describe("railHtml: a folded section", () => {
  const html = railHtml({ nav, groups, folded: ["tools"] } as never);

  it("is marked data-folded; an open one is not", () => {
    expect(groupTag(html, "tools")).toContain("data-folded");
    expect(groupTag(html, "work")).not.toContain("data-folded");
  });

  it("keeps its entries in div.den-gb#den-gb-<id>", () => {
    expect(html).toMatch(
      /<div class="den-gb" id="den-gb-tools">.*data-nav="b".*data-nav="c".*<\/div>/s,
    );
    expect(html).toContain('<div class="den-gb" id="den-gb-work">');
  });

  it("keeps the plain heading: no button, nothing hidden, without script", () => {
    expect(html).not.toMatch(/<button[^>]*den-gh/);
    expect(html).not.toMatch(/den-gb[^>]*hidden/);
    expect(html).toContain('<div class="den-gh" data-nav-role="group">');
  });

  it("is never the section of the current page", () => {
    const h = railHtml({ nav, groups, folded: ["work", "tools"] } as never);
    expect(groupTag(h, "work")).not.toContain("data-folded");
    expect(groupTag(h, "tools")).toContain("data-folded");
  });

  it("railGroupHtml with no fold says nothing of one", () => {
    const g = railGroupHtml({ id: "x", label: "X" }, "", "en");
    expect(g).not.toContain("data-folded");
  });
});

describe("the header's name, in the kit's words", () => {
  const FINAL: Record<string, [string, string, string]> = {
    en: ["Hide Tools", "Show Tools", "Show Tools, 5 inside"],
    es: ["Ocultar Tools", "Mostrar Tools", "Mostrar Tools, 5 dentro"],
    ja: ["Toolsを隠す", "Toolsを表示", "Toolsを表示（5件）"],
  };
  it.each(Object.keys(FINAL))("%s", (lang) => {
    expect(kitT(lang, "kit.rail.fold", { section: "Tools" })).toBe(
      FINAL[lang]![0],
    );
    expect(kitT(lang, "kit.rail.unfold", { section: "Tools" })).toBe(
      FINAL[lang]![1],
    );
    expect(kitT(lang, "kit.rail.unfoldN", { section: "Tools", n: "5" })).toBe(
      FINAL[lang]![2],
    );
  });
});

describe("the default store", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
      setItem: (k: string, v: string) => void m.set(k, v),
      m,
    };
  };

  it("keeps the folded sections' ids under den.rail.folded", () => {
    const s = mem();
    const st = railFoldStore(s);
    expect(st.get()).toEqual([]);
    st.set(["tools", "work"]);
    expect(JSON.parse(s.m.get("den.rail.folded")!)).toEqual(["tools", "work"]);
    expect(st.get()).toEqual(["tools", "work"]);
  });

  it("reads anything else as all open, and never throws", () => {
    const s = mem();
    s.setItem("den.rail.folded", "{not json");
    expect(railFoldStore(s).get()).toEqual([]);
    s.setItem("den.rail.folded", JSON.stringify(["ok", 3, { x: 1 }]));
    expect(railFoldStore(s).get()).toEqual(["ok"]);
    const broken = {
      getItem: () => {
        throw new Error("no storage");
      },
      setItem: () => {
        throw new Error("no storage");
      },
    };
    expect(railFoldStore(broken).get()).toEqual([]);
    expect(() => railFoldStore(broken).set(["a"])).not.toThrow();
    expect(railFoldStore(null).get()).toEqual([]);
  });
});

describe("the toggle and the folded count", () => {
  it("toggleFolded adds or drops one id, keeping the rest", () => {
    expect(toggleFolded([], "a")).toEqual(["a"]);
    expect(toggleFolded(["a", "b"], "a")).toEqual(["b"]);
    expect(toggleFolded(["b"], "a")).toEqual(["b", "a"]);
  });

  it("foldCount sums the entries' badges; bad when any is", () => {
    expect(foldCount([])).toEqual({ n: 0, bad: false });
    expect(foldCount([{ n: "2" }, { n: "3", bad: true }])).toEqual({
      n: 5,
      bad: true,
    });
    expect(foldCount([{ n: "99+" }, { n: "x" }])).toEqual({
      n: 99,
      bad: false,
    });
  });
});

describe("Den keeps it in the person's shell settings", () => {
  it("is empty by default, and stores nothing then", () => {
    expect(SHELL_DEFAULTS.folded).toEqual([]);
    expect(shellPrefs({}).folded).toEqual([]);
    expect(storedShell(shellPrefs({}))?.folded).toBeUndefined();
  });

  it("takes a list of section ids, and refuses anything else", () => {
    const ok = mergeShellPrefs(shellPrefs({}), { folded: ["tools", "pinned"] });
    expect(ok.ok && ok.value.folded).toEqual(["tools", "pinned"]);
    if (ok.ok)
      expect(storedShell(ok.value)?.folded).toEqual(["tools", "pinned"]);
    expect(mergeShellPrefs(shellPrefs({}), { folded: "tools" }).ok).toBe(false);
    expect(mergeShellPrefs(shellPrefs({}), { folded: ["../x"] }).ok).toBe(
      false,
    );
    expect(shellPrefs({ folded: ["tools", 7] }).folded).toEqual([]);
  });
});

describe("shell.css", () => {
  const css = fs.readFileSync(path.join(SRC, "shell.css"), "utf-8");
  it("hides a folded section's entries only with script", () => {
    expect(css).toMatch(
      /@media \(scripting: enabled\)\s*\{[^}]*\.den-rail-group\[data-folded\][^{]*\{\s*display: none;/,
    );
  });
  it("turns the chevron with no motion when motion is reduced", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.den-gh-chev[^{]*\{\s*transition: none;/,
    );
  });
});
