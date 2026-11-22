/**
 * den-ui 0.10.0, issue 394: DUI.saveShell keeps a rail change that the
 * person leaves the page right after. A bare page built from the kit's own
 * file saves a patch to a small server here and, in the same tick, goes to
 * another page. The server reads a save's body only after 300 ms, as a
 * busy server may, so a plain fetch is cancelled by the navigation. After
 * the next page has loaded, the server holds the saved state.
 *
 * Also: the save carries the time it was made (changedAt, ms), so the
 * server can keep the newer of two; it answers true or false; and when
 * the page hides before the save is confirmed, the kit sends it again as
 * a beacon (a JSON Blob, which no custom header rides on).
 *
 * In Chromium and WebKit. DEN_PW_WS: Den's own Playwright server instead
 * of a local browser. DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";
import type { Browser } from "playwright";
import { launchBrowser } from "../helpers/browser.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const browsers: Record<string, Browser> = {};

interface Save {
  body: Record<string, unknown> | null;
  contentType: string;
  csrf: string | undefined;
}
const saves: Save[] = [];
/** How long the server waits before it reads a save's body. */
let slowMs = 300;
/** What a save answers. */
let answer = 200;

const PAGE_A = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>A</title></head>
<body><a id="next" href="/b">Next</a>
<script type="module">
import { saveShell } from "/kit/save-shell.js";
window.saveShell = saveShell;
window.ready = true;
</script></body></html>`;

const PAGE_B = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>B</title></head>
<body><p id="b">The next page</p></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "POST" && url.pathname === "/save") {
    const ct = String(req.headers["content-type"] ?? "");
    const csrf = req.headers["x-probe-csrf"] as string | undefined;
    setTimeout(() => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let body: Record<string, unknown> | null = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          body = null;
        }
        saves.push({ body, contentType: ct, csrf });
        res.writeHead(answer, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: answer < 400 }));
      });
      req.on("error", () => {});
    }, slowMs);
    return;
  }
  if (url.pathname === "/a" || url.pathname === "/b") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(url.pathname === "/a" ? PAGE_A : PAGE_B);
    return;
  }
  if (url.pathname.startsWith("/kit/")) {
    const rel = url.pathname.slice("/kit/".length);
    const file = path.join(SRC, rel);
    if (!rel.includes("..") && fs.existsSync(file)) {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(fs.readFileSync(file));
      return;
    }
  }
  res.writeHead(404);
  res.end();
});
let origin = "";

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [server],
  });
}, 60_000);

/** The saves whose patch has this key (a save from an earlier page may still land). */
const mine = (key: string) =>
  saves.filter((s) => s.body?.shell && key in (s.body.shell as object));

async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

async function pageA(engine: string) {
  const ctx = await browsers[engine]!.newContext();
  const p = await ctx.newPage();
  await p.goto(`${origin}/a`);
  await p.waitForFunction(
    () => (window as unknown as { ready?: boolean }).ready,
  );
  return { ctx, p };
}

describe.each(["chromium", "webkit"])("DUI.saveShell in %s", (engine) => {
  const skip = () => !browsers[engine];

  it("a save, then a link at once (same tick): the server holds it after the next page", async () => {
    if (skip()) return;
    saves.length = 0;
    slowMs = 300;
    answer = 200;
    const { ctx, p } = await pageA(engine);
    await p.evaluate(() => {
      const w = window as unknown as {
        saveShell: (u: string, patch: unknown) => Promise<boolean>;
      };
      void w.saveShell("/save", { pins: ["garden"] });
      (document.getElementById("next") as HTMLAnchorElement).click();
    });
    await p.waitForURL(`${origin}/b`);
    await p.waitForSelector("#b");
    await waitFor(() => saves.length > 0, 3000);
    const got = saves.map((s) => s.body?.shell);
    expect(got.length).toBeGreaterThan(0);
    for (const s of got)
      expect(s).toMatchObject({
        pins: ["garden"],
        changedAt: expect.any(Number),
      });
    await ctx.close();
  }, 30_000);

  it("answers true when saved, false when the server says no; the patch carries changedAt; headers ride the fetch", async () => {
    if (skip()) return;
    saves.length = 0;
    slowMs = 0;
    const { ctx, p } = await pageA(engine);
    const before = Date.now();
    answer = 200;
    const yes = await p.evaluate(() =>
      (
        window as unknown as {
          saveShell: (u: string, p: unknown, o: unknown) => Promise<boolean>;
        }
      ).saveShell(
        "/save",
        { collapsed: true },
        {
          headers: { "X-Probe-Csrf": "t1" },
        },
      ),
    );
    expect(yes).toBe(true);
    const got = mine("collapsed");
    expect(got).toHaveLength(1);
    expect(got[0]!.csrf).toBe("t1");
    expect(got[0]!.contentType).toMatch(/^application\/json/);
    const at = (got[0]!.body!.shell as { changedAt: number }).changedAt;
    expect(at).toBeGreaterThanOrEqual(before - 5_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 5_000);
    answer = 500;
    const no = await p.evaluate(() =>
      (
        window as unknown as {
          saveShell: (u: string, p: unknown) => Promise<boolean>;
        }
      ).saveShell("/save", { collapsed: false }),
    );
    expect(no).toBe(false);
    answer = 200;
    // changedAt given by the host is kept (two saves keep their order).
    await p.evaluate(() =>
      (
        window as unknown as {
          saveShell: (u: string, p: unknown, o: unknown) => Promise<boolean>;
        }
      ).saveShell("/save", { dock: true }, { changedAt: 1234 }),
    );
    expect(mine("dock").at(-1)!.body).toEqual({
      shell: { dock: true, changedAt: 1234 },
    });
    await ctx.close();
  }, 30_000);

  it("the page hides before the save is confirmed: it goes again as a beacon (a JSON Blob)", async () => {
    if (skip()) return;
    saves.length = 0;
    slowMs = 600;
    answer = 200;
    const { ctx, p } = await pageA(engine);
    await p.evaluate(() => {
      const w = window as unknown as {
        saveShell: (u: string, patch: unknown) => Promise<boolean>;
      };
      void w.saveShell(
        "/save",
        { order: ["home"] },
        {
          headers: { "X-Probe-Csrf": "t3" },
        },
      );
      window.dispatchEvent(new Event("pagehide"));
    });
    await waitFor(() => mine("order").length >= 2, 4000);
    const got = mine("order");
    expect(got).toHaveLength(2);
    const [a, b] = got.map((s) => s.body?.shell as { changedAt: number });
    // The same save twice: the same changedAt, so the server keeps one.
    expect(a).toEqual(b);
    // The fetch carries the host's header; the beacon can't (a JSON Blob).
    expect(got.map((s) => s.csrf ?? null).sort()).toEqual(["t3", null].sort());
    const beacon = got.find((s) => s.csrf === undefined)!;
    expect(beacon.contentType).toMatch(/^application\/json/);
    await ctx.close();
  }, 30_000);
});
