/**
 * Issue 128: the first pane's terminal code (xterm, loaded on demand)
 * fails to load once: Den restarted, or the network blipped. Before, the
 * page kept that failure for good and the failed pane stayed open, so
 * every later pane failed and a click on the agent did nothing until the
 * person reloaded the page. Now a click on the agent again opens a working
 * pane, with no reload. The server agent's page (/) the same: its next
 * check opens the terminal.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts). Needs Playwright's
 * chromium; DEN_HELPERS_BROWSER=webkit runs it in Safari's engine.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Route } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInUrl } from "./helpers/den-auth.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let pty: ScriptedPty;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:retrier",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  pty = s.made.at(-1)!;
  s.seed({
    id: "retrier",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:retrier",
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

describe("a pane whose terminal code failed to load (issue 128)", () => {
  it("opens on the next click, with no reload", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(() => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, "9.9.9");
      } catch {
        /* none */
      }
      (window as unknown as { __loaded: number }).__loaded = Date.now();
    });
    const p = await ctx.newPage();
    // The first load of the terminal code fails, as when Den restarts.
    let aborted = 0;
    await p.route("**/vendor/xterm.mjs*", async (route: Route) => {
      if (aborted++ === 0) return route.abort("connectionreset");
      return route.continue();
    });
    await p.goto(`${s.base}/agents?layout=tabs`);
    await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
    await p.evaluate(() =>
      (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
    );
    const loaded = await p.evaluate(
      () => (window as unknown as { __loaded: number }).__loaded,
    );
    const row = p.locator(`#agl button.agr[data-id="${sid}"]`);

    await row.click();
    // The failed try: no terminal.
    const t0 = Date.now();
    while (aborted === 0 && Date.now() - t0 < 10_000)
      await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(await p.locator(`.pane[data-id="${sid}"] .xterm`).count()).toBe(0);

    // Again: a working pane, the same page.
    await row.click();
    await p
      .locator(`.pane[data-id="${sid}"] .xterm`)
      .waitFor({ timeout: 10_000 });
    const mark = `ready-${Math.random().toString(36).slice(2, 8)}`;
    await new Promise((r) => setTimeout(r, 300));
    pty.emit(`${mark}$ `);
    await p.waitForFunction(
      (m) =>
        document.querySelector(".pane .xterm-rows")?.textContent?.includes(m),
      mark,
      { timeout: 15_000 },
    );
    expect(await p.locator(`.pane[data-id="${sid}"]`).count()).toBe(1);
    // No reload: the page is the one first loaded.
    expect(
      await p.evaluate(
        () => (window as unknown as { __loaded: number }).__loaded,
      ),
    ).toBe(loaded);
    await ctx.close();
  }, 60_000);
});

describe("the server agent's terminal code failed to load (issue 128)", () => {
  let fresh: AgentsPageServer | null = null;
  beforeAll(async () => {
    if (browser) fresh = await startAgentsPageServer({ fresh: true });
  }, 60_000);
  afterAll(async () => {
    await fresh?.stop();
  });

  it("opens its terminal on a later check, with no reload", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await ctx.addInitScript(() => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, "9.9.9");
      } catch {
        /* none */
      }
      (window as unknown as { __loaded: number }).__loaded = Date.now();
    });
    const p = await ctx.newPage();
    let aborted = 0;
    await p.route("**/vendor/xterm.mjs*", async (route: Route) => {
      if (aborted++ === 0) return route.abort("connectionreset");
      return route.continue();
    });
    await p.goto(signInUrl(fresh!.stateDir, fresh!.base, "/"));
    const t0 = Date.now();
    while (aborted === 0 && Date.now() - t0 < 20_000)
      await new Promise((r) => setTimeout(r, 50));
    expect(aborted).toBeGreaterThan(0);
    const loaded = await p.evaluate(
      () => (window as unknown as { __loaded: number }).__loaded,
    );
    await p.waitForSelector(".sa-term .xterm", { timeout: 30_000 });
    expect(await p.locator(".sa-term").count()).toBe(1);
    expect(
      await p.evaluate(
        () => (window as unknown as { __loaded: number }).__loaded,
      ),
    ).toBe(loaded);
    await ctx.close();
  }, 90_000);
});
