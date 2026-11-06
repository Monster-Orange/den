/**
 * SEC-1b in a real browser (SEC-1 spec §2): localhost is the canonical
 * loopback name. Sign in through a /auth link on localhost, open a page
 * that needs a session on 127.0.0.1 (a cookie set on localhost isn't sent
 * there): the signed-out page links to the same path on localhost, and one
 * click lands signed in.
 *
 * And the refusal pages stay quiet (a consumer's SEC-1a dogfood): on the
 * 421 "Wrong address" page and on the signed-out page beyond loopback (the
 * edge hostname), the shell frame's own calls would all answer the same
 * refusal, so it starts none of its polls and streams; no /api request
 * answers 421 or 401 after the page loads, and the status chip reads
 * neutral, not "Checking…" forever.
 *
 * The real server on a throwaway distribution with an edge block (org
 * acme: den.acme.localhost). Chromium maps the names to 127.0.0.1.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
let browser: Browser | null = null;
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
      args: [
        `--host-resolver-rules=MAP evil.test 127.0.0.1, MAP ${EDGE} 127.0.0.1`,
      ],
    });
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sec1b-ui-")),
  );
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
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
  port = await freePort();
  server = spawn(
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
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const skip = () => !browser;
const signedIn = (p: Page) =>
  p.evaluate(async () => {
    const r = await fetch("/api/session", { cache: "no-store" });
    return ((await r.json()) as { signedIn?: boolean }).signedIn === true;
  });

describe("localhost is canonical", () => {
  it("signed in on localhost, a session page on 127.0.0.1 links to localhost, and one click is signed in", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const p = await ctx.newPage();
    await p.goto(signInUrl(stateDir, `http://localhost:${port}`, "/settings"));
    await p.waitForURL(`http://localhost:${port}/settings`);
    expect(await signedIn(p)).toBe(true);

    // 127.0.0.1: the cookie belongs to localhost, so this browser isn't
    // signed in here. The signed-out page, and its link to localhost.
    const r = await p.goto(`http://127.0.0.1:${port}/signin?next=%2Fsettings`);
    expect(r?.status()).toBe(401);
    await p.waitForSelector("#den-signin");
    expect(await p.textContent("#den-error-page h1")).toBe(
      "Sign in to use the terminal",
    );
    expect(await p.textContent("#den-signin-cmd")).toBe("den web login");
    expect(await p.getAttribute("#den-signin-local", "href")).toBe(
      `http://localhost:${port}/signin?next=%2Fsettings`,
    );
    // No form takes a secret or a token.
    expect(await p.locator("#den-error-page input").count()).toBe(0);

    await p.click("#den-signin-local");
    await p.waitForURL(`http://localhost:${port}/settings`, {
      timeout: 20_000,
    });
    expect(await signedIn(p)).toBe(true);
    await ctx.close();
  }, 60_000);
});

/** A page, and every /api answer of 421 or 401 after it loaded. */
async function quiet(url: string, status: number) {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const p = await ctx.newPage();
  const refused: string[] = [];
  let loaded = false;
  p.on("response", (r) => {
    const u = new URL(r.url());
    if (
      loaded &&
      u.pathname.startsWith("/api/") &&
      (r.status() === 421 || r.status() === 401)
    )
      refused.push(`${r.status()} ${u.pathname}`);
  });
  const nav = await p.goto(url);
  loaded = true;
  expect(nav?.status()).toBe(status);
  await p.waitForFunction(
    () => !!(window as unknown as { denShell?: unknown }).denShell,
  );
  await p.waitForSelector("#den-error-page h1");
  // A health poll interval's worth of quiet (5 s): nothing the shell
  // starts later may answer the refusal either.
  await p.waitForTimeout(6_000);
  const chip = (await p.textContent("#den-status"))?.trim();
  await ctx.close();
  return { refused, chip };
}

describe("refusal pages start no polls (no /api answers 421 or 401 after load)", () => {
  it("the 421 Wrong address page", async () => {
    if (skip()) return;
    const r = await quiet(`http://evil.test:${port}/`, 421);
    expect(r.refused).toEqual([]);
    expect(r.chip).toBe("Status unknown");
  }, 60_000);

  it("the signed-out page beyond loopback (the edge hostname)", async () => {
    if (skip()) return;
    const r = await quiet(`http://${EDGE}:${port}/`, 401);
    expect(r.refused).toEqual([]);
    expect(r.chip).toBe("Status unknown");
  }, 60_000);

  it("the edge's signed-out page names the command for its own origin; signing in there lets the page load", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext();
    const p = await ctx.newPage();
    await p.goto(`http://${EDGE}:${port}/`);
    await p.waitForSelector("#den-signin");
    expect(await p.textContent("#den-error-page h1")).toBe(
      "Sign in to use Den",
    );
    expect(await p.textContent("#den-signin-cmd")).toBe(
      `den web login --origin http://${EDGE}:${port}`,
    );
    expect(await p.locator("#den-signin-local").count()).toBe(0);
    const r = await p.goto(signInUrl(stateDir, `http://${EDGE}:${port}`, "/"));
    expect(r?.status()).toBe(200);
    expect(await p.locator("#den-error-page").count()).toBe(0);
    await ctx.close();
  }, 60_000);
});
