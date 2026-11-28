/**
 * den-ui UK-1: the kit's tokens.
 *
 *   - Every text and mark pair passes WCAG AA in both modes (4.5:1 text,
 *     3:1 marks), for the kit's defaults and for each theme Den ships; a
 *     status pill's text passes on its own 12% tint over each background.
 *   - Components use tokens only: no raw colour outside tokens.css.
 *   - Every rule in tokens.css and base.css has zero specificity, so a
 *     theme always wins.
 *   - The fonts stay within 120 KB, each named in fonts.css and licensed.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { colourLiterals } from "../helpers/colour-literals.js";

const ROOT = path.join(__dirname, "../../..");
const KIT = path.join(ROOT, "packages/den-ui");
const SRC = path.join(KIT, "src");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");

type Rgb = [number, number, number];
type Mode = "light" | "dark";
type Tokens = Record<string, string>;

/** #rgb, #rrggbb or hsl(h s% l%) as 0-255 sRGB. */
function parse(c: string): Rgb {
  const v = c.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (m) {
    const h =
      m[1].length === 3
        ? m[1]
            .split("")
            .map((x) => x + x)
            .join("")
        : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
  }
  m = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i.exec(v);
  if (m) {
    const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) =>
      l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as Rgb;
  }
  throw new Error(`not a colour the test reads: ${c}`);
}

function luminance([r, g, b]: Rgb): number {
  const ch = (x: number) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function ratio(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** color-mix(in srgb, c 12%, base). */
const tint = (c: Rgb, base: Rgb, p = 0.12): Rgb =>
  c.map((x, i) => x * p + base[i] * (1 - p)) as Rgb;

/** The custom properties set in the first block whose selector matches. */
function block(css: string, selector: RegExp): Tokens {
  const out: Tokens = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(css); m; m = re.exec(css)) {
    if (!selector.test(m[1])) continue;
    for (const d of m[2].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g))
      out[d[1]] = d[2].replace(/\s+/g, " ").trim();
    return out;
  }
  throw new Error(`no block for ${selector}`);
}

function kitModes(): Record<Mode, Tokens> {
  const css = read("tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
  return {
    light: block(css, /:root\[data-mode="light"\]/),
    dark: block(css, /^\s*:where\(:root\[data-mode="dark"\]\)\s*(,|$)/),
  };
}

const TEXT = [
  "text",
  "muted",
  "faint",
  "accent-text",
  "ok",
  "warn",
  "bad",
  "info",
  "remote",
];
const BACKS = ["bg", "surface", "raised", "sunken"];
const MARKS = ["accent", "border-strong", "violet"];
const MARK_BACKS = ["bg", "surface", "raised"];
const PILLS = ["ok", "warn", "bad", "info", "remote"];
const PILL_BACKS = ["bg", "surface", "sunken"];
/**
 * A disc: a mark's own colour on its 16% tint (an agent's initial in its
 * disc, say), over each background. The remote colour's disc was 4.33:1
 * over --sunken in light.
 */
const DISCS = ["remote"];
const DISC_TINT = 0.16;

/** Every pair below its bar, as "fg on bg (mode): 3.9". */
function failures(modes: Record<Mode, Tokens>): string[] {
  const out: string[] = [];
  for (const mode of ["light", "dark"] as Mode[]) {
    const t = modes[mode];
    const c = (k: string) => parse(t[k]);
    const check = (fg: Rgb, bg: Rgb, min: number, what: string) => {
      const r = ratio(fg, bg);
      if (r < min) out.push(`${what} (${mode}): ${r.toFixed(2)}`);
    };
    for (const f of TEXT)
      for (const b of BACKS) check(c(f), c(b), 4.5, `${f} on ${b}`);
    check(c("on-accent"), c("accent-fill"), 4.5, "on-accent on accent-fill");
    for (const f of MARKS)
      for (const b of MARK_BACKS) check(c(f), c(b), 3, `${f} on ${b}`);
    for (const p of PILLS)
      for (const b of PILL_BACKS)
        check(c(p), tint(c(p), c(b)), 4.5, `${p} pill over ${b}`);
    for (const p of DISCS)
      for (const b of PILL_BACKS)
        check(c(p), tint(c(p), c(b), DISC_TINT), 4.5, `${p} disc over ${b}`);
  }
  return out;
}

describe("den-ui tokens (UK-1)", () => {
  it("the kit's defaults pass AA in both modes, pills on their tint too", () => {
    expect(failures(kitModes())).toEqual([]);
  });

  it("each theme Den ships passes AA in both modes, with the kit's info and violet when it has none", () => {
    const kit = kitModes();
    const dir = path.join(ROOT, "themes");
    const themes = fs
      .readdirSync(dir)
      .filter((d) => fs.existsSync(path.join(dir, d, "den-theme.json")));
    expect(themes.length).toBeGreaterThan(0);
    const bad: Record<string, string[]> = {};
    for (const id of themes) {
      const t = JSON.parse(
        fs.readFileSync(path.join(dir, id, "den-theme.json"), "utf-8"),
      ) as { modes: Record<Mode, Tokens> };
      const f = failures({
        light: { ...kit.light, ...t.modes.light },
        dark: { ...kit.dark, ...t.modes.dark },
      });
      if (f.length) bad[id] = f;
    }
    expect(bad).toEqual({});
  });

  it("the dark default and the system-dark block hold the same values", () => {
    const css = read("tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(block(css, /:root:not\(\[data-mode\]\)/)).toEqual(kitModes().dark);
  });

  it("no raw colour outside tokens.css", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        // site/ is the kit's tab icons and head snippet (issue 644): the
        // brand's own colours (the theme colour), not a component's.
        // themes/ is a theme's tokens, built from its den-theme.json
        // (issue 788): colours are what a theme is.
        if (e.isDirectory()) {
          if (!["site", "themes"].includes(path.relative(SRC, p))) walk(p);
        } else if (/\.(css|js|mjs|html)$/.test(e.name)) files.push(p);
      }
    };
    walk(SRC);
    // Issue 322: a hex colour anywhere, comments too, but an issue number
    // in a comment ("issue #320", "(#311)"): colourLiterals.
    const raw = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i;
    const hits = files
      .filter((f) => path.basename(f) !== "tokens.css")
      .flatMap((f) => {
        const text = fs.readFileSync(f, "utf-8");
        const at = (n: number) => `${path.relative(KIT, f)}:${n}`;
        return [
          ...colourLiterals(text).map((h) => at(h.line)),
          ...text
            .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
            .split("\n")
            .map((l, i) => ({ l, n: i + 1 }))
            .filter((x) => raw.test(x.l))
            .map((x) => at(x.n)),
        ];
      });
    expect(hits).toEqual([]);
  });

  it("every rule in tokens.css and base.css has zero specificity", () => {
    for (const f of ["tokens.css", "base.css"]) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, "");
      const selectors = [...css.matchAll(/([^{}@;]+)\{[^{}]*\}/g)]
        .map((m) => m[1].trim())
        .flatMap((s) => s.split(",").map((x) => x.trim()));
      expect(selectors.length).toBeGreaterThan(0);
      expect(selectors.filter((s) => !/^:where\(.+\)$/.test(s))).toEqual([]);
    }
  });

  it("the fonts: within 120 KB, each named in fonts.css, the licence beside them", () => {
    const dir = path.join(SRC, "fonts");
    const fonts = fs.readdirSync(dir).filter((f) => f.endsWith(".woff2"));
    expect(fonts.length).toBeGreaterThan(0);
    const total = fonts.reduce(
      (n, f) => n + fs.statSync(path.join(dir, f)).size,
      0,
    );
    expect(total).toBeLessThanOrEqual(120_000);
    const css = read("fonts.css");
    const named = [...css.matchAll(/url\("fonts\/([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    expect(named.sort()).toEqual(fonts.sort());
    const ofl = fs.readFileSync(path.join(dir, "OFL.txt"), "utf-8");
    expect(ofl).toMatch(/SIL Open Font License, Version 1\.1/);
    for (const family of ["Rubik", "Space Mono"])
      expect(ofl).toContain(`The ${family} Project Authors`);
    expect(css).toMatch(/font-display: swap/);
    expect(css).not.toMatch(/https?:/);
  });
});
