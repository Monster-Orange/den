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
 *
 * The demo distribution; items written to the store here. Invented names
 * only. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];
const ASKED =
  "Approve the direction for the tests? They run the checks each project already has, by layer and by environment, and nothing new.";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
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
  await browser?.close();
  await s?.stop();
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
  await p.goto(signInUrl(s!.stateDir, s!.base, path));
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
    // The waiting question and the newest release: 2. Not the turn's end
    // (off by default), not the read ones, not the 10-day-old one.
    await badge(p, "2");
    await openBell(p);
    const pop = p.locator("#den-bell-pop");
    expect(await pop.locator('[data-kind="finished"]').count()).toBe(0);
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
    await expect(
      asked.locator("a.den-bell-open").getAttribute("href"),
    ).resolves.toBe("/agents?project=north&agent=asker");
    // Open is outside the two lines: never clipped away.
    expect(await asked.locator("a.den-bell-open").isVisible()).toBe(true);
    expect(await asked.locator(".den-bell-t a").count()).toBe(0);
    // Waiting is the one kind with no ⊘ in the row.
    expect(await asked.locator('[data-bell="stop"]').count()).toBe(0);
    await p.context().close();
  }, 90_000);

  it("⊘ asks once; Esc cancels; yes stops showing the kind, with Undo and the settings link", async () => {
    if (skip()) return;
    const p = await open("/services");
    await badge(p, "2");
    await openBell(p);
    const pop = p.locator("#den-bell-pop");
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
    const toast = p.locator(".den-toast-act");
    await toast.waitFor();
    await expect(toast.locator("span.den-tmsg").textContent()).resolves.toBe(
      "No longer showing “Releases and checks”.",
    );
    await expect(
      toast.locator("a.den-tlink").getAttribute("href"),
    ).resolves.toBe("/settings#notifications");
    // Its rows go, and the badge counts the question only.
    await badge(p, "1");
    expect(await s!.settingsGet()).toMatchObject({
      bell_kinds: { release: false },
    });
    await toast.locator("button").click();
    await badge(p, "2");
    expect(await s!.settingsGet()).toMatchObject({
      bell_kinds: { release: true },
    });
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
        await p
          .locator('#den-bell-pop [data-bell="stop"][data-sw="release"]')
          .first()
          .click();
        await p.locator('#den-bell-pop [data-bell="ask-yes"]').click();
        const toast = p.locator(".den-toast-act");
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
          const a = t.querySelector("a.den-tlink")!;
          return {
            toast: r(t),
            msg: r(t.querySelector("span.den-tmsg")),
            btn: r(t.querySelector("button")),
            link: r(a),
            lineH: parseFloat(getComputedStyle(a).lineHeight),
          };
        });
        // The words on top; both actions under them.
        expect(box.btn.t).toBeGreaterThanOrEqual(box.msg.b - 0.5);
        expect(box.link.t).toBeGreaterThanOrEqual(box.msg.b - 0.5);
        // The actions side by side, apart; the link on one line.
        expect(box.link.l).toBeGreaterThanOrEqual(box.btn.r);
        expect(box.link.h).toBeLessThan(box.lineH * 1.6);
        // Inside the screen, with its gutter.
        expect(box.toast.l).toBeGreaterThanOrEqual(15);
        expect(box.toast.r).toBeLessThanOrEqual(390 - 15);
        // Undo, so the next language starts with releases shown.
        await toast.locator("button").click();
        await badge(p, "2");
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
    for (const [lang, said] of [
      ["es", "Más de 7 días (1)"],
      ["ja", "7日より古い通知(1)"],
    ] as const) {
      expect(await s!.settings({ language: lang })).toBe(200);
      try {
        const q = await open("/services");
        await openBell(q);
        await expect(
          q.locator('#den-bell-pop [data-bell="older"]').textContent(),
        ).resolves.toBe(said);
        await q.context().close();
      } finally {
        await s!.settings({ language: null });
      }
    }
    expect(errors).toEqual([]);
  }, 120_000);
});
