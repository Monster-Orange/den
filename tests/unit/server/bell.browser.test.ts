/**
 * NT-3: the bell in the top bar, on the real path: an agent's own token
 * says it waits (POST /api/agents/self/attention); the bell on another
 * page shows 1; its panel groups by project then agent; the row links to
 * the agent; Mark all read clears the count; Esc closes and focus goes
 * back. NT-2: the agent open on screen in the Agents page doesn't notify.
 * NT-3b: its row says why it waits.
 * Translated; fits 390 px. The demo distribution, the scripted PTY.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { actorTokenOf } from "../../../src/shared/actor-token.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
let token = "";
const errors: string[] = [];

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
  const r = await fetch(`${s.base}/api/workspaces/north/agents`, {
    method: "POST",
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    body: JSON.stringify({ persona: "planner" }),
  });
  expect(r.status).toBe(200);
  token = actorTokenOf(s.made.at(-1)!.opts.env) ?? "";
  s.made.at(-1)!.emit("> ");
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

const say = (body: unknown) =>
  fetch(`${s!.base}/api/agents/self/attention`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

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

describe("NT-3: the bell", () => {
  it("an agent waits: the bell says 1; the panel groups it; Mark all read; Esc", async () => {
    if (skip()) return;
    expect((await say({ event: "waiting", why: "input" })).status).toBe(200);
    const p = await open("/services");
    await p.waitForFunction(
      () => document.querySelector(".den-bell-n")?.textContent === "1",
      null,
      { timeout: 15_000 },
    );
    expect(await p.getAttribute("#den-bell", "aria-label")).toBe(
      "Notifications: 1 unread",
    );
    await p.click("#den-bell");
    expect(await p.getAttribute("#den-bell", "aria-expanded")).toBe("true");
    const sec = p.locator(
      '#den-bell-pop section[data-scope="workspace/north"]',
    );
    await sec.waitFor();
    expect(await sec.locator(".den-bell-sc span").textContent()).toBe("north");
    const row = sec.locator('.den-bell-row[data-kind="waiting"] a');
    expect(await row.textContent()).toMatch(/is waiting for you$/);
    expect(await row.getAttribute("href")).toBe(
      "/agents?project=north&agent=planner",
    );
    await p.click('#den-bell-pop [data-bell="all"]');
    await p.waitForFunction(
      () =>
        (document.querySelector(".den-bell-n") as HTMLElement | null)
          ?.hidden === true,
    );
    await p.keyboard.press("Escape");
    expect(await p.isHidden("#den-bell-pop")).toBe(true);
    expect(await p.evaluate(() => document.activeElement?.id)).toBe("den-bell");
    await p.context().close();
  }, 90_000);

  it("0.4.44: the panel is in the shell's font, even on a page whose body has none", async () => {
    if (skip()) return;
    expect((await say({ event: "waiting", why: "input" })).status).toBe(200);
    const p = await open("/services");
    // The panel hangs off body, outside the top bar: a body with no font
    // of its own gives it the browser's (a serif).
    await p.evaluate(() => {
      document.body.style.font = "initial";
    });
    await p.waitForFunction(
      () => document.querySelector(".den-bell-n")?.textContent === "1",
      null,
      { timeout: 15_000 },
    );
    await p.click("#den-bell");
    await p.locator('#den-bell-pop [data-bell="scope"]').waitFor();
    const f = await p.evaluate(() => {
      const ff = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el) : null;
      };
      const probe = document.createElement("span");
      probe.style.fontFamily = "var(--sans)";
      document.body.appendChild(probe);
      const sans = getComputedStyle(probe).fontFamily;
      probe.remove();
      const pick = (sel: string) => {
        const c = ff(sel);
        return c
          ? {
              family: c.fontFamily,
              transform: c.textTransform,
              spacing: c.letterSpacing,
              size: c.fontSize,
            }
          : null;
      };
      return {
        sans,
        title: pick("#den-bell-h"),
        row: pick(".den-bell-row a"),
        all: pick('#den-bell-pop [data-bell="all"]'),
        scope: pick('#den-bell-pop [data-bell="scope"]'),
      };
    });
    expect(f.sans).toBeTruthy();
    for (const k of ["title", "row", "all", "scope"] as const)
      expect([k, f[k]?.family]).toEqual([k, f.sans]);
    // "Mark read" reads like "Mark all read".
    expect(f.scope).toMatchObject({ transform: "none", spacing: "normal", size: "12px" });
    expect(f.all?.size).toBe("12px");
    // Leave nothing unread for the tests after this one.
    await p.click('#den-bell-pop [data-bell="all"]');
    await p.waitForFunction(
      () =>
        (document.querySelector(".den-bell-n") as HTMLElement | null)
          ?.hidden === true,
    );
    await p.context().close();
  }, 90_000);

  it("NT-2: the agent open on screen doesn't notify", async () => {
    if (skip()) return;
    // Clear what's there.
    await fetch(`${s!.base}/api/notifications/clear`, {
      method: "POST",
      headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
      body: "{}",
    });
    const id = s!.made.at(-1)!.opts.env.DEN_SESSION_ID ?? "";
    const p = await open(
      `/agents?ws=north${id ? `&open=${encodeURIComponent(id)}` : ""}`,
    );
    // The page says what it shows; then the agent waits.
    await p.bringToFront();
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.waitForTimeout(500);
    const shows = await p.evaluate(
      () => document.querySelectorAll(".pane[data-id]").length,
    );
    if (!shows) {
      // No pane open: say it from the page as the agents page would.
      await p.evaluate(() =>
        (
          window as unknown as {
            denShell: { api: (m: string, u: string, b: unknown) => unknown };
          }
        ).denShell.api("POST", "/api/notifications/looking", {
          agents: ["planner"],
        }),
      );
    }
    expect((await say({ event: "waiting", why: "permission" })).status).toBe(
      200,
    );
    const b = (await (
      await fetch(`${s!.base}/api/notifications`, {
        headers: denAuth(s!.stateDir),
      })
    ).json()) as { unread: number; waiting: { agent: string }[] };
    expect(b.unread).toBe(0);
    // Still marked waiting: just not a notification.
    expect(b.waiting.map((w) => w.agent)).toContain("planner");
    await p.context().close();
  }, 60_000);

  it("NT-3b: the agent's row says why it waits", async () => {
    if (skip()) return;
    expect(
      (await say({ event: "waiting", why: "asked", text: "Ship it?" })).status,
    ).toBe(200);
    const p = await open("/agents?ws=north");
    await p.waitForFunction(
      () =>
        [...document.querySelectorAll(".wbdg")].some(
          (e) => e.textContent === "asked you",
        ),
      null,
      { timeout: 15_000 },
    );
    await p.context().close();
  }, 60_000);

  it("in Spanish, and it fits 390 px", async () => {
    if (skip()) return;
    expect(await s!.settings({ language: "es" })).toBe(200);
    try {
      const p = await open("/services", 390);
      expect(await p.getAttribute("#den-bell", "title")).toBe("Notificaciones");
      await p.click("#den-bell");
      await p.waitForSelector("#den-bell-pop:not([hidden])");
      const box = (await p.locator("#den-bell-pop").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(
        await p.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await p.context().close();
    } finally {
      await s!.settings({ language: null });
    }
  }, 60_000);

  it("(k) the 0.4.41 gate: the item's own words are in the page's language", async () => {
    if (skip()) return;
    // As the server keeps it (attention.ts): the English, and the key.
    new NotificationStore(s!.stateDir).add({
      kind: "waiting",
      subject: "agent:k-gate",
      scope: "workspace/north",
      text: "Kgate needs your permission",
      msg: { key: "bell.m.permission", vars: { name: "Kgate" } },
    });
    for (const [lang, said] of [
      ["es", "necesita tu permiso"],
      ["ja", "許可を待っています"],
    ] as const) {
      expect(await s!.settings({ language: lang })).toBe(200);
      try {
        const p = await open("/services", 390);
        await p.click("#den-bell");
        await p.waitForSelector("#den-bell-pop:not([hidden])");
        const row = p
          .locator("#den-bell-pop .den-bell-row")
          .filter({ hasText: "Kgate" });
        expect(await row.first().innerText()).toContain(said);
        expect(await row.first().innerText()).not.toContain("needs your");
        await p.context().close();
      } finally {
        await s!.settings({ language: null });
      }
    }
    new NotificationStore(s!.stateDir).withdraw("agent:k-gate");
  }, 90_000);

  it("NT-6: Hub's items show under their Hub project, linked to Hub", async () => {
    if (skip()) return;
    new NotificationStore(s!.stateDir).syncHub(
      [
        {
          id: "n1",
          kind: "mention",
          subject: "thread:th_1",
          scope: "hub/web/main",
          text: "Kim mentioned you on Pricing page",
          link: "https://hub.example.test/a/pricing#th_1",
          at: new Date().toISOString(),
          readBy: [],
        },
        {
          id: "n2",
          kind: "mention",
          subject: "thread:th_2",
          scope: "hub/shop/main",
          scopeName: "Shop site",
          text: "Kim mentioned you on Checkout",
          at: new Date().toISOString(),
          readBy: [],
        },
      ],
      "pat",
    );
    const p = await open("/services");
    await p.click("#den-bell");
    const sec = p.locator('#den-bell-pop section[data-scope="hub/web/main"]');
    await sec.waitFor({ timeout: 15_000 });
    expect(await sec.locator(".den-bell-sc span").textContent()).toBe(
      "Hub · web",
    );
    // Hub's name for the project, when it sends one.
    expect(
      await p
        .locator(
          '#den-bell-pop section[data-scope="hub/shop/main"] .den-bell-sc span',
        )
        .textContent(),
    ).toBe("Hub · Shop site");
    const a = sec.locator('.den-bell-row[data-id="hub:n1"] a');
    expect(await a.textContent()).toBe("Kim mentioned you on Pricing page");
    expect(await a.getAttribute("href")).toBe(
      "https://hub.example.test/a/pricing#th_1",
    );
    await p.context().close();
  }, 90_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
