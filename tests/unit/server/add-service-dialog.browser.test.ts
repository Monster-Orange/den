/**
 * Issue 806: Add Service is drawn by the kit's dialog frame (dialogHtml,
 * mountDialog through /dialog-den.js), as every other pop-up is, and keeps
 * what it did before:
 *
 *   - it opens from "+ Add repo" as a modal, its search field focused, and
 *     Report sits in its footer;
 *   - choose: a local repo, picked from its list (the search narrows it),
 *     then Add sends it and the dialog closes;
 *   - fill: a GitHub repo, then its settings (Managed, a branch, a new
 *     branch), then Add sends them and the dialog closes;
 *   - Tab stays inside it; Esc closes it, adds nothing, and focus goes
 *     back to "+ Add repo".
 *
 * The real page and server on the demo distribution; the repo lists and
 * the add itself are answered here, so nothing is cloned or written.
 * Invented names only. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
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
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const DLG = "dialog.dk-dlg#add-svc-dlg";
const OPEN_BTN = 'button.add-svc-open-btn[onclick*="openAddSvcModal"]';

/** The project page for north, with the lists answered and adds recorded. */
async function page(): Promise<{ p: Page; added: Record<string, unknown>[] }> {
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
  const added: Record<string, unknown>[] = [];
  await p.route("**/api/workspaces/available-repos*", (r) =>
    r.fulfill({
      json: [
        {
          name: "lamp",
          relPath: "code/lamp",
          absPath: "/srv/code/lamp",
          source: "local",
        },
        {
          name: "kettle",
          relPath: "code/kettle",
          absPath: "/srv/code/kettle",
          source: "local",
        },
      ],
    }),
  );
  await p.route("**/api/github/repos*", (r) =>
    r.fulfill({
      json: [
        {
          name: "widgets",
          nameWithOwner: "example/widgets",
          hasDen: true,
          defaultBranch: "main",
        },
      ],
    }),
  );
  await p.route("**/api/github/branches*", (r) =>
    r.fulfill({ json: ["main", "dev"] }),
  );
  await p.route("**/api/workspaces/services", (r) => {
    if (r.request().method() !== "POST") return r.continue();
    added.push(r.request().postDataJSON() as Record<string, unknown>);
    return r.fulfill({ json: {} });
  });
  const listed = p.waitForResponse((r) =>
    r.url().includes("/api/workspaces/available-repos"),
  );
  await p.goto(signInUrl(s!.stateDir, s!.base, "/local-dev?ws=north"));
  await listed;
  await p.waitForSelector(OPEN_BTN);
  await p.waitForTimeout(300);
  return { p, added };
}

async function openIt(p: Page): Promise<void> {
  await p.click(OPEN_BTN);
  await p.waitForSelector(`${DLG}[open]`);
}

describe("issue 806: Add Service is the kit's dialog", () => {
  it("opens as a modal frame: its field focused, Report in its footer, its words", async () => {
    if (!browser) return;
    const { p } = await page();
    await openIt(p);
    const got = await p.evaluate((sel) => {
      const d = document.querySelector(sel) as HTMLDialogElement;
      return {
        modal: d.matches(":modal"),
        panel: d.classList.contains("dk-panel"),
        focused: document.activeElement?.id ?? "",
        report: !!d.querySelector(".dk-ft [data-den-report]"),
        title: d.querySelector(".dk-hd h2")?.textContent ?? "",
        named: d.getAttribute("aria-labelledby") ?? "",
        oldLayer: !!document.querySelector(".add-svc-backdrop"),
      };
    }, DLG);
    expect(got).toEqual({
      modal: true,
      panel: true,
      focused: "add-svc-global-search",
      report: true,
      title: "Add Service — north",
      named: "add-svc-dlg-h",
      oldLayer: false,
    });
    await p.context().close();
  }, 60_000);

  it("choose: a local repo, narrowed by the search, then Add", async () => {
    if (!browser) return;
    const { p, added } = await page();
    await openIt(p);
    expect(await p.isDisabled("#add-svc-submit")).toBe(true);
    await p.fill("#add-svc-global-search", "kett");
    const rows = p.locator(`${DLG} #add-svc-local-list .add-svc-row`);
    expect(await rows.allTextContents()).toEqual([
      expect.stringContaining("kettle"),
    ]);
    await rows.first().click();
    expect(await p.isDisabled("#add-svc-submit")).toBe(false);
    await p.click("#add-svc-submit");
    await p.waitForSelector(DLG, { state: "detached" });
    expect(added).toEqual([
      {
        workspace: "north",
        address: "code/kettle",
        mode: "dev-managed",
        linkedPath: "/srv/code/kettle",
        branch: "main",
      },
    ]);
    await p.context().close();
  }, 60_000);

  it("fill: a GitHub repo's settings, then Add", async () => {
    if (!browser) return;
    const { p, added } = await page();
    await openIt(p);
    await p.click("#add-svc-tab-gh");
    await p.locator(`${DLG} #add-svc-gh-list .add-svc-row`).first().click();
    await p.waitForSelector("#add-svc-gh-config:not([style*='none'])");
    await p.check('input[name="add-svc-mode"][value="managed"]');
    await p.fill("#add-svc-branch", "dev");
    await p.fill("#add-svc-newbranch", "try-lamps");
    await p.click("#add-svc-submit");
    await p.waitForSelector(DLG, { state: "detached" });
    expect(added).toEqual([
      {
        workspace: "north",
        address: "widgets",
        mode: "managed",
        ghSlug: "example/widgets",
        branch: "dev",
        newBranch: "try-lamps",
      },
    ]);
    await p.context().close();
  }, 60_000);

  it("Tab stays inside; Esc closes it, adds nothing, and focus goes back", async () => {
    if (!browser) return;
    const { p, added } = await page();
    await openIt(p);
    for (let i = 0; i < 12; i++) {
      await p.keyboard.press("Tab");
      expect(
        await p.evaluate((sel) => !!document.activeElement?.closest(sel), DLG),
      ).toBe(true);
    }
    await p.keyboard.press("Escape");
    await p.waitForSelector(DLG, { state: "detached" });
    expect(
      await p.evaluate(
        (sel) => document.activeElement === document.querySelector(sel),
        OPEN_BTN,
      ),
    ).toBe(true);
    expect(added).toEqual([]);
    // It opens again, fresh: nothing chosen, the search empty.
    await openIt(p);
    expect(await p.inputValue("#add-svc-global-search")).toBe("");
    expect(await p.isDisabled("#add-svc-submit")).toBe(true);
    await p.context().close();
  }, 60_000);
});
