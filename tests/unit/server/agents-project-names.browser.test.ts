/**
 * 0.4.45: the Agents page names a project as the header's picker does:
 * Hub's name when it is linked to a Hub project, else its own. The list's
 * group, the pane's bar (its project and "project › repo" with Change)
 * and the To line under the terminal. Invented names only. Needs
 * Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  // north: linked to the Hub project "North Star".
  const wy = path.join(s.tmp, "dist", "config", "local", "workspaces.yml");
  fs.writeFileSync(
    wy,
    fs
      .readFileSync(wy, "utf-8")
      .replace(
        "  north:\n",
        "  north:\n    hub_project: {id: p-north, slug: north-star, name: North Star}\n",
      ),
  );
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
  await browser?.close();
  await s?.stop();
});

describe("the Agents page names a project as Hub does", () => {
  it("its group, the pane's bar and the To line say North Star, not north", async () => {
    if (!browser) return;
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 860 },
    });
    await ctx.addInitScript(() => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, "9.9.9");
      } catch {
        /* none */
      }
    });
    const p = await ctx.newPage();
    // The names come slower than the list: the page waits for them.
    await p.route("**/api/workspaces", async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    await p.goto(
      signInUrl(s.stateDir, s.base, `/agents?open=${sid}&layout=tabs`),
    );
    const pane = `.pane[data-id="${sid}"]`;
    await p
      .locator(`.agtab[data-id="${sid}"] .tm`)
      .waitFor({ timeout: 20_000 });
    // The first paint already says it: no slug first, then the name.
    expect(
      await p.locator(`.agtab[data-id="${sid}"] .tm`).textContent(),
    ).toContain("North Star");
    await p.locator(`${pane} .xterm`).waitFor({ timeout: 20_000 });
    const said = (sel: string) =>
      p.waitForFunction(
        (sel) =>
          /North Star/.test(document.querySelector(sel)?.textContent ?? ""),
        sel,
        { timeout: 10_000 },
      );
    await said(`#agl .wsg[data-ws="north"] .wsh`);
    await said(`${pane} .bar2 .where .wsn`);
    await said(`${pane} .bar2 .aglink .mono`);
    await said(`${pane} .agto`);
    await said(`.agtab[data-id="${sid}"] .tm`);
    expect(await p.locator(`${pane} .agto`).textContent()).toBe(
      "To scout · North Star",
    );
    // The page's line: "1 agent · 0 waiting · North Star" in a project.
    await p.goto(
      signInUrl(s.stateDir, s.base, `/agents?project=north&open=${sid}`),
    );
    await p.locator("#ag-count").waitFor();
    await p.waitForFunction(
      () => (document.querySelector("#ag-count")?.textContent ?? "") !== "",
    );
    expect(await p.locator("#ag-count").textContent()).toContain("North Star");
    await ctx.close();
  }, 60_000);
});
