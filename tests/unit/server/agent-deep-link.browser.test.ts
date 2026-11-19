/**
 * Issue 103, the deep link, through the real routes:
 * `/p/<project>/agents/<id>?context=<url>` opens the Agents page on that
 * agent with the URL in its composer. Nothing reaches the agent until the
 * person presses Send; then the message, then Enter.
 *
 *   - a project that isn't there, another project's agent, a context that
 *     isn't http(s), or one past Settings › Embedding's limit: a page that
 *     says which, never a blank Agents page;
 *   - at 375 px the composer fits and nothing scrolls sideways.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): what the agent got is
 * what the PTY was written. DEN_HELPERS_BROWSER=webkit runs it in WebKit.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let pty: ScriptedPty;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:scout",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  pty = s.made.at(-1)!;
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:scout",
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const typed = (from: number) =>
  Buffer.concat(pty.writes.slice(from)).toString("utf8");

async function page(width = 1280): Promise<{ p: Page; errors: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, s.stateDir, s.base);
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
  });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  return { p, errors };
}

const CONTEXT = "https://example.test/docs/page?a=1&b=two#part";
const box = (p: Page) => p.locator(`.pane[data-id="${sid}"] .agc .agc-in`);

/** Holds the page's requests to `url` until the returned call. */
async function hold(p: Page, url: string): Promise<() => void> {
  let go = () => {};
  const held = new Promise<void>((r) => (go = r));
  await p.route(url, async (r) => {
    await held;
    await r.continue();
  });
  return go;
}

/** What's new, open over the page (this version unseen): closed. */
async function closeWhatsNew(p: Page): Promise<void> {
  await p.locator("#cl-overlay.open").waitFor({ timeout: 20_000 });
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  await p.locator("#cl-overlay.open").waitFor({ state: "detached" });
}

/** The composer has the keyboard (or this fails, naming what has it). */
async function composerFocused(p: Page): Promise<void> {
  const ok = await p
    .waitForFunction(
      () => document.activeElement?.classList.contains("agc-in"),
      undefined,
      { timeout: 5_000 },
    )
    .then(() => true)
    .catch(() => false);
  const at = ok
    ? "the composer"
    : await p.evaluate(() => {
        const a = document.activeElement;
        return `${a?.tagName}#${a?.id}.${a?.className}`;
      });
  expect(at).toBe("the composer");
}

describe("issue 103: a deep link to an agent", () => {
  it("opens the agent with the URL in its composer, and sends nothing until Send", async () => {
    if (!browser) return;
    const { p, errors } = await page();
    const from = pty.writes.length;
    // What's new (this version unseen) opens over the page and takes the
    // keyboard. den#143: on a busy machine it came after the composer as
    // often as before it, so a test that read focus at once saw either.
    // Here it comes last; the next test has it first.
    const release = await hold(p, "**/api/server-info");
    const res = await p.goto(
      `${s.base}/p/north/agents/scout?context=${encodeURIComponent(CONTEXT)}`,
    );
    expect(res?.status()).toBe(200);
    await box(p).waitFor({ timeout: 20_000 });
    expect(await box(p).inputValue()).toBe(CONTEXT);
    release();
    await closeWhatsNew(p);
    // The composer has the keyboard, and the address no longer carries
    // the context (a reload doesn't fill it again).
    await composerFocused(p);
    expect(new URL(p.url()).searchParams.get("context")).toBeNull();
    // Nothing reached the agent: not the URL, not an Enter.
    await new Promise((r) => setTimeout(r, 1500));
    expect(typed(from)).not.toContain("example.test");
    expect(typed(from)).not.toMatch(/[\r\n]/);

    // Send: the message, then Enter.
    await box(p).fill(`Read this: ${CONTEXT}`);
    // BUSY-1: Send goes through the working pop-up, so it carries the
    // pop-up's request id (Try again resends it; Den runs it once).
    const sayReq = p.waitForRequest(
      (r) =>
        r.method() === "POST" && new URL(r.url()).pathname.endsWith("/say"),
    );
    await p.locator(`.pane[data-id="${sid}"] .agc .agc-send`).click();
    expect((await sayReq).headers()["x-den-request-id"]).toBeTruthy();
    const t0 = Date.now();
    while (!typed(from).includes("\r") && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    const out = typed(from);
    expect(out).toContain(`Read this: ${CONTEXT}`);
    expect(out.endsWith("\r")).toBe(true);
    await p
      .locator(`.pane[data-id="${sid}"] .agc .agc-msg[data-tone="ok"]`)
      .waitFor();
    expect(await box(p).inputValue()).toBe("");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("What's new opening first: once it is closed, the composer has the keyboard", async () => {
    if (!browser) return;
    const { p, errors } = await page();
    // The composer waits for the projects' names, held until What's new
    // is open.
    const release = await hold(p, "**/api/workspaces");
    await p.goto(
      `${s.base}/p/north/agents/scout?context=${encodeURIComponent(CONTEXT)}`,
    );
    await p.locator("#cl-overlay.open").waitFor({ timeout: 20_000 });
    release();
    await box(p).waitFor({ timeout: 20_000 });
    expect(await box(p).inputValue()).toBe(CONTEXT);
    await closeWhatsNew(p);
    await composerFocused(p);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("at 375 px the composer fits and nothing scrolls sideways", async () => {
    if (!browser) return;
    const { p, errors } = await page(375);
    await p.goto(
      `${s.base}/p/north/agents/scout?context=${encodeURIComponent(CONTEXT)}`,
    );
    await box(p).waitFor({ timeout: 20_000 });
    const over = await p.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(over).toBeLessThanOrEqual(0);
    const send = await p
      .locator(`.pane[data-id="${sid}"] .agc .agc-send`)
      .boundingBox();
    expect(send).not.toBeNull();
    expect(send!.x + send!.width).toBeLessThanOrEqual(375);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it.each([
    ["/p/west/agents/scout", 404, "There is no project west in this Den."],
    [
      "/p/south/agents/scout",
      404,
      "Project south has no agent scout. It may have been removed.",
    ],
    [
      "/p/north/agents/scout?context=javascript%3Aalert(1)",
      400,
      "The link's context must be an http or https web address.",
    ],
  ])(
    "%s: a page that says why (%i)",
    async (where, status, words) => {
      if (!browser) return;
      const { p, errors } = await page();
      const res = await p.goto(`${s.base}${where}`);
      expect(res?.status()).toBe(status);
      const lead = p.locator("#den-err-link");
      await lead.waitFor({ timeout: 20_000 });
      expect(await lead.textContent()).toBe(words);
      expect(await p.locator("#den-err-agents").isVisible()).toBe(true);
      expect(await p.locator(".agc").count()).toBe(0);
      expect(errors).toEqual([]);
      await p.context().close();
    },
    60_000,
  );

  it("a context past Settings › Embedding's limit: a page naming the limit", async () => {
    if (!browser) return;
    expect(await s.settings({ embed: { url_max_chars: 64 } })).toBe(200);
    try {
      const { p } = await page();
      const res = await p.goto(
        `${s.base}/p/north/agents/scout?context=${encodeURIComponent(`https://example.test/${"a".repeat(80)}`)}`,
      );
      expect(res?.status()).toBe(400);
      const lead = p.locator("#den-err-link");
      await lead.waitFor({ timeout: 20_000 });
      expect(await lead.textContent()).toBe(
        "The link's context is longer than 64 characters. Settings › Embedding sets the limit.",
      );
      await p.context().close();
    } finally {
      await s.settings({ embed: { url_max_chars: null } });
    }
  }, 60_000);
});
