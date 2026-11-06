/**
 * DOC-1's capture guard (scripts/doc-shots-guard.js) in a real browser: before a
 * screenshot, everything a viewer could read on the page (innerText, every
 * title / alt / aria-label, SVG text) goes through the org-name gate's own
 * matcher (scripts/org-names.js). A planted org name anywhere on the page
 * must abort the capture with an error naming the shot and the term, and
 * never the text around it.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";

interface Guard {
  guardShot: (
    page: Page,
    shot: string,
    patterns: RegExp[],
    opts?: { home?: string },
  ) => Promise<void>;
  releaseVersion: (v: string) => string;
}
interface OrgNames {
  orgPatterns: (env: Record<string, string | undefined>) => RegExp[];
  orgHits: (
    text: string,
    patterns: RegExp[],
  ) => { index: number; term: string }[];
}

const SCRIPTS = path.join(process.cwd(), "scripts");
let browser: Browser | null = null;
let guard: Guard;
let names: OrgNames;

beforeAll(async () => {
  guard = (await import(path.join(SCRIPTS, "doc-shots-guard.js"))) as Guard;
  names = (await import(path.join(SCRIPTS, "org-names.js"))) as OrgNames;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

// A fictional org; the context around it stands in for anything sensitive.
const PATTERNS = [/acme-corp-sample/i, /initrode/i];
const CONTEXT = "private-context-7f3a";

async function page(body: string): Promise<Page> {
  const p = await browser!.newPage();
  await p.setContent(
    `<!doctype html><html><head><title>Den</title></head><body>${body}</body></html>`,
  );
  return p;
}

async function guardError(body: string, shot = "hero-dark.png") {
  const p = await page(body);
  try {
    await guard.guardShot(p, shot, PATTERNS);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await p.close();
  }
}

describe("the capture guard", () => {
  it.each([
    ["the page text", `<main><p>${CONTEXT} Initrode</p></main>`],
    ["a title", `<button title="${CONTEXT} Initrode">Up</button>`],
    [
      "an aria-label",
      `<div role="button" aria-label="${CONTEXT} Initrode"></div>`,
    ],
    ["an alt", `<img alt="${CONTEXT} Initrode" src="data:,">`],
    [
      "SVG text",
      `<svg width="10" height="10"><text x="0" y="0">${CONTEXT} Initrode</text></svg>`,
    ],
    [
      "hidden text a tooltip shows",
      `<span style="display:none" title="${CONTEXT} Initrode">x</span>`,
    ],
  ])(
    "aborts on an org name in %s, naming the shot and term only",
    async (_where, body) => {
      if (!browser) return;
      const msg = await guardError(body);
      expect(msg).not.toBeNull();
      expect(msg).toContain('shot "hero-dark.png"');
      expect(msg).toContain("pattern #2 (initrode)");
      expect(msg).toContain("no image written");
      // Never the text around the match.
      expect(msg).not.toContain(CONTEXT);
    },
  );

  it("passes a page with no org name", async () => {
    if (!browser) return;
    expect(
      await guardError(
        `<main><h1 title="Graph">Graph</h1><img alt="demo-api"><svg><text>demo-web</text></svg></main>`,
      ),
    ).toBeNull();
  });

  it("aborts on a path under the real home directory", async () => {
    if (!browser) return;
    const p = await page(`<code>/Users/someone/${CONTEXT}/bin/den</code>`);
    await expect(
      guard.guardShot(p, "graph.png", [], { home: "/Users/someone" }),
    ).rejects.toThrow(
      'shot "graph.png" shows a path under your home directory',
    );
    await p.close();
  });
});

describe("the shared matcher", () => {
  it("reads DEN_ORG_NAMES_FILE: one case-insensitive regex a line, comments skipped", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-org-names-"));
    const file = path.join(dir, "org-names.txt");
    fs.writeFileSync(file, "# planted\n\nInitrode\nacme-corp-sample\n");
    const patterns = names.orgPatterns({ DEN_ORG_NAMES_FILE: file });
    expect(patterns.map((p) => p.source)).toEqual([
      "Initrode",
      "acme-corp-sample",
    ]);
    expect(names.orgHits("at INITRODE today", patterns)).toEqual([
      { index: 1, term: "Initrode" },
    ]);
    expect(names.orgPatterns({})).toEqual([]);
  });
});

describe("releaseVersion", () => {
  it("drops the prerelease suffix", () => {
    expect(guard.releaseVersion("0.3.0-dev.37")).toBe("0.3.0");
    expect(guard.releaseVersion("1.2.3")).toBe("1.2.3");
    expect(() => guard.releaseVersion("next")).toThrow("not a semver");
  });
});
