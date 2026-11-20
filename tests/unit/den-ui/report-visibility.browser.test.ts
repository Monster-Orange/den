/**
 * den-ui: the Report form says who can see the report (issue 415).
 *
 * Each of the host's info.repos[] may say its `visibility` ("public",
 * "private" or "internal"; missing or anything else reads as public) and
 * an `audience` (who can see it, as the host's own words).
 *
 * - Public: the "Public repository" pill and the "visible to everyone"
 *   warning above Send, as before.
 * - Private or Internal: that pill, then the audience, and no public
 *   warning: a quiet line instead, saying only people with access see it.
 * - With two targets, changing the select changes the pill and the line.
 * - en, es and ja.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://vis.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/kit/tokens.css">
<link rel="stylesheet" href="/kit/base.css">
</head><body><main><p>A page</p></main>
<script type="module">
  import { configureReport, openReport } from "/kit/report.js";
  window.go = (lang, repos) => {
    configureReport({
      lang,
      screenshot: false,
      adapter: {
        info: () => ({ repos }),
        send: async () => ({ status: 200, data: {} }),
      },
    });
    openReport({ prefill: { title: "Pane drops" } });
  };
  window.ready = true;
</script>
</body></html>`;

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
};

async function open(b: Browser): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1000, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    const f = u.pathname.replace(/^\/kit\//, "");
    const file = path.join(SRC, f);
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: TYPES[path.extname(file)] || "text/plain",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(
    () => (window as { ready?: boolean }).ready === true,
    undefined,
    { timeout: 10_000 },
  );
  return p;
}

type Repo = { repo: string; visibility?: string; audience?: string };

/** Opens Report with these targets and walks to Review. */
async function review(b: Browser, lang: string, repos: Repo[]) {
  const p = await open(b);
  await p.evaluate(
    ({ lang, repos }) =>
      (window as unknown as { go: (l: string, r: Repo[]) => void }).go(
        lang,
        repos,
      ),
    { lang, repos },
  );
  const dlg = p.locator("dialog.fb-dlg");
  await dlg.locator('[data-act="next"]').click();
  await dlg.locator('[data-act="review"]').click();
  await p.waitForFunction(
    () =>
      document.querySelector("dialog.fb-dlg")?.getAttribute("data-step") ===
        "review" &&
      document.querySelector("[data-preview]")?.textContent !== "…",
  );
  return p;
}

/** What Review shows about who can see it. */
const seen = (p: Page) =>
  p.evaluate(() => {
    const d = document.querySelector("dialog.fb-dlg")!;
    const txt = (e: Element | null) =>
      (e?.textContent || "").replace(/\s+/g, " ").trim();
    return {
      pills: [...d.querySelectorAll(".fb-dest .fb-pill")].map(txt),
      dest: txt(d.querySelector(".fb-dest")),
      warn: [...d.querySelectorAll(".fb-warn")].map(txt),
      note: [...d.querySelectorAll("[data-vis-note]")].map(txt),
      // The audience is text, never markup.
      injected: d.querySelectorAll(".fb-dest b.x, [data-vis-note] b.x").length,
    };
  });

const PUB_W =
  "Screenshots and text are visible to everyone. Mask anything private.";
const ONLY = "Only people with access to this repository can see it";

describe.each(["chromium", "webkit"])(
  "Report says who can see it (%s)",
  (name) => {
    it("a private target: its pill and audience, no public pill or warning", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await review(b, "en", [
        {
          repo: "acme-eng/engine",
          visibility: "private",
          audience: "members of <b class=x>the team</b>",
        },
      ]);
      const s = await seen(p);
      expect(s.pills).toEqual(["Private repository"]);
      expect(s.dest).toContain("members of <b class=x>the team</b>");
      expect(s.dest).not.toContain("Public repository");
      expect(s.warn).toEqual([]);
      expect(s.note).toHaveLength(1);
      expect(s.note[0]).toContain(ONLY);
      expect(s.note[0]).toContain("members of <b class=x>the team</b>");
      expect(s.injected).toBe(0);
      await p.context().close();
    }, 60_000);

    it("an internal target with no audience: Internal pill, the quiet line alone", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await review(b, "en", [
        { repo: "acme-eng/engine", visibility: "internal" },
      ]);
      const s = await seen(p);
      expect(s.pills).toEqual(["Internal repository"]);
      expect(s.warn).toEqual([]);
      expect(s.note).toEqual([`${ONLY}.`]);
      await p.context().close();
    }, 60_000);

    it("a public target: the public pill and warning, unchanged", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await review(b, "en", [
        { repo: "acme-eng/engine", visibility: "public", audience: "anyone" },
      ]);
      const s = await seen(p);
      expect(s.pills).toEqual(["Public repository"]);
      expect(s.dest).not.toContain("anyone");
      expect(s.warn).toEqual([`Public repository. ${PUB_W}`]);
      expect(s.note).toEqual([]);
      await p.context().close();
    }, 60_000);

    it("no visibility, or an unknown one: public", async () => {
      const b = browsers[name];
      if (!b) return;
      for (const r of [
        { repo: "acme-eng/engine" },
        { repo: "acme-eng/engine", visibility: "secret" },
      ]) {
        const p = await review(b, "en", [r]);
        const s = await seen(p);
        expect(s.pills).toEqual(["Public repository"]);
        expect(s.warn).toEqual([`Public repository. ${PUB_W}`]);
        expect(s.note).toEqual([]);
        await p.context().close();
      }
    }, 60_000);

    it("two targets: changing the select changes the pill and the line", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await review(b, "en", [
        { repo: "acme-eng/site", visibility: "public" },
        {
          repo: "acme-eng/engine",
          visibility: "private",
          audience: "the engine team",
        },
      ]);
      let s = await seen(p);
      expect(s.pills).toEqual(["Public repository"]);
      expect(s.warn).toHaveLength(1);
      expect(s.note).toEqual([]);
      const sel = p.locator('dialog.fb-dlg select[data-f="repo"]');
      await sel.selectOption("acme-eng/engine");
      await p.waitForFunction(
        () =>
          document.querySelector(".fb-dest .fb-pill")?.textContent ===
          "Private repository",
      );
      s = await seen(p);
      expect(s.pills).toEqual(["Private repository"]);
      expect(s.dest).toContain("the engine team");
      expect(s.warn).toEqual([]);
      expect(s.note[0]).toContain(ONLY);
      await sel.selectOption("acme-eng/site");
      await p.waitForFunction(
        () =>
          document.querySelector(".fb-dest .fb-pill")?.textContent ===
          "Public repository",
      );
      s = await seen(p);
      expect(s.warn).toEqual([`Public repository. ${PUB_W}`]);
      expect(s.note).toEqual([]);
      await p.context().close();
    }, 60_000);

    it("in es and ja", async () => {
      const b = browsers[name];
      if (!b) return;
      for (const [lang, priv, int, only, pub] of [
        [
          "es",
          "Repositorio privado",
          "Repositorio interno",
          "Solo lo ve quien tiene acceso a este repositorio",
          "Repositorio público",
        ],
        [
          "ja",
          "非公開リポジトリ",
          "内部リポジトリ",
          "このリポジトリにアクセスできる人だけが見られます",
          "公開リポジトリ",
        ],
      ]) {
        const p = await review(b, lang, [
          { repo: "acme-eng/engine", visibility: "private", audience: "X" },
          { repo: "acme-eng/tools", visibility: "internal" },
        ]);
        let s = await seen(p);
        expect(s.pills).toEqual([priv]);
        expect(s.warn).toEqual([]);
        expect(s.note[0]).toContain(only);
        expect(s.note[0]).toContain("X");
        expect(s.pills).not.toContain(pub);
        await p
          .locator('dialog.fb-dlg select[data-f="repo"]')
          .selectOption("acme-eng/tools");
        await p.waitForFunction(
          (int) =>
            document.querySelector(".fb-dest .fb-pill")?.textContent === int,
          int,
        );
        s = await seen(p);
        expect(s.pills).toEqual([int]);
        expect(s.note[0]).toContain(only);
        await p.context().close();
      }
    }, 60_000);
  },
);
