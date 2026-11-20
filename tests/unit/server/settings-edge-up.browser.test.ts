/**
 * Issue 395: Settings › Access, with no edge hostname, never says "then
 * `edge up`": it has a Start the edge button (Apply, when the edge runs).
 * The button shows the working pop-up until the server answers, then says
 * what happened: started, up to date (nothing restarted), or recreated and
 * why (#385).
 *
 * The edge runner is faked at the page's network: the answers of
 * GET /api/web/pair, GET /api/edge and POST /api/edge/up are the test's,
 * so nothing reaches Docker (the demo's docker is a failing shim anyway).
 * Chromium and WebKit; DEN_PW_WS connects to a Playwright server instead
 * of launching. The demo distribution (helpers/agents-page-server.ts).
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(60_000);

const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [s],
  });
});

/** The fake edge: whether it runs, and what each Start the edge answers. */
async function open(
  e: (typeof ENGINES)[number],
  edge: { up: boolean; answers: unknown[] },
): Promise<{ p: Page; posts: number[] }> {
  const ctx = await browsers[e]!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s!.stateDir, s!.base);
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  const posts: number[] = [];
  await p.route("**/api/web/pair", (r) =>
    r.request().method() === "GET"
      ? r.fulfill({ json: { hosts: [] } })
      : r.continue(),
  );
  await p.route("**/api/edge", (r) =>
    r.fulfill({ json: { configured: true, up: edge.up } }),
  );
  await p.route("**/api/edge/up", async (r) => {
    posts.push(Date.now());
    // Slow enough that the working pop-up opens (the kit's OPEN_MS).
    await new Promise((ok) => setTimeout(ok, 1500));
    await r.fulfill({ json: { ok: true, outcome: edge.answers.shift() } });
  });
  return { p, posts };
}

const dialog = (p: Page) => p.locator("dialog.bz-dlg[open]");

async function press(p: Page): Promise<string> {
  await p.locator("#set-edge-up").click();
  await dialog(p).waitFor({ timeout: 5000 });
  expect(await dialog(p).locator("h2").textContent()).toContain(
    "Starting the edge",
  );
  const out = p.locator("#set-edge-up-out:not([hidden])");
  await out.waitFor({ timeout: 15_000 });
  return (await out.textContent()) ?? "";
}

describe.each(ENGINES)("issue 395 in %s: Start the edge", (e) => {
  it("no edge hostname: a Start the edge button, no command to run; it says Edge started", async () => {
    if (!browsers[e] || !s) return;
    const { p, posts } = await open(e, {
      up: false,
      answers: [{ kind: "started", changes: [], downSeconds: null }],
    });
    await p.goto(`${s.base}/settings#access`);
    const btn = p.locator("#set-edge-up");
    await btn.waitFor({ timeout: 20_000 });
    const says = (await p.locator("#set-pair").textContent()) ?? "";
    expect(says).not.toMatch(/\brun\b|then [^.]*edge up/i);
    expect(says).toContain("use the button below");
    expect(await btn.textContent()).toBe("Start the edge");

    expect(await press(p)).toBe("Edge started");
    expect(posts.length).toBe(1);
    expect(await btn.textContent()).toBe("Apply");
    await p.context().close();
  });

  it("the edge running: Apply; it says why it was recreated, or that nothing restarted", async () => {
    if (!browsers[e] || !s) return;
    const { p } = await open(e, {
      up: true,
      answers: [
        {
          kind: "recreated",
          changes: [
            {
              field: "image",
              old: "traefik:v3.7.17",
              new: "traefik@sha256:abababababab",
            },
          ],
          downSeconds: 27,
        },
        { kind: "current", changes: [], downSeconds: null },
      ],
    });
    await p.goto(`${s.base}/settings#access`);
    const btn = p.locator("#set-edge-up");
    await btn.waitFor({ timeout: 20_000 });
    await p.waitForFunction(
      () => document.querySelector("#set-edge-up")?.textContent === "Apply",
      undefined,
      { timeout: 5000 },
    );

    expect(await press(p)).toBe(
      "Edge recreated because image: traefik:v3.7.17 → traefik@sha256:abababababab; it was unreachable for about 27 s",
    );
    await dialog(p).waitFor({ state: "detached", timeout: 10_000 });
    await p.locator("#set-edge-up:not([disabled])").waitFor();
    expect(await press(p)).toBe("Edge up to date, nothing restarted");
    await p.context().close();
  });
});
