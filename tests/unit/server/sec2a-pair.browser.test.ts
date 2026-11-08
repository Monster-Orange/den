/**
 * SEC-2a's signed-out page in a real browser, through the edge (a browser
 * Den can't place), with Sign in with GitHub turned off
 * (`web.github_client_id: ""`):
 *  - no Sign in with GitHub button; the page shows a code to approve this
 *    computer with, and every command on it names the machine it runs on;
 *  - a copy button says "Copied";
 *  - approval through the server's API (the CLI's bearer, as `web approve`
 *    sends it) signs the page in by itself: no reload, no link;
 *  - approval in Settings › Access › Waiting devices on localhost does too;
 *  - the countdown, with Playwright's fake clock: it runs out at 10
 *    minutes, says the code expired, and a new code is a click away.
 *
 * DEN_SEC2_SHOTS=<dir> also saves screenshots. Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No code is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import { cliPrefix } from "../../../src/shared/cli-command.js";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { spawnServer, stopServer } from "../../child-servers.js";
import { claimLink, mintClaimCode } from "../../../src/shared/claim-code.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
const SHORT = os.hostname().split(".")[0];
const USER = os.userInfo().username;
const SHOTS = process.env.DEN_SEC2_SHOTS ?? "";
const CODE_RE = /web approve ([0-9A-Z]{3}-[0-9A-Z]{3})$/;
let browser: Browser | null = null;
let tmp = "";
let root = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

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
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sec2a-pair-ui-")),
  );
  root = path.join(tmp, "dist");
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
  // An explicit empty client id turns Sign in with GitHub off (the
  // default is the Monster Orange Den app's).
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    'web:\n  github_client_id: ""\n',
  );
  port = await freePort();
  server = spawnServer(
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
        PORT: String(port),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const deadline = Date.now() + 40_000;
  for (;;) {
    try {
      if ((await fetch(`http://localhost:${port}/api/server-info`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const skip = () => !browser;
/** What every printed command starts with on this server (its PATH). */
const prefix = () =>
  cliPrefix("den", root, ENGINE, { pathEnv: process.env.PATH ?? "" });

/** The edge's signed-out page in a fresh browser; `before` runs first (a fake clock). */
async function edgePage(
  before?: (p: Page) => Promise<void>,
): Promise<{ ctx: BrowserContext; p: Page; code: string }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const p = await ctx.newPage();
  if (before) await before(p);
  const r = await p.goto(`http://${EDGE}:${port}/settings?x=1`);
  expect(r?.status()).toBe(401);
  await p.waitForSelector("#den-pair-cmd");
  const code = CODE_RE.exec((await p.textContent("#den-pair-cmd")) ?? "")?.[1];
  expect(!!code).toBe(true);
  return { ctx, p, code: code! };
}

/** POST to the server as the CLI does: its bearer, on localhost. */
async function asCli(p: string, body: unknown): Promise<number> {
  const r = await fetch(`http://localhost:${port}${p}`, {
    method: "POST",
    headers: {
      ...cliAuthHeaders(stateDir),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return r.status;
}

const signedIn = (p: Page) =>
  p.evaluate(async () => {
    const r = await fetch("/api/session", { cache: "no-store" });
    return ((await r.json()) as { signedIn?: boolean }).signedIn === true;
  });

/**
 * 0.4.12: sign a localhost browser in with a setup link (letting another
 * device in needs a signed-in browser holding its approval key).
 */
async function claimIn(page: Page): Promise<void> {
  await page.goto(
    claimLink(
      `http://localhost:${port}`,
      mintClaimCode(readWebSecret(stateDir)!),
    ),
  );
  await page.waitForFunction(
    () => localStorage.getItem("den.approveKey")?.length === 43,
  );
  if (new URL(page.url()).hash !== "")
    throw new Error("the approval key stayed in the address bar");
}

describe("the signed-out page through the edge, with an empty GitHub client id", () => {
  it("has no GitHub button; shows a code; every command names the machine it runs on", async () => {
    if (skip()) return;
    const { ctx, p } = await edgePage();
    expect(await p.locator("#den-gh-start").count()).toBe(0);
    expect(await p.locator("#den-gh").count()).toBe(0);
    expect((await p.textContent("#den-error-page h1"))?.trim()).toBe(
      "Sign in to Den",
    );
    expect((await p.textContent("#den-pair-title"))?.trim()).toBe(
      "Approve this computer",
    );
    expect(await p.textContent("#den-signin-where")).toBe(
      `You're opening Den from another computer. Den runs on ${SHORT}, so it needs to know this is you.`,
    );
    // Every command: its own copy button, and the line before it names
    // the machine (the server's, or "From this computer" for ssh).
    const lines = await p.$$eval(".den-cmd", (els) =>
      els.map((el) => ({
        id: el.querySelector("pre")?.id,
        cmd: el.querySelector("pre")?.textContent ?? "",
        says: el.previousElementSibling?.textContent ?? "",
        copy: !!el.querySelector("button[data-copy-for]"),
      })),
    );
    expect(lines.map((l) => l.id).sort()).toEqual(
      [
        "den-pair-cmd",
        "den-pair-ssh",
        "den-signin-cmd",
        "den-signin-ssh",
      ].sort(),
    );
    for (const l of lines) {
      expect([l.id, l.copy, l.says.includes(SHORT)]).toEqual([
        l.id,
        true,
        true,
      ]);
      // What runs on the server starts with what runs there.
      const remote = l.id?.endsWith("-ssh")
        ? (/'(.*)'$/.exec(l.cmd)?.[1] ?? "")
        : l.cmd;
      expect([l.id, remote.startsWith(`${prefix()} web `)]).toEqual([
        l.id,
        true,
      ]);
    }
    expect(
      lines
        .find((l) => l.id === "den-pair-ssh")
        ?.cmd.startsWith(`ssh ${USER}@${EDGE} '`),
    ).toBe(true);
    // The ssh target is a name: Open Terminal is an ssh:// link to it, as
    // the account Den runs as (SEC-2a-UX: an SSH app's own default
    // account is one nobody knows), and the note says which.
    expect(await p.getAttribute("#den-pair-term", "href")).toBe(
      `ssh://${USER}@${EDGE}`,
    );
    expect(await p.textContent("#den-pair-note")).toBe(
      `Log in with your ${SHORT} account (${USER}) and its password, or an SSH key.`,
    );
    // "Other ways" starts collapsed.
    expect(await p.isVisible("#den-signin-cmd")).toBe(false);
    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      await p.screenshot({
        path: path.join(SHOTS, "signed-out-pair.png"),
        fullPage: true,
      });
    }
    await ctx.close();
  }, 90_000);

  it("a copy button says Copied", async () => {
    if (skip()) return;
    const { ctx, p } = await edgePage();
    const btn = p.locator('button[data-copy-for="den-pair-cmd"]');
    expect((await btn.textContent())?.trim()).toBe("");
    await btn.click();
    await p.waitForFunction(
      () =>
        document.querySelector(
          'button[data-copy-for="den-pair-cmd"] .den-copied',
        )?.textContent === "Copied",
    );
    await ctx.close();
  }, 90_000);

  it("approval through the server's API signs the page in by itself, onto the page it asked for", async () => {
    if (skip()) return;
    const { ctx, p, code } = await edgePage();
    expect(await asCli("/api/web/approve", { code })).toBe(200);
    await p.waitForFunction(
      () => !document.querySelector("#den-signin"),
      null,
      {
        timeout: 20_000,
      },
    );
    expect(new URL(p.url()).pathname + new URL(p.url()).search).toBe(
      "/settings?x=1",
    );
    expect(await signedIn(p)).toBe(true);
    await ctx.close();
  }, 90_000);

  it("Approve in Settings › Access › Waiting devices on localhost signs it in too", async () => {
    if (skip()) return;
    const { ctx, p, code } = await edgePage();
    const local = await browser!.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const s = await local.newPage();
    await claimIn(s);
    await s.goto(`http://localhost:${port}/settings#access`);
    await s.waitForSelector("#cl-overlay.open");
    await s.keyboard.press("Escape");
    const row = s.locator(`.set-waiting[data-code="${code}"]`);
    await row.waitFor();
    expect(await row.textContent()).toMatch(/Chrome on \w+/);
    await row.locator("[data-approve]").click();
    await p.waitForFunction(
      () => !document.querySelector("#den-signin"),
      null,
      {
        timeout: 20_000,
      },
    );
    expect(await signedIn(p)).toBe(true);
    await local.close();
    await ctx.close();
  }, 90_000);

  it("the countdown runs out at 10 minutes (a fake clock): the code expired, and Get a new code gives another", async () => {
    if (skip()) return;
    const { ctx, p, code } = await edgePage((pg) => pg.clock.install());
    await p.waitForFunction(() =>
      /^(10:00|9:\d\d)$/.test(
        document.querySelector("#den-pair-left")?.textContent ?? "",
      ),
    );
    expect(await p.textContent("#den-pair-status")).toMatch(
      /^Waiting for approval… (10:00|9:\d\d)$/,
    );
    await p.clock.fastForward("05:00");
    expect(await p.textContent("#den-pair-left")).toMatch(/^[45]:\d\d$/);
    await p.clock.fastForward("05:01");
    await p.waitForSelector("#den-pair-ended");
    expect((await p.textContent("#den-pair-ended"))?.trim()).toBe(
      "This code expired.",
    );
    expect(await p.locator("#den-pair-cmd").count()).toBe(0);
    await p.click("#den-pair-new");
    await p.waitForSelector("#den-pair-cmd");
    const next = CODE_RE.exec(
      (await p.textContent("#den-pair-cmd")) ?? "",
    )?.[1];
    expect([!!next, next === code]).toEqual([true, false]);
    await ctx.close();
  }, 90_000);
});
