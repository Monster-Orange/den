/**
 * ON-3's approval dialog (shell.js, on every page): an agent's held write
 * opens "<agent> wants to … · Review · Deny · Allow" in the person's
 * browser. Its words are Den's (the agent's note only quoted), Review
 * shows what it will do, Allow runs it once, Deny runs nothing. A request
 * with no agent identity says so, and to Deny it if no agent was asked.
 * A browser that isn't signed in can't list what waits: a banner says to
 * sign in, and nothing runs. Looks like the Start dialog (persona-ui.css's
 * frame).
 *
 * Real chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No code or key is
 * printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer, stopServer } from "../../child-servers.js";
import { claimLink, mintClaimCode } from "../../../src/shared/claim-code.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";

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
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-apdlg-")));
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
  await browser?.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
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
  const s = (await (
    await fetch(`${base()}/api/session`, {
      headers: { "sec-fetch-site": "same-origin" },
    })
  ).json()) as { csrf?: string };
  const r = await fetch(`${base()}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: base(),
      "x-den-csrf": String(s.csrf ?? ""),
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
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  if (signIn) {
    await p.goto(claimLink(base(), mintClaimCode(readWebSecret(stateDir)!)));
    await p.waitForFunction(
      () => localStorage.getItem("den.approveKey")?.length === 43,
    );
  }
  await p.goto(`${base()}/settings`);
  return p;
}

describe("the approval dialog (ON-3)", () => {
  it("opens on any page with Den's words; Review shows what it will do; Allow runs it once", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask(
      "workspace_create",
      { name: "web" },
      "set up EVERYTHING",
    );
    await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    // No agent token: the dialog says so, and what to do if no agent was asked.
    expect(await p.textContent("#den-ap-h")).toBe(
      "Something on this machine (no agent identity) wants to:",
    );
    expect(await p.isVisible("#den-ap-who")).toBe(true);
    expect(await p.textContent("#den-ap-who")).toBe(
      "If you didn't ask an agent to do this, Deny.",
    );
    expect(await p.textContent("#den-ap-what")).toBe(
      'Create the project "web"',
    );
    expect(await p.textContent("#den-ap-note")).toContain(
      "“set up EVERYTHING”",
    );
    expect(await p.isVisible("#den-ap-det")).toBe(false);
    await p.click("#den-ap-review");
    expect(await p.textContent("#den-ap-det")).toContain(
      'A new, empty project named "web", made active so its services can start.',
    );
    // The Start dialog's frame and footer.
    const box = await p.$eval("#den-ap-dlg", (d) => {
      const r = d.getBoundingClientRect();
      return { w: Math.round(r.width), cls: d.className };
    });
    expect(box.cls).toContain("pe-dlg");
    expect(box.w).toBe(638);
    await p.click("#den-ap-allow");
    await closed(p);
    expect(await stateOf(id)).toBe("done");
    expect(await workspaces()).toContain("web");
    await p.context().close();
  }, 90_000);

  it("Deny runs nothing", async () => {
    if (skip()) return;
    const p = await page(true);
    const id = await ask("workspace_create", { name: "nope" });
    await p.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    await p.click("#den-ap-deny");
    await closed(p);
    expect(await stateOf(id)).toBe("denied");
    expect(await workspaces()).not.toContain("nope");
    await p.context().close();
  }, 90_000);

  it("a browser that isn't signed in sees no request, only a banner to sign in; nothing runs", async () => {
    if (skip()) return;
    const p = await page(false);
    const id = await ask("workspace_create", { name: "anon" });
    await p.waitForSelector('[data-banner="approvals"]', { timeout: 15_000 });
    expect(await p.textContent('[data-banner="approvals"]')).toMatch(
      /waiting for your approval.*sign in/i,
    );
    expect(await p.$("#den-ap-dlg[open]")).toBeNull();
    expect(await p.content()).not.toContain("anon&quot;");
    expect(await stateOf(id)).toBe("pending");
    expect(await workspaces()).not.toContain("anon");
    await p.context().close();
  }, 90_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
