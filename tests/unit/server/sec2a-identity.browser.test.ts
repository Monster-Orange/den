/**
 * SEC-2a "Seeing that you're signed in", in a real browser:
 *  - the rail footer's identity chip: the kit's "Local" when Den knows no
 *    GitHub identity (on localhost, or a browser that opened a one-time
 *    link through the edge, from another machine, and was approved from a
 *    signed-in browser: issue 819); never device words.
 *    The GitHub login is sec2a-signin's. It
 *    opens Settings › Access, and has the rail's own item metrics;
 *  - a toast on the first page load after the sign-in, once;
 *  - Linked devices lists that sign-in (approved with a code), marked
 *    This device.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No link
 * or cookie is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { signIn, signedIn } from "./helpers/signed-in.js";
import { signInUrl } from "./helpers/den-auth.js";
import { EDGE_PROOF, writeTestEdgeProof } from "./helpers/edge-proof.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
/** The edge folder, with the invented proof in it (H1). */
const edgeProofDir = (d: string) => (writeTestEdgeProof(d), d);

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
const SHORT = os.hostname().split(".")[0];
/** The edge's X-Forwarded-For for a client on another machine. */
const AWAY = { "x-forwarded-for": "203.0.113.7", ...EDGE_PROOF };
let browser: Browser | null = null;
let tmp = "";
let stateDir = "";
let port = 0;
/** The newest release in the changelog (What's new). */
let latest = "";
let server: ChildProcess;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    // DEN_PW_WS=ws://localhost:<port>/ uses a browser behind a Playwright
    // run-server; its localhost and *.localhost are this machine's.
    browser = await launchBrowser(chromium, {
      args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`],
    });
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-sec2a-id-")),
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
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: edgeProofDir(path.join(tmp, "edge-state")),
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
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
  expect(latest).not.toBe("");
}, 60_000);

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
const chip = (p: Page) =>
  p.waitForSelector("#den-ident").then(async () => ({
    text: (await p.textContent("#den-ident .den-lbl"))?.trim(),
    kind: await p.getAttribute("#den-ident", "data-ident"),
    href: await p.getAttribute("#den-ident", "href"),
  }));
/**
 * What's new never opens over the page (issue 198). The context starts
 * with this release seen (seeWhatsNew), so whether it opens no longer
 * hangs on the page's second answer (ON-6's fresh, from
 * /api/server-info) arriving before the test looks: with the release
 * seen, the page never opens it, early or late.
 */
async function whatsNewStaysShut(p: Page): Promise<void> {
  expect(
    await p.evaluate(() => localStorage.getItem("den-changelog-seen")),
  ).toBe(latest);
  expect(await p.$("#cl-overlay.open")).toBeNull();
}
/** This release counts as seen in `ctx`, on every page load. */
async function seeWhatsNew(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript((v) => {
    try {
      localStorage.setItem("den-changelog-seen", v);
    } catch {
      /* storage blocked: nothing to seed */
    }
  }, latest);
}

describe("the identity chip", () => {
  it("on localhost: Local, opening Settings › Access, with the rail's own item metrics; no toast", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
    });
    // The person's browser on this machine, signed in as `web up` does
    // (0.4.71): a signed-out one has no identity to show.
    await signIn(ctx, stateDir, `http://localhost:${port}`);
    const p = await ctx.newPage();
    // Not on /settings: its item there is the current page (bolder).
    await p.goto(`http://localhost:${port}/`);
    expect(await chip(p)).toEqual({
      text: "Local",
      kind: "local",
      href: "/settings#access",
    });
    expect(await p.locator(".den-toast").count()).toBe(0);
    // Measured, not eyeballed: the chip is a rail item like Settings.
    const box = await p.evaluate(() => {
      const m = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          h: Math.round(r.height),
          x: Math.round(r.left),
          w: Math.round(r.width),
          font: cs.font,
          pad: cs.padding,
        };
      };
      return {
        chip: m(document.querySelector("#den-ident")),
        settings: m(document.querySelector('.den-ni[data-nav="settings"]')),
      };
    });
    expect(box.chip).toEqual(box.settings);
    await ctx.close();
  }, 60_000);

  it("a one-time link from another machine, approved from a signed-in browser, no GitHub identity known: the kit's Local, never device words; a toast the first time only; Linked devices marks This device", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: AWAY,
    });
    await seeWhatsNew(ctx);
    const p = await ctx.newPage();
    const origin = `http://${EDGE}:${port}`;
    // Issue 819: the link opens the pairing screen; a person's signed-in
    // browser approves its code; the page signs itself in and goes on.
    const r = await p.goto(signInUrl(stateDir, origin, "/settings#access"));
    expect(r?.status()).toBe(401);
    await p.waitForSelector("#den-pair-code");
    const code = ((await p.textContent("#den-pair-code")) ?? "").trim();
    const me = await signedIn(stateDir, `http://localhost:${port}`);
    const ok = await fetch(`http://localhost:${port}/api/web/approve`, {
      method: "POST",
      headers: {
        ...me.headers,
        "x-den-approve-key": me.approveKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ code }),
    });
    expect(ok.status).toBe(200);
    // It goes on to the link's next, not back to the spent link.
    await p.waitForURL((u) => u.pathname === "/settings", { timeout: 20_000 });
    // The first load after the sign-in: the toast, once.
    await p.waitForSelector(".den-toast");
    expect((await p.textContent(".den-toast"))?.trim()).toBe(
      `This device is signed in to Den on ${SHORT}`,
    );
    expect(await chip(p)).toEqual({
      text: "Local",
      kind: "device",
      href: "/settings#access",
    });
    await whatsNewStaysShut(p);
    // Linked devices: this sign-in, by its method, marked This device.
    const row = p.locator(".set-device").filter({ hasText: "This device" });
    await row.waitFor();
    expect(await row.count()).toBe(1);
    expect((await row.textContent())?.replace(/\s+/g, " ")).toMatch(
      /Chrome on \w+ · This device.*approved with a code · created just now · from 203\.0\.113\.7 \(Chrome on \w+\) · last seen just now.*Revoke/,
    );
    // A reload: the chip again, and no toast.
    await p.reload();
    expect((await chip(p)).kind).toBe("device");
    expect(await p.locator(".den-toast").count()).toBe(0);
    await ctx.close();
  }, 60_000);
});
