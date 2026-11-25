/**
 * Issue 789: the kit's preview helper in a browser. A host page (served by
 * a small server here, with the kit's own files) mounts a preview whose
 * page has a script that tries to reach the host.
 *
 *  - The frame is sandbox="allow-scripts": its script runs, but the host's
 *    DOM, cookies and storage are out of its reach.
 *  - The width changes with no reload, and the frame scales to fit.
 *  - The theme (to sketch) and mode change with no reload.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import type { Browser, Frame, Page } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.resolve(__dirname, "../../../packages/den-ui/src");
let server: http.Server;
let base = "";
let browser: Browser | null = null;

/** The previewed page: a script that tries the host, and says what it got. */
const INSIDE = `<main id="probe">waiting</main><script>
var out = [];
try { out.push("dom:" + parent.document.title); } catch (e) { out.push("dom:blocked"); }
try { out.push("cookie:" + document.cookie); } catch (e) { out.push("cookie:blocked"); }
try { localStorage.getItem("x"); out.push("storage:open"); } catch (e) { out.push("storage:blocked"); }
document.getElementById("probe").textContent = out.join(" ");
</script>`;

// INSIDE has a "</script>" of its own: written raw into the host's script,
// it would end that script early. Each "<" as a JSON \u escape keeps
// the string whole.
const INSIDE_JS = JSON.stringify(INSIDE).replace(/</g, "\\u003c");

const HOST = `<!doctype html><html><head><title>host-secret</title></head>
<body><div id="host" style="width: 600px"></div>
<script type="module">
import { mountPreview } from "/kit/preview.js";
window.pv = mountPreview(document.getElementById("host"), {
  html: ${INSIDE_JS}, width: 1440, height: 600,
});
window.pvReady = true;
</script></body></html>`;

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname === "/") {
      // No CSP of its own: the frame's sandbox is what's under test.
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": "host=secret; Path=/",
      });
      return void res.end(HOST);
    }
    if (u.pathname.startsWith("/kit/")) {
      const f = path.join(SRC, u.pathname.slice(5));
      if (f.startsWith(SRC) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        res.writeHead(200, {
          "content-type": TYPES[path.extname(f)] ?? "text/plain",
        });
        return void res.end(fs.readFileSync(f));
      }
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [server] });
});

async function host(): Promise<{ p: Page; inside: () => Frame }> {
  const p = await browser!.newPage({ viewport: { width: 900, height: 800 } });
  await p.goto(`${base}/`);
  await p.waitForFunction(() => (window as { pvReady?: boolean }).pvReady);
  const inside = () => p.frames().find((f) => f !== p.mainFrame())!;
  await p.waitForFunction(() => {
    const f = document.querySelector("[data-den-preview] iframe");
    return !!f && (f as HTMLIFrameElement).contentDocument === null;
  });
  await inside().waitForFunction(
    () => document.getElementById("probe")?.textContent !== "waiting",
  );
  return { p, inside };
}

describe("issue 789: the preview frame", () => {
  it("is sandboxed: its script runs, the host's DOM, cookies and storage are out of reach", async () => {
    if (!browser) return;
    const { p, inside } = await host();
    expect(await p.getAttribute("[data-den-preview] iframe", "sandbox")).toBe(
      "allow-scripts",
    );
    expect(await inside().textContent("#probe")).toBe(
      "dom:blocked cookie:blocked storage:blocked",
    );
    await p.close();
  }, 60_000);

  it("changes width with no reload, scaled to fit the host", async () => {
    if (!browser) return;
    const { p, inside } = await host();
    await inside().evaluate(() => {
      (window as { mark?: number }).mark = 1;
    });
    const at = () =>
      p.evaluate(() => {
        const b = document.querySelector<HTMLElement>("[data-den-preview]")!;
        return { width: b.dataset.width, scale: Number(b.dataset.scale) };
      });
    // data-scale is rounded to 3 places: 600 / 1440 is 0.417.
    expect(await at()).toEqual({
      width: "1440",
      scale: Math.round((600 / 1440) * 1000) / 1000,
    });
    await p.evaluate(() =>
      (window as { pv?: { setWidth(w: number): void } }).pv!.setWidth(390),
    );
    expect(await at()).toEqual({ width: "390", scale: 1 });
    expect(
      await inside().evaluate(() => (window as { mark?: number }).mark),
    ).toBe(1);
    await p.close();
  }, 60_000);

  it("changes theme (to sketch) and mode with no reload", async () => {
    if (!browser) return;
    const { p, inside } = await host();
    await inside().evaluate(() => {
      (window as { mark?: number }).mark = 1;
    });
    const look = () =>
      inside().evaluate(() => ({
        edge: getComputedStyle(document.documentElement)
          .getPropertyValue("--edge-style")
          .trim(),
        mode: document.documentElement.dataset.mode,
      }));
    expect(await look()).toEqual({ edge: "solid", mode: "light" });
    await p.evaluate(() =>
      (
        window as {
          pv?: { setTheme(t: string | null, m?: string): void };
        }
      ).pv!.setTheme("sketch", "dark"),
    );
    await inside().waitForFunction(
      () =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--edge-style")
          .trim() === "dashed",
    );
    expect(await look()).toEqual({ edge: "dashed", mode: "dark" });
    expect(
      await inside().evaluate(() => (window as { mark?: number }).mark),
    ).toBe(1);
    await p.close();
  }, 60_000);
});
