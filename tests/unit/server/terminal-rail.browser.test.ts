/**
 * D73: the rail's Terminal opens a plain shell in the project's folder, in
 * the same pane agents use. Typing reaches it; what it prints shows. A
 * reload keeps the tab and starts no second shell. A project's "Terminal
 * here" opens one in that project. The label and tooltip are translated.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY
 * (no real shell runs). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
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
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function open(path: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
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
  return p;
}

const rows = (p: Page, id: string) =>
  p.$eval(`.pane[data-id="${id}"] .xterm-rows`, (el) => el.textContent ?? "");

describe("D73: Terminal", () => {
  it("the rail's Terminal: a shell in the project's folder; a reload keeps the tab", async () => {
    if (skip()) return;
    const p = await open("/services?ws=north");
    const link = p.locator('#den-rail [data-nav="terminal"]');
    expect(await link.getAttribute("title")).toBe(
      "Open a shell in this project's folder, in Den",
    );
    const before = s!.made.length;
    await p.goto(
      signInUrl(s!.stateDir, s!.base, "/agents?terminal=1&ws=north"),
    );
    await p.waitForSelector(".pane .xterm-rows");
    await p.waitForFunction(() => !location.search.includes("terminal="));
    const pty = s!.made.at(-1)!;
    expect(s!.made.length).toBe(before + 1);
    expect(pty.opts.cwd).toBe(s!.wsDir("north"));
    const id = await p.$eval(".pane[data-id]", (el) =>
      el.getAttribute("data-id"),
    );
    expect(id).toBeTruthy();

    // The shell's prompt shows first: the pane is attached before we type.
    pty.emit("ready$ ");
    await p.waitForFunction(
      (i) =>
        (
          document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
            ?.textContent ?? ""
        ).includes("ready$"),
      id!,
      { timeout: 20_000 },
    );
    await p.click(`.pane[data-id="${id}"] .xterm-screen`);
    await p.keyboard.type("pwd");
    await p.keyboard.press("Enter");
    for (
      let i = 0;
      i < 200 && !Buffer.concat(pty.writes).toString().includes("pwd\r");
      i++
    )
      await p.waitForTimeout(50);
    expect(Buffer.concat(pty.writes).toString()).toContain("pwd\r");
    pty.emit(`${s!.wsDir("north")}\r\n$ `);
    await p.waitForFunction(
      ([i, dir]) =>
        (
          document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
            ?.textContent ?? ""
        ).includes(dir),
      [id!, s!.wsDir("north")] as const,
    );

    await p.reload();
    await p.waitForSelector(`.pane[data-id="${id}"] .xterm-rows`);
    expect(s!.made.length).toBe(before + 1);
    expect(await rows(p, id!)).toBeDefined();
  }, 90_000);

  it("a project's Terminal here opens one in that project", async () => {
    if (skip()) return;
    const p = await open("/?ws=south");
    const here = p.locator("#ws-term-here");
    await here.waitFor();
    expect(await here.textContent()).toBe("Terminal here");
    expect(await here.getAttribute("href")).toBe("/agents?terminal=1&ws=south");
    const before = s!.made.length;
    await here.click();
    await p.waitForFunction(() => !location.search.includes("terminal="));
    await p.waitForSelector(".pane .xterm-rows");
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
  }, 90_000);

  it("the 0.4.39 gate: a second Terminal adds a tab; the rail's opens in the project in view", async () => {
    if (skip()) return;
    const p = await open("/?ws=north");
    await p.locator("#ws-term-here").click();
    await p.waitForFunction(() => !location.search.includes("terminal="));
    await p.waitForSelector(".pane[data-id]");
    const first = s!.made.length;
    const firstId = new URL(p.url()).searchParams.get("open")!;
    expect(firstId).toBeTruthy();

    // Another project's Terminal here: the first tab stays.
    await p.goto(signInUrl(s!.stateDir, s!.base, "/?ws=south"));
    await p.locator("#ws-term-here").click();
    await p.waitForFunction(() => !location.search.includes("terminal="));
    await p.waitForFunction(
      () =>
        (new URLSearchParams(location.search).get("open") ?? "").split(",")
          .length === 2,
    );
    expect(s!.made.length).toBe(first + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
    const open2 = new URL(p.url()).searchParams.get("open")!.split(",");
    expect(open2[0]).toBe(firstId);
    await p.reload();
    await p.waitForSelector(`.pane[data-id="${open2[1]}"]`, {
      state: "attached",
    });
    expect(new URL(p.url()).searchParams.get("open")!.split(",")).toEqual(
      open2,
    );

    // The rail's Terminal from /agents?ws=south: a shell in south (not the
    // first project), a third tab.
    await p.goto(
      signInUrl(
        s!.stateDir,
        s!.base,
        `/agents?ws=south&open=${open2.join(",")}`,
      ),
    );
    await p.waitForSelector(".pane[data-id]", { state: "attached" });
    await p.locator('#den-rail [data-nav="terminal"]').click();
    await p.waitForFunction(() => !location.search.includes("terminal="));
    await p.waitForFunction(
      () =>
        (new URLSearchParams(location.search).get("open") ?? "").split(",")
          .length === 3,
    );
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
  }, 120_000);

  it("in Spanish: Terminal, with its tooltip", async () => {
    if (skip()) return;
    expect(await s!.settings({ language: "es" })).toBe(200);
    try {
      const p = await open("/services?ws=north");
      const link = p.locator('#den-rail [data-nav="terminal"]');
      expect(await link.getAttribute("title")).toBe(
        "Abrir una terminal en la carpeta de este proyecto, en Den",
      );
    } finally {
      await s!.settings({ language: null });
    }
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
