/**
 * Issue 310: the first row of Settings › Access is the person's own block,
 * drawn by the kit (den-ui 0.7.4, accountPanelHtml) from /api/session's
 * identity. In a real browser, with a fake GitHub on localhost (never
 * github.com) and no gh run by the server:
 *  - a browser on this machine: the install owner's name, @login · Owner,
 *    "On this computer", and no Sign out (a local browser can't sign out);
 *  - signed in with GitHub: that sign-in's name (GitHub's, not the one
 *    stored for the owner), @login, "Signed in with GitHub", and Sign
 *    out, which signs this browser out;
 *  - signed in with a one-time link (paired): the kit's Local, never the
 *    owner's name or login, and Sign out.
 *
 * DEN_PW_WS=ws://localhost:<port>/ uses a browser behind a Playwright
 * run-server. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips
 * it. No link, code, cookie or CSRF value is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import { writeWebOwner } from "../../../src/shared/web-owner.js";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signInUrl } from "./helpers/den-auth.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
/** The edge's X-Forwarded-For for a client on another machine. */
const AWAY = { "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };
/** Invented people. */
const OWNER = { id: 4242, login: "octo-lead", name: "Odette Lead" };
/** The owner's own GitHub sign-in, with the name GitHub has for them. */
const ON_GITHUB = { id: OWNER.id, login: OWNER.login, name: "Octavia Example" };
const PANEL = '[data-setting="access.you"] [data-den-account-panel]';
let browser: Browser | null = null;
let gh: FakeGithub;
let tmp = "";
let stateDir = "";
let port = 0;
let latest = "";
let server: ChildProcess;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await chromium.connect(ws, { exposeNetwork: "<loopback>" })
      : await chromium.launch({
          args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`],
        });
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-you-")));
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
  const edgeDir = path.join(tmp, "edge-state");
  writeTestEdgeProof(edgeDir);
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: edgeDir,
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
  latest =
    (
      (await (
        await fetch(`http://localhost:${port}/api/changelog`)
      ).json()) as { version: string }[]
    )[0]?.version ?? "";
  // The owner is linked, with a name: every case below knows of them.
  writeWebOwner(OWNER, stateDir);
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server, gh],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const skip = () => !browser;

/** A context with this release's What's new seen (it stays shut). */
async function context(away: boolean): Promise<BrowserContext> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    ...(away ? { extraHTTPHeaders: AWAY } : {}),
  });
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* storage blocked: nothing to seed */
    }
  }, latest);
  return ctx;
}

/** Settings › Access's first row and what the kit's panel in it shows. */
async function you(p: Page) {
  await p.waitForSelector(PANEL, { timeout: 20_000 });
  return p.evaluate((sel) => {
    const panel = document.querySelector(sel)!;
    const tx = (s: string) =>
      panel.querySelector(s)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const sec = document.querySelector('section[data-cat="access"]');
    return {
      first: sec?.querySelector(".set-row")?.getAttribute("data-setting"),
      heading: tx("h1,h2,h3,h4,h5,h6"),
      who: tx(".den-acctp-who"),
      how: tx(".den-acctp-how"),
      action: panel.querySelector("form")?.getAttribute("action") ?? null,
      // Whether a CSRF value rides in the form (never its value).
      csrf: !!(
        panel.querySelector('form input[type="hidden"]') as HTMLInputElement
      )?.value,
      button: panel.querySelector("form button")?.textContent?.trim() ?? null,
      text: (panel.textContent ?? "").replace(/\s+/g, " ").trim(),
    };
  }, PANEL);
}

const session = (p: Page) =>
  p.evaluate(async () => {
    const r = await fetch("/api/session", { cache: "no-store" });
    return (await r.json()) as { signedIn?: boolean };
  });

/** Sign in with GitHub through the edge as `account`: the page, signed in. */
async function githubSignIn(account: {
  id: number;
  login: string;
  name?: string;
}): Promise<{ ctx: BrowserContext; p: Page }> {
  const ctx = await context(true);
  const p = await ctx.newPage();
  await p.goto(`http://${EDGE}:${port}/`);
  const flow = await p.evaluate(async () => {
    const r = await fetch("/api/github/signin", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return (await r.json()) as { id?: string; userCode?: string };
  });
  expect(typeof flow.id).toBe("string");
  gh.approve(flow.userCode!, account);
  const done = await p.evaluate(async (id) => {
    for (let i = 0; i < 100; i++) {
      const r = await fetch(`/api/github/signin/${id}`, { cache: "no-store" });
      const j = (await r.json()) as { state?: string };
      if (j.state !== "pending") return j.state;
      await new Promise((ok) => setTimeout(ok, 150));
    }
    return "timeout";
  }, flow.id!);
  expect(done).toBe("ok");
  return { ctx, p };
}

describe("Settings › Access: the person's own block, first", () => {
  it("a browser on this machine: the owner, @login · Owner, On this computer, no Sign out", async () => {
    if (skip()) return;
    const ctx = await context(false);
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}/settings#access`);
    expect(await you(p)).toMatchObject({
      first: "access.you",
      heading: "Odette Lead",
      who: "@octo-lead · Owner",
      how: "On this computer: no sign-in needed",
      action: null,
      button: null,
    });
    await ctx.close();
  }, 60_000);

  it("signed in with GitHub: that name, @login, Signed in with GitHub; Sign out signs out", async () => {
    if (skip()) return;
    const { ctx, p } = await githubSignIn(ON_GITHUB);
    await p.goto(`http://${EDGE}:${port}/settings#access`);
    const y = await you(p);
    expect(y).toMatchObject({
      first: "access.you",
      heading: "Octavia Example",
      who: "@octo-lead",
      how: "Signed in with GitHub",
      action: "/api/session/logout",
      csrf: true,
      button: "Sign out",
    });
    expect(y.text).not.toMatch(/Odette/);
    expect((await session(p)).signedIn).toBe(true);
    // Sign out: the post ends this browser's sign-in, then the page
    // reloads to the signed-out one.
    await Promise.all([
      p.waitForEvent("framenavigated", { timeout: 15_000 }),
      p.click(`${PANEL} form button`),
    ]);
    await p.waitForLoadState("load");
    expect((await session(p)).signedIn).toBe(false);
    expect(await p.$(PANEL)).toBeNull();
    await ctx.close();
  }, 90_000);

  it("paired with a one-time link: the kit's Local, never the owner; Sign out", async () => {
    if (skip()) return;
    const ctx = await context(true);
    const p = await ctx.newPage();
    const r = await p.goto(
      signInUrl(stateDir, `http://${EDGE}:${port}`, "/settings#access"),
    );
    expect(r?.status()).toBe(200);
    const y = await you(p);
    expect(y).toMatchObject({
      first: "access.you",
      heading: "Local",
      who: null,
      how: "Signed in with a one-time link or code",
      action: "/api/session/logout",
      csrf: true,
      button: "Sign out",
    });
    expect(y.text).not.toMatch(/Odette|octo-lead|Owner/);
    await ctx.close();
  }, 60_000);
});
