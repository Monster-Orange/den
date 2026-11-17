/**
 * Issue 415: a Den whose Report destination is private says so. Den's own
 * GET /api/report (report-routes.ts, with a fake `gh`: no network) feeds
 * the kit's Report form, as den-kit.js does; Review shows the private pill
 * and no public warning. A failed lookup reads as public.
 *
 * On a bare page built from the kit's own files, in Chromium and WebKit.
 * DEN_PW_WS: Den's own Playwright server instead of a local browser.
 * DEN_SKIP_BROWSER_TESTS=1 skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import {
  handleReportRoutes,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://den-vis.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

/** Den's own Report routes, with a fake `gh` that says `answer`. */
function den(answer: GhResult): ReportRouteDeps {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "den-vis-b-"));
  return {
    settings: () =>
      feedbackSettings(
        { bugs: { url: "https://github.com/acme-eng/engine/issues" } },
        {},
        {},
      ),
    stateDir: () => state,
    gh: async (args) =>
      args[0] === "auth"
        ? { code: 0, stdout: "", stderr: "" }
        : args[0] === "api" && args[1] === "repos/acme-eng/engine"
          ? answer
          : { code: 1, stdout: "", stderr: "unknown" },
    names: () => ({ home: "/Users/pat", hosts: [], projects: [] }),
    diagnostics: async () => ({}),
    agentOf: () => null,
    personOf: () => "person",
    readBody: async () => "",
    sendJson: (res, body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
  };
}

/** One GET through Den's handler, in this process: [status, body]. */
function call(d: ReportRouteDeps, p: string): Promise<[number, string]> {
  return new Promise((ok) => {
    const req = Object.assign(new http.IncomingMessage(null as never), {
      method: "GET",
      url: p,
      headers: {},
    });
    let status = 200;
    const res = {
      writeHead: (s: number) => ((status = s), res),
      end: (b?: string) => ok([status, b ?? ""]),
    } as unknown as http.ServerResponse;
    if (!handleReportRoutes(req, res, p, d)) ok([404, ""]);
  });
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="/kit/tokens.css">
<link rel="stylesheet" href="/kit/base.css">
</head><body><main><p>A page</p></main>
<script type="module">
  import { configureReport, openReport } from "/kit/report.js";
  // As den-kit.js: info is Den's GET /api/report.
  configureReport({
    lang: "en",
    screenshot: false,
    adapter: {
      info: () => fetch("/api/report").then((r) => r.json()),
      send: async () => ({ status: 200, data: {} }),
    },
  });
  window.go = () => openReport({ prefill: { title: "Pane drops" } });
  window.ready = true;
</script>
</body></html>`;

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
};

async function review(b: Browser, d: ReportRouteDeps): Promise<Page> {
  const ctx = await b.newContext({
    viewport: { width: 1000, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    if (u.pathname.startsWith("/api/report")) {
      const [status, body] = await call(d, u.pathname);
      return r.fulfill({ status, contentType: "application/json", body });
    }
    const file = path.join(SRC, u.pathname.replace(/^\/kit\//, ""));
    if (u.pathname.startsWith("/kit/") && fs.existsSync(file))
      return r.fulfill({
        contentType: TYPES[path.extname(file)] || "text/plain",
        body: fs.readFileSync(file),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  await p.evaluate(() => (window as unknown as { go: () => void }).go());
  const dlg = p.locator("dialog.fb-dlg");
  await dlg.locator('[data-act="next"]').click();
  await dlg.locator('[data-act="review"]').click();
  await p.waitForFunction(
    () =>
      document.querySelector("dialog.fb-dlg")?.getAttribute("data-step") ===
      "review",
  );
  return p;
}

const seen = (p: Page) =>
  p.evaluate(() => {
    const d = document.querySelector("dialog.fb-dlg")!;
    return {
      pill: d.querySelector(".fb-dest .fb-pill")?.textContent,
      warn: d.querySelectorAll(".fb-warn").length,
      note: d.querySelectorAll("[data-vis-note]").length,
    };
  });

describe.each(["chromium", "webkit"])(
  "Den's Report says a private destination is private (%s)",
  (name) => {
    it("a private repo in config: the private pill, no public warning", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await review(
        b,
        den({
          code: 0,
          stdout: JSON.stringify({ private: true, visibility: "private" }),
          stderr: "",
        }),
      );
      expect(await seen(p)).toEqual({
        pill: "Private repository",
        warn: 0,
        note: 1,
      });
      await p.context().close();
    }, 60_000);

    it("a failed lookup: public, as before", async () => {
      const b = browsers[name];
      if (!b) return;
      const p = await review(
        b,
        den({ code: 1, stdout: "", stderr: "HTTP 404: Not Found" }),
      );
      expect(await seen(p)).toEqual({
        pill: "Public repository",
        warn: 1,
        note: 0,
      });
      await p.context().close();
    }, 60_000);
  },
);
