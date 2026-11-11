/**
 * SEC-2a "Seeing that you're signed in", in a real browser:
 *  - the rail footer's identity chip: "Local" on localhost; "Signed in ·
 *    this device" for a browser signed in with a one-time link (through the
 *    edge, from another machine); the GitHub login is sec2a-signin's. It
 *    opens Settings › Access, and has the rail's own item metrics;
 *  - a toast on the first page load after the sign-in, once;
 *  - Linked devices lists the one-time-link sign-in, marked This device.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. No link
 * or cookie is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer, stopServer } from "../../child-servers.js";
import { signInUrl } from "./helpers/den-auth.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
const SHORT = os.hostname().split(".")[0];
/** The edge's X-Forwarded-For for a client on another machine. */
const AWAY = { "x-forwarded-for": "203.0.113.7" };
let browser: Browser | null = null;
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
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (server) await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const skip = () => !browser;
const chip = (p: Page) =>
  p.waitForSelector("#den-ident").then(async () => ({
    text: (await p.textContent("#den-ident .den-lbl"))?.trim(),
    kind: await p.getAttribute("#den-ident", "data-ident"),
    href: await p.getAttribute("#den-ident", "href"),
  }));
/**
 * What's new on this Den: it has no repo yet, so the shell marks the
 * release seen and never opens it (ON-6). Wait for that, so nothing opens
 * over the page later.
 */
async function closeWhatsNew(p: Page): Promise<void> {
  await p.waitForFunction(() =>
    Object.keys(localStorage).some((k) => k.endsWith("-changelog-seen")),
  );
  expect(await p.$("#cl-overlay.open")).toBeNull();
}

describe("the identity chip", () => {
  it("on localhost: Local, opening Settings › Access, with the rail's own item metrics; no toast", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
    });
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

  it("signed in with a one-time link from another machine: Signed in · this device; a toast the first time only; Linked devices marks This device", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 900 },
      extraHTTPHeaders: AWAY,
    });
    const p = await ctx.newPage();
    const origin = `http://${EDGE}:${port}`;
    const r = await p.goto(signInUrl(stateDir, origin, "/settings#access"));
    expect(r?.status()).toBe(200);
    // The first load after the sign-in: the toast, once.
    await p.waitForSelector(".den-toast");
    expect((await p.textContent(".den-toast"))?.trim()).toBe(
      `This device is signed in to Den on ${SHORT}`,
    );
    expect(await chip(p)).toEqual({
      text: "Signed in · this device",
      kind: "device",
      href: "/settings#access",
    });
    await closeWhatsNew(p);
    // Linked devices: this sign-in, by its method, marked This device.
    const row = p.locator(".set-device").filter({ hasText: "This device" });
    await row.waitFor();
    expect(await row.count()).toBe(1);
    expect((await row.textContent())?.replace(/\s+/g, " ")).toMatch(
      /Chrome on \w+ · This device.*signed in with a one-time link · created just now · from 203\.0\.113\.7 \(Chrome on \w+\) · last seen just now.*Revoke/,
    );
    // A reload: the chip again, and no toast.
    await p.reload();
    expect((await chip(p)).kind).toBe("device");
    expect(await p.locator(".den-toast").count()).toBe(0);
    await ctx.close();
  }, 60_000);
});
