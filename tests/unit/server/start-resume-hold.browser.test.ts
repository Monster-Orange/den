import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signIn } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const notes = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = notes.find((n) => n.version)?.version ?? "";
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

type Answer = { route: Route };

async function page(): Promise<{ p: Page; resumes: Answer[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch (err) {
      void err;
    }
  }, latest);
  await signIn(ctx, s!.stateDir, s!.base);
  const p = await ctx.newPage();
  await p.route(/\/api\/sessions(\?|$)/, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    const data = (await res.json()) as {
      workspaces?: string[];
      sessions?: Record<string, unknown>[];
    };
    const ws = data.workspaces?.[0] ?? "default";
    data.sessions = [
      ...(data.sessions ?? []),
      {
        id: "s-scout-old",
        kind: "agent",
        workspace: ws,
        agent: "scout",
        displayName: "scout",
        state: "stopped",
      },
    ];
    return route.fulfill({ response: res, json: data });
  });
  const resumes: Answer[] = [];
  await p.route(/\/agents\/scout\/resume$/, (route) => {
    resumes.push({ route });
  });
  await p.goto(`${s!.base}/agents?start=1`);
  await p.waitForSelector("#ag-dlg[open]");
  return { p, resumes };
}

describe("Start › Resume it holds its dialog open", () => {
  it("the dialog stays open with Resume it held until the resume answers", async () => {
    if (skip()) return;
    const { p, resumes } = await page();
    await p.fill("#ag-name", "scout");
    const resume = p.locator("#ag-as button");
    await resume.waitFor();
    const sent = p.waitForRequest(/\/agents\/scout\/resume$/);
    await resume.click();
    await sent;
    expect(resumes.length).toBe(1);
    expect(
      await p.locator("#ag-dlg").evaluate((d) => (d as HTMLDialogElement).open),
    ).toBe(true);
    expect(await resume.getAttribute("aria-busy")).toBe("true");
    await p.keyboard.press("Escape");
    expect(
      await p.locator("#ag-dlg").evaluate((d) => (d as HTMLDialogElement).open),
    ).toBe(true);
    await resumes[0]!.route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true }),
    });
    await p.waitForFunction(
      () => !(document.getElementById("ag-dlg") as HTMLDialogElement).open,
    );
    await p.context().close();
  });
});
