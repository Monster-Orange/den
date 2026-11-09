/**
 * D17 in a real browser: a Den with no owner and web.allowed_github_org,
 * opened only at its edge URL.
 *  - The signed-out page leads with Connect your GitHub account and This
 *    is my computer.
 *  - This is my computer goes to localhost and straight back (a top-level
 *    round trip, no terminal), the code leaves the address bar, and the
 *    GitHub sign-in starts with that proof: the code to enter shows.
 *  - Approved on (fake) GitHub as a member of the org: signed in, on the
 *    page asked for, and the owner is linked.
 * At 390 px nothing is wider than the window. DEN_SEC2_SHOTS=<dir> saves
 * screenshots. Needs Playwright's chromium (DEN_D17_BROWSER=firefox or
 * webkit runs it there); DEN_SKIP_BROWSER_TESTS=1 skips
 * it. A fake GitHub on localhost (never github.com); no code is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { readWebOwner } from "../../../src/shared/web-owner.js";
import { spawnServer, stopServer } from "../../child-servers.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";

const ENGINE = path.resolve(__dirname, "../../..");
const SHOTS = process.env.DEN_SEC2_SHOTS ?? "";
const EDGE = "den.acme.localhost";
const ENGINE_NAME = (
  ["firefox", "webkit"].includes(process.env.DEN_D17_BROWSER ?? "")
    ? process.env.DEN_D17_BROWSER
    : "chromium"
) as "chromium" | "firefox" | "webkit";
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
    const pw = await import("playwright");
    // DEN_D17_BROWSER=firefox or webkit (Safari's engine) runs the same
    // round trip there; *.localhost is loopback in both.
    browser =
      ENGINE_NAME === "chromium"
        ? await pw.chromium.launch({
            args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`],
          })
        : await pw[ENGINE_NAME].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-d17-claim-")),
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
      "web:",
      "  allowed_github_org: acme-co",
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

const OWNER = { id: 4242, login: "octo-owner" };

describe("Connect your GitHub account, on this computer", () => {
  it("leads the signed-out page; This is my computer goes round and starts the sign-in; a member gets in", async () => {
    if (skip()) return;
    gh.orgs["acme-co"] = { [OWNER.login]: "private" };
    const ctx = await browser!.newContext({
      viewport: { width: 390, height: 900 },
    });
    const p = await ctx.newPage();
    const r = await p.goto(`http://${EDGE}:${port}/settings`);
    expect(r?.status()).toBe(401);
    await p.waitForSelector("#den-claim-title");
    expect(await text(p, "#den-claim-title")).toBe(
      "Connect your GitHub account",
    );
    expect(await text(p, "#den-claim-org")).toBe(
      "Members of the acme-co GitHub org can claim it, in a browser on Studio.",
    );
    // It comes first: before the where-it-runs line and Approve this computer.
    expect(
      await p.$eval("#den-signin", (el) =>
        [...el.children].findIndex((c) => c.id === "den-gh"),
      ),
    ).toBe(0);
    expect(await p.getAttribute("#den-claim-here", "href")).toBe(
      `http://localhost:${port}/attest?return=${encodeURIComponent(`http://${EDGE}:${port}/settings`)}`,
    );
    expect(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    if (SHOTS)
      await p.screenshot({
        path: path.join(SHOTS, "d17-claim-390.png"),
        fullPage: true,
      });

    await p.click("#den-claim-here");
    // Back on the edge page, with the code gone from the address bar, and
    // the GitHub code to enter showing.
    await p.waitForSelector("#den-gh-code", { timeout: 15_000 });
    expect(p.url()).toBe(`http://${EDGE}:${port}/settings`);
    expect(await p.isVisible("#den-claim-here")).toBe(false);
    const userCode = await text(p, "#den-gh-code");
    expect(userCode).toBe(gh.codes[gh.codes.length - 1].userCode);
    if (SHOTS)
      await p.screenshot({
        path: path.join(SHOTS, "d17-code-390.png"),
        fullPage: true,
      });

    gh.approve(userCode, OWNER);
    await p.waitForURL(`http://${EDGE}:${port}/settings`, { timeout: 15_000 });
    await p.waitForFunction(
      () => !document.querySelector("#den-signin"),
      null,
      {
        timeout: 15_000,
      },
    );
    expect(readWebOwner(stateDir)).toMatchObject({ login: "octo-owner" });
    const cookies = await ctx.cookies(`http://${EDGE}:${port}`);
    expect(cookies.some((c) => c.name === `den_session_${port}`)).toBe(true);
    await ctx.close();
  }, 60_000);
});
