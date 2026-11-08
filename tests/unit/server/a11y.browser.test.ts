/**
 * Accessibility (axe-core) on the real web server, in a real browser: the
 * demo distribution, with notes up (a stub health check on localhost) and
 * pinned.
 *
 * Five surfaces, each in light and dark, at 1440×900 and 390×844:
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
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
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

const AXE = require.resolve("axe-core/axe.min.js");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let stub: http.Server | null = null;
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
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
  await browser?.close();
  await s?.stop();
  await new Promise<void>((r) => (stub ? stub.close(() => r()) : r()));
});

type Scheme = "light" | "dark";
type Size = { name: string; width: number; height: number };
const SIZES: Size[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];
const phone = (z: Size) => z.width < 640;

async function page(url: string, scheme: Scheme, z: Size): Promise<Page> {
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
