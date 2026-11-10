/**
 * D20: the agents page tags where an agent's session runs, from what the
 * session host stamped, through GET /api/sessions (no mocked route):
 *
 *   - a host in the desktop login session (Aqua): "Stops at logout" on the
 *     row, and a button in the pane bar that says why when tapped;
 *   - a host outside it (Background): "No GUI";
 *   - a host that didn't say: no tag.
 *
 * The 0.4.22-dev.0 gate found the tags never rendered: the rows the
 * server sent dropped the stamp. The demo distribution with a session host
 * in this process and a scripted PTY (helpers/agents-page-server.ts).
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
const servers: AgentsPageServer[] = [];

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
  for (const s of servers) await s.stop();
});

/** A server whose host stamps `launchd`, with one running agent. */
async function withAgent(launchd?: string) {
  const s = await startAgentsPageServer(launchd ? { launchd } : {});
  servers.push(s);
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
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: "acme-north:scout",
  });
  return { s, id: info.ref.id };
}

async function open(s: AgentsPageServer, id: string, width = 1280) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
  });
  const p: Page = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${s.base}/agents?open=${id}&layout=tabs`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  return { p, errors };
}

describe("where an agent runs, on the agents page (D20)", () => {
  it("Aqua: 'Stops at logout' on the row and in the pane bar, which says why", async () => {
    if (!browser) return;
    const { s, id } = await withAgent("Aqua");
    const { p, errors } = await open(s, id);
    const row = p.locator(`.agr[data-id="${id}"] [data-where="logout"]`);
    await row.waitFor({ timeout: 10_000 });
    const btn = p.locator(`.pane[data-id="${id}"] [data-act="where"]`);
    await btn.waitFor({ timeout: 10_000 });
    expect(await btn.getAttribute("data-where")).toBe("logout");
    expect(await btn.getAttribute("title")).toContain(
      "service install --mode always",
    );
    expect(await btn.getAttribute("title")).toContain(
      "not yet proven across a logout",
    );
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("Background: 'No GUI'; at 375 px too", async () => {
    if (!browser) return;
    const { s, id } = await withAgent("Background");
    const { p, errors } = await open(s, id, 375);
    await p
      .locator(`.agr[data-id="${id}"] [data-where="bg"]`)
      .waitFor({ state: "attached", timeout: 10_000 });
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("a host that didn't say: no tag", async () => {
    if (!browser) return;
    const { s, id } = await withAgent();
    const { p } = await open(s, id);
    await p.locator(`.pane[data-id="${id}"] .bar2`).waitFor();
    expect(await p.locator("[data-where]").count()).toBe(0);
    await p.context().close();
  }, 60_000);
});
