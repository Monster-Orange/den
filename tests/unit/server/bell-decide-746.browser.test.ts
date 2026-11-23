/**
 * Issue 746: Allow and Deny in the bell's "Needs you" row decide the held
 * write, through the working pop-up. They went through busyAction names
 * busy-den.js didn't list, so the kit threw and nothing was decided
 * (busy-names-registered.test.ts keeps every name listed).
 *
 * Real chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. The setup is the
 * approval dialog's (approval-dialog.browser.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Locator, Page } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { denAuth } from "./helpers/den-auth.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS: Den's own Playwright server instead of a local browser.
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-bellap-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 60_000 },
  );
  server = started.server;
  port = started.port;
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const skip = () => !browser;
/** The dialog is shut (a closed <dialog> is hidden, so wait on `open`). */
const closed = (p: Page) =>
  p.waitForFunction(
    () =>
      !(document.getElementById("den-ap-dlg") as HTMLDialogElement | null)
        ?.open,
    undefined,
    { timeout: 15_000 },
  );
const base = () => `http://localhost:${port}`;

/** The ask's ticket per id: what lets the asker read its own request. */
const tickets = new Map<string, string>();

/** What an MCP tool with no agent token does: ask the server to hold a write. */
async function ask(
  action: string,
  args: unknown,
  note?: string,
): Promise<string> {
  // The CLI's credential, as the MCP server sends it (mcp/api.ts).
  const r = await fetch(`${base()}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...denAuth(stateDir),
    },
    body: JSON.stringify({ action, args, ...(note ? { note } : {}) }),
  });
  expect(r.status).toBe(202);
  const a = (await r.json()) as { id: string; ticket: string };
  tickets.set(a.id, a.ticket);
  return a.id;
}
const stateOf = async (id: string) =>
  (
    (await (
      await fetch(`${base()}/api/approvals/${id}`, {
        headers: { "x-den-approval-ticket": tickets.get(id) ?? "" },
      })
    ).json()) as {
      state: string;
    }
  ).state;
const workspaces = async () =>
  Object.keys(
    (
      (await (await fetch(`${base()}/api/workspaces`)).json()) as {
        workspaces?: Record<string, unknown>;
      }
    ).workspaces ?? {},
  );

async function page(signIn: boolean): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  // A refused poll is a console error; the dialog's polling must make none.
  p.on("console", (m) => {
    if (m.type() !== "error") return;
    // A signed-out page's refused read or write (401) is expected (0.4.71):
    // only that line, and only on the signed-out page.
    if (
      !signIn &&
      m.text() ===
        "Failed to load resource: the server responded with a status of 401 (Unauthorized)"
    )
      return;
    errors.push(`console: ${m.text()}`);
  });
  if (signIn) {
    // Issue 819: first run, then approved by a signed-in browser.
    await signInPage(p, stateDir, base());
    await p.waitForFunction(
      () => localStorage.getItem("den.approveKey")?.length === 43,
    );
  }
  await p.goto(`${base()}/settings`);
  return p;
}

/** Click `which` in the row and wait for the bell's decide answer. */
async function decide(p: Page, row: Locator, which: "allow" | "deny") {
  const answered = p.waitForResponse(
    (r) => r.url().includes("/decide") && r.request().method() === "POST",
    { timeout: 15_000 },
  );
  await row.locator(`[data-bell="${which}"]`).click();
  expect((await answered).status()).toBe(200);
}

/** Put off the Allow pop-up, then open the bell at the request's row. */
async function bellRow(p: Page, id: string) {
  await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
  await p.click("#den-ap-later");
  await closed(p);
  await p.click("#den-bell");
  const row = p.locator(`[data-ap-row="${id}"]`);
  await row.waitFor({ timeout: 15_000 });
  return row;
}

describe("the bell's Allow and Deny (issue 746)", () => {
  it("Allow in the bell runs the held write once", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask("workspace_create", { name: "bellweb" });
    const row = await bellRow(p, id);
    await decide(p, row, "allow");
    expect(await stateOf(id)).toBe("done");
    expect(await workspaces()).toContain("bellweb");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("Deny in the bell runs nothing", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask("workspace_create", { name: "bellnope" });
    const row = await bellRow(p, id);
    await decide(p, row, "deny");
    expect(await stateOf(id)).toBe("denied");
    expect(await workspaces()).not.toContain("bellnope");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);
});
