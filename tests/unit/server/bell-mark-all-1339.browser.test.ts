/**
 * Issue 1339: "Mark all read" and "Clear read" in the bell, on the real
 * page. The POST is held in the test, so what the person sees while it
 * runs is checked:
 *
 *   1. After the click the button holds the kit's dots (disabled,
 *      aria-busy, its own label kept; issues 1054 and 698), and the rows
 *      show read (or are gone) before the POST answers.
 *   2. When it answers, the button comes back as it should.
 *   3. When it fails, the rows go back as they were, with an error toast.
 *   4. Either way, the kit holds no button after (heldCount 0): the bell
 *      lets each one it held go, even one it drew again meanwhile.
 *
 * Rows are picked by data-kind and data-read, buttons by data-bell.
 * DEN_HELPERS_BROWSER=webkit runs it in WebKit; DEN_PW_WS connects to a
 * Playwright server instead of a local browser. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";
/** The error the held POST answers with (a token, not a sentence). */
const ERR = "e1339-store-unwritten";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    browser = await launchBrowser(pw[engine]);
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

const skip = () => !browser;

/**
 * The store afresh: three questions, unread, and (with `read`) two more
 * already read. Filed as from Hub, so Den's own sweep keeps them.
 */
function seed(read = false): void {
  const st = new NotificationStore(s!.stateDir);
  st.remove(() => true);
  for (const name of ["asker", "brief", "third"])
    st.add({
      kind: "waiting",
      subject: `agent:${name}`,
      scope: "workspace/north",
      text: `${name}: ready?`,
      link: `/agents?project=north&agent=${name}`,
      source: "hub",
    });
  if (read)
    for (const name of ["shipper", "other"]) {
      const n = st.add({
        kind: "waiting",
        subject: `agent:${name}`,
        scope: "workspace/north",
        text: `${name}: done?`,
        source: "hub",
      });
      st.markRead({ id: n!.id });
    }
}

const ROWS = '#den-bell-pop [data-kind="waiting"][data-id]';
const UNREAD = `${ROWS}[data-read="false"]`;
const count = (p: Page, sel: string) => p.locator(sel).count();
/** Waits until `sel` matches exactly `n` elements. */
const until = (p: Page, sel: string, n: number) =>
  p.waitForFunction(
    ([q, k]) => document.querySelectorAll(q as string).length === k,
    [sel, n] as const,
  );
/**
 * How many buttons the kit holds with dots now (its heldCount), from the
 * very module the page loaded: Den stamps the URLs it serves (?v=, see
 * asset-stamp.ts), and a module is its full URL. A string, so the page
 * runs import() itself (TypeScript would rewrite it).
 */
const HELD =
  "import(performance.getEntriesByType('resource').map((e) => e.name)" +
  ".find((u) => /\\/kit\\/busy\\.js(\\?|$)/.test(u)))" +
  ".then((m) => m.heldCount())";
const held = (p: Page) => p.evaluate<number>(HELD);
/**
 * Every press lets its button go: once its answer is in, the kit holds
 * none, not even one the bell drew again meanwhile. A release is async, so
 * the page asks again every 50 ms for up to 5 s and says the last count.
 */
async function noneHeld(p: Page): Promise<void> {
  const last = await p.evaluate<number>(
    `(async () => { const end = Date.now() + 5000; let n = await ${HELD};` +
      ` while (n !== 0 && Date.now() < end) {` +
      ` await new Promise((r) => setTimeout(r, 50)); n = await ${HELD}; }` +
      ` return n; })()`,
  );
  expect(last).toBe(0);
}
/** The page's own words for an i18n key. */
const words = (p: Page, key: string) =>
  p.evaluate(
    (k) =>
      (
        window as unknown as { denShell: { t: (k: string) => string } }
      ).denShell.t(k),
    key,
  );

/** The page with its bell open, and `path`'s POST held until `release`. */
async function open(
  path: "read" | "clear",
  rows: number,
): Promise<{ p: Page; release: (ok: boolean) => Promise<void> }> {
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
  let held: Route | null = null;
  let got: () => void = () => {};
  const arrived = new Promise<void>((r) => (got = r));
  await p.route(`**/api/notifications/${path}`, (r) => {
    held = r;
    got();
  });
  await signInPage(p, s!.stateDir, s!.base, "/services");
  await p.waitForSelector("#den-bell");
  await p.locator("#den-bell").click();
  await until(p, ROWS, rows);
  return {
    p,
    release: async (ok) => {
      await arrived;
      if (ok) await held!.continue();
      else
        await held!.fulfill({ status: 500, json: { ok: false, error: ERR } });
    },
  };
}

/**
 * Issue 1524: the button is held (aria-busy and aria-disabled; issue 1434:
 * never disabled, so it keeps focus) once the click's handler has run,
 * which may be after click() returns: wait for it, never read it once.
 * By selector on every poll: the bell draws the held button anew.
 */
async function heldNow(p: Page, sel: string): Promise<void> {
  await p.waitForFunction(
    (s) => {
      const b = document.querySelector(s);
      return (
        !!b &&
        b.getAttribute("aria-busy") === "true" &&
        b.getAttribute("aria-disabled") === "true" &&
        !(b as HTMLButtonElement).disabled
      );
    },
    sel,
    { timeout: 10_000 },
  );
}

describe("Mark all read (issue 1339)", () => {
  it("busy in the button and the rows read before the POST answers; back after", async () => {
    if (skip()) return;
    seed();
    const { p, release } = await open("read", 3);
    expect(await count(p, UNREAD)).toBe(3);
    const btn = p.locator('#den-bell-pop [data-bell="all"]');
    await btn.click();
    await heldNow(p, '#den-bell-pop [data-bell="all"]');
    // The kit's dots: the held button's one aria-hidden part.
    await btn.locator('[aria-hidden="true"]').waitFor();
    // The probe sees the kit's hold: one button, this one.
    expect(await held(p)).toBe(1);
    expect((await btn.textContent())?.trim()).toBe(
      await words(p, "bell.markAll"),
    );
    // The rows show read while the POST is still held.
    expect(await count(p, UNREAD)).toBe(0);
    expect(await count(p, ROWS)).toBe(3);
    await release(true);
    await btn.waitFor({ state: "detached" });
    await noneHeld(p);
    expect(await count(p, UNREAD)).toBe(0);
    expect(
      new NotificationStore(s!.stateDir).list().filter((n) => !n.read).length,
    ).toBe(0);
    await p.context().close();
  }, 60_000);

  it("a failed POST puts the rows back unread, with an error toast", async () => {
    if (skip()) return;
    seed();
    const { p, release } = await open("read", 3);
    const btn = p.locator('#den-bell-pop [data-bell="all"]');
    await btn.click();
    expect(await count(p, UNREAD)).toBe(0);
    await release(false);
    const alert = p.getByRole("alert").filter({ hasText: ERR });
    await alert.waitFor();
    await until(p, UNREAD, 3);
    expect(await btn.isDisabled()).toBe(false);
    expect(await btn.getAttribute("aria-busy")).toBeNull();
    // Issue 1434: nor left aria-disabled after the error.
    expect(await btn.getAttribute("aria-disabled")).toBeNull();
    expect((await btn.textContent())?.trim()).toBe(
      await words(p, "bell.markAll"),
    );
    await noneHeld(p);
    await p.context().close();
  }, 60_000);
});

describe("Clear read (issue 1339)", () => {
  it("busy in the button and the read rows gone before the POST answers", async () => {
    if (skip()) return;
    seed(true);
    const { p, release } = await open("clear", 5);
    const btn = p.locator('#den-bell-pop [data-bell="clear"]');
    await btn.click();
    await heldNow(p, '#den-bell-pop [data-bell="clear"]');
    // The kit's dots: the held button's one aria-hidden part.
    await btn.locator('[aria-hidden="true"]').waitFor();
    // The probe sees the kit's hold: one button, this one.
    expect(await held(p)).toBe(1);
    expect((await btn.textContent())?.trim()).toBe(
      await words(p, "bell.clearRead"),
    );
    expect(await count(p, ROWS)).toBe(3);
    await release(true);
    await btn.waitFor({ state: "detached" });
    await noneHeld(p);
    expect(new NotificationStore(s!.stateDir).list().length).toBe(3);
    await p.context().close();
  }, 60_000);

  it("a failed POST puts the read rows back, with an error toast", async () => {
    if (skip()) return;
    seed(true);
    const { p, release } = await open("clear", 5);
    await p.locator('#den-bell-pop [data-bell="clear"]').click();
    expect(await count(p, ROWS)).toBe(3);
    await release(false);
    await p.getByRole("alert").filter({ hasText: ERR }).waitFor();
    await until(p, ROWS, 5);
    await noneHeld(p);
    await p.context().close();
  }, 60_000);
});
