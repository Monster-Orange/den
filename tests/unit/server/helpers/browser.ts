/**
 * The one place a test gets a browser. DEN_PW_WS=ws://host:port/ connects
 * to a Playwright run-server (the Linux image: CI, or a shell with no GUI
 * session) instead of starting one here. The remote browser's localhost
 * and *.localhost are this machine's (exposeNetwork "<loopback>"), so a
 * test server on 127.0.0.1 answers as it would locally. Launch-only
 * options (args such as --host-resolver-rules) apply only to a local
 * launch: the run-server chose its own. tests/unit/test-infra/
 * pw-launch-guard.test.ts keeps every other test file off
 * `.launch(`.
 */
import type { Browser, LaunchOptions } from "playwright";

export type BrowserKind = "chromium" | "firefox" | "webkit";

/** A browser of `kind`: remote when DEN_PW_WS is set, else launched here. */
export async function openBrowser(
  kind: BrowserKind = "chromium",
  launchOpts?: LaunchOptions,
): Promise<Browser> {
  const pw = await import("playwright");
  const ws = process.env.DEN_PW_WS;
  return ws
    ? pw[kind].connect(ws, { exposeNetwork: "<loopback>" })
    : pw[kind].launch(launchOpts);
}
