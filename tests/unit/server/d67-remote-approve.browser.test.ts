/**
 * D67: approving from another computer, all in browsers. No terminal, no
 * command, no ssh.
 *
 *  - A browser that isn't signed in (through the edge, a browser Den
 *    can't place) shows a code. A browser signed in to Den (here on the
 *    Den machine) asks "Allow this computer?" with the same code. Allow
 *    there signs the first one in by itself.
 *  - A held write waits. A signed-in browser without the approval key sees
 *    the banner with a Sign in button, not a command. Sign in shows the
 *    signed-out page with a code, even though it has a session. Allowed
 *    from the other browser, it comes back to the page it was on, and the
 *    approval dialog opens there. Allow runs the write.
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
const EDGE = "den.acme.localhost";
let browser: Browser | null = null;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({
      args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`],
    });
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d67-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  tls: none",
      "",
    ].join("\n"),
  );
  // Sign in with GitHub off: the code is the only way in.
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    'web:\n  github_client_id: ""\n',
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
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
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
const local = () => `http://localhost:${port}`;
const edge = () => `http://${EDGE}:${port}`;

async function open(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  return p;
}

/** What an MCP tool with no agent token does: ask the server to hold a write. */
async function ask(action: string, args: unknown): Promise<string> {
  const s = (await (
    await fetch(`${local()}/api/session`, {
      headers: { "sec-fetch-site": "same-origin" },
    })
  ).json()) as { csrf?: string };
  const r = await fetch(`${local()}/api/approvals`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: local(),
      "x-den-csrf": String(s.csrf ?? ""),
    },
    body: JSON.stringify({ action, args }),
  });
  expect(r.status).toBe(202);
  return ((await r.json()) as { id: string }).id;
}

const workspaces = async () =>
  Object.keys(
    (
      (await (await fetch(`${local()}/api/workspaces`)).json()) as {
        workspaces?: Record<string, unknown>;
      }
    ).workspaces ?? {},
  );

/** The other browser's pop-up shows `code`; Allow it there. */
async function allowFrom(a: Page, code: string): Promise<void> {
  await a.waitForSelector("#den-pair-dlg[open]", { timeout: 15_000 });
  expect((await a.textContent("#den-pair-dlg-code"))?.trim()).toBe(code);
  expect(await a.textContent("#den-pair-h")).toBe("Allow this computer?");
  await a.click("#den-pair-allow");
  await a.waitForFunction(
    () =>
      !(document.getElementById("den-pair-dlg") as HTMLDialogElement | null)
        ?.open,
  );
}

/** The signed-out page's code: the browser way first, commands folded. */
async function codeOn(b: Page): Promise<string> {
  await b.waitForSelector("#den-pair-code", { timeout: 15_000 });
  expect(await b.isVisible("#den-pair-browser")).toBe(true);
  expect(await b.isVisible("#den-pair-cmd")).toBe(false);
  return ((await b.textContent("#den-pair-code")) ?? "").trim();
}

describe("D67: approve from another computer, in browsers only", () => {
  it("a signed-in browser allows the other one in, then its held write", async () => {
    if (skip()) return;
    // A: signed in on the Den machine.
    const a = await open();
    await a.goto(claimLink(local(), mintClaimCode(readWebSecret(stateDir)!)));
    await a.waitForFunction(
      () => localStorage.getItem("den.approveKey")?.length === 43,
    );
    await a.goto(`${local()}/settings`);

    // B: another computer, not signed in.
    const b = await open();
    const r = await b.goto(`${edge()}/settings`);
    expect(r?.status()).toBe(401);
    const first = await codeOn(b);
    expect(first).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
    await allowFrom(a, first);
    await b.waitForURL(`${edge()}/settings`, { timeout: 15_000 });
    await b.waitForFunction(
      () => localStorage.getItem("den.approveKey")?.length === 43,
    );

    // B loses its approval key (another tab, cleared storage): signed in,
    // but it can't see what waits.
    // (Navigated first: the landing page may still be settling.)
    await b.goto(`${edge()}/settings?tab=access#top`);
    await b.evaluate(() => localStorage.removeItem("den.approveKey"));
    await b.reload();
    const id = await ask("workspace_create", { name: "far" });
    // A shows the approval too; Later there, as if no one is at it.
    await a.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    await a.click("#den-ap-later");

    const banner = '[data-banner="approvals"]';
    await b.waitForSelector(banner, { timeout: 15_000 });
    const says = (await b.textContent(banner)) ?? "";
    expect(says).toMatch(/sign in on this browser/i);
    // No command to run anywhere.
    expect(says).not.toMatch(/web login|web approve|\bden\b /);
    await b.click(`${banner} button`);
    await b.waitForURL(/\/signin\?again=1/, { timeout: 15_000 });
    const second = await codeOn(b);
    expect(second).not.toBe(first);
    await allowFrom(a, second);

    // Back where it was, and the approval dialog opens there.
    await b.waitForURL(`${edge()}/settings?tab=access#top`, {
      timeout: 15_000,
    });
    await b.waitForSelector("#den-ap-dlg[open]", { timeout: 15_000 });
    expect(await b.textContent("#den-ap-what")).toBe(
      'Create the project "far"',
    );
    await b.click("#den-ap-allow");
    await b.waitForFunction(
      () =>
        !(document.getElementById("den-ap-dlg") as HTMLDialogElement | null)
          ?.open,
      undefined,
      { timeout: 15_000 },
    );
    expect(await workspaces()).toContain("far");
    expect(id).toBeTruthy();
    await a.context().close();
    await b.context().close();
  }, 120_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
