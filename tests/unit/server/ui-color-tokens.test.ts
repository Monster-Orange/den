/**
 * The web UI draws every color and font from the active theme (/theme.css):
 * no page, stylesheet or UI script in public/ may hard-code one. A literal
 * here is a color that ignores the theme and the light mode, or a font the
 * theme's type never reaches.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const files = fs
  .readdirSync(PUBLIC)
  .filter((f) => /\.(html|css|js)$/.test(f))
  .sort();

/** #rgb, #rgba, #rrggbb, #rrggbbaa; not an HTML entity (&#9654;) or an id. */
const HEX = /(?<![&\w])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![\w-])/gi;
/** rgb()/hsl() of a real color. Black alone is allowed: a modal scrim. */
const FN = /\b(?:rgba?|hsla?)\(\s*([^)]*)\)/gi;
const black = (args: string) =>
  /^0[\s,]+0[\s,]+0(?:[\s,/]+[\d.]+%?)?$/.test(args.trim());

function literals(file: string): string[] {
  const out: string[] = [];
  fs.readFileSync(path.join(PUBLIC, file), "utf-8")
    .split("\n")
    .forEach((line, i) => {
      for (const m of line.matchAll(HEX)) out.push(`${file}:${i + 1}: ${m[0]}`);
      for (const m of line.matchAll(FN))
        if (!black(m[1])) out.push(`${file}:${i + 1}: ${m[0]}`);
    });
  return out;
}

describe("UI colors come from theme tokens", () => {
  it("covers the pages, stylesheets and UI scripts", () => {
    for (const f of [
      "index.html",
      "local-dev.html",
      "services.html",
      "logs.html",
      "release.html",
      "environments.html",
      "header.js",
      "graph.css",
      "graph.js",
      "panel.js",
    ])
      expect(files).toContain(f);
  });

  it.each(files)("%s has no color literal", (f) => {
    expect(literals(f)).toEqual([]);
  });

  it.each(files.filter((f) => f.endsWith(".html")))(
    "%s links /theme.css and sets data-mode before first paint",
    (f) => {
      const html = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
      const head = html.slice(0, html.indexOf("</head>"));
      expect(head).toContain(
        '<link rel="stylesheet" href="/theme.css" id="theme-css" />',
      );
      const script = head.indexOf("dataset.mode");
      expect(script).toBeGreaterThan(-1);
      expect(script).toBeLessThan(head.indexOf("/theme.css"));
    },
  );

  it("never uses accent as a text color (accent-text is for text)", () => {
    const hits = files.flatMap((f) =>
      fs
        .readFileSync(path.join(PUBLIC, f), "utf-8")
        .split("\n")
        .map((l, i) => [l, i + 1] as const)
        .filter(([l]) =>
          /(?<![\w-])color\s*[:=]\s*["']?var\(--accent\)/.test(l),
        )
        .map(([, n]) => `${f}:${n}`),
    );
    expect(hits).toEqual([]);
  });

  it.each(files)("%s draws text only in theme fonts", (f) => {
    expect(fontLiterals(f)).toEqual([]);
  });

  it.each(files)(
    "%s never draws text in a config color (swatch, border, dot only)",
    (f) => {
      expect(configColorText(f)).toEqual([]);
    },
  );
});

/** The theme's font tokens; their fallbacks live in /theme.css. */
const FONT_VAR = /^var\(--(?:sans|mono|display|ja)\)$/;
/** font-family: <value> in CSS, an inline style or a JS string. */
const FONT_FAMILY = /(?<![\w-])font-family\s*:\s*([^;"'`}]+)/gi;
/** The font shorthand: font: [style weight] size[/lh] family. */
const FONT_SHORT = /(?<![\w-])font\s*:\s*([^;"'`}]+)/gi;
/** el.style.fontFamily = "…" */
const FONT_JS = /\.fontFamily\s*=\s*([^;\n]+)/g;

function lines(file: string): [string, number][] {
  return fs
    .readFileSync(path.join(PUBLIC, file), "utf-8")
    .split("\n")
    .map((l, i) => [l, i + 1]);
}

function fontLiterals(file: string): string[] {
  const out: string[] = [];
  for (const [line, n] of lines(file)) {
    for (const m of line.matchAll(FONT_FAMILY)) {
      const v = m[1].trim();
      if (v !== "inherit" && !FONT_VAR.test(v))
        out.push(`${file}:${n}: ${m[0]}`);
    }
    for (const m of line.matchAll(FONT_SHORT)) {
      const v = m[1].trim();
      const family = v.split(/\s+/).pop() ?? "";
      if (v !== "inherit" && !FONT_VAR.test(family))
        out.push(`${file}:${n}: ${m[0]}`);
    }
    for (const m of line.matchAll(FONT_JS)) out.push(`${file}:${n}: ${m[0]}`);
  }
  return out;
}

/**
 * A color from the org config (orgs.<id>.color: an org, workspace or
 * application tint) is picked for one ground and fails contrast on the
 * other: as text on a light ground it can be 2.5:1. So it is only ever a
 * swatch, a border or a dot, carried in --oc / --org; labels use --text or
 * --muted. Caught: `color:` (not border-color, background) set to one of
 * those properties, or to an interpolated `….color`, in CSS, HTML or JS.
 */
const CONFIG_COLOR_TEXT = [
  /(?<![\w-])color\s*:\s*var\(--(?:oc|org)\b/gi,
  /(?<![\w-])color\s*:\s*\$\{[^}]*\.color\b/gi,
  /\.style\.color\s*=\s*[^;\n]*\.color\b/g,
  /\.style\.setProperty\(\s*["']color["']\s*,[^)]*\.color\b/g,
];

function configColorText(file: string): string[] {
  const out: string[] = [];
  for (const [line, n] of lines(file))
    for (const re of CONFIG_COLOR_TEXT)
      for (const m of line.matchAll(re)) out.push(`${file}:${n}: ${m[0]}`);
  return out;
}
