/**
 * 0.4.8: the Agents page never falls back to All in place of its ?ws=.
 *
 *   - ?ws=<a workspace that isn't active>: one line, "Workspace west isn't
 *     active · Switch to west"; the list is that workspace's alone, and
 *     Clear stopped sends exactly it ({"workspaces":["west"]});
 *   - Switch to west makes it active and views it (the top bar's switch);
 *   - ?ws=<no such workspace>: the same line, saying no workspace has that
 *     name, and an empty list (nothing to clear).
 *
 * The demo distribution (acme; north and south active, west not) with a
 * session host in this process and a scripted PTY: nothing really runs.
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

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let latest = "";
const errors: string[] = [];
const STOPPED_AT = "2026-11-06T10:00:00.000Z";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ inactive: ["west"] });
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  s.seed({
    id: "scout",
    persona: "reviewer",
    workspace: "north",
    resumeToken: "77777777-7777-4777-8777-777777777777",
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "drifter",
    persona: "devops",
    workspace: "west",
    resumeToken: "88888888-8888-4888-8888-888888888888",
    stoppedAt: STOPPED_AT,
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function open(ws: string): Promise<Page> {
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
  await p.goto(signInUrl(s!.stateDir, s!.base, `/agents?ws=${ws}`));
  await p.waitForSelector("#agl:not([aria-busy]) .agnote, #agl .none", {
    timeout: 20_000,
  });
  return p;
}

const note = (p: Page) => p.locator('#agl .agnote[data-note="inactive"]');
const listed = (p: Page) =>
  p
    .locator("#agl .agst, #agl .agr")
    .evaluateAll((els) =>
      els
        .filter((e) => e.matches(".agst") || !e.closest(".agst"))
        .map(
          (e) =>
            `${(e.closest(".wsg") as HTMLElement | null)?.dataset.ws}/${(e as HTMLElement).dataset.agent ?? (e as HTMLElement).dataset.id}`,
        ),
    );

describe("?ws= for a workspace that isn't active", () => {
  it("says so in one line, lists only that workspace, and Clear stopped sends exactly it", async () => {
    if (skip()) return;
    const p = await open("west");
    await note(p).waitFor();
    expect((await note(p).textContent())?.replace(/\s+/g, " ").trim()).toBe(
      "Workspace west isn't active · Switch to west",
    );
    expect(await listed(p)).toEqual(["west/drifter"]);
    expect(await p.locator("#ag-start").isVisible()).toBe(true);
    const req = p.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/agents/clear-stopped",
    );
    await p.locator("#ag-clear").click();
    expect((await req).postDataJSON()).toEqual({ workspaces: ["west"] });
    await p.locator('#agl .agst[data-agent="drifter"]').waitFor({
      state: "detached",
    });
    // north's stopped agent is untouched.
    expect(fs.existsSync(path.join(s!.stateDir, "agents", "scout.json"))).toBe(
      true,
    );
    await p.context().close();
  }, 60_000);

  it("a workspace no one has: the same line, and an empty list", async () => {
    if (skip()) return;
    const p = await open("nowhere");
    await note(p).waitFor();
    expect((await note(p).textContent())?.replace(/\s+/g, " ").trim()).toBe(
      "Workspace nowhere isn't active (no workspace has that name)",
    );
    expect(await note(p).locator("button").count()).toBe(0);
    expect(await listed(p)).toEqual([]);
    expect(await p.locator("#ag-clear").isHidden()).toBe(true);
    // Nowhere to start an agent: no + Start agent.
    expect(await p.locator("#ag-start").isHidden()).toBe(true);
    await p.context().close();
  }, 60_000);

  it("Switch to west makes it active and views it, as the top bar's switch does", async () => {
    if (skip()) return;
    const p = await open("west");
    const posts: Array<{ path: string; body: unknown }> = [];
    p.on("request", (r) => {
      const u = new URL(r.url()).pathname;
      if (
        r.method() === "POST" &&
        (u === "/api/workspaces" || u === "/api/scope")
      )
        posts.push({ path: u, body: r.postDataJSON() });
    });
    const reloaded = p.waitForEvent("load");
    await note(p).getByRole("button", { name: "Switch to west" }).click();
    await reloaded;
    expect(posts).toEqual([
      { path: "/api/workspaces", body: { name: "west", action: "activate" } },
      { path: "/api/scope", body: { scope: "west" } },
    ]);
    await p.waitForSelector("#agl:not([aria-busy])");
    await p.waitForFunction(
      () => !document.querySelector('#agl .agnote[data-note="inactive"]'),
    );
    await p.context().close();
    expect(errors).toEqual([]);
  }, 60_000);
});
