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
 * The check (tests/unit/pw-launch-check.test.ts): no file under tests/ but
 * this one launches or connects a browser itself.
 */
import type { Browser, BrowserType, LaunchOptions } from "playwright";

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

/** A browser for a test: DEN_PW_WS's server, else a local launch. */
export async function launchBrowser(
  engine: BrowserEngine | BrowserType = "chromium",
  options?: LaunchOptions,
): Promise<Browser> {
  const type = await browserType(engine);
  const ws = process.env.DEN_PW_WS;
  if (!ws) {
    const refused = hostWebkitRefusal(
      type.name(),
      process.env,
      process.platform,
    );
    if (refused) throw new Error(refused);
    return type.launch(options);
  }
  try {
    return await type.connect(ws, { exposeNetwork: "<loopback>" });
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
