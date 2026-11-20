/**
 * Issue 463: every test gets its browser through one helper
 * (tests/unit/helpers/browser.ts), and a check finds any that does not.
 *
 * - The check: no file under tests/ launches a browser, or connects to
 *   DEN_PW_WS, by itself. A suite that did would start a local browser on a
 *   machine whose browsers must come from the shared Playwright server.
 * - The helper: DEN_PW_WS set connects (the loopback shared) and never
 *   launches, even when the server is unreachable; unset, it launches with
 *   the suite's options; openBrowser gives null when it can't open one and
 *   DEN_SKIP_BROWSER_TESTS=1.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { BrowserType } from "playwright";
import {
  directBrowserOpens,
  launchBrowser,
  openBrowser,
} from "./helpers/browser.js";

const TESTS = path.resolve(__dirname, "..");
// The helper, and this file (its examples open browsers on purpose).
const SKIP = [path.join(__dirname, "helpers", "browser.ts"), __filename];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "fixtures")
        out.push(...sources(p));
    } else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name) && !SKIP.includes(p))
      out.push(p);
  }
  return out;
}

describe("the check: tests get a browser through launchBrowser", () => {
  it("finds the browser suites (there are many)", () => {
    const pw = sources(TESTS).filter((f) =>
      fs.readFileSync(f, "utf-8").includes('"playwright"'),
    );
    expect(pw.length).toBeGreaterThan(100);
  });

  it("no file under tests/ launches or connects a browser itself", () => {
    const bad = sources(TESTS).flatMap((f) =>
      directBrowserOpens(fs.readFileSync(f, "utf-8")).map(
        (w) => `${path.relative(TESTS, f)}: ${w}`,
      ),
    );
    expect(bad).toEqual([]);
  });

  it("fails on a suite that launches or connects by itself", () => {
    const direct = `
const { chromium } = await import("playwright");
browser = await chromium.launch();
other = await pw[engine].launch({ args: [] });
remote = await chromium.connect(ws, { exposeNetwork: "<loopback>" });
ctx = await chromium.launchPersistentContext(dir);`;
    expect(directBrowserOpens(direct)).toEqual([
      "line 3: launches a browser without launchBrowser",
      "line 4: launches a browser without launchBrowser",
      "line 5: connects to DEN_PW_WS without launchBrowser",
      "line 6: launches a browser without launchBrowser",
    ]);
  });

  it("passes a suite that uses the helper, and code that isn't a browser", () => {
    const ok = `
const { chromium } = await import("playwright");
// chromium.launch() in a comment is fine
browser = await launchBrowser(chromium, { args: [] });`;
    expect(directBrowserOpens(ok)).toEqual([]);
    // An agent runtime's launch() in a file with no Playwright.
    expect(directBrowserOpens(`const out = rt.launch(input);`)).toEqual([]);
  });
});

describe("launchBrowser", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function fakeType(connectFails = false) {
    const calls: string[] = [];
    const type = {
      name: () => "webkit",
      launch: async (o?: unknown) => {
        calls.push(`launch ${JSON.stringify(o ?? null)}`);
        return "local" as never;
      },
      connect: async (ws: string, o: unknown) => {
        calls.push(`connect ${ws} ${JSON.stringify(o)}`);
        if (connectFails) throw new Error("connect ECONNREFUSED");
        return "remote" as never;
      },
    };
    return { type: type as unknown as BrowserType, calls };
  }

  it("connects to DEN_PW_WS with the loopback shared, and never launches", async () => {
    process.env.DEN_PW_WS = "ws://pw.test:3921/";
    const { type, calls } = fakeType();
    expect(await launchBrowser(type, { args: ["--x"] })).toBe("remote");
    expect(calls).toEqual([
      'connect ws://pw.test:3921/ {"exposeNetwork":"<loopback>"}',
    ]);
  });

  it("launches with the suite's options when DEN_PW_WS is unset", async () => {
    delete process.env.DEN_PW_WS;
    const { type, calls } = fakeType();
    expect(await launchBrowser(type, { args: ["--x"] })).toBe("local");
    expect(calls).toEqual(['launch {"args":["--x"]}']);
  });

  it("an unreachable DEN_PW_WS fails and says so; no local browser", async () => {
    process.env.DEN_PW_WS = "ws://pw.test:3921/";
    delete process.env.DEN_SKIP_BROWSER_TESTS;
    const { type, calls } = fakeType(true);
    await expect(launchBrowser(type)).rejects.toThrow(
      /DEN_PW_WS is set \(ws:\/\/pw\.test:3921\/\).*no local browser.*ECONNREFUSED/,
    );
    await expect(openBrowser(type)).rejects.toThrow(/DEN_PW_WS is set/);
    expect(calls.some((c) => c.startsWith("launch"))).toBe(false);
  });

  it("openBrowser gives null when it can't open one and DEN_SKIP_BROWSER_TESTS=1", async () => {
    process.env.DEN_PW_WS = "ws://pw.test:3921/";
    process.env.DEN_SKIP_BROWSER_TESTS = "1";
    const { type } = fakeType(true);
    expect(await openBrowser(type)).toBeNull();
    // It opens normally when it can.
    expect(await openBrowser(fakeType().type)).toBe("remote");
  });
});
