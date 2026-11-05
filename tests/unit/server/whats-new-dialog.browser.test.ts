/**
 * The "What's new" pop-up in a real browser (0.3.0-dev.17): it is a modal
 * dialog (role, aria-modal, a label), it takes focus and keeps Tab inside,
 * it gives focus back on close (to the version pill after a first-visit
 * auto-open), and every reopen starts at the top, however it was closed
 * (Escape, ×, Got it) and whether it was collapsed or expanded.
 *
 * The reopen-at-top half needs real layout: a scrollTop set while the
 * overlay is display:none does not stick, which no fake DOM reproduces.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let port = 0;
let server: ChildProcess;
let browser: Browser | null = null;
let serverOut = "";

function get(p: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: p, agent: false }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject);
  });
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    // No browser: fail loudly, never pass by skipping (set
    // DEN_SKIP_BROWSER_TESTS=1 where none can be installed).
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-cl-")));
  const root = path.join(tmp, "dist");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
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
        DEN_HOME: path.join(tmp, "home"),
        HOME: path.join(tmp, "home"),
        PORT: String(port),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.stdout!.on("data", (d: Buffer) => (serverOut += d.toString()));
  server.stderr!.on("data", (d: Buffer) => (serverOut += d.toString()));
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await get("/api/server-info")) === 200) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline)
      throw new Error(`server did not start:\n${serverOut}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}, 40_000);

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

const state = (p: Page) =>
  p.evaluate(() => {
    const overlay = document.getElementById("cl-overlay");
    const box = overlay?.querySelector(".cl-box");
    const body = document.getElementById("cl-body");
    const a = document.activeElement;
    return {
      open: !!overlay?.classList.contains("open"),
      scrollTop: body ? Math.round(body.scrollTop) : -1,
      focusInside: !!box && box.contains(a),
      focus: a?.id || a?.tagName || "",
      expanded:
        document.getElementById("cl-more")?.getAttribute("aria-expanded") ===
        "true",
    };
  });

/** Open from the version pill, as a person does. */
async function openFromPill(p: Page): Promise<void> {
  await p.focus("#version-pill");
  await p.keyboard.press("Enter");
  await p.waitForSelector("#cl-overlay.open");
}

async function scrollBody(p: Page): Promise<number> {
  return p.evaluate(() => {
    const body = document.getElementById("cl-body")!;
    body.scrollTop = 4000;
    return body.scrollTop;
  });
}

describe("the What's new dialog", () => {
  it("is a labelled modal that takes focus, keeps Tab in, and gives it back", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${port}/services`);
    // First visit: it opens by itself.
    await p.waitForSelector("#cl-overlay.open", { timeout: 10_000 });
    const box = p.locator("#cl-overlay .cl-box");
    expect(await box.getAttribute("role")).toBe("dialog");
    expect(await box.getAttribute("aria-modal")).toBe("true");
    const labelledBy = await box.getAttribute("aria-labelledby");
    expect(await p.locator(`#${labelledBy}`).textContent()).toBe("What's new");
    // Focus is on the toggle (there are earlier releases), inside the box.
    expect(await state(p)).toEqual(
      expect.objectContaining({ focusInside: true, focus: "cl-more" }),
    );
    for (let i = 0; i < 6; i++) {
      await p.keyboard.press(i % 2 ? "Shift+Tab" : "Tab");
      await p.keyboard.press("Tab");
      expect((await state(p)).focusInside).toBe(true);
    }
    // Closing an auto-open hands focus to the version pill.
    await p.keyboard.press("Escape");
    expect(await state(p)).toEqual(
      expect.objectContaining({ open: false, focus: "version-pill" }),
    );
    // Opened from the pill: focus goes back to the pill.
    await openFromPill(p);
    await p.click("#cl-close-btn");
    expect((await state(p)).focus).toBe("version-pill");
    await ctx.close();
  }, 40_000);

  it.each([
    ["Escape", false],
    ["Escape", true],
    ["close", false],
    ["close", true],
    ["got it", false],
    ["got it", true],
  ])(
    "reopens at the top after %s (expanded: %s)",
    async (how, expand) => {
      if (!browser) return;
      // A short window so even the newest release scrolls.
      const ctx = await browser.newContext({
        viewport: { width: 1024, height: 420 },
      });
      const p = await ctx.newPage();
      await p.goto(`http://127.0.0.1:${port}/services`);
      await p.waitForSelector("#cl-overlay.open", { timeout: 10_000 });
      if (expand) {
        await p.click("#cl-more");
        expect((await state(p)).expanded).toBe(true);
      }
      expect(await scrollBody(p)).toBeGreaterThan(0);
      if (how === "Escape") await p.keyboard.press("Escape");
      else if (how === "close") await p.click("#cl-close-btn");
      else await p.click("#cl-got-it-btn");
      expect((await state(p)).open).toBe(false);
      await openFromPill(p);
      expect(await state(p)).toEqual(
        expect.objectContaining({ open: true, scrollTop: 0, expanded: false }),
      );
      await ctx.close();
    },
    30_000,
  );
});
