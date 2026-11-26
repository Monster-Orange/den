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
let s: AgentsPageServer;
let latest = "";

async function startScout(): Promise<string> {
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
  });
  return info.ref.id;
}

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    browser = await launchBrowser(pw.chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const ptyCols = (p: Page, id: string) =>
  p.locator(`[data-id="${id}"][data-cols]`).getAttribute("data-pty-cols");

describe("issue 1641: a pane says its PTY's size only for the session it is on", () => {
  it("after a restart, the pane claims no PTY size until its new session's terminal connects", async () => {
    if (!browser) return;
    const old = await startScout();
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      reducedMotion: "reduce",
    });
    await signIn(ctx, s.stateDir, s.base);
    await ctx.addInitScript((v) => {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    }, latest);
    const p = await ctx.newPage();
    const errors: string[] = [];
    p.on("pageerror", (e) => errors.push(e.message));
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    await p.routeWebSocket(/\/api\/sessions\/[^/]+\/io$/, async (ws) => {
      if (!ws.url().includes(encodeURIComponent(old))) await held;
      ws.connectToServer();
    });
    await p.goto(`${s.base}/agents?open=${old}&layout=tabs`);
    await p.locator(`[data-id="${old}"][data-pty-cols]`).waitFor({
      timeout: 20_000,
    });
    s.made.at(-1)!.exit(0);
    await p
      .locator(`[data-id="${old}"][data-cols] [data-act="attach"]`)
      .waitFor({ state: "detached", timeout: 15_000 });
    const next = await startScout();
    await p
      .locator(`[data-id="${next}"][data-cols]`)
      .waitFor({ timeout: 20_000 });
    expect(await ptyCols(p, next)).toBeNull();
    release();
    await p
      .locator(`[data-id="${next}"][data-pty-cols]`)
      .waitFor({ timeout: 20_000 });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
