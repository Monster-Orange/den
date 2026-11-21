/**
 * Issue 133: the confirm actions on the Projects and Services pages send
 * their request through the working pop-up (denShell.busyAction): Delete
 * project and Remove service. Their answer is held here until the pop-up
 * shows (a slow answer), so no wait is judged by the clock: the pop-up is
 * open and working, the request carries the pop-up's request id (what Try
 * again resends), and it closes once the answer comes.
 *
 * The real server and pages; the DELETE itself is answered here, so
 * nothing is deleted. Invented names only. DEN_PW_WS uses Den's own
 * Playwright server; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
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
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

/** The newest version in the server's changelog (What's new's). */
async function newestVersion(): Promise<string> {
  const r = await fetch(`${s!.base}/api/changelog`, {
    headers: denAuth(s!.stateDir),
  });
  const list = (await r.json()) as { version?: string }[];
  const v = list[0]?.version;
  if (!v) throw new Error("the changelog has no version");
  return v;
}

async function page(at: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  // What's new stays shut: the newest version counts as seen. The page
  // opens it unless the seen version equals the newest one exactly, so a
  // made-up version would not do.
  await ctx.addInitScript(
    (v) => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
      } catch {
        /* none */
      }
    },
    await newestVersion(),
  );
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, at));
  await p.waitForFunction(
    () =>
      !!(window as { denShell?: unknown }).denShell &&
      typeof (window as { deleteWorkspace?: unknown }).deleteWorkspace ===
        "function",
  );
  return p;
}

interface Held {
  /** The held request's X-Den-Request-Id ("" when it had none). */
  id: Promise<string>;
  /** Answer it (200, ok). */
  answer(): void;
}

/** Hold `method url` (path) until answer(); every other request goes on. */
async function hold(p: Page, method: string, pathname: string): Promise<Held> {
  let release: () => void = () => {};
  const go = new Promise<void>((r) => (release = r));
  let seen: (id: string) => void = () => {};
  const id = new Promise<string>((r) => (seen = r));
  await p.route(
    (u) => u.pathname === pathname,
    async (r: Route) => {
      if (r.request().method() !== method) return r.fallback();
      seen(r.request().headers()["x-den-request-id"] ?? "");
      await go;
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    },
  );
  return { id, answer: release };
}

/**
 * Answer each shared confirm (askConfirm: its own data-dk-kind="confirm"),
 * the first with OK, every later one Cancel, until `done`. Waits for the
 * confirm to open and to go, never for time; any other pop-up is never
 * touched.
 */
async function confirmFirst(p: Page, done: Promise<unknown>): Promise<void> {
  const ask = p.locator('dialog[open][data-dk-kind="confirm"]');
  let answer = "ok";
  for (;;) {
    const opened = ask
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true);
    // Once done, the wait still pending ends with the page: nothing to see.
    opened.catch(() => {});
    if (!(await Promise.race([opened, done.then(() => false)]))) return;
    const id = await ask.getAttribute("id");
    const one = p.locator(`dialog[id="${id}"]`);
    await one.locator(`[data-dk="${answer}"]`).click();
    await one.waitFor({ state: "detached", timeout: 20_000 });
    answer = "cancel";
  }
}

/** The working pop-up shows while the answer is held, then closes. */
async function expectWorking(p: Page, held: Held): Promise<void> {
  const id = await held.id;
  try {
    // The pop-up's request id: Try again resends it.
    expect(id).not.toBe("");
    const dlg = p.locator('den-busy dialog[open][data-state="working"]');
    await dlg.waitFor({ state: "visible", timeout: 20_000 });
    expect(await dlg.getByRole("progressbar").count()).toBe(1);
  } finally {
    held.answer();
  }
  await p.locator("den-busy dialog[open]").waitFor({
    state: "detached",
    timeout: 20_000,
  });
}

describe("issue 133: confirm actions go through the working pop-up", () => {
  it("Projects page: Delete project, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/local-dev?ws=south");
    const held = await hold(p, "DELETE", "/api/workspaces");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            deleteWorkspace(e: Event, n: string): Promise<void>;
          }
        ).deleteWorkspace(new Event("click"), "south"),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    const sent = held.id.then(() => true);
    await confirmFirst(p, sent);
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Projects page: Remove service, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/local-dev?ws=north");
    const held = await hold(p, "DELETE", "/api/workspaces/services");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            removeService(w: string, a: string): Promise<void>;
          }
        ).removeService("north", "notes"),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await confirmFirst(
      p,
      held.id.then(() => true),
    );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Services page: Delete project, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/services");
    const held = await hold(p, "DELETE", "/api/workspaces");
    const run = p
      .evaluate(() =>
        (
          window as unknown as { deleteWorkspace(): Promise<void> }
        ).deleteWorkspace(),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await confirmFirst(
      p,
      held.id.then(() => true),
    );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Services page: Remove service, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/services");
    const held = await hold(p, "DELETE", "/api/workspaces/services");
    const run = p
      .evaluate(() =>
        (
          window as unknown as { removeService(a: string): Promise<void> }
        ).removeService("notes"),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
