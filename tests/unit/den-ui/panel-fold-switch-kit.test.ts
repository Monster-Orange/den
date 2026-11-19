/**
 * den-ui: the panel fold toggle (issue 548), the folded panel's edge strip
 * (issue 549) and the switch (issue 551), the checks that need no browser:
 *
 *   - the markup each builder draws: tags, classes, roles, aria, ids;
 *   - data only: the toggle and the strip take no words; their words are
 *     the kit's, in en, es and ja (the FINAL table), and a host's "label",
 *     "title" or "aria-label" is not used;
 *   - the switch's label and help are the host's own text (its setting's
 *     name), escaped; the switch adds no words of its own;
 *   - a count of 0 draws no count; a count says what it counts with the
 *     kit's badge words; any other `what` is dropped;
 *   - the files name no product.
 *
 * The browser half (keyboard, focus, callbacks, sizes at 1280 and 390,
 * light and dark) is panel-fold-switch-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  edgeStripHtml,
  foldToggleHtml,
} from "../../../packages/den-ui/src/panel-fold.js";
import { switchHtml } from "../../../packages/den-ui/src/switch.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const { kitT } = strings as unknown as {
  kitT: (l: string, k: string, v?: object) => string;
};

/** The attributes of the first `<tag …>` in `html`. */
function attrs(html: string, tag: string): Record<string, string> {
  const m = html.match(new RegExp(`<${tag}\\b([^>]*)>`));
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const a of m[1]!.matchAll(/([\w-]+)(?:="([^"]*)")?/g))
    out[a[1]!] = a[2] ?? "";
  return out;
}

const FINAL: Record<string, Record<string, string>> = {
  en: {
    "kit.fold.panel": "Panel",
    "kit.fold.show": "Show panel",
    "kit.fold.hidden": "Panel, hidden",
  },
  es: {
    "kit.fold.panel": "Panel",
    "kit.fold.show": "Mostrar panel",
    "kit.fold.hidden": "Panel, oculto",
  },
  ja: {
    "kit.fold.panel": "パネル",
    "kit.fold.show": "パネルを表示",
    "kit.fold.hidden": "パネル（非表示）",
  },
};

describe("panel fold toggle (issue 548): foldToggleHtml", () => {
  it("is a button: icon, then the kit's word; aria-pressed; aria-controls", () => {
    const h = foldToggleHtml({ pressed: true, controls: "side" });
    const a = attrs(h, "button");
    expect(a).toMatchObject({
      type: "button",
      class: "den-fold",
      "aria-pressed": "true",
      "aria-controls": "side",
      "data-den-fold": "",
    });
    // The icon is aria-hidden: the word names the button.
    expect(h).toMatch(
      /^<button[^>]*><svg viewBox="0 0 24 24" aria-hidden="true">.*<\/svg><span class="den-fold-word">Panel<\/span><\/button>$/,
    );
  });

  it("pressed false is aria-pressed false; pressed is true by default", () => {
    expect(attrs(foldToggleHtml({ pressed: false }), "button")).toMatchObject({
      "aria-pressed": "false",
    });
    expect(attrs(foldToggleHtml({}), "button")).toMatchObject({
      "aria-pressed": "true",
    });
  });

  it("without controls there is no aria-controls", () => {
    expect(attrs(foldToggleHtml({}), "button")["aria-controls"]).toBe(
      undefined,
    );
  });

  it("takes no words: a host's label, title or aria-label is not used", () => {
    const h = foldToggleHtml({
      label: "Mine",
      title: "Mine",
      "aria-label": "Mine",
    } as never);
    expect(h).not.toContain("Mine");
    expect(h).toContain(">Panel<");
  });

  it("escapes its id data", () => {
    expect(foldToggleHtml({ controls: 'a"><b' })).toContain(
      'aria-controls="a&quot;&gt;&lt;b"',
    );
  });

  it.each(["en", "es", "ja"])("words in %s", (lang) => {
    const h = foldToggleHtml({ lang });
    expect(h).toContain(`>${FINAL[lang]!["kit.fold.panel"]}</span>`);
  });
});

describe("edge strip (issue 549): edgeStripHtml", () => {
  it("is a complementary landmark named by the kit, with Show panel and a count", () => {
    const h = edgeStripHtml({ count: 2, controls: "side" });
    expect(attrs(h, "div")).toMatchObject({
      class: "den-strip",
      role: "complementary",
      "aria-label": "Panel, hidden",
      "data-den-strip": "",
    });
    const b = attrs(h, "button");
    expect(b).toMatchObject({
      type: "button",
      class: "den-strip-show",
      "aria-label": "Show panel",
      title: "Show panel",
      "aria-controls": "side",
      "data-den-strip-show": "",
    });
    // The count: the number seen, its words heard.
    expect(h).toContain(
      '<span class="den-strip-n" data-den-strip-n><span aria-hidden="true">2</span><span class="den-strip-sr">2 open</span></span>',
    );
  });

  it("a count of 0 (or none) draws no count", () => {
    expect(edgeStripHtml({ count: 0 })).not.toContain("den-strip-n");
    expect(edgeStripHtml({})).not.toContain("den-strip-n");
  });

  it("says what it counts with the kit's badge words; another kind is dropped", () => {
    expect(edgeStripHtml({ count: 3, what: "waiting" })).toContain(
      '<span class="den-strip-sr">3 waiting</span>',
    );
    expect(edgeStripHtml({ count: 3, what: "bogus" as never })).toContain(
      '<span class="den-strip-sr">3 open</span>',
    );
  });

  it("99+ past 99, as the bell", () => {
    expect(edgeStripHtml({ count: 120 })).toContain(
      '<span aria-hidden="true">99+</span><span class="den-strip-sr">120 open</span>',
    );
  });

  it("takes no words: a host's label, title or aria-label is not used", () => {
    const h = edgeStripHtml({
      count: 1,
      label: "Mine",
      title: "Mine",
      show: "Mine",
    } as never);
    expect(h).not.toContain("Mine");
  });

  it.each(["en", "es", "ja"])("words in %s", (lang) => {
    const h = edgeStripHtml({ count: 1, lang });
    expect(attrs(h, "div")["aria-label"]).toBe(FINAL[lang]!["kit.fold.hidden"]);
    expect(attrs(h, "button")["aria-label"]).toBe(
      FINAL[lang]!["kit.fold.show"],
    );
    expect(h).toContain(
      `<span class="den-strip-sr">${kitT(lang, "kit.badge.open", { n: 1 })}</span>`,
    );
  });
});

describe("switch (issue 551): switchHtml", () => {
  it("is a label holding the host's words and a role=switch checkbox", () => {
    const h = switchHtml({ id: "s1", label: "Show notes", on: true });
    expect(attrs(h, "label")).toMatchObject({
      class: "den-switch",
      for: "s1",
    });
    expect(attrs(h, "input")).toMatchObject({
      type: "checkbox",
      role: "switch",
      class: "den-switch-input",
      id: "s1",
      checked: "",
      "aria-labelledby": "s1-label",
      "data-den-switch": "",
    });
    // Named by the label alone: the help is its description, not its name.
    expect(h).toContain(
      '<span class="den-switch-label" id="s1-label">Show notes</span>',
    );
  });

  it("off is unchecked; disabled is disabled; help is its description", () => {
    const h = switchHtml({
      id: "s2",
      label: "A",
      on: false,
      disabled: true,
      help: "B",
    });
    const i = attrs(h, "input");
    expect(i.role).toBe("switch");
    expect(i.checked).toBe(undefined);
    expect(i.disabled).toBe("");
    expect(i["aria-describedby"]).toBe("s2-help");
    expect(h).toContain('<span class="den-switch-help" id="s2-help">B</span>');
    expect(attrs(h, "label")["data-disabled"]).toBe("");
  });

  it("no help, no aria-describedby; an id of its own when none is given", () => {
    const a = attrs(switchHtml({ label: "A" }), "input");
    const b = attrs(switchHtml({ label: "A" }), "input");
    expect(a["aria-describedby"]).toBe(undefined);
    expect(a.id).toMatch(/^den-sw-\d+$/);
    expect(b.id).not.toBe(a.id);
  });

  it("escapes the host's words and id", () => {
    const h = switchHtml({ id: 'x"', label: "<b>A</b>", help: "&" });
    expect(h).toContain("&lt;b&gt;A&lt;/b&gt;");
    expect(h).toContain(">&amp;</span>");
    expect(h).toContain('id="x&quot;"');
  });

  it("with no label it draws nothing (a switch must have a name)", () => {
    expect(switchHtml({ label: "" })).toBe("");
    expect(switchHtml({} as never)).toBe("");
  });

  it.each(["en", "es", "ja"])(
    "adds no words of its own in %s: only the host's",
    (lang) => {
      const h = switchHtml({ id: "s", label: "L", help: "H", lang } as never);
      const text = h
        .replace(/<[^>]*>/g, " ")
        .trim()
        .split(/\s+/);
      expect(text).toEqual(["L", "H"]);
    },
  );
});

describe("the words (strings.js)", () => {
  it("has the FINAL words in en, es and ja", () => {
    for (const [lang, words] of Object.entries(FINAL))
      for (const [k, v] of Object.entries(words))
        expect([lang, k, kitT(lang, k)]).toEqual([lang, k, v]);
  });

  it.each(["panel-fold.js", "switch.js", "panel-fold.css", "switch.css"])(
    "%s names no product",
    (f) => {
      const src = fs
        .readFileSync(path.join(SRC, f), "utf-8")
        .replace(/den-[\w-]+/g, "")
        .replace(/data-den[\w-]*/g, "");
      expect([...src.matchAll(/\b[dD]en(?:[A-Z_$][\w$]*)?\b/g)]).toEqual([]);
    },
  );
});
