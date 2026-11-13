/**
 * The server agent in the browser (ON-6):
 *
 *   - a fresh Den's first page (/) is its agent: it starts by itself in a
 *     terminal framed as the page, says it only reads until the person
 *     allows a write, and offers Open in Agents;
 *   - with no runtime, the same page shows how to install one and the
 *     manual path, and starts nothing;
 *   - after setup it is one click away in the rail, and ⌘K has
 *     "Ask <name>"; Agents lists it under "Server", not a workspace.
 *
 * The demo distribution (acme) on the real web server, with a session host
 * in this process and a scripted PTY: nothing an agent starts really runs.
 * No token, cookie or login code is printed.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function open(
  s: AgentsPageServer,
  at: string,
  before?: (p: Page) => Promise<void>,
): Promise<Page> {
  const latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  if (before) await before(p);
  await p.goto(signInUrl(s.stateDir, s.base, at));
  return p;
}

describe("a fresh Den", () => {
  let s: AgentsPageServer | null = null;
  beforeAll(async () => {
    if (browser) s = await startAgentsPageServer({ fresh: true });
  }, 60_000);
  afterAll(async () => {
    await s?.stop();
  });

  it("opens on its own agent: started by itself in a terminal, reading only until allowed", async () => {
    if (!browser) return;
    const p = await open(s!, "/");
    expect(await p.locator("#den-shell").getAttribute("data-page")).toBe(
      "server-agent",
    );
    await p.waitForSelector(".sa-term .xterm", { timeout: 20_000 });
    expect((await p.locator("h1").textContent())?.trim()).toBe("Acme agent");
    expect(await p.locator('[data-note="reads-only"]').isVisible()).toBe(true);
    // Open in Agents: its pane there.
    const href = await p.locator("#sa-open").getAttribute("href");
    expect(href).toMatch(/^\/agents\?open=/);
    expect(await p.locator("#sa-open").isVisible()).toBe(true);
    // It runs as the server agent: in the distribution's own repo (SRV-1b:
    // server_agent.folder, the root by default), Den's MCP for the whole
    // Den, and Den's onboarding prompt.
    expect(s!.made).toHaveLength(1);
    const pty = s!.made[0];
    expect(pty.opts.cwd).toBe(path.join(s!.tmp, "dist"));
    expect(pty.args[pty.args.length - 1]).toMatch(
      /Let's set up Acme\. Where are your repos\?/,
    );
    const mcp = JSON.parse(
      fs.readFileSync(pty.args[pty.args.indexOf("--mcp-config") + 1], "utf-8"),
    ) as { mcpServers: Record<string, { args: string[] }> };
    expect(Object.values(mcp.mcpServers)[0].args).toEqual(
      expect.arrayContaining(["--workspace", "den-server"]),
    );
    expect(fs.existsSync(s!.ran)).toBe(false);
    // A reload attaches to it: no second start.
    await p.reload();
    await p.waitForSelector(".sa-term .xterm", { timeout: 20_000 });
    expect(s!.made).toHaveLength(1);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("gate 0.4.44: Trust goes within a check of the prompt clearing, however long the page was open; a stale check hides it; a click checks first", async () => {
    if (!browser) return;
    let prompt: unknown = { kind: "trust", folder: "/dist" };
    let hang = false;
    const posts: string[] = [];
    const p = await open(s!, "/server-agent", async (pg) => {
      await pg.clock.install();
      await pg.route("**/api/server-agent", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        if (hang) return; // never answered: a check that went stale
        const r = await route.fetch();
        const j = (await r.json()) as Record<string, unknown>;
        await route.fulfill({ response: r, json: { ...j, prompt, promptCheckMs: 2000 } });
      });
      await pg.route("**/api/server-agent/trust", async (route) => {
        posts.push(route.request().postData() ?? "");
        await route.fulfill({ json: { ok: true, typed: true } });
      });
    });
    const yes = '[data-act="trust-yes"]';
    const shown = (state: "visible" | "detached") =>
      p.waitForSelector(yes, { state, timeout: 8_000 });
    await shown("visible");
    // Open well past the old 45 looks (90 s), the prompt still there.
    await p.clock.runFor(100_000);
    await shown("visible");
    // It clears (answered in the terminal): gone within a check.
    prompt = null;
    await p.clock.runFor(2_500);
    await shown("detached");
    // A prompt that comes later still shows.
    prompt = { kind: "trust", folder: "/dist" };
    await p.clock.runFor(10_500);
    await shown("visible");
    // Checks that stop answering: stale, Trust goes.
    hang = true;
    await p.clock.runFor(6_500);
    await shown("detached");
    hang = false;
    await p.clock.runFor(2_500);
    await shown("visible");
    // The prompt clears between checks: the click checks first, sends nothing.
    prompt = null;
    await p.click(yes);
    await shown("detached");
    expect(posts).toEqual([]);
    await p.context().close();
  }, 90_000);
});

describe("a fresh Den with no runtime", () => {
  let s: AgentsPageServer | null = null;
  beforeAll(async () => {
    if (browser)
      s = await startAgentsPageServer({ fresh: true, runtime: "missing" });
  }, 60_000);
  afterAll(async () => {
    await s?.stop();
  });

  it("shows how to install one and the manual path, and starts nothing", async () => {
    if (!browser) return;
    const p = await open(s!, "/");
    await p.waitForSelector('[data-note="manual"]', { timeout: 20_000 });
    const steps = await p.locator(".sa-steps li").allTextContents();
    // This Den exists: from its folder, its own command.
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatch(/^cd \S/);
    expect(steps.slice(1)).toEqual([
      "./bin/acme repo add <path>",
      "./bin/acme up",
    ]);
    expect(await p.locator('[data-note="no-runtime"]').isVisible()).toBe(true);
    expect(await p.locator(".sa-term").count()).toBe(0);
    expect(s!.made).toHaveLength(0);
    await p.context().close();
  }, 60_000);
});

describe("after setup", () => {
  let s: AgentsPageServer | null = null;
  beforeAll(async () => {
    if (browser) s = await startAgentsPageServer();
  }, 60_000);
  afterAll(async () => {
    await s?.stop();
  });

  it("is one click away in the rail and never starts by itself; Start runs it", async () => {
    if (!browser) return;
    const p = await open(s!, "/local-dev");
    const rail = p.locator('.den-rail [data-nav="server-agent"]');
    await rail.waitFor();
    expect(await rail.getAttribute("title")).toBe("Acme agent");
    await rail.click();
    await p.waitForURL(/\/server-agent$/);
    await p.waitForSelector('[data-note="idle"]', { timeout: 20_000 });
    expect(s!.made).toHaveLength(0);
    await p.locator('button[data-act="start"]').click();
    await p.waitForSelector(".sa-term .xterm", { timeout: 20_000 });
    expect(s!.made).toHaveLength(1);
    await p.context().close();
  }, 60_000);

  it("Agents lists it under Server, not under a workspace", async () => {
    if (!browser) return;
    const p = await open(s!, "/agents");
    const g = p.locator('#agl .wsg[data-ws="den-server"]');
    await g.waitFor({ timeout: 20_000 });
    expect((await g.locator(".wsh span").first().textContent())?.trim()).toBe(
      "Server",
    );
    expect(await g.locator(".wsh a").count()).toBe(0);
    expect(await g.locator(".agr").first().textContent()).toContain(
      "Acme agent",
    );
    // It is the list's first group.
    expect(await p.locator("#agl .wsg").first().getAttribute("data-ws")).toBe(
      "den-server",
    );
    await p.context().close();
  }, 60_000);

  it("⌘K has Ask Acme, which opens it", async () => {
    if (!browser) return;
    const p = await open(s!, "/agents");
    await p.waitForSelector("#agl:not([aria-busy])", { timeout: 20_000 });
    await p.keyboard.press("Control+k");
    await p.waitForSelector(".den-pal");
    await p.keyboard.type("ask");
    const first = p.locator("#den-pal-o-0 .den-pal-l");
    await first.waitFor();
    expect((await first.textContent())?.trim()).toBe("Ask Acme");
    // The server agent is Ask Acme, never "Agents › den-server / …".
    const rows = await p.locator("#den-pal-list .den-pal-l").allTextContents();
    expect(rows.some((r) => r.includes("den-server"))).toBe(false);
    await p.keyboard.press("Enter");
    await p.waitForURL(/\/server-agent$/);
    await p.context().close();
  }, 60_000);
});
