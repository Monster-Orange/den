/**
 * SEC-1a in a real browser (SEC-1 spec §7's gate): a page on another origin
 * can't change anything on Den's server, and Den's own shell still can.
 *
 * A second tiny HTTP server on another port serves the attacker's page. It
 * POSTs to Den's /api/settings with fetch(mode: "no-cors") and with a
 * cross-site form; the route's side effect (config/local/user.yml) must not
 * happen. Then Den's own page makes the same change through
 * denShell.api(), which carries the CSRF token on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as net from "net";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import type { Browser } from "playwright";
import { startDenServer, stopServer } from "../../child-servers.js";

const ENGINE = path.resolve(__dirname, "../../..");
let browser: Browser | null = null;
let tmp = "";
let userYml = "";
let port = 0;
let server: ChildProcess;
let evil: http.Server | null = null;
let evilPort = 0;
/** What the attacker's server saw: its page was loaded (so the attack ran). */
let evilHits = 0;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "localhost", r));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const yml = () =>
  fs.existsSync(userYml) ? fs.readFileSync(userYml, "utf-8") : "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-xorigin-")));
  const root = path.join(tmp, "dist");
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    "environments: [local]\n",
  );
  userYml = path.join(root, "config", "local", "user.yml");
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        ...process.env,
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
    { timeoutMs: 30_000 },
  );
  server = started.server;
  port = started.port;

  // The attacker: another origin (another port), its page aimed at Den.
  evilPort = await freePort();
  const den = `http://localhost:${port}`;
  evil = http.createServer((req, res) => {
    evilHits++;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body>
<form id="f" method="POST" action="${den}/api/settings" enctype="text/plain" target="sink">
  <input name='{"editor":"emacs","x":"' value='"}'>
</form>
<iframe name="sink"></iframe>
<script>
  window.attack = async () => {
    await fetch(${JSON.stringify(den)} + "/api/settings", {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ editor: "emacs" }),
    }).catch(() => {});
    return "sent";
  };
</script></body></html>`);
  });
  await new Promise<void>((r) => evil!.listen(evilPort, "localhost", r));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (evil) await new Promise<void>((r) => evil!.close(() => r()));
  await stopServer(server);
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("a page on another origin (SEC-1a)", () => {
  it("can't POST to Den's /api: neither fetch(no-cors) nor a form runs the route; Den's own shell can", async () => {
    if (!browser) return;
    const before = yml();
    expect(before).not.toMatch(/editor:/);
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    // What Den answered the attacker's requests (the browser saw them).
    const refused: number[] = [];
    p.on("response", (r) => {
      if (
        new URL(r.url()).port === String(port) &&
        r.request().method() === "POST"
      )
        refused.push(r.status());
    });

    await p.goto(`http://localhost:${evilPort}/`);
    expect(evilHits).toBeGreaterThan(0);
    expect(
      await p.evaluate(() =>
        (window as unknown as { attack: () => Promise<string> }).attack(),
      ),
    ).toBe("sent");
    // The form, too: a top-level cross-site POST into the iframe.
    const formDone = p.waitForResponse(
      (r) =>
        r.url().endsWith("/api/settings") && r.request().method() === "POST",
    );
    await p.evaluate(() =>
      (document.getElementById("f") as HTMLFormElement).submit(),
    );
    await formDone;
    // Both reached Den and were refused before the route ran.
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const s of refused) expect(s).toBe(403);
    expect(yml()).toBe(before);

    // Den's own shell: the same change through denShell.api().
    const own = await ctx.newPage();
    await own.goto(`http://localhost:${port}/settings`);
    await own.waitForFunction(
      () =>
        !!(window as unknown as { denShell?: { api?: unknown } }).denShell?.api,
    );
    const answer = await own.evaluate(async () => {
      const sh = (
        window as unknown as {
          denShell: {
            api: (m: string, u: string, b: unknown) => Promise<unknown>;
          };
        }
      ).denShell;
      await sh.api("POST", "/api/settings", { editor: "zed" });
      return "ok";
    });
    expect(answer).toBe("ok");
    expect(yml()).toMatch(/editor: zed/);
    // And a page's own fetch() (not through denShell.api) is covered too.
    const status = await own.evaluate(async () => {
      const r = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ editor: "vim" }),
      });
      return r.status;
    });
    expect(status).toBe(200);
    expect(yml()).toMatch(/editor: vim/);

    // A stale token (the server restarted under an open page): the first
    // answer is 403 csrf; the shell fetches a fresh token and retries once.
    // The settings page's Access row asks /api/session too (when it
    // redraws), so the token fetch is counted as at least one, and the retry
    // by the POSTs: the refused one and exactly one more.
    let sessions = 0;
    let posts = 0;
    own.on("request", (r) => {
      const p = new URL(r.url()).pathname;
      if (p === "/api/session") sessions++;
      if (p === "/api/settings" && r.method() === "POST") posts++;
    });
    let refusedOnce = false;
    await own.route("**/api/settings", async (route) => {
      if (route.request().method() === "POST" && !refusedOnce) {
        refusedOnce = true;
        return route.fulfill({
          status: 403,
          json: {
            ok: false,
            error: "stale",
            code: "csrf",
            requestId: "00000000",
          },
        });
      }
      return route.continue();
    });
    await own.evaluate(async () => {
      const sh = (
        window as unknown as {
          denShell: {
            api: (m: string, u: string, b: unknown) => Promise<unknown>;
          };
        }
      ).denShell;
      await sh.api("POST", "/api/settings", { editor: "emacs" });
    });
    expect(refusedOnce).toBe(true);
    expect(posts).toBe(2);
    expect(sessions).toBeGreaterThanOrEqual(1);
    expect(yml()).toMatch(/editor: emacs/);
    await ctx.close();
  }, 60_000);

  // A shell-grade GET (route-classes.ts): /api/service/exec streams over GET,
  // so an <img src> or a no-cors fetch from another origin is the attack.
  // Its side effect: the route audits every call, even one whose service
  // doesn't exist (a refused exec in the activity list), so nothing need run.
  it("can't start a run over GET (img src, no-cors fetch); Den's own page can", async () => {
    if (!browser) return;
    const exec = (svc: string) =>
      `http://localhost:${port}/api/service/exec?repo=widget&service=${svc}&cmd=up&env=local`;
    const activity = async (svc: string) =>
      (
        (await (
          await fetch(
            `http://localhost:${port}/api/activity?address=widget/${svc}`,
          )
        ).json()) as { entries: unknown[] }
      ).entries.length;
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    const answers: number[] = [];
    // Both requests leave the browser (Chrome may block the img's JSON
    // answer before a response event, so the requests are what's counted).
    p.on("request", (r) => {
      if (new URL(r.url()).pathname === "/api/service/exec")
        answers.push(r.method() === "GET" ? 1 : 0);
    });
    await p.goto(`http://localhost:${evilPort}/`);
    await p.evaluate(async (u) => {
      await new Promise<void>((done) => {
        const img = new Image();
        img.onload = img.onerror = () => done();
        img.src = u;
      });
      await fetch(u.replace("svc-img", "svc-fetch"), { mode: "no-cors" }).catch(
        () => {},
      );
    }, exec("svc-img"));
    // Request events can land after the page's promises settle.
    for (let i = 0; i < 100 && answers.length < 2; i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(answers).toEqual([1, 1]);
    expect(await activity("svc-img")).toBe(0);
    expect(await activity("svc-fetch")).toBe(0);

    // Den's own page: the same request runs the route (an EventSource, as
    // the shell's runner opens it).
    const own = await ctx.newPage();
    await own.goto(`http://localhost:${port}/settings`);
    const got = await own.evaluate(
      (u) =>
        new Promise<string>((done) => {
          const es = new EventSource(u);
          es.onmessage = (e) => {
            es.close();
            done(String(e.data));
          };
          es.onerror = () => {
            es.close();
            done("error");
          };
        }),
      exec("svc-own"),
    );
    expect(got).not.toBe("error");
    expect(await activity("svc-own")).toBe(1);
    await ctx.close();
  }, 60_000);
});
