/**
 * Issue 352: Settings › Project › Agents' extra MCP servers, the row's
 * actions in a browser. Change opens the row's form: a new address sends
 * { url } and the row shows it; No bearer sends { bearer: null }.
 * Remove asks first (the kit's dialog): Cancel sends nothing, Remove
 * sends DELETE and the row is gone. No bearer value is ever on the page.
 *
 * The demo distribution (helpers/agents-page-server.ts), the mcp-servers
 * routes answered by the test (a stateful fake). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
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

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
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
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const skip = () => !browser;
const URL_A = "https://mcp.tracker.example.test";
const URL_B = "https://mcp2.tracker.example.test/mcp";

interface Sent {
  method: string;
  name: string;
  body: unknown;
}

async function page(): Promise<{ p: Page; sent: Sent[] }> {
  const ctx = await browser!.newContext({
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
  const list = [
    { name: "tracker", url: URL_A },
    { name: "wiki", url: "https://wiki.example.test/mcp" },
  ];
  const sent: Sent[] = [];
  const view = () => ({ ok: true, project: "north", servers: list });
  await p.route("**/api/workspaces/*/mcp-servers**", (r) => {
    const req = r.request();
    const m = /\/mcp-servers(?:\/([^/?]+))?/.exec(req.url());
    const name = m?.[1] ? decodeURIComponent(m[1]) : "";
    if (name) {
      const body = req.method() === "POST" ? req.postDataJSON() : undefined;
      sent.push({ method: req.method(), name, body });
      const i = list.findIndex((x) => x.name === name);
      if (req.method() === "DELETE") list.splice(i, 1);
      else if ((body as { url?: string })?.url)
        list[i] = { name, url: (body as { url: string }).url };
    }
    return r.fulfill({
      contentType: "application/json",
      body: JSON.stringify(view()),
    });
  });
  await signInPage(p, s!.stateDir, s!.base, "/settings?ws=north#workspace");
  await p.waitForSelector(
    '[data-setting="workspace.mcp_servers"] [data-pmcp-list]',
  );
  return { p, sent };
}

const ROW = '[data-setting="workspace.mcp_servers"]';
const rows = (p: Page) =>
  p.$$eval(`${ROW} [data-pmcp-text]`, (els) =>
    els.map((e) => (e.textContent ?? "").trim()),
  );

describe("issue 352: Settings › Project › Agents' extra MCP servers › Change, Remove", () => {
  it("Change: a new address is sent and shown; No bearer sends a null bearer", async () => {
    if (skip()) return;
    const { p, sent } = await page();
    expect(await rows(p)).toEqual([
      `tracker: ${URL_A}`,
      "wiki: https://wiki.example.test/mcp",
    ]);
    expect(await p.isVisible(`${ROW} [data-pmcp-form="tracker"]`)).toBe(false);
    await p.click(`${ROW} [data-pmcp-edit="tracker"]`);
    const form = `${ROW} [data-pmcp-form="tracker"]`;
    expect(await p.isVisible(form)).toBe(true);
    expect(await p.inputValue(`${form} [data-pmcp-url]`)).toBe(URL_A);
    await p.fill(`${form} [data-pmcp-url]`, URL_B);
    await p.click(`${form} [data-pmcp-save]`);
    await p.waitForFunction(
      ([sel, u]) =>
        [...document.querySelectorAll(`${sel} [data-pmcp-text]`)].some((e) =>
          (e.textContent ?? "").includes(u),
        ),
      [ROW, URL_B] as const,
    );
    expect(sent).toEqual([
      { method: "POST", name: "tracker", body: { url: URL_B } },
    ]);
    await p.click(`${ROW} [data-pmcp-edit="wiki"]`);
    await p.check(`${ROW} [data-pmcp-form="wiki"] [data-pmcp-nobearer]`);
    await p.click(`${ROW} [data-pmcp-form="wiki"] [data-pmcp-save]`);
    // Saved, the list is drawn again with every form closed.
    await p.waitForFunction(
      (sel) =>
        (document.querySelector(sel) as HTMLElement | null)?.hidden === true,
      `${ROW} [data-pmcp-form="wiki"]`,
    );
    expect(sent[1]).toEqual({
      method: "POST",
      name: "wiki",
      body: { bearer: null },
    });
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(0);
    await p.context().close();
  }, 60_000);

  it("Remove asks first: Cancel sends nothing; Remove sends DELETE and the row goes", async () => {
    if (skip()) return;
    const { p, sent } = await page();
    await p.click(`${ROW} [data-pmcp-remove="tracker"]`);
    await p.locator('dialog [data-dk="cancel"]').click();
    expect(sent).toEqual([]);
    await p.click(`${ROW} [data-pmcp-remove="tracker"]`);
    await p.locator('dialog [data-dk="ok"]').click();
    await p.waitForFunction(
      (sel) => !document.querySelector(`${sel} [data-pmcp="tracker"]`),
      ROW,
    );
    expect(sent).toEqual([
      { method: "DELETE", name: "tracker", body: undefined },
    ]);
    expect(await rows(p)).toEqual(["wiki: https://wiki.example.test/mcp"]);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});
