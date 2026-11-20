/**
 * The rail's account entry (den-ui 0.7.1) draws who is signed in from
 * Den's data, in a real browser, with a fake GitHub on localhost (never
 * github.com) and no gh run by the server:
 *  - no GitHub identity known at all: the kit's "Local";
 *  - a browser on this machine: the install owner's GitHub identity, the
 *    name over @login, its role (Owner) in an account menu's header only;
 *  - a browser signed in with a one-time link from another machine (no
 *    GitHub sign-in of its own): "Local", never the owner's name;
 *  - signed in with GitHub: that sign-in's name over @login, or @login
 *    alone when GitHub has no name for it.
 * In none of them do device words ("Signed in", "this device") appear in
 * the entry or a menu.
 *
 * DEN_PW_WS=ws://localhost:<port>/ uses a browser behind a Playwright
 * run-server. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips
 * it. No link, code or cookie is printed.
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
import { signIn } from "./helpers/signed-in.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { startFakeGithub, type FakeGithub } from "./helpers/fake-github.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
/** The edge's X-Forwarded-For for a client on another machine. */
const AWAY = { "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };
/** Invented people. */
const OWNER = { id: 4242, login: "octo-lead" };
const DEVICE_WORDS = /signed in|this device/i;
let browser: Browser | null = null;
let gh: FakeGithub;
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium, {
      args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`],
    });
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  gh = await startFakeGithub({ interval: 0 });
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-acct-")));
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

/** What the entry draws: its lines, its kind, its whole text and tooltip. */
async function entry(p: Page) {
  await p.waitForSelector("#den-ident");
  return p.evaluate(() => {
    const el = document.querySelector("#den-ident")!;
    const tx = (s: string) => el.querySelector(s)?.textContent?.trim() ?? null;
    return {
      name: tx(".den-acct-n"),
      login: tx(".den-acct-l"),
      role: tx(".den-acct-r"),
      kind: el.getAttribute("data-ident"),
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      title: el.getAttribute("title") ?? "",
    };
  });
}

/** Every account menu on the page (the kit's), as text: none in Den. */
const menus = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll("#den-account, .den-pop .den-acct")]
      .map((m) => m.textContent ?? "")
      .join(" "),
  );

/** The session's identity, as the page's own call gets it. */
const identity = (p: Page) =>
  p.evaluate(async () => {
    const r = await fetch("/api/session", { cache: "no-store" });
    return ((await r.json()) as { identity?: Record<string, unknown> })
      .identity;
  });

/** No device words in the entry, its tooltip, or any account menu. */
async function noDeviceWords(p: Page) {
  const e = await entry(p);
  expect(e.text).not.toMatch(DEVICE_WORDS);
  expect(e.title).not.toMatch(DEVICE_WORDS);
  expect(await menus(p)).not.toMatch(DEVICE_WORDS);
}

/** Sign in with GitHub through the edge as `account`: the page, signed in. */
async function githubSignIn(account: {
  id: number;
  login: string;
  name?: string;
}): Promise<{ ctx: BrowserContext; p: Page }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: AWAY,
  });
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
  await p.goto(`http://${EDGE}:${port}/`);
  return { ctx, p };
}

describe("the account entry draws who is signed in", () => {
  it("no GitHub identity known at all: the kit's Local", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
    });
    // A browser on this machine, signed in as `web up` does (0.4.71).
    await signIn(ctx, stateDir, `http://localhost:${port}`);
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}/`);
    expect(await entry(p)).toMatchObject({
      name: "Local",
      login: null,
      role: null,
      kind: "local",
    });
    expect(await identity(p)).toEqual({ kind: "local" });
    await noDeviceWords(p);
    await ctx.close();
  }, 60_000);

  it("a browser on this machine: the owner's name over @login; Owner only in a menu's header", async () => {
    if (skip()) return;
    writeWebOwner({ ...OWNER, name: "Odette Lead" }, stateDir);
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
    });
    // A browser on this machine, signed in as `web up` does (0.4.71).
    await signIn(ctx, stateDir, `http://localhost:${port}`);
    const p = await ctx.newPage();
    await p.goto(`http://localhost:${port}/`);
    expect(await entry(p)).toMatchObject({
      name: "Odette Lead",
      login: "@octo-lead",
      role: null,
      kind: "local",
    });
    expect((await entry(p)).text).not.toMatch(/\bOwner\b/);
    // The data Den gives the kit: the owner's identity with its role.
    expect(await identity(p)).toEqual({
      kind: "local",
      owner: { login: "octo-lead", name: "Odette Lead", role: "owner" },
    });
    // The kit's account menu header, from that data: the role on its own line.
    const header = await p.evaluate(() => {
      const k = (
        window as unknown as {
          DenUIShell: { accountMenuHtml: (o: object) => string };
        }
      ).DenUIShell;
      const d = document.createElement("div");
      d.innerHTML = k.accountMenuHtml({
        name: "Odette Lead",
        login: "octo-lead",
        role: "Owner",
      });
      return [...d.querySelectorAll(".den-acct > span")].map(
        (s) => s.textContent,
      );
    });
    expect(header).toEqual(["Odette Lead", "@octo-lead", "Owner"]);
    await noDeviceWords(p);
    await ctx.close();
  }, 60_000);

  it("signed in with a one-time link from another machine: the kit's Local, never the owner's name", async () => {
    if (skip()) return;
    // The owner is linked (the case above), with a name: a browser paired
    // with a link has no GitHub sign-in of its own, so it isn't the owner.
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: AWAY,
    });
    const p = await ctx.newPage();
    const r = await p.goto(signInUrl(stateDir, `http://${EDGE}:${port}`, "/"));
    expect(r?.status()).toBe(200);
    expect(await entry(p)).toMatchObject({
      name: "Local",
      login: null,
      role: null,
      kind: "device",
    });
    const e = await entry(p);
    expect(e.text).not.toMatch(/Odette|octo-lead/);
    expect(e.title).not.toMatch(/Odette|octo-lead/);
    const id = await identity(p);
    expect(id).toMatchObject({ kind: "device" });
    expect(id).not.toHaveProperty("owner");
    expect(id).not.toHaveProperty("login");
    expect(id).not.toHaveProperty("name");
    await noDeviceWords(p);
    await ctx.close();
  }, 60_000);

  it("signed in with GitHub, with a name: that name over @login", async () => {
    if (skip()) return;
    const { ctx, p } = await githubSignIn({
      ...OWNER,
      name: "Octavia Example",
    });
    expect(await entry(p)).toMatchObject({
      name: "Octavia Example",
      login: "@octo-lead",
      role: null,
      kind: "github",
    });
    expect(await identity(p)).toMatchObject({
      kind: "github",
      login: "octo-lead",
      name: "Octavia Example",
    });
    await noDeviceWords(p);
    await ctx.close();
  }, 90_000);

  it("signed in with GitHub, no name on GitHub: @login alone", async () => {
    if (skip()) return;
    const { ctx, p } = await githubSignIn(OWNER);
    expect(await entry(p)).toMatchObject({
      name: "@octo-lead",
      login: null,
      role: null,
      kind: "github",
    });
    const id = await identity(p);
    expect(id).toMatchObject({ kind: "github", login: "octo-lead" });
    expect(id).not.toHaveProperty("name");
    await noDeviceWords(p);
    await ctx.close();
  }, 90_000);
});
