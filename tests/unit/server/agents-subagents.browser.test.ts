/**
 * den#3: the pane bar says what an agent's subagents run on, and where
 * that came from, through GET /api/sessions (no mocked route): "subagents:
 * sonnet" with Den's default in its tip; a persona's inherit as "the
 * runtime's"; nothing for an agent whose record has none (a runtime that
 * takes no subagent model). The demo distribution with a session host in
 * this process (helpers/agents-page-server.ts). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
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

/** A server with one running agent whose record has `subagents`. */
async function withAgent(subagents?: { model?: string; from: string }) {
  const s = await startAgentsPageServer({});
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
    ...(subagents ? { subagents } : {}),
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

describe("an agent's subagent model, in its pane bar (den#3)", () => {
  it("the default: 'subagents: sonnet', and the tip says it is Den's default", async () => {
    if (!browser) return;
    const { s, id } = await withAgent({ model: "sonnet", from: "default" });
    const { p, errors } = await open(s, id);
    const tag = p.locator(`.pane[data-id="${id}"] .bar2 [data-subagents]`);
    await tag.waitFor({ timeout: 10_000 });
    expect(await tag.getAttribute("data-subagents")).toBe("sonnet");
    expect((await tag.textContent())?.trim()).toBe("subagents: sonnet");
    expect(await tag.getAttribute("title")).toContain("Explore too");
    expect(await tag.getAttribute("title")).toContain("Den's default");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("a persona's inherit: 'the runtime's', from its persona", async () => {
    if (!browser) return;
    const { s, id } = await withAgent({ from: "persona" });
    const { p } = await open(s, id);
    const tag = p.locator(`.pane[data-id="${id}"] .bar2 [data-subagents]`);
    await tag.waitFor({ timeout: 10_000 });
    expect(await tag.getAttribute("data-subagents")).toBe("inherit");
    expect((await tag.textContent())?.trim()).toBe("subagents: the runtime's");
    expect(await tag.getAttribute("title")).toContain("subagent_model");
    await p.context().close();
  }, 60_000);

  it("a record without one: no tag", async () => {
    if (!browser) return;
    const { s, id } = await withAgent();
    const { p } = await open(s, id);
    await p.locator(`.pane[data-id="${id}"] .bar2`).waitFor();
    expect(await p.locator("[data-subagents]").count()).toBe(0);
    await p.context().close();
  }, 60_000);
});
