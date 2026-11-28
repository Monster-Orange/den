import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://redact.test";
const PREF_KEY = "den.report.include";
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
  window.previews = [];
  window.go = (repos, open) => {
    configureReport({
      lang: "en",
      screenshot: false,
      adapter: {
        info: () => ({ repos }),
        preview: async (form) => {
          window.previews.push({ repo: form.repo, redact: form.redact });
          return { status: 200, data: { title: "t", body: "b" } };
        },
        send: async () => ({ status: 200, data: {} }),
      },
    });
    openReport(open);
  };
  window.ready = true;
</script>
</body></html>`;

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
};

type Repo = { repo: string; visibility?: string; redact?: boolean };
type Open = Record<string, unknown>;
async function open(b: Browser, saved: unknown): Promise<Page> {
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
  await p.evaluate(
    ({ k, v }) => {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, JSON.stringify(v));
    },
    { k: PREF_KEY, v: saved },
  );
  return p;
}
async function include(
  b: Browser,
  repos: Repo[],
  o: { saved?: unknown; open?: Open } = {},
) {
  const p = await open(b, o.saved ?? null);
  await p.evaluate(
    ({ repos, opn }) =>
      (window as unknown as { go: (r: Repo[], o: Open) => void }).go(
        repos,
        opn,
      ),
    { repos, opn: o.open ?? { prefill: { title: "Pane drops" } } },
  );
  const dlg = dialog(p);
  await dlg.locator('[data-act="next"]').click();
  await dlg.locator('[data-f="redact"]').waitFor();
  return p;
}

const dialog = (p: Page) => p.getByRole("dialog");

const box = (p: Page) =>
  dialog(p)
    .locator('[data-f="redact"]')
    .evaluate((e) => (e as HTMLInputElement).checked);

const saved = (p: Page) =>
  p.evaluate((k) => JSON.parse(localStorage.getItem(k) || "null"), PREF_KEY);
async function toReview(p: Page) {
  const n = await p.evaluate(
    () => (window as unknown as { previews: unknown[] }).previews.length,
  );
  await dialog(p).locator('[data-act="review"]').click();
  return lastPreview(p, n);
}

async function lastPreview(p: Page, after: number) {
  await p.waitForFunction(
    (n) => (window as unknown as { previews: unknown[] }).previews.length > n,
    after,
  );
  return p.evaluate(() => {
    const v = (
      window as unknown as { previews: { repo: string; redact: boolean }[] }
    ).previews;
    return v[v.length - 1];
  });
}

const PRIV: Repo = { repo: "o/closed", visibility: "private", redact: false };
const PUB: Repo = { repo: "o/open", visibility: "public" };
const PRIV_ON: Repo = { repo: "o/team", visibility: "internal" };

const draft = (by: string, repo: string | undefined, redact: boolean) => ({
  draft: { id: "d1", by, title: "Pane drops", repo, redact },
});

async function pick(p: Page, repo: string) {
  const n = await p.evaluate(
    () => (window as unknown as { previews: unknown[] }).previews.length,
  );
  await dialog(p).locator('select[data-f="repo"]').selectOption(repo);
  return lastPreview(p, n);
}

describe.each(["chromium", "webkit"])(
  "Report: the Redact names default (%s)",
  (name) => {
    const b = () => browsers[name];
    const skip = () => !b();

    it("a private repo whose host says off starts off", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV]);
      try {
        expect(await box(p)).toBe(false);
        expect(await toReview(p)).toEqual({ repo: PRIV.repo, redact: false });
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("switching to a public repo turns it on, and the preview follows", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV, PUB]);
      try {
        expect(await box(p)).toBe(false);
        expect((await toReview(p)).redact).toBe(false);
        const n = await p.evaluate(
          () => (window as unknown as { previews: unknown[] }).previews.length,
        );
        await dialog(p).locator('select[data-f="repo"]').selectOption(PUB.repo);
        expect(await lastPreview(p, n)).toEqual({
          repo: PUB.repo,
          redact: true,
        });
        await dialog(p).locator('[data-act="back-include"]').click();
        expect(await box(p)).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("Remember without touching the box saves no redact value", async () => {
      if (skip()) return;
      const p = await include(b(), [PUB]);
      try {
        await dialog(p).locator('[data-f="remember"]').check();
        await toReview(p);
        const s = await saved(p);
        expect(s).not.toBeNull();
        expect(s).not.toHaveProperty("redact");
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("an old saved off leaves a public repo on", async () => {
      if (skip()) return;
      const p = await include(b(), [PUB], { saved: { redact: false } });
      try {
        expect(await box(p)).toBe(true);
        expect((await toReview(p)).redact).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("an unknown repo whose host says off stays on", async () => {
      if (skip()) return;
      const p = await include(b(), [{ repo: "o/who", redact: false }]);
      try {
        expect(await box(p)).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("an agent's draft can't turn it off on a public repo", async () => {
      if (skip()) return;
      const p = await include(b(), [PUB], {
        open: {
          draft: {
            id: "d1",
            by: "agent",
            title: "Pane drops",
            repo: PUB.repo,
            redact: false,
          },
        },
      });
      try {
        expect(await box(p)).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);
    it("a person's own draft can turn it off on a public repo", async () => {
      if (skip()) return;
      const p = await include(b(), [PUB], {
        open: draft("person", PUB.repo, false),
      });
      try {
        expect(await box(p)).toBe(false);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("a person's draft with no repo can't turn it off on a public repo", async () => {
      if (skip()) return;
      const p = await include(b(), [PUB], {
        open: draft("person", undefined, false),
      });
      try {
        expect(await box(p)).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("private: a saved choice beats the host default", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV], {
        saved: { redact: true, redactChosen: true },
      });
      try {
        expect(await box(p)).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("private: the draft beats the saved choice", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV_ON], {
        saved: { redact: false },
        open: draft("agent", PRIV_ON.repo, true),
      });
      try {
        expect(await box(p)).toBe(true);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("unticking on a public repo with Remember saves nothing for private ones", async () => {
      if (skip()) return;
      const p = await include(b(), [PUB, PRIV_ON]);
      try {
        await dialog(p).locator('[data-f="redact"]').uncheck();
        await dialog(p).locator('[data-f="remember"]').check();
        expect((await toReview(p)).redact).toBe(false);
        expect(await saved(p)).not.toHaveProperty("redact");
        expect(await pick(p, PRIV_ON.repo)).toEqual({
          repo: PRIV_ON.repo,
          redact: true,
        });
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("a second Review keeps the choice the first one saved", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV_ON, PUB]);
      try {
        await dialog(p).locator('[data-f="redact"]').uncheck();
        await dialog(p).locator('[data-f="remember"]').check();
        await toReview(p);
        expect(await saved(p)).toHaveProperty("redact", false);
        await pick(p, PUB.repo);
        await dialog(p).locator('[data-act="back-include"]').click();
        await toReview(p);
        expect(await saved(p)).toHaveProperty("redact", false);
      } finally {
        await p.context().close();
      }
    }, 60_000);
    it("private: an old saved on, from before the mark, leaves the host's off", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV], { saved: { redact: true } });
      try {
        expect(await box(p)).toBe(false);
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it("a tick on a private repo with Remember saves it, marked as chosen", async () => {
      if (skip()) return;
      const p = await include(b(), [PRIV]);
      try {
        await dialog(p).locator('[data-f="redact"]').check();
        await dialog(p).locator('[data-f="remember"]').check();
        await toReview(p);
        expect(await saved(p)).toMatchObject({
          redact: true,
          redactChosen: true,
        });
      } finally {
        await p.context().close();
      }
    }, 60_000);
  },
);
