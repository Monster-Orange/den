/**
 * Issue 806: Projects' Add Service is the kit's dialog (dialogHtml and
 * mountDialog, through dialog-den.js), not a full-window pop-up of the
 * page's own, and it keeps what it did: choose a repo (Local or GitHub),
 * fill the GitHub one's mode and branches, Add, Esc, focus in and back,
 * and the Report button inside it. Its words are the page's language.
 *
 * The repos it lists and the add itself are routed here (invented names),
 * so nothing is cloned or written. The module is served as ui-assets.ts
 * lists it. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let base = "";
let server: ChildProcess;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-806-")));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    "environments: [local]\n",
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    "active: [north]\nfocus: north\nworkspaces:\n  north:\n    services:\n      kettle:\n        mode: dev-managed\n        path: /nowhere/kettle\n",
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: dist,
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
      },
    },
  );
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const LOCAL = [
  {
    name: "garden",
    relPath: "code/garden",
    absPath: "/nowhere/code/garden",
    source: "local",
    currentBranch: "main",
  },
  {
    name: "pantry",
    relPath: "code/pantry",
    absPath: "/nowhere/code/pantry",
    source: "local",
    currentBranch: "main",
  },
];
const GH = [
  {
    name: "orchard",
    nameWithOwner: "example-co/orchard",
    hasDen: true,
    isArchived: false,
    defaultBranch: "main",
  },
  {
    name: "meadow",
    nameWithOwner: "example-co/meadow",
    hasDen: false,
    isArchived: false,
    defaultBranch: "trunk",
  },
];

type Win = {
  denShell?: { api: (m: string, u: string, b?: unknown) => Promise<unknown> };
  openAddSvcModal?: (ws: string) => void;
};

const DLG = "dialog#add-svc-dlg";

/** /local-dev signed in, the repos routed, each add recorded in `adds`. */
async function open(lang = "en"): Promise<{
  p: Page;
  adds: Record<string, unknown>[];
}> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, path.join(tmp, "home"), base);
  // What's new stays shut: with no release notes there is nothing to open
  // (it opens on a version not seen yet, matched exactly, over the page).
  await ctx.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
  const adds: Record<string, unknown>[] = [];
  await ctx.route("**/api/workspaces/available-repos*", (r) =>
    r.fulfill({ json: LOCAL }),
  );
  await ctx.route("**/api/github/repos*", (r) => r.fulfill({ json: GH }));
  await ctx.route("**/api/github/branches*", (r) =>
    r.fulfill({ json: ["main", "dev"] }),
  );
  await ctx.route("**/api/workspaces/services", async (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    adds.push(r.request().postDataJSON() as Record<string, unknown>);
    await r.fulfill({ json: { ok: true } });
  });
  const p = await ctx.newPage();
  await p.goto(`${base}/settings`);
  await p.waitForFunction(() => !!(window as unknown as Win).denShell?.api);
  await p.evaluate(
    (language) =>
      (window as unknown as Win).denShell!.api("POST", "/api/settings", {
        language,
      }),
    lang,
  );
  await p.goto(`${base}/local-dev?ws=north`);
  await p.locator("[data-add-svc]").waitFor({ timeout: 20_000 });
  return { p, adds };
}

async function openDialog(p: Page): Promise<void> {
  await p.locator("[data-add-svc]").click();
  await p.locator(`${DLG}[open]`).waitFor();
}

describe("issue 806: Add Service on the kit's dialog", () => {
  it("is the kit's frame: a modal <dialog>, named, with Report inside; no page layer", async () => {
    if (!browser) return;
    const { p } = await open();
    await openDialog(p);
    const got = await p.evaluate((sel) => {
      const d = document.querySelector(sel) as HTMLDialogElement;
      const h = document.getElementById(
        d.getAttribute("aria-labelledby") || "",
      );
      return {
        kit: d.classList.contains("dk-dlg") && d.classList.contains("dk-panel"),
        modal: d.matches(":modal"),
        role: d.getAttribute("role"),
        name: h?.textContent ?? "",
        report: !!d.querySelector("[data-den-report]"),
        layer: !!document.getElementById("add-svc-backdrop"),
        focusIn: d.contains(document.activeElement),
      };
    }, DLG);
    expect(got).toEqual({
      kit: true,
      modal: true,
      role: "dialog",
      name: expect.stringContaining("north"),
      report: true,
      layer: false,
      focusIn: true,
    });
    await p.context().close();
  }, 60_000);

  it("Esc closes it, and focus goes back to the button that opened it", async () => {
    if (!browser) return;
    const { p } = await open();
    const btn = p.locator("[data-add-svc]");
    await btn.focus();
    await p.keyboard.press("Enter");
    await p.locator(`${DLG}[open]`).waitFor();
    await p.keyboard.press("Escape");
    await p.locator(`${DLG}[open]`).waitFor({ state: "detached" });
    expect(await btn.evaluate((b) => document.activeElement === b)).toBe(true);
    await p.context().close();
  }, 60_000);

  it("Local: filter, choose a repo, Add: the add is sent and the dialog closes", async () => {
    if (!browser) return;
    const { p, adds } = await open();
    await openDialog(p);
    const add = p.locator(`${DLG} [data-as="add"]`);
    expect(await add.isDisabled()).toBe(true);
    await p.fill(`${DLG} #add-svc-global-search`, "pant");
    await expectRows(p, ["pantry"]);
    await p.locator(`${DLG} [data-as-local="code/pantry"]`).click();
    expect(await add.isDisabled()).toBe(false);
    await add.click();
    await p.locator(`${DLG}[open]`).waitFor({ state: "detached" });
    expect(adds).toEqual([
      expect.objectContaining({
        workspace: "north",
        address: "code/pantry",
        mode: "dev-managed",
        linkedPath: "/nowhere/code/pantry",
      }),
    ]);
    await p.context().close();
  }, 60_000);

  it("GitHub: choose, fill mode and branches, Add: they are what's sent", async () => {
    if (!browser) return;
    const { p, adds } = await open();
    await openDialog(p);
    await p.click(`${DLG} [role="tab"][data-id="gh"]`);
    await p.locator(`${DLG} [data-as-gh="orchard"]`).click();
    await p.check(`${DLG} input[name="add-svc-mode"][value="managed"]`);
    await p.fill(`${DLG} #add-svc-branch`, "dev");
    await p.fill(`${DLG} #add-svc-newbranch`, "feat-pears");
    await p.click(`${DLG} [data-as="add"]`);
    await p.locator(`${DLG}[open]`).waitFor({ state: "detached" });
    expect(adds).toEqual([
      expect.objectContaining({
        workspace: "north",
        address: "orchard",
        mode: "managed",
        ghSlug: "example-co/orchard",
        branch: "dev",
        newBranch: "feat-pears",
      }),
    ]);
    await p.context().close();
  }, 60_000);

  it("Local and GitHub are the kit's panel tabs: → moves, keeps focus and shows the panel", async () => {
    if (!browser) return;
    const { p } = await open();
    await openDialog(p);
    const tabs = `${DLG} [data-den-tabs="panel"]`;
    await p.locator(`${tabs} [role="tab"][data-id="local"]`).focus();
    await p.keyboard.press("ArrowRight");
    const gh = p.locator(`${tabs} [role="tab"][data-id="gh"]`);
    await expect(gh.getAttribute("aria-selected")).resolves.toBe("true");
    expect(await gh.evaluate((b) => document.activeElement === b)).toBe(true);
    expect(await p.locator(`${DLG} #add-svc-panel-gh`).isHidden()).toBe(false);
    expect(await p.locator(`${DLG} #add-svc-panel-local`).isHidden()).toBe(
      true,
    );
    expect(
      await p.locator(`${tabs} [role="tablist"]`).getAttribute("aria-label"),
    ).toBeTruthy();
    await p.context().close();
  }, 60_000);

  it("a refused add says why inside the dialog, which stays open", async () => {
    if (!browser) return;
    const { p } = await open();
    await p.context().route("**/api/workspaces/services", (r) =>
      r.request().method() === "POST"
        ? r.fulfill({
            status: 409,
            json: { error: "orchard is already there" },
          })
        : r.fallback(),
    );
    await openDialog(p);
    await p.click(`${DLG} [role="tab"][data-id="gh"]`);
    await p.locator(`${DLG} [data-as-gh="orchard"]`).click();
    await p.click(`${DLG} [data-as="add"]`);
    await p
      .locator(`${DLG} #add-svc-msg`, { hasText: "already there" })
      .waitFor();
    expect(await p.locator(`${DLG}[open]`).count()).toBe(1);
    await p.context().close();
  }, 60_000);

  it("its words are the page's language (es)", async () => {
    if (!browser) return;
    const { p } = await open("es");
    await openDialog(p);
    const words = await p.evaluate((sel) => {
      const d = document.querySelector(sel)!;
      return {
        title: d.querySelector("h2")?.textContent ?? "",
        add: d.querySelector('[data-as="add"]')?.textContent ?? "",
        filter:
          (d.querySelector("#add-svc-global-search") as HTMLInputElement)
            ?.placeholder ?? "",
      };
    }, DLG);
    await p.evaluate(() =>
      (window as unknown as Win).denShell!.api("POST", "/api/settings", {
        language: "en",
      }),
    );
    expect(words.title).toMatch(/servicio/i);
    expect(words.add).not.toBe("Add");
    expect(words.filter).not.toMatch(/Filter/);
    await p.context().close();
  }, 60_000);
});

async function expectRows(p: Page, names: string[]): Promise<void> {
  const got = await p.$$eval(`${DLG} [data-as-local]`, (els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => e.querySelector("[data-as-name]")?.textContent ?? ""),
  );
  expect(got.map((s) => s.replace(/ @ .*$/, ""))).toEqual(names);
}
