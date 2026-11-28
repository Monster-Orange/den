/**
 * FB (issue 81), done when: "a test opens every page and every pop-up and
 * finds a visible Report button in each". The browser sweep
 * (report-everywhere.browser.test.ts) opens a sample; this one is static
 * and exhaustive: every pop-up the code can build, in Den's pages
 * (src/ui) and the UI kit (packages/den-ui/src), is found by what builds
 * it, and each must get Report one of two ways:
 *
 * - The injector (report-inject.js, started by shell.js on every page):
 *   the construct makes a layer it watches (a dialog, role="dialog" or
 *   "alertdialog", a .den-drawer), and not one it skips.
 * - Its own: listed in OWN below, with the mark in its file that draws
 *   the button (or why it needs none).
 *
 * A new pop-up the injector can't see, or one it skips, fails here until
 * it draws its own Report and is listed.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "src", "ui", "server", "public");
const INJECT = path.join(PUBLIC, "report-inject.js");

/** What builds a pop-up (or shows one), in code. */
const CONSTRUCT =
  /<dialog\b|createElement\(\s*["']dialog["']\s*\)|role=\\?["'](?:alert)?dialog\\?["']|setAttribute\(\s*["']role["']\s*,\s*["'](?:alert)?dialog["']|\bden-drawer(?![\w-])|showPopover\(|\bpopover=|\.popover\s*=/;

/** Of those, the ones that make a layer the injector watches (its LAYERS). */
const LAYER =
  /<dialog\b|createElement\(\s*["']dialog["']\s*\)|role=\\?["'](?:alert)?dialog\\?["']|setAttribute\(\s*["']role["']\s*,\s*["'](?:alert)?dialog["']|\bden-drawer(?![\w-])/;

/** Files that name pop-ups without building one. */
const NOT_POPUPS: Record<string, string> = {
  "src/ui/server/public/report-inject.js": "the injector's own selectors",
  "src/ui/server/public/popover.js": "how pop-ups close: a selector list",
};

/**
 * Pop-ups that get Report their own way: `file`, an `anchor` in the lines
 * around the construct, and the `mark` in the file that draws the button
 * (null: needs none, and `why` says so).
 */
const OWN: {
  file: string;
  anchor: string;
  mark: RegExp | null;
  why: string;
}[] = [
  {
    file: "packages/den-ui/src/report.js",
    anchor: "fb-dlg",
    mark: null,
    why: "the Report form itself",
  },
  {
    file: "packages/den-ui/src/pager.js",
    anchor: "den-pager-menu",
    mark: null,
    why: "the compact pager's small menu of page and per-page choices; it closes on any tap outside, and the page under it keeps its Report",
  },
  {
    file: "packages/den-ui/src/busy.js",
    anchor: "bz-dlg",
    mark: /btn\("report"\)/,
    why: "the working pop-up: Report · Close in its own row",
  },
  {
    file: "src/ui/server/public/bell.js",
    anchor: "den-bell-ask",
    mark: null,
    why: "an ask drawn inside the bell's panel, whose foot has Report",
  },
  {
    file: "packages/den-ui/src/shell-client.js",
    anchor: "railBox",
    mark: /den-rb-drawer/,
    why: "the rail as a drawer on a phone: its scrim covers the top bar, so the kit draws Report in it",
  },
  {
    file: "src/ui/server/public/shell.js",
    anchor: "topShow",
    mark: null,
    why: "puts a pop-up built elsewhere in the top layer; builds none",
  },
  {
    file: "src/ui/server/public/shell.js",
    anchor: "data-den-top-added",
    mark: null,
    why: "puts a pop-up built elsewhere in the top layer; builds none",
  },
  {
    file: "src/ui/server/public/topbar.js",
    anchor: "pop.showPopover",
    mark: /createElement\("dialog"\)/,
    why: "shows the admin password ask, a dialog the injector sees",
  },
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

/** The injector's skipped classes (report-inject.js SKIP). */
function skipped(): string[] {
  const src = fs.readFileSync(INJECT, "utf-8");
  const block = /export const SKIP = \[([\s\S]*?)\]/.exec(src)?.[1] ?? "";
  return [...block.matchAll(/["']\.([\w-]+)["']/g)].map((m) => m[1]);
}

interface Site {
  file: string;
  line: number;
  text: string;
  near: string;
}

/** Every construct in code: not a comment, not a CSS rule in a string. */
function sites(): Site[] {
  const files = [
    ...walk(path.join(ROOT, "src", "ui")),
    ...walk(path.join(ROOT, "packages", "den-ui", "src")),
  ].filter((f) => /\.(js|ts|html)$/.test(f) && !f.endsWith(".d.ts"));
  const out: Site[] = [];
  for (const abs of files) {
    const file = path.relative(ROOT, abs);
    if (NOT_POPUPS[file]) continue;
    const lines = fs.readFileSync(abs, "utf-8").split("\n");
    lines.forEach((text, i) => {
      if (!CONSTRUCT.test(text)) return;
      const t = text.trim();
      if (/^(\*|\/\/|\/\*)/.test(t)) return;
      // A stylesheet in a string: ".den-drawer { … }".
      if (/^["'`][^"'`]*\{/.test(t)) return;
      out.push({
        file,
        line: i + 1,
        text: t,
        near: lines.slice(Math.max(0, i - 4), i + 5).join("\n"),
      });
    });
  }
  return out;
}

describe("every pop-up the code can build gets Report (issue 81)", () => {
  const skip = skipped();
  const all = sites();

  it("finds the pop-ups (the scan sees the code)", () => {
    expect(skip.length).toBeGreaterThan(0);
    // Some of each: the pages', the kit's.
    expect(all.some((s) => s.file.startsWith("src/ui/"))).toBe(true);
    expect(all.some((s) => s.file.startsWith("packages/den-ui/"))).toBe(true);
  });

  it("each is the injector's or draws its own", () => {
    const missing: string[] = [];
    for (const s of all) {
      const own = OWN.find(
        (o) => o.file === s.file && s.near.includes(o.anchor),
      );
      if (own) {
        if (
          own.mark &&
          !own.mark.test(fs.readFileSync(path.join(ROOT, s.file), "utf-8"))
        )
          missing.push(
            `${s.file}:${s.line} (${own.why}): no ${own.mark} in the file`,
          );
        continue;
      }
      const isSkipped = skip.some((c) =>
        new RegExp(`\\b${c}(?![\\w-])`).test(s.near),
      );
      if (!LAYER.test(s.text))
        missing.push(
          `${s.file}:${s.line}: the injector can't see it: ${s.text}`,
        );
      else if (isSkipped)
        missing.push(`${s.file}:${s.line}: the injector skips it: ${s.text}`);
    }
    expect(missing).toEqual([]);
  });

  it("each skipped class is one that draws its own (OWN)", () => {
    const anchors = OWN.map((o) => o.anchor);
    // The rail is drawn by the kit (.den-rail inside .den-rail-box).
    const loose = skip.filter(
      (c) =>
        !anchors.includes(c) &&
        !(c.startsWith("den-rail") && anchors.includes("railBox")),
    );
    expect(loose).toEqual([]);
  });

  it("every page starts the injector", () => {
    const shell = fs.readFileSync(path.join(PUBLIC, "shell.js"), "utf-8");
    expect(shell).toMatch(/startReportInjector\(/);
    const pages = fs.readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));
    expect(pages.length).toBeGreaterThan(0);
    expect(
      pages.filter(
        (f) =>
          !fs.readFileSync(path.join(PUBLIC, f), "utf-8").includes("/shell.js"),
      ),
    ).toEqual([]);
  });

  it("the injector's layers are the ones this test counts as seen", () => {
    const src = fs.readFileSync(INJECT, "utf-8");
    const layers = /export const LAYERS =\s*'([^']+)'/.exec(src)?.[1];
    expect(layers).toBe(
      'dialog[open], [role="dialog"], [role="alertdialog"], .den-drawer',
    );
  });
});
