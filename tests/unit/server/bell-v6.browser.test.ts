/**
 * Bell v6 (0.4.45): a quieter bell, on the real page.
 *
 *   1. Only the kinds that are on show, and the badge counts only those
 *      ("Agent finished its turn" is off by default; items older than the
 *      fold days fold under one "Older than 7 days" row and don't count).
 *   2. Repeats of a kind from one agent fold into one row with ×N.
 *   3. A long question shows two lines and an Open link.
 *   4. A row's ⊘ asks once (Esc cancels, the panel stays); yes stops
 *      showing the kind, with Undo and a link to the settings.
 *   5. Nothing shown: "Nothing needs you right now.", which kinds are off,
 *      and the settings link.
 *   6. Settings › Notifications: a switch per kind; waiting off warns.
 *   7. At 390 px the panel is the full width.
 *   8. ATTN-5 (den#142): releases and checks fold into one Updates row,
 *      closed, and never count on the badge.
 *
 * The demo distribution; items written to the store here. Invented names
 * only. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];
const ASKED =
  "Approve the direction for the tests? They run the checks each project already has, by layer and by environment, and nothing new.";

beforeAll(async () => {
  try {
    // DEN_HELPERS_BROWSER=webkit|firefox runs it there (den#93: Safari too).
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    browser = await launchBrowser(pw[engine]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  const dir = s.stateDir;
  // Ten days ago: folded as older.
  new NotificationStore(dir, () => new Date(Date.now() - 10 * 86_400_000)).add({
    kind: "service",
    subject: "agent:old-one",
    scope: "workspace/south",
    text: "Old release shipped",
  });
  const st = new NotificationStore(dir);
  // Three releases from one agent: two read, the newest not.
  for (let i = 0; i < 3; i++) {
    const n = st.add({
      kind: "service",
      subject: "agent:shipper",
      scope: "workspace/north",
      text: `Release ${i + 1} shipped`,
    });
    if (i < 2) st.markRead({ id: n!.id });
    await new Promise((r) => setTimeout(r, 5));
  }
  st.add({
    kind: "finished",
    subject: "agent:quiet",
    scope: "workspace/north",
    text: "Quiet finished its turn",
    msg: { key: "bell.m.turn", vars: { name: "Quiet" } },
  });
  // The question's agent is a real one: its record, its session ended by
  // itself (issue 424). Issue 369: the server's first attention check (2 s
  // after it starts) withdraws an unread "asked" row whose agent has no
  // record, as a leftover from before. Rows written before that check went;
  // rows written after it stayed. Which came first was timing.
  s.seed({ id: "asker", workspace: "north" });
  st.add({
    kind: "waiting",
    subject: "agent:asker",
    scope: "workspace/north",
    text: `Asker asked: ${ASKED}`,
    msg: { key: "bell.m.asked", vars: { name: "Asker", text: ASKED } },
    link: "/agents?project=north&agent=asker",
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const skip = () => !browser;

async function open(path: string, width = 1280): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 860 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, path);
  await p.waitForSelector("#den-bell");
  return p;
}

const badge = (p: Page, n: string) =>
  p.waitForFunction(
    (want) => {
      const b = document.querySelector(".den-bell-n") as HTMLElement | null;
      return want === "" ? b?.hidden === true : b?.textContent === want;
    },
    n,
    { timeout: 15_000 },
  );

async function openBell(p: Page): Promise<void> {
  await p.click("#den-bell");
  await p.locator("#den-bell-pop .den-bell-hd").waitFor();
  await p.waitForFunction(
    () =>
      document.querySelector(
        "#den-bell-pop section, #den-bell-pop .den-bell-empty",
      ) !== null,
  );
}

describe("bell v6: a quieter bell", () => {
  it("only kinds on show; the badge counts them, not old or hidden ones; ×N folds repeats; Older folds", async () => {
    if (skip()) return;
    const p = await open("/services");
    // ATTN-5 (den#142): the waiting question only. Releases are updates;
    // not the turn's end (off by default), not the 10-day-old one.
    await badge(p, "1");
    await openBell(p);
    const pop = p.locator("#den-bell-pop");
    expect(await pop.locator('[data-kind="finished"]').count()).toBe(0);
    // Releases fold into one Updates row, closed.
    const upd = pop.locator('[data-bell="updates"]');
    await expect(upd.textContent()).resolves.toBe("Updates (3)");
    await expect(upd.getAttribute("aria-expanded")).resolves.toBe("false");
    expect(await pop.locator('[data-kind="service"]').count()).toBe(0);
    await upd.click();
    await expect(
      pop.locator('[data-bell="updates"]').getAttribute("aria-expanded"),
    ).resolves.toBe("true");
    // Three releases from one agent: one row, ×3.
    const x = pop.locator('.den-bell-x[data-bell="fold"]');
    expect(await x.count()).toBe(1);
    await expect(x.textContent()).resolves.toBe("×3");
    await expect(x.getAttribute("aria-expanded")).resolves.toBe("false");
    expect(
      await pop
        .locator('section[data-scope="workspace/north"] [data-kind="service"]')
        .count(),
    ).toBe(1);
    await x.click();
    await expect(
      pop
        .locator('.den-bell-x[data-bell="fold"]')
        .getAttribute("aria-expanded"),
    ).resolves.toBe("true");
    expect(
      await pop
        .locator('section[data-scope="workspace/north"] [data-kind="service"]')
        .count(),
    ).toBe(3);
    // Older: one row with the count; open, its item shows.
    const older = pop.locator('[data-bell="older"]');
    await expect(older.textContent()).resolves.toBe("Older than 7 days (1)");
    expect(
      await pop.locator('section[data-scope="workspace/south"]').count(),
    ).toBe(0);
    await older.click();
    await pop.locator('section[data-scope="workspace/south"]').waitFor();
    // A long question: two lines and an Open link to the agent.
    const asked = pop.locator('.den-bell-row[data-kind="waiting"]');
    await expect(asked.locator(".den-bell-t.long").count()).resolves.toBe(1);
    const lines = await asked
      .locator(".den-bell-t")
      .evaluate((e) =>
        Math.round(
          e.getBoundingClientRect().height /
            parseFloat(getComputedStyle(e).lineHeight),
        ),
      );
    expect(lines).toBeLessThanOrEqual(2);
    // den#93: the row is the link (its two lines inside it), no Open link.
    await expect(
      asked.locator('a[data-bell="open"]').getAttribute("href"),
    ).resolves.toBe("/agents?project=north&agent=asker");
    expect(await asked.locator('a[data-bell="open"] .den-bell-t').count()).toBe(
      1,
    );
    expect(await asked.locator("a").count()).toBe(1);
    expect(await asked.textContent()).not.toMatch(/\bOpen\b/);
    // Waiting is the one kind with no ⊘ in the row.
    expect(await asked.locator('[data-bell="stop"]').count()).toBe(0);
    // A click anywhere on the row (here its time) opens it, marked read
    // first. The read is answered here, so the next test's bell is as it was.
    let read: unknown = null;
    await p.route("**/api/notifications/read", (r) => {
      read = r.request().postDataJSON();
      return r.fulfill({ json: { ok: true } });
    });
    await asked.locator("time").click();
    await p.waitForURL(/\/agents\?project=north&agent=asker/);
    expect(read).toMatchObject({ id: expect.any(String) });
    await p.context().close();
  }, 90_000);

  it("⊘ asks once; Esc cancels; yes stops showing the kind, with Undo and the settings link", async () => {
    if (skip()) return;
    const p = await open("/services");
    await badge(p, "1");
    await openBell(p);
    const pop = p.locator("#den-bell-pop");
    await pop.locator('[data-bell="updates"]').click();
    const stop = pop.locator('[data-bell="stop"][data-sw="release"]').first();
    await expect(stop.getAttribute("aria-label")).resolves.toBe(
      "Stop showing this kind",
    );
    await stop.click();
    const ask = pop.locator('[role="alertdialog"]');
    await expect(ask.locator("#den-bell-askt").textContent()).resolves.toBe(
      "Stop showing “Releases and checks”?",
    );
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLElement)?.dataset.bell,
      ),
    ).toBe("ask-yes");
    await p.keyboard.press("Escape");
    expect(await ask.count()).toBe(0);
    expect(await p.isHidden("#den-bell-pop")).toBe(false);
    await stop.click();
    await pop.locator('[data-bell="ask-yes"]').click();
    const toast = p.locator(
      "[data-den-toast] [data-kind]:has([data-toast-undo])",
    );
    await toast.waitFor();
    await expect(toast.locator("[data-toast-msg]").textContent()).resolves.toBe(
      "No longer showing “Releases and checks”.",
    );
    await expect(
      toast.locator("[data-toast-link]").getAttribute("href"),
    ).resolves.toBe("/settings#notifications");
    // Its rows go, and Updates with them; the badge still counts the question.
    await pop.locator('[data-bell="updates"]').waitFor({ state: "detached" });
    await badge(p, "1");
    expect(await s!.settingsGet()).toMatchObject({
      bell_kinds: { release: false },
    });
    // Undo's save, armed before the click: the note goes at the click and
    // the save follows it (issue 424: in WebKit the note was gone before
    // the save landed, and the save landed in the next test).
    const undone = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") &&
        r.request().method() === "POST" &&
        JSON.stringify(r.request().postDataJSON()).includes('"release":true'),
    );
    await toast.locator("button").click();
    await p.waitForFunction(
      () =>
        document.querySelector(
          "[data-den-toast] [data-kind]:has([data-toast-undo])",
        ) === null,
    );
    await undone;
    expect(await s!.settingsGet()).toMatchObject({
      bell_kinds: { release: true },
    });
    // Undone: the releases are back under Updates.
    if (await p.isHidden("#den-bell-pop")) await openBell(p);
    await pop.locator('[data-bell="updates"]').waitFor();
    await p.context().close();
  }, 90_000);

  it("nothing shown: says so, which kinds are off, and links to the settings", async () => {
    if (skip()) return;
    expect(
      await s!.settings({ bell_kinds: { waiting: false, release: false } }),
    ).toBe(200);
    try {
      const p = await open("/services");
      await badge(p, "");
      await openBell(p);
      const empty = p.locator("#den-bell-pop .den-bell-empty");
      await expect(empty.locator("p").first().textContent()).resolves.toBe(
        "Nothing needs you right now.",
      );
      await expect(empty.locator("p").nth(1).textContent()).resolves.toBe(
        "Not shown: Agent is waiting for you, Agent finished its turn, Releases and checks.",
      );
      await expect(empty.locator("a").getAttribute("href")).resolves.toBe(
        "/settings#notifications",
      );
      await p.context().close();
    } finally {
      await s!.settings({ bell_kinds: { waiting: null, release: null } });
    }
  }, 90_000);

  it("Settings › Notifications: a switch per kind, finished off; waiting off warns", async () => {
    if (skip()) return;
    const p = await open("/settings#notifications");
    const sw = (k: string) =>
      p.locator(`#setting-notifications-${k} input.set-check`);
    // Signing in drops the #: the category from its link in the nav.
    await p.click('#set-nav a[data-cat="notifications"]');
    await sw("waiting").waitFor();
    for (const k of ["waiting", "hub", "pr", "release", "pick", "shared"])
      expect(await sw(k).isChecked()).toBe(true);
    expect(await sw("finished").isChecked()).toBe(false);
    await sw("waiting").click();
    const warn = p.locator(".set-warn", {
      hasText: "agents waiting for you won't show here or on the badge",
    });
    await warn.waitFor();
    expect(await s!.settingsGet()).toMatchObject({
      bell_kinds: { waiting: false },
    });
    await sw("waiting").click();
    await warn.waitFor({ state: "detached" });
    await s!.settings({ bell_kinds: { waiting: null } });
    await p.context().close();
  }, 90_000);

  it("390 px: the Undo note stacks (the words, then Undo and the settings link in a row), in en, es and ja", async () => {
    if (skip()) return;
    for (const lang of ["en", "es", "ja"] as const) {
      if (lang !== "en")
        expect(await s!.settings({ language: lang })).toBe(200);
      try {
        const p = await open("/services", 390);
        await openBell(p);
        await p.locator('#den-bell-pop [data-bell="updates"]').click();
        await p
          .locator('#den-bell-pop [data-bell="stop"][data-sw="release"]')
          .first()
          .click();
        await p.locator('#den-bell-pop [data-bell="ask-yes"]').click();
        const toast = p.locator(
          "[data-den-toast] [data-kind]:has([data-toast-undo])",
        );
        await toast.waitFor();
        const box = await toast.evaluate((t) => {
          const r = (e: Element | null) => {
            const b = e!.getBoundingClientRect();
            return {
              l: b.left,
              r: b.right,
              t: b.top,
              b: b.bottom,
              h: b.height,
            };
          };
          const a = t.querySelector<HTMLAnchorElement>("[data-toast-link]")!;
          return {
            toast: r(t),
            msg: r(t.querySelector("[data-toast-msg]")),
            btn: r(t.querySelector("button")),
            link: r(a),
            linkLines: (() => {
              const g = document.createRange();
              g.selectNodeContents(a);
              return new Set(
                [...g.getClientRects()].map((c) => Math.round(c.top)),
              ).size;
            })(),
          };
        });
        // The words on top; both actions under them.
        expect(box.btn.t).toBeGreaterThanOrEqual(box.msg.b - 0.5);
        expect(box.link.t).toBeGreaterThanOrEqual(box.msg.b - 0.5);
        // The actions side by side, apart; the link on one line.
        expect(box.link.l).toBeGreaterThanOrEqual(box.btn.r);
        expect(box.linkLines).toBe(1);
        expect(box.link.h).toBeGreaterThanOrEqual(44);
        expect(box.btn.h).toBeGreaterThanOrEqual(44);
        // Inside the screen, with its gutter.
        expect(box.toast.l).toBeGreaterThanOrEqual(15);
        expect(box.toast.r).toBeLessThanOrEqual(390 - 15);
        // Undo, so the next language starts with releases shown.
        await toast.locator("button").click();
        await p.waitForFunction(() =>
          fetch("/api/notifications")
            .then((r) => r.json())
            .then((b) => b.updates?.count === 3),
        );
        await p.context().close();
      } finally {
        if (lang !== "en") await s!.settings({ language: null });
      }
    }
  }, 150_000);

  it("390 px: the panel is the full width; Spanish and Japanese say it", async () => {
    if (skip()) return;
    const p = await open("/services", 390);
    await openBell(p);
    const w = await p
      .locator("#den-bell-pop")
      .evaluate((e) => e.getBoundingClientRect().width);
    expect(w).toBe(390);
    const sw = await p.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(sw).toBe(true);
    await p.context().close();
    for (const [lang, said, upd] of [
      ["es", "Más de 7 días (1)", "Novedades (3)"],
      ["ja", "7日より古い通知(1)", "お知らせ(3)"],
    ] as const) {
      expect(await s!.settings({ language: lang })).toBe(200);
      try {
        const q = await open("/services");
        await openBell(q);
        await expect(
          q.locator('#den-bell-pop [data-bell="older"]').textContent(),
        ).resolves.toBe(said);
        await expect(
          q.locator('#den-bell-pop [data-bell="updates"]').textContent(),
        ).resolves.toBe(upd);
        await q.context().close();
      } finally {
        await s!.settings({ language: null });
      }
    }
    expect(errors).toEqual([]);
  }, 120_000);
});
