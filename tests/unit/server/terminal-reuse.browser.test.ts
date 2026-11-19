/**
 * Issue 448: the rail's Terminal opens the project's running shell, not a
 * new one each click. Two clicks give one shell, in front and with the
 * keyboard. "New terminal" starts another on purpose. With several
 * running, the rail opens the one used last.
 *
 * Issue 482: shells are on Terminals (/terminals); New terminal is the
 * page's own button (#tm-new), no longer one in the shell's bar.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY
 * (no real shell runs), in Chromium and WebKit. DEN_PW_WS: Den's own
 * Playwright server instead of a local browser. DEN_SKIP_BROWSER_TESTS=1
 * skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const errors: string[] = [];

describe.each(["chromium", "webkit"] as const)("issue 448 in %s", (name) => {
  let browser: Browser | null = null;
  let s: AgentsPageServer | null = null;
  let latest = "";

  beforeAll(async () => {
    try {
      const pw = await import("playwright");
      const kind = pw[name];
      browser = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
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
    await closeBrowserSuite({ browsers: [browser], servers: [s] });
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
    p.on("pageerror", (e) => {
      if (leaving.has(p) && refusedOwnFetch(e.message)) return;
      errors.push(`${name}: ${e.message}`);
    });
    // The next page is in: the one before it starts nothing more.
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) leaving.delete(p);
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, path));
    return p;
  }

  /** The pane with the keyboard: its session id, or null. */
  const keyed = (p: Page) =>
    p.evaluate(
      () =>
        (document.activeElement?.closest(".pane") as HTMLElement | null)
          ?.dataset.id ?? null,
    );

  /**
   * WebKit refuses a fetch a page starts after a click has begun loading
   * the next page, and reports it as a page error ("Fetch API cannot load
   * <url> due to access control checks."). The page's polls (the rail's
   * helpers count first, 1.5 s after load) run on timers, so one can start
   * in that gap. Only that message, for this server's own URL, and only
   * while the test's own click is loading the next page.
   */
  const leaving = new Set<Page>();
  const refusedOwnFetch = (msg: string) =>
    msg.endsWith(" due to access control checks.") &&
    msg.includes(`/${new URL(s!.base).host}/`);

  /** The rail's Terminal, once the page has used ?terminal=. */
  async function railTerminal(p: Page) {
    leaving.add(p);
    await p.locator('#den-rail [data-nav="terminal"]').click();
    await p.waitForURL(/terminal=1/).catch(() => {});
    await p.waitForFunction(() => !location.search.includes("terminal="));
    await p.waitForSelector(".pane[data-id] .xterm-rows");
    // The page is done with the link when a pane has the keyboard.
    await p
      .waitForFunction(
        () => Boolean(document.activeElement?.closest(".pane[data-id]")),
        null,
        { timeout: 10_000 },
      )
      .catch(() => {});
    await p.waitForTimeout(500);
  }

  const openIds = (p: Page) =>
    (new URL(p.url()).searchParams.get("open") ?? "")
      .split(",")
      .filter(Boolean);

  let first = "";
  let second = "";

  it("two clicks on the rail's Terminal give one shell, in front with the keyboard", async () => {
    if (skip()) return;
    const p = await open("/services?ws=north");
    const before = s!.made.length;
    await railTerminal(p);
    expect(s!.made.length).toBe(before + 1);
    first = openIds(p)[0] ?? "";
    expect(first).toBeTruthy();
    // Clause 1: the second click opens that shell again, no new session.
    await railTerminal(p);
    expect(s!.made.length).toBe(before + 1);
    expect(openIds(p)).toEqual([first]);
    expect(await keyed(p)).toBe(first);
    expect(await p.locator(`.pane[data-id="${first}"]`).isVisible()).toBe(true);
  }, 120_000);

  it("New terminal on the page starts another one", async () => {
    if (skip() || !first) return;
    const p = await open(`/terminals?ws=north&open=${first}`);
    await p.waitForSelector(`.pane[data-id="${first}"]`);
    const btn = p.locator("#tm-new");
    await btn.waitFor();
    expect((await btn.textContent())?.trim()).toBe("New terminal");
    const before = s!.made.length;
    await btn.click();
    await p.waitForFunction(
      (n) =>
        (new URLSearchParams(location.search).get("open") ?? "").split(",")
          .length === n,
      2,
    );
    expect(s!.made.length).toBe(before + 1);
    second = openIds(p).find((x) => x !== first) ?? "";
    expect(second).toBeTruthy();
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("north"));
  }, 120_000);

  it("with two running, the rail opens the one used last", async () => {
    if (skip() || !first || !second) return;
    const before = s!.made.length;
    // The first one is used last: the rail opens it.
    const p = await open(`/terminals?ws=north&open=${first}`);
    await p.waitForSelector(`.pane[data-id="${first}"] .xterm-screen`);
    await p.click(`.pane[data-id="${first}"] .xterm-screen`);
    await p.waitForTimeout(300);
    await railTerminal(p);
    expect(await keyed(p)).toBe(first);
    // Now the second one: the rail opens that.
    const q = await open(`/terminals?ws=north&open=${second}`);
    await q.waitForSelector(`.pane[data-id="${second}"] .xterm-screen`);
    await q.click(`.pane[data-id="${second}"] .xterm-screen`);
    await q.waitForTimeout(300);
    await railTerminal(q);
    expect(await keyed(q)).toBe(second);
    expect(s!.made.length).toBe(before);
  }, 120_000);

  it("the second click stays in the project of the first, not the first project", async () => {
    if (skip()) return;
    const p = await open("/services?ws=south");
    const before = s!.made.length;
    await railTerminal(p);
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
    const south = openIds(p)[0] ?? "";
    expect(south).toBeTruthy();
    // The address no longer names the project: still south's shell.
    await railTerminal(p);
    expect(s!.made.length).toBe(before + 1);
    expect(await keyed(p)).toBe(south);
  }, 120_000);
});

it("no page errors", () => {
  expect(errors).toEqual([]);
});
