/**
 * Issue 320 in real browsers, Chromium and WebKit (Safari's engine, the
 * owner's browser): a signed-out page's code must not be approvable once
 * the page has gone.
 *
 *  - Navigated away: WebKit drops the keepalive DELETE its pagehide sends,
 *    so the page also sends a beacon (POST …/withdraw). Within a second
 *    the code has ended: `web approve` (POST /api/web/approve with the
 *    CLI's bearer) answers 410 ended, and the page's poll id claims no
 *    session.
 *  - Closed with no pagehide at all (Playwright's page.close() fires
 *    none): the server ends a request it hasn't heard from within its
 *    unseen bound (DEN_PAIR_UNSEEN_MS, short here). Same answer.
 *  - A page whose polls stall past the bound (a background tab, throttled):
 *    when its poll gets through it is told "gone" and shows a fresh code by
 *    itself, never a dead "expired" screen.
 *
 * DEN_PW_WS=ws://localhost:<port>/ uses browsers behind a Playwright
 * run-server (the Linux image); DEN_SKIP_BROWSER_TESTS=1 skips it. No code,
 * poll id or cookie is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, BrowserContext, Page, Route } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { cliAuthHeaders } from "../../../src/shared/web-secret.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const ENGINE = path.resolve(__dirname, "../../..");
const EDGE = "den.acme.localhost";
const UNSEEN_MS = 4000;
const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let tmp = "";
let stateDir = "";
let port = 0;
let server: ChildProcess;
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const ws = process.env.DEN_PW_WS;
    for (const name of ENGINES)
      browsers[name] = ws
        ? await pw[name].connect(ws, { exposeNetwork: "<loopback>" })
        : name === "chromium"
          ? await pw.chromium.launch({
              args: [`--host-resolver-rules=MAP ${EDGE} 127.0.0.1`],
            })
          : await pw[name].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-unseen-")));
  const root = path.join(tmp, "dist");
  stateDir = path.join(tmp, "home", ".den");
  fs.mkdirSync(path.join(root, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  tls: none",
      "",
    ].join("\n"),
  );
  // Sign in with GitHub off: the code is the only way in.
  fs.writeFileSync(
    path.join(root, "config", "local", "user.yml"),
    'web:\n  github_client_id: ""\n',
  );
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
        DEN_HOME: stateDir,
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
        DEN_PAIR_UNSEEN_MS: String(UNSEEN_MS),
      },
    },
    { timeoutMs: 60_000 },
  );
  server = started.server;
  port = started.port;
}, 120_000);

afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

const local = () => `http://localhost:${port}`;
const edge = () => `http://${EDGE}:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A signed-out page on the edge: its page, and its own request's poll id. */
async function signedOut(
  name: (typeof ENGINES)[number],
): Promise<{ page: Page; pollId: () => string; code: string }> {
  const ctx = await browsers[name]!.newContext();
  contexts.push(ctx);
  const page = await ctx.newPage();
  let id = "";
  page.on("response", (r) => {
    if (
      r.request().method() === "POST" &&
      new URL(r.url()).pathname === "/api/signin/code"
    )
      r.json()
        .then((b: { id?: string }) => (id = String(b.id ?? "")))
        .catch(() => {});
  });
  const r = await page.goto(`${edge()}/settings`);
  expect(r?.status()).toBe(401);
  await page.waitForSelector("#den-pair-code", { timeout: 15_000 });
  const code = ((await page.textContent("#den-pair-code")) ?? "").trim();
  expect(code).toMatch(/^[0-9A-Z]{3}-[0-9A-Z]{3}$/);
  for (let i = 0; i < 50 && !id; i++) await sleep(100);
  expect(id.length).toBeGreaterThan(16);
  return { page, pollId: () => id, code };
}

/** `web approve <code>`: the CLI's bearer, on the Den machine. */
async function approve(
  code: string,
): Promise<{ status: number; code: string }> {
  const r = await fetch(`${local()}/api/web/approve`, {
    method: "POST",
    headers: {
      authorization: cliAuthHeaders(stateDir).Authorization ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({ code }),
  });
  const b = (await r.json()) as { ok?: boolean; code?: string };
  // Approved, the answer holds the code: never shown.
  return { status: r.status, code: b.ok ? "approved" : String(b.code ?? "") };
}

/** The gone page's poll id, polled now: no session to claim. */
async function claimed(id: string): Promise<[number, boolean]> {
  const r = await fetch(`${local()}/api/signin/code/${id}`);
  return [r.status, r.headers.get("set-cookie") !== null];
}

describe.each(ENGINES)("issue 320 in %s", (name) => {
  const skip = () => !browsers[name];

  it("navigated away: within a second its code has ended; approve says ended and no session is claimed", async () => {
    if (skip()) return;
    const { page, pollId, code } = await signedOut(name);
    await page.goto("about:blank");
    await sleep(1000);
    expect(await approve(code)).toEqual({ status: 410, code: "ended" });
    expect(await claimed(pollId())).toEqual([404, false]);
  }, 60_000);

  it("the beacon alone, as the browser sends it (its own Origin), passes the guard and ends the code", async () => {
    if (skip()) return;
    const { page, pollId, code } = await signedOut(name);
    const sent = await page.evaluate(
      (id) =>
        navigator.sendBeacon(
          `/api/signin/code/${encodeURIComponent(id)}/withdraw`,
        ),
      pollId(),
    );
    expect(sent).toBe(true);
    await sleep(500);
    expect(await approve(code)).toEqual({ status: 410, code: "ended" });
  }, 60_000);

  it("closed with no pagehide: past the unseen bound its code has ended; approve says ended and no session is claimed", async () => {
    if (skip()) return;
    const { page, pollId, code } = await signedOut(name);
    await page.close();
    await sleep(UNSEEN_MS + 500);
    expect(await approve(code)).toEqual({ status: 410, code: "ended" });
    expect(await claimed(pollId())).toEqual([404, false]);
  }, 60_000);

  it("a page whose polls stall past the bound (a background tab) shows a fresh code by itself", async () => {
    if (skip()) return;
    const { page, code } = await signedOut(name);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const POLL = /\/api\/signin\/code\/[A-Za-z0-9_-]{16,64}$/;
    await page.route(POLL, async (route: Route) => {
      if (route.request().method() === "GET") await held;
      await route.continue().catch(() => {});
    });
    await sleep(UNSEEN_MS + 1000);
    release();
    await page.waitForFunction(
      (old) => {
        const el = document.getElementById("den-pair-code");
        const t = (el?.textContent ?? "").trim();
        return /^[0-9A-Z]{3}-[0-9A-Z]{3}$/.test(t) && t !== old;
      },
      code,
      { timeout: 15_000 },
    );
    expect(await page.isVisible("#den-pair-ended")).toBe(false);
    // The old code has ended; the new one is the one waiting.
    expect(await approve(code)).toEqual({ status: 410, code: "ended" });
  }, 60_000);
});
