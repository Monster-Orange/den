/**
 * Issue 1137: the sketch theme's follow-ups, in the kit's CSS and tokens.
 * Each comes with a kit token whose default draws exactly as today; the
 * sketch theme (outline buttons) sets it.
 *  1. Danger stands apart: its edge's width and style are tokens; sketch's
 *     danger is a solid 2px edge, the one solid edge in the theme.
 *  3. One hover tint (--hover-tint) on every button, as a layer over its
 *     own background; disabled keeps its edge, its label goes to
 *     --btn-disabled-text, and it has no hover tint.
 *  4. Every kit focus ring is --focus-ring at --focus-offset; sketch draws
 *     it in --text, 2px out.
 *  5. The dividers between rows in a list stay solid when edges are dashed.
 * (2, status never by colour alone, is the browser test
 * status-not-colour-1137.browser.test.ts.)
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { ThemeManifest } from "../../../src/shared/theme/contract.js";
import { renderThemeTokens } from "../../../src/ui/server/theme-runtime.js";
import { declOf, propsOf, resolve, rulesOf } from "./kit-css.js";

const ROOT = path.resolve(__dirname, "../../..");
process.env.DEN_ENGINE_ROOT = ROOT;
const KIT = path.join(ROOT, "packages/den-ui/src");
const read = (p: string) => fs.readFileSync(p, "utf8");
const kit = (f: string) => read(path.join(KIT, f));
const sketch = JSON.parse(
  read(path.join(KIT, "themes/sketch/den-theme.json")),
) as ThemeManifest;
const sketchTokens = propsOf(renderThemeTokens("sketch", sketch), /^:root$/);
/** The kit's own defaults (tokens.css), with no theme. */
const kitTokens = propsOf(kit("tokens.css"), /:root/);

describe("issue 1137 (1): danger stands apart from primary", () => {
  const DANGER: [string, string][] = [
    ["button.css", ".den-btn.danger"],
    ["dialog.css", ".den-btn.dk-danger"],
  ];

  it("its edge's width and style are tokens, today's values by default", () => {
    for (const [f, sel] of DANGER) {
      const w = declOf(kit(f), sel, "border-width");
      const s = declOf(kit(f), sel, "border-style");
      expect({ sel, w, s }).toEqual({
        sel,
        w: "var(--danger-edge-width, 1px)",
        s: "var(--danger-edge-style, var(--edge-style, solid))",
      });
      expect(resolve(w!, kitTokens)).toBe("1px");
      expect(resolve(s!, kitTokens)).toBe("solid");
    }
  });

  it("sketch draws danger with a solid 2px edge in --bad", () => {
    expect(sketchTokens["--danger-edge-width"]).toBe("2px");
    expect(sketchTokens["--danger-edge-style"]).toBe("solid");
    expect(sketchTokens["--danger-border"]).toBe("var(--bad)");
  });
});

describe("issue 1137 (3): one hover tint, and a disabled cue", () => {
  const HOVER =
    '.den-btn:not([aria-busy="true"]):not(:disabled):not([aria-disabled="true"]):hover';

  it("every button's hover lays --hover-tint over its own background, none by default", () => {
    expect(declOf(kit("button.css"), HOVER, "background-image")).toBe(
      "linear-gradient(var(--hover-tint, transparent), var(--hover-tint, transparent))",
    );
    expect(kitTokens["--hover-tint"]).toBeUndefined();
  });

  it("sketch's tint is 6% of --text", () => {
    expect(sketchTokens["--hover-tint"]).toBe(
      "color-mix(in srgb, var(--text) 6%, transparent)",
    );
  });

  it("disabled: today's look by default; in sketch a faint label at full opacity", () => {
    const css = kit("button.css");
    const DIS = ".den-btn:disabled";
    const opacity = declOf(css, DIS, "opacity")!;
    expect(opacity).toBe("var(--btn-disabled-opacity, 0.6)");
    expect(resolve(opacity, kitTokens)).toBe("0.6");
    // Each kind keeps its own label colour by default.
    const label: [string, string, string][] = [
      ["button.css", ".den-btn:disabled", "var(--text)"],
      [
        "button.css",
        ".den-btn.primary:disabled",
        "var(--primary-text, var(--on-accent))",
      ],
      ["button.css", ".den-btn.danger:disabled", "var(--bad)"],
      [
        "dialog.css",
        ".den-btn.dk-danger:disabled",
        "var(--danger-text, var(--on-accent))",
      ],
    ];
    for (const [f, sel, today] of label)
      expect({ sel, color: declOf(kit(f), sel, "color") }).toEqual({
        sel,
        color: `var(--btn-disabled-text, ${today})`,
      });
    expect(sketchTokens["--btn-disabled-text"]).toBe("var(--faint)");
    expect(sketchTokens["--btn-disabled-opacity"]).toBe("1");
  });
});

describe("issue 1137 (4): the focus ring on dashed edges", () => {
  it("every kit focus ring reads --focus-ring and --focus-offset, today's values by default", () => {
    const seen: string[] = [];
    for (const f of fs.readdirSync(KIT).filter((f) => f.endsWith(".css")))
      for (const r of rulesOf(kit(f))) {
        if (!r.sels.some((s) => s.includes(":focus-visible"))) continue;
        if (!r.decls.outline || r.decls.outline === "none") continue;
        seen.push(`${f} ${r.sels[0]}`);
        expect({ f, sel: r.sels[0], outline: r.decls.outline }).toEqual({
          f,
          sel: r.sels[0],
          outline: expect.stringMatching(/^2px solid var\(--focus-ring, .+\)$/),
        });
        expect({ f, sel: r.sels[0], off: r.decls["outline-offset"] }).toEqual({
          f,
          sel: r.sels[0],
          off: expect.stringMatching(/^var\(--focus-offset, \d+px\)$/),
        });
      }
    expect(seen.length).toBeGreaterThanOrEqual(13);
    expect(kitTokens["--focus-ring"]).toBeUndefined();
  });

  it("sketch draws it 2px out, in --text", () => {
    expect(sketchTokens["--focus-ring"]).toBe("var(--text)");
    expect(sketchTokens["--focus-offset"]).toBe("2px");
  });
});

describe("issue 1137 (5): row dividers stay solid", () => {
  const ROWS: [string, string, string][] = [
    ["report.css", ".fb-row", "border-bottom"],
    ["shell.css", ".den-bell-sec + .den-bell-sec", "border-top"],
    ["whatsnew.css", ".cl-divider", "border-top"],
  ];
  it("the dividers between rows are solid, never --edge-style", () => {
    for (const [f, sel, prop] of ROWS)
      expect({ sel, v: declOf(kit(f), sel, prop) }).toEqual({
        sel,
        v: "1px solid var(--border)",
      });
  });
});
