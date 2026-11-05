/**
 * The web UI draws every color from the active theme (/theme.css): no page,
 * stylesheet or UI script in public/ may hard-code one. A literal here is a
 * color that ignores the theme and the light mode.
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
});
