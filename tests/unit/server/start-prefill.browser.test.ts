import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let latest = "";
const errors: string[] = [];
const FOLDER = "/srv/prefill-check";
const SESSIONS = (u: URL) => u.pathname === "/api/sessions";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

async function page(hold?: (r: Route) => void): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      return;
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  if (hold) await p.route(SESSIONS, (r) => hold(r));
  return p;
}

const link = `/agents?start=1&project=south&folder=${encodeURIComponent(FOLDER)}`;
const opened = (p: Page) =>
  p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
const closed = (p: Page) =>
  p.waitForSelector("#ag-dlg:not([open])", { state: "attached" });
const folder = (p: Page) => p.inputValue("#ag-folder");

describe("the Start dialog's prefill from a ?start=1 link", () => {
  it("prefills the project and folder once; Start again opens empty", async () => {
    if (skip()) return;
    const p = await page();
    await p.goto(`${s!.base}${link}`);
    await opened(p);
    expect(await p.inputValue("#ag-ws")).toBe("south");
    expect(await folder(p)).toBe(FOLDER);
    await p.click("#ag-cancel");
    await closed(p);
    await p.click("#ag-start");
    await opened(p);
    expect(await folder(p)).toBe("");
    await p.context().close();
  });

  it("Bring in, opened before the link's Start, ignores the prefill and uses it up", async () => {
    if (skip()) return;
    const held: Route[] = [];
    const p = await page((r) => void held.push(r));
    await p.goto(`${s!.base}${link}`);
    await p.waitForFunction(() => {
      const b = document.querySelector<HTMLButtonElement>("#ag-bring");
      return !!b && !b.hidden && !b.disabled;
    });
    expect(await p.$("#ag-dlg[open]")).toBeNull();
    await p.click("#ag-bring");
    await opened(p);
    expect(await folder(p)).toBe("");
    await p.click("#ag-cancel");
    await closed(p);
    for (const r of held.splice(0)) await r.continue();
    await p.unroute(SESSIONS);
    await opened(p);
    expect(await folder(p)).toBe("");
    await p.context().close();
  });

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
