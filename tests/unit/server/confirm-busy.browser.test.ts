/**
 * Issue 1054 (was 133): the confirm actions on the Projects and Services
 * pages show their wait on the button pressed, never a Working pop-up.
 * Delete project: its last dialog stays open with its Delete (or Go) held
 * until the answer, then closes. Remove service: its row's button is held.
 * The answer is held here, so no wait is judged by the clock; the request
 * still carries the kit's request id where it goes through busyAction.
 *
 * The real server and pages; the DELETE itself is answered here, so
 * nothing is deleted. Invented names only. DEN_PW_WS uses Den's own
 * Playwright server; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { signInPage } from "./helpers/signed-in.js";
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
  await signInPage(p, s!.stateDir, s!.base, at);
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
 * Issue 1054: answer each of Delete project's dialogs with its own Delete
 * (or Go), until the DELETE is sent from one: that dialog stays open with
 * its pressed button held (the kit's dots, aria-busy) and no Working
 * pop-up, then closes once the answer comes. Waits for dialogs and the
 * request, never for time.
 */
async function deleteFromLastDialog(p: Page, held: Held): Promise<void> {
  const sent = held.id.then(() => true);
  const ask = p.locator('dialog[open][data-dk-kind="confirm"]');
  for (;;) {
    // One confirm is open at a time: each step's opens as the last goes.
    await ask.waitFor({ state: "visible", timeout: 30_000 });
    const id = await ask.getAttribute("id");
    const one = p.locator(`dialog[id="${id}"]`);
    // Its main action: OK on a confirm, Go on the agents question.
    const go = one.locator('[data-dk="ok"], [data-dk="go"]');
    await go.click();
    const gone = one
      .waitFor({ state: "detached", timeout: 30_000 })
      .then(() => false);
    gone.catch(() => {});
    if (!(await Promise.race([sent, gone]))) continue;
    try {
      await p.waitForFunction(
        (dlg) =>
          document
            .querySelector(`dialog[id="${dlg}"] [aria-busy="true"]`)
            ?.matches('[data-dk="ok"], [data-dk="go"]') ?? false,
        id,
        { timeout: 20_000 },
      );
      expect(await one.getAttribute("open")).not.toBeNull();
      expect(await p.locator("den-busy dialog[open]").count()).toBe(0);
    } finally {
      held.answer();
    }
    await one.waitFor({ state: "detached", timeout: 20_000 });
    return;
  }
}

/** Answer the first shared confirm with OK (Remove service's question). */
async function confirmOk(p: Page): Promise<void> {
  const ask = p.locator('dialog[open][data-dk-kind="confirm"]');
  await ask.waitFor({ state: "visible", timeout: 30_000 });
  await ask.locator('[data-dk="ok"]').click();
}

/**
 * Issue 1054: the pressed button shows the wait on itself (aria-busy,
 * disabled) while the answer is held, with no Working pop-up; it is given
 * back once the answer comes.
 */
async function expectHeldButton(p: Page, held: Held): Promise<void> {
  try {
    expect(await held.id).not.toBe("");
    await p.waitForFunction(
      () => {
        const b = document.getElementById("cb-btn") as HTMLButtonElement | null;
        return b?.getAttribute("aria-busy") === "true" && !!b.disabled;
      },
      undefined,
      { timeout: 20_000 },
    );
    expect(await p.locator("den-busy dialog[open]").count()).toBe(0);
  } finally {
    held.answer();
  }
  await p.waitForFunction(
    () => !document.getElementById("cb-btn")?.hasAttribute("aria-busy"),
    undefined,
    { timeout: 20_000 },
  );
}

/** A button on the page to press, as the row's own Remove would be. */
async function addButton(p: Page): Promise<void> {
  await p.evaluate(() => {
    const b = document.createElement("button");
    b.id = "cb-btn";
    b.className = "den-btn";
    b.textContent = "Remove";
    document.body.append(b);
  });
}

describe("issue 1054: confirm actions show their wait on the button pressed", () => {
  it("Projects page: Delete project holds its last dialog's button, no pop-up", async () => {
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
    await deleteFromLastDialog(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Projects page: Remove service holds its button, no pop-up", async () => {
    if (skip()) return;
    const p = await page("/local-dev?ws=north");
    await addButton(p);
    const held = await hold(p, "DELETE", "/api/workspaces/services");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            removeService(w: string, a: string, b: Element): Promise<void>;
          }
        ).removeService("north", "notes", document.getElementById("cb-btn")!),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await confirmOk(p);
    await expectHeldButton(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Services page: Delete project holds its last dialog's button, no pop-up", async () => {
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
    await deleteFromLastDialog(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Services page: Remove service holds its button, no pop-up", async () => {
    if (skip()) return;
    const p = await page("/services");
    await addButton(p);
    const held = await hold(p, "DELETE", "/api/workspaces/services");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            removeService(a: string, b: Element): Promise<void>;
          }
        ).removeService("notes", document.getElementById("cb-btn")!),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await expectHeldButton(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
