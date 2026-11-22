/**
 * Issue 448, clause 4 and the exited shells: the rail's Terminal opens the
 * plain shell used most recently. With All projects, across every project,
 * whatever the list's order; with one project, that project's. Used means
 * a person typed in it, in any browser (the server keeps when). An exited
 * shell never opens: with none running, a new one starts.
 *
 * Each "machine" here is a browser context of its own (its own storage),
 * so only what the server knows can decide.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY
 * (no real shell runs), in Chromium and WebKit. DEN_PW_WS: Den's own
 * Playwright server instead of a local browser. DEN_SKIP_BROWSER_TESTS=1
 * skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const errors: string[] = [];

describe.each(["chromium", "webkit"] as const)("issue 448 in %s", (name) => {
  let browser: Browser | null = null;
  let s: AgentsPageServer | null = null;
  let latest = "";
  const contexts: BrowserContext[] = [];

  beforeAll(async () => {
    try {
      const pw = await import("playwright");
      const kind = pw[name];
      browser = await launchBrowser(kind);
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
      throw err;
    }
    s = await startAgentsPageServer();
    latest =
      (
        (await (await fetch(`${s.base}/api/changelog`)).json()) as {
          version: string;
        }[]
      )[0]?.version ?? "";
    await scope("all");
  }, 90_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await closeBrowserSuite({ browsers: [browser], servers: [s] });
  });

  const skip = () => !browser;

  async function scope(v: string) {
    const r = await fetch(`${s!.base}/api/scope`, {
      method: "POST",
      headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
      body: JSON.stringify({ scope: v }),
    });
    expect(r.status).toBe(200);
  }

  /** A shell started in `ws` (as another page's Terminal would). */
  const ptys = new Map<string, ScriptedPty>();
  async function startShell(ws: string): Promise<string> {
    const r = await fetch(`${s!.base}/api/workspaces/${ws}/sessions`, {
      method: "POST",
      headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await r.json()) as { session: { id: string } };
    ptys.set(session.id, s!.made.at(-1)!);
    ptys.get(session.id)!.emit("$ ");
    // Starts a few ms apart: the start time alone never ties.
    await new Promise((r) => setTimeout(r, 20));
    return session.id;
  }

  /** A browser of its own (another machine: nothing in its storage). */
  async function open(path: string): Promise<Page> {
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 860 },
      reducedMotion: "reduce",
    });
    contexts.push(ctx);
    await ctx.addInitScript((v) => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
      } catch {
        /* none */
      }
    }, latest);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => {
      if (leaving.has(p) && refusedOwnFetch(e.message)) return;
      errors.push(`${name}: ${e.message}`);
    });
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) leaving.delete(p);
    });
    await signInPage(p, s!.stateDir, s!.base, path);
    return p;
  }

  /**
   * Issue 640: the pane's live connection is open. The pane draws before
   * its socket opens, and a key typed before then is dropped; a remote
   * browser (DEN_PW_WS) opens it later than a local one. The shell's
   * prompt in the pane came over that socket.
   */
  async function connected(p: Page, id: string) {
    await p.waitForFunction(
      (i) =>
        (
          document.querySelector(`.pane[data-id="${i}"] .xterm-rows`)
            ?.textContent ?? ""
        ).includes("$"),
      id,
      { timeout: 20_000 },
    );
  }

  /** A person types in shell `id`, on a machine of its own, then leaves. */
  async function typeIn(id: string) {
    const p = await open(`/agents?open=${id}`);
    await p.waitForSelector(`.pane[data-id="${id}"] .xterm-screen`);
    await connected(p, id);
    await p.click(`.pane[data-id="${id}"] .xterm-screen`);
    const pty = ptys.get(id)!;
    const before = pty.writes.length;
    await p.keyboard.type("x");
    const deadline = Date.now() + 10_000;
    while (
      !Buffer.concat(pty.writes.slice(before)).toString().includes("x") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 50));
    expect(Buffer.concat(pty.writes.slice(before)).toString()).toContain("x");
    await p.context().close();
    // Used a few ms apart: the order of use is never a tie.
    await new Promise((r) => setTimeout(r, 20));
  }

  /** Shell `id` ends, and the server's list says so. */
  async function endShell(id: string) {
    ptys.get(id)!.exit(0);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const list = (await (await fetch(`${s!.base}/api/sessions`)).json()) as {
        sessions: { id: string; exited?: boolean }[];
      };
      if (list.sessions.find((x) => x.id === id)?.exited) return;
      if (Date.now() > deadline) throw new Error(`${id} never exited`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The pane with the keyboard: its session id, or null. */
  const keyed = (p: Page) =>
    p.evaluate(
      () =>
        (document.activeElement?.closest(".pane") as HTMLElement | null)
          ?.dataset.id ?? null,
    );

  /** As in terminal-reuse.browser.test.ts: WebKit's refused fetch on leave. */
  const leaving = new Set<Page>();
  const refusedOwnFetch = (msg: string) =>
    msg.endsWith(" due to access control checks.") &&
    msg.includes(`/${new URL(s!.base).host}/`);

  /** The rail's Terminal, once the page has used ?terminal=. */
  async function railTerminal(p: Page) {
    leaving.add(p);
    await p.locator('#den-rail [data-nav="terminal"]').click();
    await p.waitForURL(/terminal=1/).catch(() => {});
    await p.waitForFunction(() => !location.search.includes("terminal="));
    await p.waitForSelector(".pane[data-id] .xterm-rows");
    await p
      .waitForFunction(
        () => Boolean(document.activeElement?.closest(".pane[data-id]")),
        null,
        { timeout: 10_000 },
      )
      .catch(() => {});
    await p.waitForTimeout(500);
  }

  let north1 = "";
  let south1 = "";

  it("All projects: the shell used last across every project, not the first one listed", async () => {
    if (skip()) return;
    // South's starts first, north's last; north is listed first. North's
    // is typed in, then south's: south's is the one used last.
    south1 = await startShell("south");
    north1 = await startShell("north");
    await typeIn(north1);
    await typeIn(south1);
    const before = s!.made.length;
    const p = await open("/services");
    await railTerminal(p);
    expect(await keyed(p)).toBe(south1);
    expect(s!.made.length).toBe(before);
    // Now north's is used last: the rail follows.
    await typeIn(north1);
    const q = await open("/services");
    await railTerminal(q);
    expect(await keyed(q)).toBe(north1);
    expect(s!.made.length).toBe(before);
  }, 180_000);

  it("one project selected: that project's shell used last, never another's", async () => {
    if (skip() || !north1 || !south1) return;
    // North's second starts after north1's last use; north1 is typed in
    // again; south's is used last of all.
    const north2 = await startShell("north");
    await typeIn(north1);
    await typeIn(south1);
    await scope("north");
    try {
      const before = s!.made.length;
      const p = await open("/services?project=north");
      await railTerminal(p);
      expect(await keyed(p)).toBe(north1);
      expect(s!.made.length).toBe(before);
    } finally {
      await scope("all");
    }
    await endShell(north2);
  }, 180_000);

  it("(a) an exited shell used last never opens: the running one does", async () => {
    if (skip() || !south1) return;
    const south2 = await startShell("south");
    await typeIn(south2);
    await endShell(south2);
    const before = s!.made.length;
    const p = await open("/services?project=south");
    await railTerminal(p);
    expect(await keyed(p)).toBe(south1);
    expect(s!.made.length).toBe(before);
    // All projects too.
    await typeIn(south1);
    const south3 = await startShell("south");
    await typeIn(south3);
    await endShell(south3);
    const q = await open("/services");
    await railTerminal(q);
    expect(await keyed(q)).toBe(south1);
    expect(s!.made.length).toBe(before + 1);
  }, 180_000);

  it("(c) a shell that ends while the page is open never opens", async () => {
    if (skip() || !south1) return;
    // The page lists south1 running and in front; it ends while open.
    const p = await open(`/agents?project=south&open=${south1}`);
    await p.waitForSelector(`.pane[data-id="${south1}"] .xterm-screen`);
    await connected(p, south1);
    await p.click(`.pane[data-id="${south1}"] .xterm-screen`);
    await p.keyboard.type("x");
    await endShell(south1);
    const before = s!.made.length;
    await railTerminal(p);
    const now = await keyed(p);
    expect(now).not.toBe(south1);
    // South had no running shell left: a new one, in south.
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
  }, 180_000);

  it("(b) only exited shells in the project: a new one starts", async () => {
    if (skip() || !north1) return;
    await typeIn(north1);
    await endShell(north1);
    const before = s!.made.length;
    const p = await open("/services?project=north");
    await railTerminal(p);
    expect(await keyed(p)).not.toBe(north1);
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("north"));
  }, 180_000);
});

it("no page errors", () => {
  expect(errors).toEqual([]);
});
