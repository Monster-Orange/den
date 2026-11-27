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
    // Issue 310: a button opening the Account area.
    act: await p.getAttribute("#den-ident", "data-act"),
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
  it("on localhost: Local, opening the Account area, with the rail's own item metrics; no toast", async () => {
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
      href: null,
      act: "account",
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
    // Every toast's text, as it appears (a toast can close before a poll
    // sees it): recorded from the first paint of every page.
    await ctx.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __toasts: string[] }).__toasts = seen;
      new MutationObserver((ms) => {
        for (const m of ms)
          for (const n of m.addedNodes) {
            const el = n instanceof Element ? n : null;
            // The toast's own role (shell.js toast()), not its class.
            const t = el?.matches('[role="status"]')
              ? el
              : el?.querySelector('[role="status"]');
            const text = t?.textContent?.trim();
            if (text) seen.push(text);
          }
      }).observe(document, { childList: true, subtree: true });
    });
    const p = await ctx.newPage();
    const origin = `http://${EDGE}:${port}`;
    // Issue 819: the link opens the pairing screen; a person's signed-in
    // browser approves its code; the page signs itself in and goes on.
    const r = await p.goto(signInUrl(stateDir, origin, "/settings#access"));
    expect(r?.status()).toBe(401);
    await p.waitForSelector("#den-pair-code");
    const code = ((await p.textContent("#den-pair-code")) ?? "").trim();
    // The race the 0.4.87 dry run lost: another GET /api/session on the
    // page after the sign-in (Settings' signed-in row) answers before the shell's own. It
    // must not spend the welcome: the toast still shows, once.
    await ctx.addInitScript(() => {
      void fetch("/api/session", {
        cache: "no-store",
        headers: { "x-test-first": "1" },
      }).catch(() => {});
    });
    let firstDone: Promise<void> = Promise.resolve();
    await ctx.route(
      (u) => u.pathname === "/api/session",
      async (route) => {
        if (route.request().headers()["x-test-first"]) {
          let done!: () => void;
          firstDone = new Promise((r) => (done = r));
          const res = await route.fetch();
          await route.fulfill({ response: res });
          done();
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
        await firstDone;
        await route.continue();
      },
    );
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
    // Read the toast's text in the same step that sees it: a toast can
    // close between a wait and a later read.
    const toast = await p.waitForFunction(
      () =>
        (window as unknown as { __toasts?: string[] }).__toasts?.find((t) =>
          t.includes("signed in"),
        ) ?? null,
    );
    expect(await toast.jsonValue()).toBe(
      `This device is signed in to Den on ${SHORT}`,
    );
    expect(await chip(p)).toEqual({
      text: "Local",
      kind: "device",
      href: null,
      act: "account",
    });
    await whatsNewStaysShut(p);
    // Issue 310: Devices and sessions (the Account area) marks This
    // device; its place, never its address.
    await p.goto(p.url().replace(/[?#].*$/, "") + "?account=devices");
    const row = p
      .locator(
        'dialog.den-aa-dlg[open] .den-aa-pane[data-aa-pane="devices"] .den-aa-item',
      )
      .filter({ hasText: "This device" });
    await row.waitFor({ timeout: 20_000 });
    expect(await row.count()).toBe(1);
    const text = (await row.textContent())?.replace(/\s+/g, " ") ?? "";
    expect(text).toMatch(/^Chrome on \w+ ?This device.*Last seen.*Sign out$/);
    expect(text).not.toContain("203.0.113.7");
    // A reload: the chip again, and no toast.
    await p.reload();
    expect((await chip(p)).kind).toBe("device");
    expect(await p.locator(".den-toast").count()).toBe(0);
    expect(
      await p.evaluate(
        () => (window as unknown as { __toasts?: string[] }).__toasts ?? [],
      ),
    ).not.toContainEqual(expect.stringContaining("signed in"));
    await ctx.close();
  }, 60_000);
});
