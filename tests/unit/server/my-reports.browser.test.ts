/**
 * FB (den#81): My reports (E2) and Finish later's screenshot, in the page.
 * The person's reports, live from GitHub (here the test's answer to
 * /api/report/mine): state, last reply, a link out, a dot for a reply not
 * opened yet (their own replies never get one). Their drafts beside them,
 * agents' on the second tab, to continue or discard. Finish later keeps
 * the screenshot and its masks in this browser (IndexedDB), never on Den's
 * server, and Continue brings them back; sending forgets them. Entry
 * points: the command palette and the form's own link. en, es, ja; 390 px.
 *
 * Every /api/report call is answered by the test (never the real `gh`);
 * github.com is never reached. Invented names.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, BrowserContext, Locator, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

jest.setTimeout(30_000);

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: a Linux browser (the Playwright image), as on CI.
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

/** A visible element's box: waits until it is laid out, never null. */
async function boxOf(l: Locator) {
  await l.waitFor({ state: "visible" });
  const b = await l.boundingBox();
  if (!b) throw new Error("no box: the element is not laid out");
  return b;
}
const HOUR = 3_600_000;
const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

interface Draft {
  id: string;
  by: string;
  title: string;
  savedAt: string;
  kind?: string;
  description?: string;
  hasShot?: boolean;
  shot?: string;
}

interface Fake {
  mine: [number, Record<string, unknown>];
  drafts: Draft[];
  posted: Record<string, unknown>[];
  deleted: string[];
  sent: Record<string, unknown>[];
}

const REPORTS = [
  {
    repo: "acme-eng/engine",
    number: 7,
    title: "Agents list jumps when helpers start",
    url: "https://github.com/acme-eng/engine/issues/7",
    state: "open",
    updatedAt: iso(2 * HOUR),
    replies: 2,
    lastReply: { text: "Fixed in 9.9.9", at: iso(2 * HOUR), by: "maintainer" },
  },
  {
    repo: "acme-eng/engine",
    number: 5,
    title: "Bell font looks off",
    url: "https://github.com/acme-eng/engine/issues/5",
    state: "closed",
    updatedAt: iso(26 * HOUR),
    replies: 1,
    lastReply: { text: "Thanks", at: iso(26 * HOUR), by: "pat" },
  },
];

const fresh = (over: Partial<Fake> = {}): Fake => ({
  mine: [200, { ok: true, signedIn: true, me: "pat", reports: REPORTS }],
  drafts: [],
  posted: [],
  deleted: [],
  sent: [],
  ...over,
});

const ctxs: BrowserContext[] = [];
afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
});

async function page(fake: Fake, width = 1440): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  ctxs.push(ctx);
  // The link out opens github.com in a new tab: answered here, never sent.
  await ctx.route("https://github.com/**", (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<p>issue</p>" }),
  );
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const json = (r: Route, status: number, body: unknown) =>
    r.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  await p.route("**/api/report**", async (r) => {
    const u = new URL(r.request().url());
    const m = r.request().method();
    const body = r.request().postDataJSON?.() ?? null;
    if (u.pathname === "/api/report")
      return json(r, 200, {
        ok: true,
        enabled: true,
        repos: [{ repo: "acme-eng/engine" }],
        github: { signedIn: true, deviceFlow: true },
        maxPerHour: 5,
        sentThisHour: 0,
      });
    if (u.pathname === "/api/report/diagnostics")
      return json(r, 200, { ok: true, sections: { Den: "acme 9.9.9" } });
    if (u.pathname === "/api/report/mine") return json(r, ...fake.mine);
    if (u.pathname === "/api/report/preview")
      return json(r, 200, {
        ok: true,
        title: body.title,
        body: "**Kind:** bug",
        repo: "acme-eng/engine",
      });
    if (u.pathname === "/api/report/send") {
      fake.sent.push(body);
      return json(r, 200, {
        ok: true,
        url: "https://github.com/acme-eng/engine/issues/42",
        repo: "acme-eng/engine",
        added: false,
      });
    }
    if (u.pathname === "/api/report/drafts" && m === "GET")
      return json(r, 200, {
        ok: true,
        drafts: fake.drafts.map(({ shot, ...d }) =>
          shot ? { ...d, hasShot: true } : d,
        ),
      });
    if (u.pathname === "/api/report/drafts" && m === "POST") {
      fake.posted.push(body);
      const id = body.id || "0123456789abcdef";
      fake.drafts = fake.drafts.filter((d) => d.id !== id);
      fake.drafts.unshift({
        id,
        by: "person",
        title: body.title,
        description: body.description,
        kind: body.kind,
        savedAt: iso(0),
      });
      return json(r, 200, { ok: true, draft: { id } });
    }
    const one = /^\/api\/report\/drafts\/([a-f0-9]{16})$/.exec(u.pathname);
    if (one && m === "GET") {
      const d = fake.drafts.find((x) => x.id === one[1]);
      return d
        ? json(r, 200, { ok: true, draft: d })
        : json(r, 404, { ok: false });
    }
    if (one && m === "DELETE") {
      fake.deleted.push(one[1]);
      fake.drafts = fake.drafts.filter((x) => x.id !== one[1]);
      return json(r, 200, { ok: true });
    }
    return json(r, 404, { ok: false });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

const my = (p: Page) => p.locator("dialog.fb-my");
const form = (p: Page) => p.locator("dialog.fb-dlg:not(.fb-my)");
const openMy = (p: Page) =>
  p.evaluate(() =>
    (
      window as unknown as { denShell: { myReports: () => Promise<unknown> } }
    ).denShell.myReports(),
  );

/** What this browser keeps for a draft's screenshot (IndexedDB). */
const kept = (p: Page, id: string) =>
  p.evaluate(
    (key) =>
      new Promise<{ masks: unknown[]; size: number } | null>((ok) => {
        const r = indexedDB.open("den-report", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("shots");
        r.onsuccess = () => {
          const g = r.result
            .transaction("shots", "readonly")
            .objectStore("shots")
            .get(key);
          g.onsuccess = () => {
            r.result.close();
            const v = g.result as { blob?: Blob; masks: unknown[] } | undefined;
            ok(v?.blob ? { masks: v.masks, size: v.blob.size } : null);
          };
        };
      }),
    id,
  );

describe("FB: My reports", () => {
  it("lists the person's reports live from GitHub: state, last reply, the link out; a dot for a reply not opened yet", async () => {
    if (skip()) return;
    const p = await page(fresh());
    await openMy(p);
    const rows = my(p).locator("[data-report]");
    await rows.first().waitFor();
    expect(await rows.count()).toBe(2);
    expect(await my(p).locator("h2").textContent()).toBe("My reports");
    const r7 = my(p).locator('[data-report="acme-eng/engine#7"]');
    expect(await r7.textContent()).toContain(
      "Open · last reply: “Fixed in 9.9.9” 2 hours ago",
    );
    expect(await r7.locator("a").getAttribute("href")).toBe(
      "https://github.com/acme-eng/engine/issues/7",
    );
    expect(await r7.locator("a").getAttribute("rel")).toBe(
      "noopener noreferrer",
    );
    // A reply by someone else, not opened: the dot. Their own: none.
    expect(await r7.locator(".fb-dot").getAttribute("aria-label")).toBe(
      "New reply",
    );
    const r5 = my(p).locator('[data-report="acme-eng/engine#5"]');
    expect(await r5.textContent()).toContain("Closed · last reply: “Thanks”");
    expect(await r5.locator(".fb-dot").count()).toBe(0);
    // Opening it on GitHub: the dot goes, and stays gone next time.
    const tab = p.context().waitForEvent("page");
    await r7.locator("a").click();
    await (await tab).close();
    expect(await r7.locator(".fb-dot").count()).toBe(0);
    await my(p).locator('[data-act="done"]').click();
    await my(p).waitFor({ state: "detached" });
    await openMy(p);
    await my(p).locator('[data-report="acme-eng/engine#7"]').waitFor();
    expect(await my(p).locator(".fb-dot").count()).toBe(0);
  });

  it("drafts from agents: their own tab with the count; Continue opens the form with it and its screenshot; Discard removes it", async () => {
    if (skip()) return;
    const fake = fresh();
    const p = await page(fake);
    const shot = await p.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 80;
      c.height = 60;
      const g = c.getContext("2d")!;
      g.fillStyle = "rgb(255, 0, 255)";
      g.fillRect(0, 0, 80, 60);
      return c.toDataURL("image/png");
    });
    fake.drafts = [
      {
        id: "aaaaaaaaaaaaaaaa",
        by: "agent:helper-1",
        title: "Pane drops on resize",
        description: "Seen twice.",
        kind: "bug",
        savedAt: iso(HOUR),
        shot,
      },
      {
        id: "bbbbbbbbbbbbbbbb",
        by: "agent:helper-2",
        title: "Logs tab is slow",
        kind: "bug",
        savedAt: iso(HOUR),
      },
    ];
    await openMy(p);
    const agents = my(p).locator('[data-tab="agents"]');
    await my(p).locator("[data-report]").first().waitFor();
    expect(await agents.textContent()).toBe("Drafts from agents (2)");
    // Mine doesn't list agents' drafts.
    expect(await my(p).locator("[data-draft]").count()).toBe(0);
    await agents.click();
    expect(await agents.getAttribute("aria-selected")).toBe("true");
    const row = my(p).locator('[data-draft="bbbbbbbbbbbbbbbb"]');
    expect(await row.textContent()).toContain("From helper-2 · 1 hour ago");
    await row.locator('[data-act="rmdraft"]').click();
    await row.waitFor({ state: "detached" });
    expect(fake.deleted).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(await agents.textContent()).toBe("Drafts from agents (1)");
    await my(p)
      .locator('[data-draft="aaaaaaaaaaaaaaaa"] [data-act="cont"]')
      .click();
    await my(p).waitFor({ state: "detached" });
    await form(p).locator("canvas[data-shot]").waitFor();
    expect(await form(p).locator('[data-f="title"]').inputValue()).toBe(
      "Pane drops on resize",
    );
    const px = await form(p)
      .locator("canvas[data-shot]")
      .evaluate((c: HTMLCanvasElement) => [
        c.width,
        ...c.getContext("2d")!.getImageData(40, 30, 1, 1).data.slice(0, 3),
      ]);
    expect(px).toEqual([80, 255, 0, 255]);
  });

  it("not signed in to GitHub: it says so, and the drafts still show; none at all: the empty line; a GitHub error is shown", async () => {
    if (skip()) return;
    const fake = fresh({
      mine: [200, { ok: true, signedIn: false, reports: [] }],
      drafts: [
        {
          id: "cccccccccccccccc",
          by: "person",
          title: "Half-written",
          savedAt: iso(0),
        },
      ],
    });
    const p = await page(fake);
    await openMy(p);
    await my(p).locator(".fb-warn").waitFor();
    expect(await my(p).locator(".fb-warn").textContent()).toBe(
      "Sign in to GitHub to see your reports here. Drafts are shown either way.",
    );
    expect(
      await my(p).locator('[data-draft="cccccccccccccccc"]').textContent(),
    ).toContain("Draft: Finish later · Saved on this computer · not sent");
    await my(p).locator('[data-act="done"]').click();
    fake.mine = [200, { ok: true, signedIn: true, me: "pat", reports: [] }];
    fake.drafts = [];
    await openMy(p);
    await my(p)
      .getByText("No reports yet. Press Report on any page to send one.")
      .waitFor();
    await my(p).locator('[data-act="done"]').click();
    fake.mine = [502, { ok: false, error: "HTTP 502: Bad gateway" }];
    await openMy(p);
    await my(p).locator(".fb-err").waitFor();
    expect(await my(p).locator(".fb-err").textContent()).toBe(
      "HTTP 502: Bad gateway",
    );
  });

  it("Finish later keeps the screenshot and its mask in this browser, not on Den's server; Continue brings them back; sending forgets them", async () => {
    if (skip()) return;
    const fake = fresh();
    const p = await page(fake);
    await p.keyboard.press("ControlOrMeta+Shift+F");
    const c = form(p).locator("canvas[data-shot]");
    await c.waitFor();
    const cb = await boxOf(c);
    await p.mouse.move(cb.x + cb.width * 0.2, cb.y + cb.height * 0.2);
    await p.mouse.down();
    await p.mouse.move(cb.x + cb.width * 0.4, cb.y + cb.height * 0.4, {
      steps: 4,
    });
    await p.mouse.up();
    await form(p).getByText("1 area hidden").waitFor();
    await form(p).locator('[data-f="title"]').fill("Pane drops");
    await form(p).locator('[data-act="later"]').first().click();
    await p.waitForFunction(
      () =>
        document.querySelector("dialog.fb-dlg")?.getAttribute("data-step") ===
        "later",
    );
    expect(await form(p).textContent()).toContain(
      "Find it under My reports, at the top of Report an issue or in the command palette.",
    );
    // The text went to Den; the picture did not.
    expect(fake.posted).toHaveLength(1);
    expect(Object.keys(fake.posted[0])).not.toContain("shot");
    expect(JSON.stringify(fake.posted[0])).not.toMatch(/data:image/);
    const k = await kept(p, "0123456789abcdef");
    expect(k?.masks).toHaveLength(1);
    expect(k!.size).toBeGreaterThan(0);
    await form(p).locator('[data-act="done"]').click();
    await form(p).waitFor({ state: "detached" });
    // Continue from My reports: the text, the screenshot and the mask.
    await openMy(p);
    await my(p)
      .locator('[data-draft="0123456789abcdef"] [data-act="cont"]')
      .click();
    await form(p).locator("canvas[data-shot]").waitFor();
    expect(await form(p).locator('[data-f="title"]').inputValue()).toBe(
      "Pane drops",
    );
    await form(p).getByText("1 area hidden").waitFor();
    const px = await form(p)
      .locator("canvas[data-shot]")
      .evaluate((el: HTMLCanvasElement) =>
        Array.from(
          el
            .getContext("2d")!
            .getImageData(
              Math.round(el.width * 0.3),
              Math.round(el.height * 0.3),
              1,
              1,
            )
            .data.slice(0, 3),
        ),
      );
    expect(px).toEqual([0, 0, 0]);
    // Sent: the kept screenshot is forgotten.
    await form(p).locator('[data-act="next"]').click();
    await form(p).locator('[data-act="review"]').click();
    const download = p.waitForEvent("download");
    await form(p).locator('[data-act="send"]').click();
    await download;
    expect(fake.sent[0]).toMatchObject({ draftId: "0123456789abcdef" });
    await p.waitForFunction(
      () =>
        new Promise((ok) => {
          const r = indexedDB.open("den-report", 1);
          r.onsuccess = () => {
            const g = r.result
              .transaction("shots", "readonly")
              .objectStore("shots")
              .count();
            g.onsuccess = () => {
              r.result.close();
              ok(g.result === 0);
            };
          };
        }),
    );
  });

  it("ways in: the command palette, and the form's own link (typed text is kept or discarded first)", async () => {
    if (skip()) return;
    const p = await page(fresh());
    await p.keyboard.press("Control+k");
    await p.waitForSelector(".den-pal");
    await p.keyboard.type("my reports");
    await p
      .getByRole("option", { name: /My reports/ })
      .first()
      .click();
    await my(p).locator("[data-report]").first().waitFor();
    await p.keyboard.press("Escape");
    await my(p).waitFor({ state: "detached" });
    await p.keyboard.press("ControlOrMeta+Shift+F");
    await form(p).locator('[data-f="title"]').waitFor();
    await form(p).locator('[data-f="title"]').fill("Half");
    await form(p).locator('[data-act="mine"]').click();
    // Text typed: keep it or discard it first.
    await p.waitForFunction(
      () =>
        document.querySelector("dialog.fb-dlg")?.getAttribute("data-step") ===
        "keep",
    );
    await form(p).locator('[data-act="discard"]').click();
    await my(p).locator("[data-report]").first().waitFor();
    expect(await form(p).count()).toBe(0);
  });

  it("in es and ja, and at 390 px with nothing wider than the screen", async () => {
    if (skip()) return;
    for (const [lang, title, tab] of [
      ["es", "Mis informes", "Borradores de agentes (0)"],
      ["ja", "自分の報告", "エージェントの下書き (0)"],
    ] as const) {
      await s!.settings({ language: lang });
      const p = await page(fresh(), 390);
      await p.waitForFunction((l) => document.documentElement.lang === l, lang);
      await openMy(p);
      await my(p).locator("[data-report]").first().waitFor();
      expect(await my(p).locator("h2").textContent()).toBe(title);
      expect(await my(p).locator('[data-tab="agents"]').textContent()).toBe(
        tab,
      );
      const over = await my(p).evaluate(
        (d) =>
          [...d.querySelectorAll("*")].filter(
            (el) => el.getBoundingClientRect().right > innerWidth + 1,
          ).length + (d.scrollWidth > d.clientWidth + 1 ? 1 : 0),
      );
      expect(over).toBe(0);
    }
    await s!.settings({ language: "en" });
  });

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
