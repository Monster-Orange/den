/**
 * den-ui base: no pop-up or form control falls back to the browser's
 * default font (issue 651).
 *
 * A modal dialog sits in the top layer but inherits from <body>, and a
 * page may set its font on a wrapper rather than on <body>; a dialog that
 * didn't set its own font then drew in the browser's serif. So the kit's
 * base gives every `dialog` the kit's sans font and the text colour of
 * its parent, and `button`, `input`, `select` and `textarea` inherit the
 * font. Both products load base.css, so Hub gets it too.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const BASE = path.join(__dirname, "../../../packages/den-ui/src/base.css");
const TOKENS = path.join(__dirname, "../../../packages/den-ui/src/tokens.css");

/** Each rule's selectors (split on commas) and its declarations. */
function rules(css: string): { sel: string[]; decl: Record<string, string> }[] {
  const out: { sel: string[]; decl: Record<string, string> }[] = [];
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of flat.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const decl: Record<string, string> = {};
    for (const d of m[2].matchAll(/([\w-]+)\s*:\s*([^;]+);?/g))
      decl[d[1].trim()] = d[2].trim();
    out.push({
      sel: m[1]
        .trim()
        .split(",")
        .map((s) => s.replace(/\s+/g, " ").trim()),
      decl,
    });
  }
  return out;
}

/** The declarations that apply to a bare `el` (inside :where()). */
function declsFor(el: string): Record<string, string> {
  const css = fs.readFileSync(BASE, "utf-8");
  const hit: Record<string, string> = {};
  for (const r of rules(css))
    for (const s of r.sel) {
      const inner = /^:where\((.+)\)$/.exec(s)?.[1];
      if (!inner) continue;
      if (
        inner
          .split(",")
          .map((x) => x.trim())
          .includes(el)
      )
        Object.assign(hit, r.decl);
    }
  return hit;
}

describe("den-ui base: pop-ups and form controls use the kit's font (issue 651)", () => {
  it("the sans token exists in tokens.css", () => {
    expect(fs.readFileSync(TOKENS, "utf-8")).toMatch(/--sans\s*:/);
  });

  it("dialog: the kit's sans font, and its parent's colour", () => {
    const d = declsFor("dialog");
    expect(d["font-family"]).toBe("var(--sans)");
    expect(d["color"]).toBe("inherit");
  });

  it.each(["button", "input", "select", "textarea"])(
    "%s: inherits the font",
    (el) => {
      expect(declsFor(el)["font"]).toBe("inherit");
    },
  );
});
