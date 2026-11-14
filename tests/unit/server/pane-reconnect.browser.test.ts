/**
 * 0.4.46: a terminal pane reconnects on its own, in a real browser.
 *
 *   - the web server restarts (the session host and its agent run on):
 *     the pane is live again with no click, and the screen is replayed
 *     once, not twice;
 *   - a server that stays down trips the cap: "Couldn't reconnect: N
 *     tries in M minutes" with the reason and Reconnect; back up,
 *     Reconnect brings it live;
 *   - a tablet's background tab: the page hidden, its socket dropped, the
 *     page shown again: live with no click, no "Reconnecting…" and no
 *     button on the way (hidden closes never count toward the cap);
 *   - the __DEN_TITLE__ agent's page uses the same pane module: it too is
 *     live again after a restart with no click, and both pages' sources
 *     open their socket only through term-pane.js.
 *
 * DEN_RECONNECT_BROWSER=webkit (Safari's engine) or firefox runs it there;
 * DEN_PW_WS=ws://localhost:<port>/ uses a browser behind a Playwright
 * run-server. The demo distribution with a scripted PTY
 * (helpers/agents-page-server.ts): nothing really runs.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
let browser: Browser | null = null;
let sid = "";
let latest = "";
const errors: string[] = [];

/** user.yml's panes.*: quick tries, and a cap of `n` within a minute. */
function panes(n: number): void {
  fs.writeFileSync(
    path.join(s!.tmp, "dist", "config", "local", "user.yml"),
    [
      "panes:",
      "  reconnect_seconds: 0.2",
      "  reconnect_max_seconds: 0.5",
      `  reconnect_max_failures: ${n}`,
      "  reconnect_window_seconds: 60",
      "  connect_timeout_seconds: 2",
      "",
    ].join("\n"),
  );
}

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_RECONNECT_BROWSER ?? "")
        ? process.env.DEN_RECONNECT_BROWSER
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
  host = await connectHost(sessionPaths(s.stateDir).socket);
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  const info = await host.start({
    name: "acme-north:shell",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  sid = info.ref.id;
  s.made.at(-1)!.emit("shell ready\r\n$ ");
}, 60_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

const skip = () => !browser;
const pty = () => s!.made.at(-1)!;
const PANE = () => `.pane[data-id="${sid}"]`;

async function page(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
    // The page's hidden state, set by the test (a tablet's background tab).
    const w = window as unknown as { __hidden: boolean };
    w.__hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => w.__hidden,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (w.__hidden ? "hidden" : "visible"),
    });
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${s!.base}/agents?open=${sid}&layout=tabs`);
  await p
    .waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 })
    .catch(async (e) => {
      throw new Error(
        `${e.message}\nERR: ${errors.join(" | ")}\nPAGE: ${(await p.textContent("main").catch(() => ""))?.slice(0, 600)}\nLOG: ${s!.log().slice(-800)}`,
      );
    });
  await live(p, "ready");
  return p;
}

/** The pane's screen shows `text`. */
async function live(p: Page, text: string, timeout = 20_000): Promise<void> {
  await p.waitForFunction(
    ([sel, t]) =>
      (
        document.querySelector(`${sel} .xterm-rows`)?.textContent ?? ""
      ).includes(t),
    [PANE(), text] as const,
    { timeout },
  );
}

/** What the pane's bar says, and whether it has a Reconnect button. */
const bar = (p: Page) =>
  p.$eval(PANE(), (el) => ({
    text: el.querySelector(".bar2")?.textContent ?? "",
    button: !!el.querySelector('.bar2 [data-act="reconnect"]'),
  }));

/** Types into the pane; the PTY gets it (the socket is live). */
async function typesThrough(p: Page, what: string): Promise<void> {
  const from = pty().writes.length;
  await p.click(`${PANE()} .term`);
  await p.keyboard.type(what);
  const end = Date.now() + 10_000;
  while (
    !Buffer.concat(pty().writes.slice(from)).toString("latin1").includes(what)
  ) {
    if (Date.now() > end) throw new Error(`"${what}" never reached the PTY`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const hide = (p: Page, h: boolean) =>
  p.evaluate((v) => {
    (window as unknown as { __hidden: boolean }).__hidden = v;
    document.dispatchEvent(new Event("visibilitychange"));
  }, h);

describe("0.4.46: a pane reconnects on its own", () => {
  it("the web server restarts: the pane is live again with no click, the screen once", async () => {
    if (skip()) return;
    panes(1000);
    const p = await page();
    // What the agent printed while the page was away.
    await s!.webDown();
    pty().emit("while away\r\n");
    await s!.webUp();
    await live(p, "while away");
    await typesThrough(p, "back");
    expect((await bar(p)).button).toBe(false);
    // Replayed onto a clean screen: "shell ready" shows once.
    const rows = await p.$eval(
      `${PANE()} .xterm-rows`,
      (e) => e.textContent ?? "",
    );
    expect(rows.split("shell ready").length - 1).toBe(1);
    await p.context().close();
  }, 120_000);

  it("a server that stays down trips the cap; back up, Reconnect brings it live", async () => {
    if (skip()) return;
    panes(3);
    const p = await page();
    await s!.webDown();
    try {
      await p.waitForFunction(
        (sel) =>
          /Couldn't reconnect: 3 tries in 1 minutes/.test(
            document.querySelector(`${sel} .bar2`)?.textContent ?? "",
          ),
        PANE(),
        { timeout: 20_000 },
      );
      expect((await bar(p)).button).toBe(true);
    } finally {
      await s!.webUp();
    }
    // Tripped: it waits for the person.
    await new Promise((r) => setTimeout(r, 1500));
    expect((await bar(p)).button).toBe(true);
    await p.click(`${PANE()} [data-act="reconnect"]`);
    pty().emit("after reconnect\r\n");
    await live(p, "after reconnect");
    await typesThrough(p, "again");
    expect(await bar(p)).toMatchObject({ button: false });
    expect((await bar(p)).text).not.toMatch(/Couldn't reconnect/);
    await p.context().close();
  }, 120_000);

  it("a tablet's background tab: hidden, dropped, shown again: live with no click and nothing on the way", async () => {
    if (skip()) return;
    panes(2);
    const p = await page();
    // What the bar says from here on, every change.
    await p.evaluate((sel) => {
      const w = window as unknown as { __said: string[] };
      w.__said = [];
      const b = document.querySelector(`${sel} .bar2`)!;
      new MutationObserver(() => w.__said.push(b.textContent ?? "")).observe(
        b,
        { subtree: true, childList: true, characterData: true },
      );
    }, PANE());
    await hide(p, true);
    // Its socket drops while hidden, and stays down past the cap of 2.
    await s!.webDown();
    await new Promise((r) => setTimeout(r, 2000));
    await s!.webUp();
    pty().emit("while hidden\r\n");
    await hide(p, false);
    await live(p, "while hidden");
    await typesThrough(p, "shown");
    const said = await p.evaluate(
      () => (window as unknown as { __said: string[] }).__said,
    );
    expect(said.join("\n")).not.toMatch(/Reconnecting|Couldn't reconnect/);
    expect((await bar(p)).button).toBe(false);
    await p.context().close();
  }, 120_000);

  it("both pages open their terminal through the one pane module", () => {
    const src = (f: string) =>
      fs.readFileSync(
        path.join(process.cwd(), "src", "ui", "server", "public", f),
        "utf-8",
      );
    for (const f of ["agents-page.js", "server-agent-page.js"]) {
      expect(src(f)).toMatch(
        /import \{[^}]*\btermPane\b[^}]*\} from "\/term-pane\.js"/,
      );
      expect(src(f)).not.toContain("new WebSocket(");
    }
  });

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});

describe("0.4.46: the __DEN_TITLE__ agent's page reconnects on its own too", () => {
  let f: AgentsPageServer | null = null;
  beforeAll(async () => {
    if (browser) f = await startAgentsPageServer({ fresh: true });
  }, 60_000);
  afterAll(async () => {
    await f?.stop();
  });

  it("the web server restarts: its terminal is live again with no click", async () => {
    if (skip()) return;
    fs.writeFileSync(
      path.join(f!.tmp, "dist", "config", "local", "user.yml"),
      "panes:\n  reconnect_seconds: 0.2\n  reconnect_max_seconds: 0.5\n",
    );
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 860 },
      reducedMotion: "reduce",
    });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(signInUrl(f!.stateDir, f!.base, "/"));
    await p.waitForSelector(".sa-term .xterm", { timeout: 20_000 });
    const agent = () => f!.made[0]!;
    agent().emit("agent ready\r\n");
    const shows = (text: string) =>
      p.waitForFunction(
        (t) =>
          (
            document.querySelector(".sa-term .xterm-rows")?.textContent ?? ""
          ).includes(t),
        text,
        { timeout: 20_000 },
      );
    await shows("agent ready");
    await f!.webDown();
    agent().emit("while away\r\n");
    await f!.webUp();
    await shows("while away");
    const from = agent().writes.length;
    await p.click(".sa-term .xterm");
    await p.keyboard.type("hello");
    const end = Date.now() + 10_000;
    while (
      !Buffer.concat(agent().writes.slice(from))
        .toString("latin1")
        .includes("hello")
    ) {
      if (Date.now() > end) throw new Error("typing never reached the agent");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await p.locator(".sa-recon button").count()).toBe(0);
    await ctx.close();
  }, 120_000);
});
