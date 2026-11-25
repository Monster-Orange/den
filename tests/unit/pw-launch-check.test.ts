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
import type { Browser, BrowserType } from "playwright";
import {
  browserWaitMs,
  directBrowserOpens,
  localBrowserAssumptions,
  hostWebkitRefusal,
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

  /** A connected browser: its contexts say whether a guard routed them. */
  function remoteBrowser() {
    const routes: string[] = [];
    return {
      name: "remote",
      routes,
      newContext: async () => ({
        route: async (p: string) => void routes.push(p),
      }),
    };
  }

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
        return remoteBrowser() as never;
      },
    };
    return { type: type as unknown as BrowserType, calls };
  }

  it("connects to DEN_PW_WS with the loopback shared, and never launches", async () => {
    process.env.DEN_PW_WS = "ws://pw.test:3921/";
    const { type, calls } = fakeType();
    const b = (await launchBrowser(type, {
      args: ["--x"],
    })) as unknown as ReturnType<typeof remoteBrowser>;
    expect(b.name).toBe("remote");
    // Issue 1205: it comes back guarded (the loopback is shared).
    await (b as unknown as Browser).newContext();
    expect(b.routes).toEqual(["**/*"]);
    expect(calls).toEqual([
      'connect ws://pw.test:3921/ {"exposeNetwork":"<loopback>"}',
    ]);
  });

  it("launches with the suite's options when DEN_PW_WS is unset", async () => {
    delete process.env.DEN_PW_WS;
    // A local WebKit on a Mac needs the person's own yes (see below).
    process.env.DEN_HOST_WEBKIT = "1";
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
    expect(
      ((await openBrowser(fakeType().type)) as unknown as { name: string })
        .name,
    ).toBe("remote");
  });
});

// A local WebKit on a shared Mac took down its window server and logged every
// session out. On macOS, WebKit comes from DEN_PW_WS (the Linux image) or CI;
// a person on their own Mac opts in with DEN_HOST_WEBKIT=1.
describe("no local WebKit on a Mac without DEN_PW_WS", () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it("refuses WebKit on macOS with no DEN_PW_WS, and names the way out", () => {
    const why = hostWebkitRefusal("webkit", {}, "darwin");
    expect(why).toMatch(/DEN_PW_WS/);
    expect(why).toMatch(/DEN_HOST_WEBKIT=1/);
  });

  it("allows it with DEN_PW_WS, in CI, with DEN_HOST_WEBKIT=1, off macOS, or for Chromium", () => {
    expect(
      hostWebkitRefusal("webkit", { DEN_PW_WS: "ws://x/" }, "darwin"),
    ).toBeNull();
    expect(hostWebkitRefusal("webkit", { CI: "true" }, "darwin")).toBeNull();
    expect(
      hostWebkitRefusal("webkit", { DEN_HOST_WEBKIT: "1" }, "darwin"),
    ).toBeNull();
    expect(hostWebkitRefusal("webkit", {}, "linux")).toBeNull();
    expect(hostWebkitRefusal("chromium", {}, "darwin")).toBeNull();
  });

  it("launchBrowser never launches a refused WebKit", async () => {
    if (process.platform !== "darwin") return; // the rule is macOS's
    delete process.env.DEN_PW_WS;
    delete process.env.CI;
    delete process.env.DEN_HOST_WEBKIT;
    let launched = false;
    const type = {
      name: () => "webkit",
      launch: async () => {
        launched = true;
        return "local" as never;
      },
    } as unknown as BrowserType;
    await expect(launchBrowser(type)).rejects.toThrow(/DEN_PW_WS/);
    expect(launched).toBe(false);
  });
});

describe("issue 191: browser tests assume no local browser", () => {
  it("no browser test picks a key from the runner's OS, maps a host by a launch argument, or reads a download's path", () => {
    const bad = sources(TESTS)
      .filter((f) => f.endsWith(".browser.test.ts"))
      .flatMap((f) =>
        localBrowserAssumptions(fs.readFileSync(f, "utf-8")).map(
          (w) => `${path.relative(TESTS, f)}: ${w}`,
        ),
      );
    expect(bad).toEqual([]);
  });

  it("finds each one", () => {
    const src = [
      'const mod = process.platform === "darwin" ? "Meta" : "Control";',
      "args: [`--host-resolver-rules=MAP evil.test 127.0.0.1`],",
      "const where = await download.path();",
      "args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1, MAP den.acme.localhost 127.0.0.1`],",
      "// process.platform in a comment is fine",
    ].join("\n");
    expect(localBrowserAssumptions(src)).toEqual([
      "line 1: the runner's OS, not the browser's",
      "line 2: maps evil.test by a launch argument",
      "line 3: a download's local path",
    ]);
  });

  it("a page wait is a setting, 20 s unset", () => {
    expect(browserWaitMs({})).toBe(20_000);
    expect(browserWaitMs({ DEN_BROWSER_WAIT_MS: "45000" })).toBe(45_000);
    expect(browserWaitMs({ DEN_BROWSER_WAIT_MS: "nope" })).toBe(20_000);
  });
});
