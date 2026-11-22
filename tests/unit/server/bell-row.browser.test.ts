/**
 * Issue 93: a bell row opens on a click anywhere; there is no separate
 * Open link. Issue 791 (the approved Peek mock): an agent's row opens its
 * peek over the page, and its one small "Open in Agents" link goes to
 * the page, as the row did. On the real page, at 1280 and 390 px:
 *
 *   1. A long question's row and a short one's both open (their peek) on
 *      a click in the middle of their text, and on a click on their time.
 *   2. No row holds an element named Open (Abrir, 開く) in en, es or ja;
 *      the only Open in a row is the agent's Open in Agents link.
 *   3. The row's link is reached by Tab, shows a focus ring, has
 *      one accessible name, and Enter opens it.
 *   4. The controls inside a row (×N, ⊘) do their own thing and never
 *      open the row, by click or by Enter.
 *   5. Issue 187: every row that opens on a click shows the pointer
 *      cursor anywhere on it (its dot, its text, its time, the space
 *      between), in en, es and ja.
 *
 * DEN_HELPERS_BROWSER=webkit runs it in WebKit; DEN_PW_WS connects to a
 * Playwright server instead of a local browser. Invented names only.
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
const LONG_Q =
  "Approve the direction for the tests? They run the checks each project already has, by layer and by environment, and nothing new.";
const SHORT_Q = "Ship it today?";
const LONG_LINK = "/agents?project=north&agent=asker";
const SHORT_LINK = "/agents?project=north&agent=brief";
const OPEN_WORDS = /^(open|abrir|開く)$/i;

beforeAll(async () => {
  try {
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
  const st = new NotificationStore(s.stateDir);
  ask();
  // Two releases from one agent, with a link: one row with ×2 and ⊘ (an
  // unread item takes a new one of its kind in, so the first is read).
  for (let i = 0; i < 2; i++) {
    const n = st.add({
      kind: "service",
      subject: "agent:shipper",
      scope: "workspace/north",
      text: `Release ${i + 1} shipped`,
      link: "/settings",
    });
    if (i === 0) st.markRead({ id: n!.id });
    await new Promise((r) => setTimeout(r, 5));
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

/**
 * The two questions, each filed again when it is gone. Filed as from Hub:
 * Den's own sweep drops a question of its own whose agent isn't waiting,
 * and these agents are invented. The row is drawn the same either way.
 */
function ask(): void {
  const st = new NotificationStore(s!.stateDir);
  const have = st.list().filter((n) => n.kind === "waiting" && !n.read);
  for (const [name, q, link] of [
    ["Asker", LONG_Q, LONG_LINK],
    ["Brief", SHORT_Q, SHORT_LINK],
  ] as const) {
    if (have.some((n) => n.link === link)) continue;
    st.add({
      kind: "waiting",
      subject: `agent:${name.toLowerCase()}`,
      scope: "workspace/north",
      text: `${name} asked: ${q}`,
      msg: { key: "bell.m.asked", vars: { name, text: q } },
      link,
      source: "hub",
    });
  }
}

async function open(width: number): Promise<Page> {
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
  ask();
  // Reads are answered here, so every page sees the same bell.
  await p.route("**/api/notifications/read", (r) =>
    r.fulfill({ json: { ok: true } }),
  );
  await signInPage(p, s!.stateDir, s!.base, "/services");
  await p.waitForSelector("#den-bell");
  return p;
}

async function openBell(p: Page): Promise<void> {
  await p.click("#den-bell");
  await p.locator("#den-bell-pop .den-bell-hd").waitFor();
  await p
    .locator('#den-bell-pop .den-bell-row[data-kind="waiting"]')
    .first()
    .waitFor();
}

const row = (p: Page, link: string) =>
  p.locator(".den-bell-row", {
    has: p.locator(`a[href="${link}"]`),
  });

/** Issue 791: the row opened its agent's peek, over /services. */
async function peeked(p: Page, link: string): Promise<void> {
  await p.locator("dialog#den-peek[open]").waitFor({ timeout: 10_000 });
  const agent = new URL(link, "http://x").searchParams.get("agent");
  await expect(p.locator("#den-peek .dk-hd h2").textContent()).resolves.toBe(
    agent,
  );
  expect(new URL(p.url()).pathname).toBe("/services");
}

/** The page didn't leave /services within a short wait. */
async function stays(p: Page): Promise<void> {
  await p.waitForTimeout(600);
  expect(new URL(p.url()).pathname).toBe("/services");
}

/**
 * Issue 187: the cursor at every part of every row that opens on a click
 * (the row itself, its dot, its text, its time), as "<part> <cursor>" for
 * each one that isn't the pointer.
 */
async function notPointer(p: Page): Promise<string[]> {
  return p.$$eval("#den-bell-pop [data-id][data-kind]", (rows) => {
    const out: string[] = [];
    let n = 0;
    for (const r of rows) {
      if (!r.querySelector('a[data-bell="open"]')) continue;
      n++;
      const parts: [string, Element | null][] = [
        ["row", r],
        ["dot", r.querySelector("[aria-hidden]")],
        ["text", r.querySelector('a[data-bell="open"]')],
        ["time", r.querySelector("time")],
      ];
      for (const [what, el] of parts) {
        if (!el) continue;
        const c = getComputedStyle(el).cursor;
        if (c !== "pointer")
          out.push(`${(r as HTMLElement).dataset.id} ${what} ${c}`);
      }
    }
    if (!n) out.push("no row opens on a click");
    return out;
  });
}

describe.each([1280, 390])(
  "issue 93: a bell row opens on a click anywhere (%i px)",
  (width) => {
    it.each([
      ["long", LONG_LINK],
      ["short", SHORT_LINK],
    ])(
      "a %s question opens on a click in the middle of its text",
      async (_k, link) => {
        if (skip()) return;
        const p = await open(width);
        await openBell(p);
        const r = row(p, link);
        expect(await r.count()).toBe(1);
        // The middle of the question's text (its two-line span, or the
        // link that holds it: the first in the row, in either shape).
        // locator.click() aims at the element's centre and waits until it
        // is visible and still, finding it again if the bell redraws the
        // row; a boundingBox() read once can be null mid-redraw.
        await r.locator(".den-bell-t, a").first().click();
        await peeked(p, link);
        await p.context().close();
      },
      90_000,
    );

    it.each([
      ["long", LONG_LINK],
      ["short", SHORT_LINK],
    ])(
      "a %s question opens on a click on its time",
      async (_k, link) => {
        if (skip()) return;
        const p = await open(width);
        await openBell(p);
        const r = row(p, link);
        await r.locator("time").click();
        await peeked(p, link);
        await p.context().close();
      },
      90_000,
    );

    it("issue 187: every row that opens shows the pointer cursor", async () => {
      if (skip()) return;
      const p = await open(width);
      await openBell(p);
      await p.locator('#den-bell-pop [data-bell="updates"]').click();
      await p.locator('#den-bell-pop [data-kind="service"]').waitFor();
      expect(await notPointer(p)).toEqual([]);
      await p.context().close();
    }, 90_000);

    it("Tab reaches the row's link: one name, a focus ring, and Enter opens it", async () => {
      if (skip()) return;
      const p = await open(width);
      await p.focus("#den-bell");
      await p.keyboard.press("Enter");
      await p
        .locator('#den-bell-pop .den-bell-row[data-kind="waiting"]')
        .first()
        .waitFor();
      const r = row(p, SHORT_LINK);
      // The row's link has one name, the question itself; beside it the
      // agent's Open in Agents link (issue 791).
      const links = r.getByRole("link");
      expect(await links.count()).toBe(2);
      expect(await r.locator('a[data-bell="page"]').getAttribute("href")).toBe(
        SHORT_LINK,
      );
      const name = await r
        .locator('a[data-bell="open"]')
        .evaluate((a) => a.getAttribute("aria-label") ?? a.textContent ?? "");
      expect(name).toContain(SHORT_Q);
      expect(await r.getByRole("button").count()).toBe(0);
      // Tab until the row's link has focus.
      let at = "";
      for (let i = 0; i < 30 && at !== SHORT_LINK; i++) {
        await p.keyboard.press("Tab");
        at = await p.evaluate(() =>
          document.activeElement?.getAttribute("data-bell") === "open"
            ? (document.activeElement?.getAttribute("href") ?? "")
            : "",
        );
      }
      expect(at).toBe(SHORT_LINK);
      const ring = await p.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const cs = getComputedStyle(a);
        return {
          visible: a.matches(":focus-visible"),
          style: cs.outlineStyle,
          width: parseFloat(cs.outlineWidth),
        };
      });
      // A ring shows (the browser's own, or the house one).
      expect(ring.visible).toBe(true);
      expect(ring.style).not.toBe("none");
      expect(ring.width).toBeGreaterThan(0);
      await p.keyboard.press("Enter");
      await peeked(p, SHORT_LINK);
      await p.context().close();
    }, 90_000);

    it("×N and ⊘ inside a row do their own thing and never open it", async () => {
      if (skip()) return;
      const p = await open(width);
      await openBell(p);
      const pop = p.locator("#den-bell-pop");
      await pop.locator('[data-bell="updates"]').click();
      const r = row(p, "/settings").first();
      await r.waitFor();
      // ×2: the repeats unfold, the page stays.
      const x = r.locator('[data-bell="fold"]');
      await x.click();
      await expect(
        pop.locator('[data-bell="fold"]').getAttribute("aria-expanded"),
      ).resolves.toBe("true");
      await stays(p);
      // ⊘ by click: its question, the page stays.
      await pop.locator('[data-bell="stop"]').first().click();
      await pop.locator('[role="alertdialog"]').waitFor();
      await stays(p);
      await pop.locator('[data-bell="ask-no"]').click();
      // ⊘ by Enter: the same.
      await pop.locator('[data-bell="stop"]').first().focus();
      await p.keyboard.press("Enter");
      await pop.locator('[role="alertdialog"]').waitFor();
      await stays(p);
      await p.context().close();
    }, 90_000);
  },
);

describe("issues 93, 187: no Open in any row, and the pointer on each, in en, es and ja", () => {
  it.each(["en", "es", "ja"])(
    "%s",
    async (lang) => {
      if (skip()) return;
      expect(await s!.settings({ language: lang })).toBe(200);
      try {
        const p = await open(1280);
        await openBell(p);
        await p.locator('#den-bell-pop [data-bell="updates"]').click();
        await p
          .locator('#den-bell-pop .den-bell-row[data-kind="service"]')
          .waitFor();
        const names = await p.$$eval(
          "#den-bell-pop .den-bell-row a, #den-bell-pop .den-bell-row button",
          (els) =>
            els.map((e) =>
              (e.getAttribute("aria-label") ?? e.textContent ?? "").trim(),
            ),
        );
        expect(names.length).toBeGreaterThan(0);
        expect(names.filter((n) => OPEN_WORDS.test(n))).toEqual([]);
        // Issue 791: the agent's Open in Agents link is the one Open.
        const texts = await p.$$eval("#den-bell-pop .den-bell-row", (els) =>
          els.map((e) => {
            const c = e.cloneNode(true) as HTMLElement;
            c.querySelectorAll(".den-bell-page").forEach((x) => x.remove());
            return c.textContent ?? "";
          }),
        );
        for (const t of texts) expect(t).not.toMatch(/\b(Open|Abrir)\b|開く/);
        // Issue 187: and each row that opens shows the pointer.
        expect(await notPointer(p)).toEqual([]);
        await p.context().close();
      } finally {
        await s!.settings({ language: null });
      }
    },
    90_000,
  );
});
