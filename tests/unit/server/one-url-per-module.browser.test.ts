/**
 * Issue 231: Den names each same-origin script and stylesheet with
 * `?v=<version>`. If a page reaches one module by two URLs (stamped and
 * bare, or stamped two ways), the browser loads two copies, each with its
 * own state. This loads every page Den serves (the server's own route
 * list), signed in, in Chromium and WebKit, opens the cheap lazy parts
 * (the Agents page's terminal, Report, the bell; the graph draws on
 * /graph), records every same-origin .js/.mjs/.css request from before
 * the first byte, and fails when one path was asked for under more than
 * one URL.
 *
 * Not an exception here: the xterm retry (`again()` in agents-page.js and
 * server-agent-page.js) adds &try=N only after a failed load, which a
 * normal load never has.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
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
import { SERVED_PAGES } from "./helpers/served-pages.js";

/** Each page once: a `.html` twin serves the same file as its bare path. */
const PAGES = SERVED_PAGES.filter(
  (p) => !(p.endsWith(".html") && SERVED_PAGES.includes(p.slice(0, -5))),
);

const ENGINES = ["chromium", "webkit"] as const;
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
/** What a page is opened with, so its lazy part shows (pathname kept). */
const QUERY: Record<string, string> = { "/graph": "?ws=north" };
let latest = "";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES)
      browsers[e] = process.env.DEN_PW_WS
        ? await pw[e].connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await pw[e].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  // One running agent, so the Agents page opens a terminal (xterm).
  host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:planner",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  s.seed({
    id: "planner",
    persona: "planner",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: "acme-north:planner",
  });
  s.made[s.made.length - 1]!.emit("planner ready\r\n$ ");
  QUERY["/agents"] = `?open=${info.ref.id}&layout=tabs`;
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 90_000);

afterAll(async () => {
  for (const b of Object.values(browsers)) await b?.close();
  host?.close();
  await s?.stop();
});

const skip = () => !s;

/** Opens what a page loads late, where it has it; misses are fine. */
async function openLazy(p: Page, route: string): Promise<void> {
  const quiet = { timeout: 5_000 };
  if (route === "/agents")
    await p.waitForSelector(".pane .xterm-rows", quiet).catch(() => {});
  if (route === "/graph")
    await p.waitForSelector(".dg-card", quiet).catch(() => {});
  if (await p.locator("#den-bell").count()) {
    await p
      .click("#den-bell", quiet)
      .then(() => p.waitForSelector("#den-bell-pop", quiet))
      .catch(() => {});
    await p.keyboard.press("Escape");
  }
  const report = p.locator("#den-shell .den-top [data-den-report]");
  if (await report.count()) {
    await report
      .first()
      .click(quiet)
      .then(() => p.waitForSelector("dialog.fb-dlg", quiet))
      .catch(() => {});
  }
  await p.waitForLoadState("networkidle").catch(() => {});
}

/** pathname -> every distinct URL it was asked for under, on one page. */
async function loads(
  engine: (typeof ENGINES)[number],
  route: string,
  inject?: string,
): Promise<Map<string, Set<string>>> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  const seen = new Map<string, Set<string>>();
  const origin = new URL(s!.base).origin;
  try {
    // What's new stays shut: it would cover the buttons clicked below.
    await ctx.addInitScript((v) => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
      } catch {
        /* none */
      }
    }, latest);
    const p = await ctx.newPage();
    p.on("request", (r) => {
      const u = new URL(r.url());
      if (u.origin !== origin || !/\.(m?js|css)$/.test(u.pathname)) return;
      const set = seen.get(u.pathname) ?? new Set<string>();
      set.add(u.pathname + u.search);
      seen.set(u.pathname, set);
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, route + (QUERY[route] ?? "")));
    await p.waitForLoadState("networkidle").catch(() => {});
    if (inject)
      await p.addScriptTag({ type: "module", content: inject }).catch(() => {});
    await openLazy(p, route);
  } finally {
    await ctx.close();
  }
  return seen;
}

function doubles(seen: Map<string, Set<string>>): string[] {
  return [...seen]
    .filter(([, urls]) => urls.size > 1)
    .map(([path, urls]) => `${path}: ${[...urls].sort().join(" , ")}`);
}

describe("issue 231: one URL per module on every page", () => {
  it("the list is the server's pages", () => {
    expect(PAGES).toEqual(
      expect.arrayContaining(["/", "/agents", "/graph", "/settings"]),
    );
    expect(PAGES.length).toBeGreaterThan(10);
  });

  for (const engine of ENGINES)
    it(`${engine}: no page asks for a script or stylesheet by two URLs`, async () => {
      if (skip()) return;
      const bad: string[] = [];
      const all = new Set<string>();
      for (const route of PAGES) {
        const seen = await loads(engine, route);
        for (const path of seen.keys()) all.add(path);
        for (const d of doubles(seen)) bad.push(`${route} ${d}`);
      }
      // The lazy parts really loaded: the terminal, Report, the graph.
      const lazy = [
        "/vendor/xterm.mjs",
        "/report-dialog.js",
        "/graph.js",
        "/vendor/elk.bundled.js",
      ];
      expect(lazy.filter((m) => !all.has(m))).toEqual([]);
      expect(all.size).toBeGreaterThan(30);
      expect(bad).toEqual([]);
    }, 300_000);

  it("catches a module asked for bare as well as stamped", async () => {
    if (skip()) return;
    const seen = await loads(
      "chromium",
      "/graph",
      'import("/graph.js").catch(() => {});',
    );
    expect(doubles(seen).join("\n")).toMatch(/^\/graph\.js: /m);
  }, 60_000);
});
