/**
 * Accessibility (axe-core) on the real web server, in a real browser: the
 * demo distribution, with notes up (a stub health check on localhost) and
 * pinned.
 *
 * Every page in the nav registry (denShell.pages(): the list the rail is
 * drawn from, Settings included), its <main>, in light and dark, at
 * 1440×900 and 390×844 (issue 297). The list is read from the running
 * shell, never written here, so a page added later is checked too; a
 * registry page without a clean run fails.
 *
 * Five surfaces too, each in light and dark, at the same two sizes:
 *
 * - the rail (at phone size, the drawer: ☰ opens it);
 * - an open pinned-service panel (a click on the rail's pinned row);
 * - the Start agent dialog on /agents;
 * - the Graph's line for Open in Graph outside the View ("blog is in
 *   south, outside this View.", Show south);
 * - the server agent's page (/server-agent).
 *
 * axe runs with WCAG 2.0 and 2.1 A and AA plus best practice. Any
 * violation fails, with its id, impact and targets. Nothing is excluded.
 * A scan must have found its target and passed some rules, so a scan of
 * nothing fails too.
 *
 * Chromium by default; DEN_HELPERS_BROWSER=webkit (or firefox) picks
 * another engine, and DEN_PW_WS connects to a Playwright server.
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const AXE = require.resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let stub: http.Server | null = null;
let latest = "";
const errors: string[] = [];

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
  stub = http.createServer((_q, r) => r.end("ok"));
  await new Promise<void>((r) => stub!.listen(0, "localhost", r));
  const stubUrl = `http://localhost:${(stub.address() as AddressInfo).port}`;
  s = await startAgentsPageServer({ health: { notes: `${stubUrl}/health` } });
  expect(await s.settings({ shell: { pins: ["notes"] } })).toBe(200);
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s, stub],
  });
});

type Scheme = "light" | "dark";
type Size = { name: string; width: number; height: number };
const SIZES: Size[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const phone = (z: Size) => z.width < 640;

async function page(
  url: string,
  scheme: Scheme,
  z: Size,
  init?: () => void,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: z.width, height: z.height },
    reducedMotion: "reduce",
    colorScheme: scheme,
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  if (init) await ctx.addInitScript(init);
  const p = await ctx.newPage();
  await p.emulateMedia({ colorScheme: scheme });
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(signInUrl(s!.stateDir, s!.base, url));
  return p;
}

/** At phone size the rail is a drawer: ☰ opens it. */
async function openRail(p: Page, z: Size): Promise<void> {
  await p.waitForSelector('.den-rail [data-pin="notes"]', {
    state: "attached",
  });
  if (phone(z)) {
    await p.click(".den-menu-btn");
    await p.waitForSelector("body.den-rail-open");
  }
  await p.waitForSelector('.den-rail [data-visit="notes"]', {
    timeout: 20_000,
  });
}

/** The top bar's View: "all" or one workspace (a server setting). */
async function view(p: Page, scope: string): Promise<void> {
  await p.waitForFunction(() => "denShell" in window);
  await p.evaluate(async (v) => {
    await (
      window as unknown as {
        denShell: { api(m: string, u: string, b: unknown): Promise<unknown> };
      }
    ).denShell.api("POST", "/api/scope", { scope: v });
  }, scope);
}

interface Found {
  id: string;
  impact: string | null;
  targets: string[];
}
interface Scan {
  present: boolean;
  passes: number;
  violations: Found[];
}

/**
 * axe on `sel` (and, when `widen` names one, its closest such ancestor:
 * the dialog the drawer's rail sits in).
 */
async function scan(p: Page, sel: string, widen?: string): Promise<Scan> {
  await p.addScriptTag({ path: AXE });
  return p.evaluate(
    async ({ sel, widen, tags }) => {
      const el = document.querySelector(sel);
      if (!el) return { present: false, passes: 0, violations: [] };
      const root = (widen && el.closest(widen)) || el;
      const axe = (
        window as unknown as {
          axe: {
            run(
              ctx: Element,
              opts: unknown,
            ): Promise<{
              passes: unknown[];
              violations: {
                id: string;
                impact: string | null;
                nodes: { target: unknown[] }[];
              }[];
            }>;
          };
        }
      ).axe;
      const r = await axe.run(root, {
        runOnly: { type: "tag", values: tags },
        resultTypes: ["violations", "passes"],
      });
      return {
        present: true,
        passes: r.passes.length,
        violations: r.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          targets: v.nodes.map((n) => n.target.map(String).join(" ")),
        })),
      };
    },
    { sel, widen, tags: TAGS },
  );
}

function report(what: string, r: Scan): string {
  if (!r.violations.length) return `${what}: clean`;
  return [
    `${what}: ${r.violations.length} violation(s)`,
    ...r.violations.map(
      (v) => `  ${v.id} (${v.impact ?? "?"}): ${v.targets.join(", ")}`,
    ),
  ].join("\n");
}

function expectClean(what: string, r: Scan): void {
  expect([what, r.present]).toEqual([what, true]);
  expect([what, r.passes > 0]).toEqual([what, true]);
  expect(report(what, r)).toBe(`${what}: clean`);
}

const SURFACES: {
  name: string;
  run(scheme: Scheme, z: Size): Promise<Scan>;
}[] = [
  {
    name: "the rail",
    async run(scheme, z) {
      const p = await page("/services", scheme, z);
      await openRail(p, z);
      const r = await scan(p, "#den-rail", '[role="dialog"]');
      await p.context().close();
      return r;
    },
  },
  {
    name: "the pinned-service panel",
    async run(scheme, z) {
      const p = await page("/services", scheme, z);
      await openRail(p, z);
      await p.click('.den-rail [data-pin="notes"]');
      await p.waitForSelector(".den-svp[role='dialog']");
      const r = await scan(p, ".den-svp");
      await p.context().close();
      return r;
    },
  },
  {
    name: "the Start agent dialog",
    async run(scheme, z) {
      const p = await page("/agents?start=1", scheme, z);
      await p.waitForSelector("#ag-dlg[open]", { timeout: 20_000 });
      await p.waitForSelector('#ag-persona [data-pid="planner"]');
      const r = await scan(p, "#ag-dlg[open]");
      await p.context().close();
      return r;
    },
  },
  {
    name: "the Graph's outside-this-View line",
    async run(scheme, z) {
      const p = await page("/services", scheme, z);
      await view(p, "north");
      try {
        await p.goto(`${s!.base}/graph#focus=blog`);
        await p.waitForSelector(".dg-out button", { timeout: 20_000 });
        return await scan(p, ".dg-out");
      } finally {
        await view(p, "all");
        await p.context().close();
      }
    },
  },
  {
    name: "the server agent's page",
    async run(scheme, z) {
      const p = await page("/server-agent", scheme, z);
      await p.waitForSelector('[data-note="idle"]', { timeout: 20_000 });
      const r = await scan(p, "#den-content");
      await p.context().close();
      return r;
    },
  },
];

interface RegPage {
  id: string;
  href: string;
}

/**
 * The nav registry as the running shell has it (denShell.pages()), after
 * `init` (a script run before the page's own: a test's extra page).
 */
async function registryPages(init?: () => void): Promise<RegPage[]> {
  const p = await page("/services", "light", SIZES[0], init);
  try {
    await p.waitForFunction(() => "denShell" in window);
    await p.evaluate(
      () =>
        new Promise<void>((done) =>
          (
            window as unknown as {
              denShellQueue: { push(f: () => void): void };
            }
          ).denShellQueue.push(() => setTimeout(done, 0)),
        ),
    );
    return await p.evaluate(() =>
      (
        window as unknown as { denShell: { pages(): RegPage[] } }
      ).denShell.pages(),
    );
  } finally {
    await p.context().close();
  }
}

/** A page's <main> once its shell is up and its first requests have settled. */
async function scanPage(href: string, scheme: Scheme, z: Size): Promise<Scan> {
  const p = await page(href, scheme, z);
  try {
    await p.waitForSelector("#den-content", { timeout: 20_000 });
    await p.waitForFunction(() => "denShell" in window);
    await p
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined);
    await p
      .waitForFunction(
        () => !document.querySelector('#den-content [aria-busy="true"]'),
        undefined,
        { timeout: 5_000 },
      )
      .catch(() => undefined);
    return await scan(p, "#den-content");
  } finally {
    await p.context().close();
  }
}

/** Every page in `pages`, scanned: the hrefs visited and each one's report. */
async function scanAll(
  pages: RegPage[],
  scheme: Scheme,
  z: Size,
): Promise<{ visited: string[]; reports: string[] }> {
  const visited: string[] = [];
  const reports: string[] = [];
  for (const pg of pages) {
    const what = `${pg.href}, ${scheme}, ${z.name}`;
    let r: Scan;
    try {
      r = await scanPage(pg.href, scheme, z);
    } catch (err) {
      reports.push(`${what}: did not load (${(err as Error).message})`);
      continue;
    }
    if (!r.present || r.passes === 0) {
      reports.push(`${what}: nothing scanned`);
      continue;
    }
    visited.push(pg.href);
    reports.push(report(what, r));
  }
  return { visited, reports };
}

const PROBE: RegPage = { id: "a11y-probe", href: "/services?a11y-probe=1" };

describe("every page in the nav registry", () => {
  let registry: RegPage[] = [];
  const runs = new Map<string, string[]>();

  beforeAll(async () => {
    if (!browser || !s) return;
    registry = await registryPages();
  }, 60_000);

  it("the registry has the rail's pages, Settings among them", () => {
    if (!browser || !s) return;
    const hrefs = registry.map((r) => r.href);
    expect(hrefs).toEqual(expect.arrayContaining(["/services", "/settings"]));
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  for (const z of SIZES)
    for (const scheme of ["light", "dark"] as Scheme[])
      it(`axe finds no violation on any of them, ${scheme}, ${z.name} (${z.width}×${z.height})`, async () => {
        if (!browser || !s) return;
        const { visited, reports } = await scanAll(registry, scheme, z);
        runs.set(`${scheme} ${z.name}`, visited);
        expect(reports.filter((r) => !r.endsWith(": clean"))).toEqual([]);
      }, 600_000);

  it("every registry page had an a11y run, in every scheme and size", () => {
    if (!browser || !s) return;
    const want = registry.map((r) => r.href).sort();
    for (const z of SIZES)
      for (const scheme of ["light", "dark"] as Scheme[]) {
        const key = `${scheme} ${z.name}`;
        expect([key, (runs.get(key) ?? []).slice().sort()]).toEqual([
          key,
          want,
        ]);
      }
  });

  it("the list follows the registry: a page added to it is visited", async () => {
    if (!browser || !s) return;
    const withProbe = await registryPages(() => {
      const w = window as unknown as {
        denShellQueue?: unknown[] | { push(f: unknown): void };
      };
      w.denShellQueue = w.denShellQueue || [];
      (w.denShellQueue as { push(f: unknown): void }).push(
        (sh: { registerNav(n: unknown): void }) =>
          sh.registerNav({
            id: "a11y-probe",
            label: "A11y probe",
            group: "develop",
            href: "/services?a11y-probe=1",
          }),
      );
    });
    expect(registry.map((r) => r.href)).not.toContain(PROBE.href);
    expect(withProbe).toContainEqual(PROBE);
    const { visited } = await scanAll(withProbe, "light", SIZES[0]);
    expect(visited).toContain(PROBE.href);
  }, 600_000);
});

describe("axe finds no violation", () => {
  for (const surface of SURFACES)
    for (const z of SIZES)
      for (const scheme of ["light", "dark"] as Scheme[])
        it(`${surface.name}, ${scheme}, ${z.name} (${z.width}×${z.height})`, async () => {
          if (!browser || !s) return;
          const what = `${surface.name}, ${scheme}, ${z.name}`;
          expectClean(what, await surface.run(scheme, z));
        }, 60_000);

  it("a scan of nothing fails", async () => {
    if (!browser || !s) return;
    const p = await page("/services", "light", SIZES[0]);
    const r = await scan(p, ".den-no-such-thing");
    await p.context().close();
    expect(r.present).toBe(false);
    expect(() => expectClean("nothing", r)).toThrow();
  }, 60_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
