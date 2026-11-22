/**
 * One way for a test to get a browser (issue 463).
 *
 * - DEN_PW_WS set: connect to that Playwright server, with the loopback
 *   shared (`exposeNetwork: "<loopback>"`), so the remote browser reaches
 *   this machine's localhost and *.localhost. Launch options do not apply
 *   there. It never falls back to a local browser: an unreachable server
 *   fails the suite and names DEN_PW_WS.
 * - DEN_PW_WS unset: launch a local browser with the suite's options,
 *   except WebKit on macOS outside CI: a local WebKit on a shared Mac took
 *   down its window server and logged every session out. There it is
 *   refused unless DEN_HOST_WEBKIT=1 (a person on their own Mac).
 *
 * `launchBrowser` throws when it can't open one; a suite's own catch decides
 * whether DEN_SKIP_BROWSER_TESTS=1 skips it. `openBrowser` does that itself:
 * it gives null instead of throwing when DEN_SKIP_BROWSER_TESTS=1.
 *
 * - The gate gave the run a test box (DEN_GATE_BOX, issue 991): every
 *   context is held to the run's base URLs (DEN_GATE_ALLOW, Den's
 *   shared/gates/pw-guard), localhost names are pinned to 127.0.0.1, and
 *   each refused request is recorded (`boxGuardBlocks`) and printed. A
 *   "host:*" base URL covers only the ports this run serves (./own-ports:
 *   its servers while they listen, and child servers a helper saw answer).
 *   A box run with no base URLs opens no browser.
 *
 * The check (tests/unit/pw-launch-check.test.ts): no file under tests/ but
 * this one launches or connects a browser itself.
 */
import type { Browser, BrowserType, LaunchOptions, Page } from "playwright";
import {
  allowFromEnv,
  guardBrowser,
  pinLoopbackNames,
} from "../../../src/shared/gates/pw-guard.js";
import { ownPorts } from "./own-ports.js";

export { boxOwnPort } from "./own-ports.js";

export type BrowserEngine = "chromium" | "firefox" | "webkit";

async function browserType(
  engine: BrowserEngine | BrowserType,
): Promise<BrowserType> {
  if (typeof engine !== "string") return engine;
  const pw = await import("playwright");
  return pw[engine];
}

/** Why a local launch of `engine` is refused here, or null when it isn't. */
export function hostWebkitRefusal(
  engine: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | null {
  if (engine !== "webkit" || platform !== "darwin") return null;
  if (env.DEN_PW_WS || env.CI === "true" || env.DEN_HOST_WEBKIT === "1")
    return null;
  return (
    "A local WebKit on macOS is refused: it can take down the window " +
    "server and log every session out. Set DEN_PW_WS to the Linux " +
    "Playwright server, run it in CI, or on your own Mac set " +
    "DEN_HOST_WEBKIT=1."
  );
}

const blocks: string[] = [];
let pinned = false;

/** Requests the box guard refused in this process (issue 991). */
export function boxGuardBlocks(): string[] {
  return [...blocks];
}

/** On a box run, holds `browser` to the run's base URLs. */
function boxGuarded(browser: Browser, env: NodeJS.ProcessEnv): Browser {
  if (!env.DEN_GATE_BOX) return browser;
  const allow = allowFromEnv(env);
  if (!pinned) {
    pinLoopbackNames();
    pinned = true;
  }
  guardBrowser(
    browser,
    allow,
    (url) => {
      blocks.push(url);
      console.error(
        `box guard: refused ${url} (allowed: ${allow.join(", ")}; a "host:*" ` +
          "entry covers only the ports this test process opened)",
      );
    },
    ownPorts(),
  );
  // browser.newPage() makes its own context, not through newContext: give
  // it a guarded one, closed with the page as Playwright's would be.
  browser.newPage = async (o?: Parameters<Browser["newPage"]>[0]) => {
    const ctx = await browser.newContext(o);
    const page = await ctx.newPage();
    page.once("close", () => void ctx.close().catch(() => {}));
    return page;
  };
  return browser;
}

/** A browser for a test: DEN_PW_WS's server, else a local launch. */
export async function launchBrowser(
  engine: BrowserEngine | BrowserType = "chromium",
  options?: LaunchOptions,
): Promise<Browser> {
  if (process.env.DEN_GATE_BOX && !allowFromEnv(process.env).length)
    throw new Error(
      `The gate gave this run test box ${process.env.DEN_GATE_BOX} but no ` +
        "base URLs (DEN_GATE_ALLOW is empty): no browser opens. Ask with " +
        "gate run --base-url http://127.0.0.1:* (any port but 80 and 443).",
    );
  const type = await browserType(engine);
  const ws = process.env.DEN_PW_WS;
  if (!ws) {
    const refused = hostWebkitRefusal(
      type.name(),
      process.env,
      process.platform,
    );
    if (refused) throw new Error(refused);
    return boxGuarded(await type.launch(options), process.env);
  }
  try {
    return boxGuarded(
      await type.connect(ws, { exposeNetwork: "<loopback>" }),
      process.env,
    );
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(
      `DEN_PW_WS is set (${ws}) but its Playwright server gave no ` +
        `${type.name()} browser; no local browser is started instead. ${why}`,
    );
  }
}

/** launchBrowser, or null when it can't and DEN_SKIP_BROWSER_TESTS=1. */
export async function openBrowser(
  engine: BrowserEngine | BrowserType = "chromium",
  options?: LaunchOptions,
): Promise<Browser | null> {
  try {
    return await launchBrowser(engine, options);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return null;
    throw err;
  }
}

/**
 * Issue 191: how long a test waits for something the page shows (a
 * terminal's line, say), never a fixed few seconds: a remote browser
 * (DEN_PW_WS) adds its proxy's round trips. DEN_BROWSER_WAIT_MS sets it;
 * 20 s unset. A wait still ends as soon as the thing shows.
 */
export function browserWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.DEN_BROWSER_WAIT_MS);
  return Number.isFinite(n) && n > 0 ? n : 20_000;
}

/**
 * Issue 191: whether the page's browser is on a Mac, as the page itself
 * decides (term-input.js isMac): never the test runner's process.platform,
 * since a remote browser (DEN_PW_WS) runs on another OS. For a label the
 * page shows (⌘ or Ctrl+); a key to press is "ControlOrMeta".
 */
export function pageIsMac(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const nav = navigator as Navigator & {
      userAgentData?: { platform?: string };
    };
    return /mac|iphone|ipad/i.test(
      nav.userAgentData?.platform || nav.platform || "",
    );
  });
}

/** Where a test source launches or connects a browser itself (the check). */
export function directBrowserOpens(source: string): string[] {
  if (!/["']playwright["']/.test(source)) return [];
  const out: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment
    if (/\.launch(PersistentContext|Server)?\s*\(/.test(line))
      out.push(`line ${i + 1}: launches a browser without launchBrowser`);
    else if (/exposeNetwork/.test(line))
      out.push(`line ${i + 1}: connects to DEN_PW_WS without launchBrowser`);
  });
  return out;
}

/**
 * Issue 191: where a browser test assumes the browser runs on this
 * machine, which a remote one (DEN_PW_WS) doesn't: the runner's OS picking
 * a key or label (process.platform: use "ControlOrMeta" and pageIsMac), a
 * host mapped by a launch argument other than a *.localhost one (a remote
 * browser takes no launch arguments; *.localhost is loopback there too),
 * and a download's local path (use saveAs).
 */
export function localBrowserAssumptions(source: string): string[] {
  const out: string[] = [];
  source.split("\n").forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment
    if (/process\.platform/.test(line))
      out.push(`line ${i + 1}: the runner's OS, not the browser's`);
    for (const m of line.matchAll(/MAP\s+([^\s,`'"]+)/g))
      if (!/\.localhost$|^\$\{/.test(m[1]))
        out.push(`line ${i + 1}: maps ${m[1]} by a launch argument`);
    if (/\.path\(\)/.test(line) && /download|\bdl\b/i.test(line))
      out.push(`line ${i + 1}: a download's local path`);
  });
  return out;
}
