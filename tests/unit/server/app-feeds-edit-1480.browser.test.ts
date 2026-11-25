/**
 * Issue 1480: Settings › Project › App event feeds, the row's own Add and
 * Remove, in Chromium and WebKit. The row shows each feed's last delivery
 * (time and state). Add sends { name, agent, url, bearer } with the agent
 * picked from the project's own; Remove asks first (the kit's dialog):
 * Cancel sends nothing, Remove sends DELETE and the feed goes. Busy shows
 * in the button.
 *
 * The demo distribution (helpers/agents-page-server.ts), the event-feeds
 * routes answered by the test (a stateful fake). Needs Playwright's
 * chromium and webkit; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names
 * only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const browsers: Partial<Record<"chromium" | "webkit", Browser>> = {};
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browsers.chromium = await launchBrowser(pw.chromium);
    browsers.webkit = await launchBrowser(pw.webkit);
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
}, 120_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

const URL_A = "https://chat.example.test/events";
const URL_B = "https://tasks.example.test/events";
const AT = Date.UTC(2026, 10, 24, 18, 30);

interface Sent {
  method: string;
  name: string;
  body: unknown;
}

async function page(
  b: Browser,
): Promise<{ p: Page; sent: Sent[]; slow: { ms: number } }> {
  const ctx = await b.newContext({
    viewport: { width: 375, height: 900 },
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
  const list: Record<string, unknown>[] = [
    {
      name: "chat",
      agent: "planner",
      url: URL_A,
      state: "connected",
      since: AT,
      last_event_at: AT,
      unread: 0,
      problem: null,
    },
  ];
  const sent: Sent[] = [];
  const slow = { ms: 0 };
  await p.route("**/api/workspaces/*/event-feeds**", async (r) => {
    const req = r.request();
    const m = /\/event-feeds(?:\/([^/?]+))?/.exec(req.url());
    const name = m?.[1] ? decodeURIComponent(m[1]) : "";
    if (req.method() !== "GET") {
      const body = req.method() === "POST" ? req.postDataJSON() : undefined;
      sent.push({ method: req.method(), name, body });
      if (slow.ms) await new Promise((res) => setTimeout(res, slow.ms));
      if (req.method() === "DELETE")
        list.splice(
          list.findIndex((x) => x.name === name),
          1,
        );
      else {
        const f = body as { name: string; agent: string; url: string };
        list.push({
          name: f.name,
          agent: f.agent,
          url: f.url,
          state: "connecting",
          since: AT,
          last_event_at: null,
          unread: 0,
          problem: null,
        });
      }
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, project: "north", name }),
      });
    }
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        feeds: list,
        problems: [],
        agents: ["planner", "scout"],
      }),
    });
  });
  await signInPage(p, s!.stateDir, s!.base, "/settings?ws=north#workspace");
  await p.waitForSelector(`${ROW} [data-feed-list]`);
  return { p, sent, slow };
}

const ROW = '[data-setting="workspace.event_feeds"]';
const names = (p: Page) =>
  p.$$eval(`${ROW} [data-feed]`, (els) =>
    els.map((e) => e.getAttribute("data-feed")),
  );

describe.each(["chromium", "webkit"] as const)(
  "issue 1480: App event feeds › Add, Remove (%s)",
  (kind) => {
    const b = () => browsers[kind];

    it("shows a feed's last delivery; Add sends the feed, busy in the button, and the row shows it", async () => {
      if (!b()) return;
      const { p, sent, slow } = await page(b()!);
      expect(
        await p.textContent(`${ROW} [data-feed="chat"] [data-feed-st]`),
      ).toBe("Connected");
      expect(
        await p.textContent(`${ROW} [data-feed="chat"] [data-feed-last]`),
      ).toMatch(/^Last event /);
      expect(
        await p.$$eval(`${ROW} [data-feed-agent-pick] option`, (els) =>
          els.map((e) => (e as HTMLOptionElement).value),
        ),
      ).toEqual(["planner", "scout"]);
      await p.fill(`${ROW} [data-feed-name]`, "tasks");
      await p.selectOption(`${ROW} [data-feed-agent-pick]`, "scout");
      await p.fill(`${ROW} [data-feed-url]`, URL_B);
      await p.fill(`${ROW} [data-feed-bearer]`, "tasks_feed_token");
      slow.ms = 1500;
      await p.click(`${ROW} [data-feed-addbtn]`);
      await p.waitForFunction(
        (sel) =>
          document
            .querySelector(`${sel} [data-feed-addbtn]`)
            ?.getAttribute("aria-busy") === "true",
        ROW,
      );
      await p.waitForSelector(`${ROW} [data-feed="tasks"]`);
      expect(sent).toEqual([
        {
          method: "POST",
          name: "",
          body: {
            name: "tasks",
            agent: "scout",
            url: URL_B,
            bearer: "tasks_feed_token",
          },
        },
      ]);
      expect(await names(p)).toEqual(["chat", "tasks"]);
      // The bearer is a ref's name; no value is ever on the page.
      expect(await p.textContent(ROW)).not.toContain("tasks_feed_token");
      expect(
        await p.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        ),
      ).toBeLessThanOrEqual(0);
      await p.context().close();
    }, 60_000);

    it("Remove asks first: Cancel sends nothing; Remove sends DELETE and the feed goes", async () => {
      if (!b()) return;
      const { p, sent } = await page(b()!);
      await p.click(`${ROW} [data-feed-remove="chat"]`);
      await p.locator('dialog [data-dk="cancel"]').click();
      expect(sent).toEqual([]);
      await p.click(`${ROW} [data-feed-remove="chat"]`);
      await p.locator('dialog [data-dk="ok"]').click();
      await p.waitForSelector(`${ROW} [data-feed-none]`);
      expect(sent).toEqual([
        { method: "DELETE", name: "chat", body: undefined },
      ]);
      expect(errors).toEqual([]);
      await p.context().close();
    }, 60_000);
  },
);
