/**
 * Issue 340: the pane bar says which vendor account an agent runs on under
 * the always-on service, by its label (never an email), through GET
 * /api/sessions (no mocked route); nothing for an agent with none. The
 * demo distribution with a session host in this process
 * (helpers/agents-page-server.ts). Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
const servers: AgentsPageServer[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [...servers],
  });
});

/** A server with one running agent whose record has `signIn`. */
async function withAgent(signIn?: { id: string; label: string }) {
  const s = await startAgentsPageServer({});
  servers.push(s);
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:scout",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: "acme-north:scout",
    ...(signIn ? { signIn } : {}),
  });
  return { s, id: info.ref.id };
}

async function open(s: AgentsPageServer, id: string, width = 1280) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s.stateDir, s.base);
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
  });
  const p: Page = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${s.base}/agents?open=${id}&layout=tabs`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  return { p, errors };
}

describe("the vendor account an agent runs on, in its pane bar (issue 340)", () => {
  it("its label, with a tip that says why", async () => {
    if (!browser) return;
    const { s, id } = await withAgent({
      id: "2",
      label: "Claude account B",
    });
    const { p, errors } = await open(s, id);
    const tag = p.locator(`.pane[data-id="${id}"] .bar2 [data-signin]`);
    await tag.waitFor({ timeout: 10_000 });
    expect((await tag.textContent())?.trim()).toBe("on Claude account B");
    expect(await tag.getAttribute("title")).toContain("after logout");
    expect(await tag.getAttribute("title")).not.toContain("@");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("a record without one: no tag", async () => {
    if (!browser) return;
    const { s, id } = await withAgent();
    const { p } = await open(s, id);
    await p
      .locator(`.pane[data-id="${id}"] .bar2`)
      .waitFor({ timeout: 10_000 });
    expect(
      await p.locator(`.pane[data-id="${id}"] .bar2 [data-signin]`).count(),
    ).toBe(0);
    await p.context().close();
  }, 60_000);
});
