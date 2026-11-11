/**
 * SEC-2a in a real browser, with a fake GitHub on localhost (never
 * github.com):
 *  - the edge's signed-out page (a browser Den can't place) has Sign in
 *    with GitHub: one click shows the code and github.com/login/device; once
 *    the owner approves, the page reloads signed in. Another account is
 *    refused by name;
 *  - Settings › Access on localhost: the owner, the linked devices with
 *    Revoke, and Pair a device (a QR code and the link for the edge).
 *
 * DEN_SEC2_SHOTS=<dir> also saves screenshots (light, dark, 390 px) of each.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No code
 * or link is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import { claimLink, mintClaimCode } from "../../../src/shared/claim-code.js";
import { readWebSecret } from "../../../src/shared/web-secret.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import { writeWebOwner } from "../../../src/shared/web-owner.js";
import { startDenServer, stopServer } from "../../child-servers.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
const SHOTS = process.env.DEN_SEC2_SHOTS ?? "";
let browser: Browser | null = null;
let gh: FakeGithub;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

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
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sec2a-ui-")),
  );
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
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    "web:\n  github_client_id: Iv23liAcmeTest\n",
  );
  writeWebOwner({ id: 4242, login: "octo-owner" }, stateDir);
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
        DEN_TEST_GITHUB_URL: gh.url,
      },
    },
    { timeoutMs: 40_000 },
  );
  server = started.server;
  port = started.port;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await stopServer(server);
  await gh?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const skip = () => !browser;
const lastCode = () => gh.codes[gh.codes.length - 1].userCode;

/** Screenshots of `p` in light, dark and at 390 px, when DEN_SEC2_SHOTS is set. */
async function shots(p: Page, name: string, ready: () => Promise<unknown>) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const [mode, width] of [
    ["light", 1280],
    ["dark", 1280],
    ["light", 390],
  ] as const) {
    await p.emulateMedia({ colorScheme: mode });
    // The signed-out page sets data-mode once, at load: follow the switch.
    await p.evaluate((m) => (document.documentElement.dataset.mode = m), mode);
    await p.setViewportSize({ width, height: width === 390 ? 1600 : 1000 });
    await ready();
    // Let a resize's rail/drawer transition finish first.
    await p.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished)),
    );
    await p.screenshot({
      path: path.join(SHOTS, `${name}-${width === 390 ? "390" : mode}.png`),
      fullPage: true,
    });
  }
  await p.emulateMedia({ colorScheme: "light" });
  await p.setViewportSize({ width: 1280, height: 1000 });
}

async function edgePage(): Promise<{ ctx: BrowserContext; p: Page }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 1000 },
  });
  const p = await ctx.newPage();
  const r = await p.goto(`http://${EDGE}:${port}/`);
  expect(r?.status()).toBe(401);
  await p.waitForSelector("#den-gh-start");
  return { ctx, p };
}

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

describe("Sign in with GitHub on the edge's signed-out page", () => {
  it("shows the code and github.com/login/device; the owner's approval reloads the page signed in", async () => {
    if (skip()) return;
    const { ctx, p } = await edgePage();
    expect((await p.textContent("#den-gh-start"))?.trim()).toBe(
      "Sign in with GitHub",
    );
    await shots(p, "signed-out", () => p.waitForSelector("#den-gh-start"));
    await p.click("#den-gh-start");
    await p.waitForSelector("#den-gh-code");
    expect((await p.textContent("#den-gh-code"))?.trim() === lastCode()).toBe(
      true,
    );
    expect(await p.getAttribute("#den-gh-open", "href")).toBe(
      "https://github.com/login/device",
    );
    await shots(p, "signed-out-code", () => p.waitForSelector("#den-gh-code"));
    gh.approve(lastCode(), { id: 4242, login: "octo-owner" });
    await p.waitForFunction(
      () => !document.querySelector("#den-signin"),
      null,
      {
        timeout: 20_000,
      },
    );
    const signedIn = await p.evaluate(async () => {
      const r = await fetch("/api/session", { cache: "no-store" });
      return ((await r.json()) as { signedIn?: boolean }).signedIn === true;
    });
    expect(signedIn).toBe(true);
    // The rail's identity chip names the GitHub account.
    await p.waitForSelector("#den-ident");
    expect([
      (await p.textContent("#den-ident .den-lbl"))?.trim(),
      await p.getAttribute("#den-ident", "data-ident"),
    ]).toEqual(["@octo-owner", "github"]);
    await ctx.close();
  }, 90_000);

  it("another account is refused by name, and can start again", async () => {
    if (skip()) return;
    const { ctx, p } = await edgePage();
    await p.click("#den-gh-start");
    await p.waitForSelector("#den-gh-code");
    gh.approve(lastCode(), { id: 777, login: "someone-else" });
    await p.waitForSelector(".den-gh-err", { timeout: 20_000 });
    expect((await p.textContent(".den-gh-err"))?.trim()).toBe(
      "@someone-else isn't the owner of this Den. Only the owner's account can use Sign in with GitHub. Use Approve this computer instead.",
    );
    expect((await p.textContent("#den-gh-start"))?.trim()).toBe("Start again");
    expect(await p.isVisible("#den-gh-start")).toBe(true);
    await ctx.close();
  }, 90_000);
});

describe("Settings › Access", () => {
  it("shows the owner, the linked devices with Revoke, and Pair a device's QR code and link", async () => {
    if (skip()) return;
    // A device to list: a browser signs in with GitHub on the edge first.
    const edge = await edgePage();
    await edge.p.click("#den-gh-start");
    await edge.p.waitForSelector("#den-gh-code");
    gh.approve(lastCode(), { id: 4242, login: "octo-owner" });
    await edge.p.waitForFunction(() => !document.querySelector("#den-signin"));
    await edge.ctx.close();

    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 1000 },
    });
    const p = await ctx.newPage();
    await claimIn(p);
    await p.goto(`http://localhost:${port}/settings#access`);
    // A brand-new Den never opens What's new: it marks it seen (ON-6).
    await p.waitForFunction(() =>
      Object.keys(localStorage).some((k) => k.endsWith("-changelog-seen")),
    );
    expect(await p.$("#cl-overlay.open")).toBeNull();
    await p.waitForSelector("#set-owner");
    expect((await p.textContent("#set-owner"))?.replace(/\s+/g, " ")).toBe(
      "Owner: @octo-owner (github:4242)",
    );
    await p.waitForSelector(".set-device");
    const before = await p.locator(".set-device").count();
    expect(before).toBeGreaterThanOrEqual(1);
    const rows = await p.locator(".set-device").allTextContents();
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Chrome on \w+.*signed in with GitHub \(@octo-owner\) · created just now · from .* · last seen just now/,
        ),
        // 0.4.12: this browser, signed in with the setup link, with Revoke.
        expect.stringMatching(
          /This device.*claimed with a setup link · created just now.*Revoke/,
        ),
      ]),
    );
    const section = p.locator("#setting-access-owner");
    const access = () =>
      p
        .waitForSelector(".set-device")
        .then(() => section.scrollIntoViewIfNeeded());
    await shots(p, "settings-access", access);

    await p.click("#set-pair-go");
    await p.waitForSelector("#set-pair-qr svg");
    const link = await p.getAttribute("#set-pair-link", "href");
    expect(link?.startsWith(`http://${EDGE}/auth?c=`)).toBe(true);
    expect(await p.textContent("#set-pair-left")).toMatch(
      /^Expires in \d+ s\.$/,
    );
    await shots(p, "pair-a-device", async () => {
      await p.waitForSelector("#set-pair-qr svg");
      await p.locator("#set-pair-qr").scrollIntoViewIfNeeded();
    });

    await p.locator("[data-revoke]").first().click();
    await p.waitForFunction(
      (n) => document.querySelectorAll(".set-device").length < n,
      before,
      { timeout: 20_000 },
    );
    await ctx.close();
  }, 120_000);
});
