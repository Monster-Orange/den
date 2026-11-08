/**
 * SEC-2a-UX in a real browser: the edge's signed-out page explains Sign in
 * with GitHub the same way in every state.
 *  - Three steps: link the owner on the machine, enter the code at
 *    github.com/login/device, come back and press Sign in with GitHub.
 *  - No owner yet: step 1 is to do (with the command), and there is no
 *    button. An owner: step 1 is done ("Owner: @login"), and the button
 *    is there.
 *  - Below them: only the owner's account signs in this way, and a Learn
 *    more link to the docs.
 *  - With no owner, the page watches: once the owner is linked on the
 *    machine, step 1 shows done and the button appears, with no reload.
 * At 1440 and 390 px, nothing is wider than the window.
 * DEN_SEC2_SHOTS=<dir> also saves a screenshot of each. Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. A fake GitHub on localhost
 * (never github.com); no code or link is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { clearWebOwner, writeWebOwner } from "../../../src/shared/web-owner.js";
import { spawnServer, stopServer } from "../../child-servers.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";

const ENGINE = path.resolve(__dirname, "../../..");
const SHOTS = process.env.DEN_SEC2_SHOTS ?? "";
const EDGE = "den.acme.localhost";
const LEARN =
  "https://github.com/Monster-Orange/den/blob/main/docs/distributions.md#signing-in-with-github";
let browser: Browser | null = null;
let gh: FakeGithub;
let tmp = "";
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
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sec2a-steps-")),
  );
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
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
    "web:\n  github_client_id: Iv23liAcmeTest\n  machine_name: Studio\n",
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
        DEN_TEST_GITHUB_URL: gh.url,
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
  await stopServer(server);
  await gh?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const skip = () => !browser;
const text = async (p: Page, sel: string) =>
  ((await p.textContent(sel)) ?? "").replace(/\s+/g, " ").trim();

/** The signed-out page on the edge, at `width`. */
async function signedOut(width: number): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 1000 },
  });
  const p = await ctx.newPage();
  const r = await p.goto(`http://${EDGE}:${port}/`);
  expect(r?.status()).toBe(401);
  await p.waitForSelector("#den-gh-steps");
  return p;
}

/** A full-page screenshot, when DEN_SEC2_SHOTS is set. */
async function shot(p: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await p.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/** Nothing on the page reaches past the window's right edge. */
async function fits(p: Page): Promise<void> {
  const over = await p.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > w) out.push("page");
    for (const el of document.querySelectorAll("#den-signin *")) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > w + 0.5)
        out.push(`${el.tagName.toLowerCase()}#${el.id}.${el.className}`);
    }
    return out;
  });
  expect(over).toEqual([]);
}

/** The three steps, the note and Learn more: the same in every state. */
async function threeSteps(p: Page): Promise<void> {
  expect(await p.locator("#den-gh-steps > li").count()).toBe(3);
  expect(await text(p, "#den-gh-step2")).toBe(
    "It shows a code. Enter it at github.com/login/device and approve.",
  );
  expect(await text(p, "#den-gh-step3")).toBe(
    "Then come back here and press Sign in with GitHub, with the same GitHub account.",
  );
  expect(await text(p, "#den-gh-only")).toBe(
    "Only the owner's GitHub account can sign in this way. For anyone else, use Approve this computer. Learn more",
  );
  expect(await p.getAttribute("#den-gh-learn", "href")).toBe(LEARN);
  expect(await text(p, "#den-gh-learn")).toBe("Learn more");
}

describe.each([1440, 390])("the signed-out page at %i px", (width) => {
  it("no owner yet: three steps, step 1 to do with its command, no button", async () => {
    if (skip()) return;
    clearWebOwner(stateDir);
    const p = await signedOut(width);
    await threeSteps(p);
    expect(await text(p, "#den-gh-step1")).toMatch(
      /^On Studio, run (den|\/\S*\/bin\/den) web owner link, or use Settings › Access there\./,
    );
    expect(
      await p.evaluate(() =>
        document.querySelector("#den-gh-step1")?.classList.contains("done"),
      ),
    ).toBe(false);
    expect(await p.locator("#den-gh-start").count()).toBe(0);
    await fits(p);
    await shot(p, `gh-steps-no-owner-${width}`);
    await p.context().close();
  }, 60_000);

  it("an owner: the same three steps, step 1 done and naming the owner, and the button", async () => {
    if (skip()) return;
    writeWebOwner({ id: 4242, login: "octo-owner" }, stateDir);
    const p = await signedOut(width);
    await threeSteps(p);
    expect(
      await p.evaluate(() =>
        document.querySelector("#den-gh-step1")?.classList.contains("done"),
      ),
    ).toBe(true);
    expect(await text(p, "#den-gh-owner")).toBe("Owner: @octo-owner");
    expect(await text(p, "#den-gh-start")).toBe("Sign in with GitHub");
    await fits(p);
    await shot(p, `gh-steps-owner-${width}`);
    await p.context().close();
  }, 60_000);
});

describe("no owner yet, then one is linked", () => {
  it("the page shows Sign in with GitHub by itself, with no reload", async () => {
    if (skip()) return;
    clearWebOwner(stateDir);
    const ctx = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    // Watch faster than the page's 5 s.
    await ctx.addInitScript(() => {
      (window as unknown as { __denOwnerPollMs: number }).__denOwnerPollMs =
        100;
    });
    const p = await ctx.newPage();
    let loads = 0;
    p.on("load", () => loads++);
    expect((await p.goto(`http://${EDGE}:${port}/`))?.status()).toBe(401);
    await p.waitForSelector("#den-gh-steps");
    expect(await p.locator("#den-gh-start").count()).toBe(0);
    writeWebOwner({ id: 4242, login: "octo-owner" }, stateDir);
    await p.waitForSelector("#den-gh-start", { timeout: 10_000 });
    expect(await text(p, "#den-gh-owner")).toBe("Owner: @octo-owner");
    expect(
      await p.evaluate(() =>
        document.querySelector("#den-gh-step1")?.classList.contains("done"),
      ),
    ).toBe(true);
    await threeSteps(p);
    expect(loads).toBe(1);
    await ctx.close();
  }, 60_000);
});
