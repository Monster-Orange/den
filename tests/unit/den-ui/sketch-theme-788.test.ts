/**
 * Issue 788: the `sketch` theme, for previews that are still being worked
 * on: greys only, dashed edges, outline buttons, one plain face.
 *
 *  - den.theme/v1 gains two optional shape keys, `edge` (solid | dashed)
 *    and `buttons` (filled | outline). With neither, a theme draws as it
 *    did: the kit's borders are solid and its primary button is filled
 *    with accent-fill (checked here for Den's own theme, value for value).
 *  - The sketch theme validates (schema and the kit's contrast rules), has
 *    every colour token in both modes, every colour on the grey ramp, one
 *    face for every text size, dashed edges and no filled button.
 *  - The kit carries it as themes/sketch.css, built from its den-theme.json
 *    by scripts/build-sketch-theme.ts; the built file never drifts.
 *  - The schema doc lists both keys, their defaults, and the release.
 */
import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  checkContrast,
  validateThemeDir,
  type ThemeManifest,
} from "../../../src/shared/theme/contract.js";
import {
  COLOR_TOKENS,
  renderThemeCss,
  renderThemeTokens,
} from "../../../src/ui/server/theme-runtime.js";

const ROOT = path.resolve(__dirname, "../../..");
// The schema is read from the engine root: this checkout's, whichever
// node_modules jest runs from.
process.env.DEN_ENGINE_ROOT = ROOT;
const KIT = path.join(ROOT, "packages/den-ui/src");
const SKETCH_DIR = path.join(KIT, "themes/sketch");
const read = (p: string) => fs.readFileSync(p, "utf8");
const json = (p: string) => JSON.parse(read(p)) as ThemeManifest;

/** The custom properties a CSS block sets, by name (the first block that has it). */
function propsOf(css: string, selector: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!selector.test(m[1].trim())) continue;
    for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g))
      if (!(d[1] in out)) out[d[1]] = d[2].trim();
  }
  return out;
}

/** var() substitution, with fallbacks, as a browser resolves it. */
function resolve(value: string, vars: Record<string, string>): string {
  let v = value;
  for (let i = 0; i < 10; i++) {
    const next = v.replace(
      /var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g,
      (_m, name: string, fb?: string) => vars[name] ?? (fb ?? "").trim(),
    );
    if (next === v) break;
    v = next;
  }
  return v;
}

/** One declaration's value in a rule whose selector list names `sel`. */
function declOf(css: string, sel: string, prop: string): string | null {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of bare.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sels = m[1].split(",").map((s) => s.trim());
    if (!sels.includes(sel)) continue;
    const d = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*([^;]+);`).exec(m[2]);
    if (d) return d[1].trim();
  }
  return null;
}

/** What `theme` draws for the kit's primary button and a bordered edge. */
function drawn(theme: ThemeManifest, mode: "light" | "dark") {
  const css = renderThemeCss(theme.id, theme);
  const vars = {
    ...propsOf(css, /^:root$/m),
    ...propsOf(
      css,
      new RegExp(`:root\\[data-mode="${mode}"\\]|^:root,\\s*$`, "m"),
    ),
    ...Object.fromEntries(
      COLOR_TOKENS.map((t) => [`--${t}`, theme.modes[mode][t]]),
    ),
  };
  const button = read(path.join(KIT, "button.css"));
  const dialog = read(path.join(KIT, "dialog.css"));
  const border = (s: string) =>
    resolve(declOf(button, s, "border") ?? "", vars);
  return {
    edge: border(".den-btn"),
    primary: {
      bg: resolve(declOf(button, ".den-btn.primary", "background")!, vars),
      border: resolve(
        declOf(button, ".den-btn.primary", "border-color")!,
        vars,
      ),
      text: resolve(declOf(button, ".den-btn.primary", "color")!, vars),
    },
    dialogPrimary: resolve(
      declOf(dialog, ".dk-btn.dk-primary", "background")!,
      vars,
    ),
    dialogDanger: resolve(
      declOf(dialog, ".dk-btn.dk-danger", "background")!,
      vars,
    ),
  };
}

describe("issue 788: themes without the new keys draw as before", () => {
  const den = json(path.join(ROOT, "themes/den/den-theme.json"));
  it.each(["light", "dark"] as const)(
    "Den's own theme, %s: solid edges, the primary filled with accent-fill",
    (mode) => {
      const c = den.modes[mode];
      expect(drawn(den, mode)).toEqual({
        edge: "1px solid " + c.border,
        primary: {
          bg: c["accent-fill"],
          border: c["accent-fill"],
          text: c["on-accent"],
        },
        dialogPrimary: c["accent-fill"],
        dialogDanger: c.bad,
      });
    },
  );

  it("the kit's own defaults (no theme CSS) are the same: solid, filled", () => {
    const tokens = read(path.join(KIT, "tokens.css"));
    const root = propsOf(tokens, /^:where\(:root\)$/);
    expect(root["--edge-style"]).toBe("solid");
    expect(root["--primary-bg"]).toBe("var(--accent-fill)");
    expect(root["--primary-border"]).toBe("var(--accent-fill)");
    expect(root["--primary-text"]).toBe("var(--on-accent)");
    expect(root["--danger-bg"]).toBe("var(--bad)");
  });

  it("every kit border that was solid reads --edge-style, falling back to solid", () => {
    for (const f of fs.readdirSync(KIT).filter((f) => f.endsWith(".css"))) {
      const css = read(path.join(KIT, f));
      expect({ f, left: css.match(/\bsolid var\(--border/g) ?? [] }).toEqual({
        f,
        left: [],
      });
      for (const m of css.matchAll(/var\(--edge-style([^)]*)\)/g))
        expect({ f, use: m[0] }).toEqual({
          f,
          use: "var(--edge-style, solid)",
        });
    }
  });
});

describe("issue 788: the sketch theme", () => {
  const sketch = json(path.join(SKETCH_DIR, "den-theme.json"));

  it("validates: the schema and the kit's contrast rules", () => {
    const v = validateThemeDir(SKETCH_DIR, { expectId: "sketch" });
    expect({ issues: v.issues, contrast: v.contrast }).toEqual({
      issues: [],
      contrast: [],
    });
    expect(checkContrast(sketch)).toEqual([]);
  });

  it("has every colour token in both modes, all on the grey ramp", () => {
    for (const mode of ["light", "dark"] as const) {
      const c = sketch.modes[mode] as Record<string, string>;
      for (const t of COLOR_TOKENS) {
        expect({ mode, t, set: typeof c[t] }).toEqual({
          mode,
          t,
          set: "string",
        });
        const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c[t]);
        expect({
          mode,
          t,
          grey: !!m && m[1] === m[2] && m[2] === m[3],
        }).toEqual({ mode, t, grey: true });
      }
    }
  });

  it("one face for every size, dashed edges, outline buttons", () => {
    expect(sketch.type?.display ?? sketch.type?.sans).toBe(sketch.type?.sans);
    expect(sketch.fonts ?? []).toEqual([]);
    expect(sketch.shape?.edge).toBe("dashed");
    expect(sketch.shape?.buttons).toBe("outline");
    for (const mode of ["light", "dark"] as const) {
      const d = drawn(sketch, mode);
      expect(d.edge).toBe("1px dashed " + sketch.modes[mode].border);
      expect(d.primary.bg).toBe("transparent");
      expect(d.dialogPrimary).toBe("transparent");
      expect(d.dialogDanger).toBe("transparent");
      expect(d.primary.border).toBe(sketch.modes[mode]["border-strong"]);
      expect(d.primary.text).toBe(sketch.modes[mode].text);
    }
  });

  it("the kit's themes/sketch.css is built from it and never drifts", () => {
    expect(read(path.join(KIT, "themes/sketch.css"))).toBe(
      renderThemeTokens("sketch", sketch),
    );
    expect(() =>
      execFileSync(
        path.join(ROOT, "node_modules/.bin/tsx"),
        [path.join(ROOT, "scripts/build-sketch-theme.ts"), "--check"],
        { cwd: ROOT, stdio: "pipe" },
      ),
    ).not.toThrow();
  }, 60_000);
});

describe("issue 788: the schema and its doc", () => {
  it("den.theme/v1's shape takes edge and buttons, with defaults", () => {
    const s = JSON.parse(read(path.join(ROOT, "schemas/den.theme.v1.json")));
    const shape = s.$defs.shape.properties;
    expect(shape.edge.enum).toEqual(["solid", "dashed"]);
    expect(shape.edge.default).toBe("solid");
    expect(shape.buttons.enum).toEqual(["filled", "outline"]);
    expect(shape.buttons.default).toBe("filled");
  });

  it("the theme doc lists both keys, their defaults and 0.4.88", () => {
    const doc = read(path.join(ROOT, "docs/distributions.md"));
    expect(doc).toMatch(
      /`edge`: `solid` \(the default\) or `dashed`[^]{0,120}0\.4\.88/,
    );
    expect(doc).toMatch(
      /`buttons`: `filled` \(the default\) or `outline`[^]{0,240}0\.4\.88/,
    );
  });
});
