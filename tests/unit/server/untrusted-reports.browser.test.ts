/**
 * 0.4.12: files an agent can write are never served as Den's own origin.
 * The approval key lives in this origin's localStorage (web-session.ts);
 * a page Den serves from a repo's test output (the Playwright report at
 * /report/, ZAP's at /reports/security/) is written by whatever ran the
 * tests, an agent included. Each is served sandboxed (CSP `sandbox`
 * without allow-same-origin, nosniff): its scripts run in an opaque
 * origin and can't read Den's storage or call its API as the page.
 *
 * The real server (helpers/error-frame-server.ts) and Chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser } from "playwright";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";

let s: FrameServer | null = null;
let browser: Browser | null = null;

/** A report page that tries to read Den's storage and says what it got. */
const PROBE = `<!doctype html><html><body><pre id="out"></pre><script>
let read;
try { read = String(localStorage.getItem("den.approveKey")); } catch (e) { read = "blocked"; }
document.getElementById("out").textContent = JSON.stringify({ origin: self.origin, read });
</script></body></html>`;

function put(rel: string, body: string): void {
  const f = path.join(s!.tmp, "dist", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startFrameServer({ prefix: "den-untrusted-" });
  put("playwright-report/index.html", PROBE);
  put("reports/security/local/zap.html", PROBE);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
  removeFrameTmp(s);
});

describe("a report a test run wrote", () => {
  it.each([["/report/"], ["/reports/security/local/zap.html"]])(
    "%s runs in an opaque origin: it can't read Den's localStorage",
    async (p) => {
      if (!browser) return;
      const page = await browser.newPage();
      // Den's page holds an approval key.
      await page.goto(`${s!.base}/services`);
      await page.evaluate(() =>
        localStorage.setItem("den.approveKey", "k".repeat(43)),
      );
      const r = await page.goto(`${s!.base}${p}`);
      expect(r?.status()).toBe(200);
      expect(r?.headers()["content-security-policy"]).toMatch(/^sandbox\b/);
      expect(r?.headers()["content-security-policy"]).not.toMatch(
        /allow-same-origin/,
      );
      expect(r?.headers()["x-content-type-options"]).toBe("nosniff");
      await page.waitForFunction(
        () => document.getElementById("out")?.textContent,
      );
      const got = JSON.parse((await page.textContent("#out")) ?? "{}") as {
        origin: string;
        read: string;
      };
      expect(got).toEqual({ origin: "null", read: "blocked" });
      await page.close();
    },
    60_000,
  );
});
