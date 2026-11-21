/**
 * Issue 278 on the Agents page, end to end through Den's own server:
 *
 *   1. An agent whose transcript records automatic compactions in a loop
 *      (synthetic compact_boundary lines) is found by the server's watch:
 *      the bell rings once, and its row and its pane bar say "Compacting
 *      repeatedly", with the likely cause (its start's instruction check)
 *      and Stop: the same Stop as its pane's, which stops it.
 *   2. Its instruction files over the share: a "Large instructions" tag
 *      naming the largest file.
 *   3. Clear ends the loop for now (and a hold, when there is one).
 *
 * The demo distribution with a session host in this process
 * (helpers/agents-page-server.ts). Temp dirs, invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  instructionCheck,
  readCompacting,
  writeInstructionCheck,
} from "../../../src/shared/agents/context-watch.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { signInPage } from "./helpers/signed-in.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let sessionId = "";
const TOKEN = "27827827-8278-4278-8278-278278278278";
const files = () => path.join(s!.stateDir, "agent-files", "scout");
const transcript = () =>
  path.join(s!.tmp, "home", ".claude", "projects", "-seeded", `${TOKEN}.jsonl`);

/** `n` automatic compactions, the last a few seconds ago. */
function loop(n: number): void {
  const now = Date.now();
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      timestamp: new Date(now - (n - i) * 45_000).toISOString(),
      compactMetadata: { trigger: "auto", preTokens: 380000 },
    }),
  );
  fs.appendFileSync(transcript(), lines.join("\n") + "\n");
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
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
  sessionId = info.ref.id;
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    resumeToken: TOKEN,
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: "acme-north:scout",
  });
  fs.mkdirSync(files(), { recursive: true });
  writeInstructionCheck(
    files(),
    instructionCheck(
      [{ path: path.join(s.wsDir("north"), "CLAUDE.md"), bytes: 840 * 1024 }],
      s.wsDir("north"),
      { sharePercent: 15, contextTokens: 200_000 },
    ),
  );
  loop(5);
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

const skip = () => !browser;

async function open(url: string) {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const latest =
    (
      (await (await fetch(`${s!.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  // den#143: a page showing scout's pane says so every 4 s (NT-2), and
  // that takes scout's updates off the bell (ATTN-5), this one included.
  // On a busy machine a "looking" landed between the ring and the count
  // (0 bells, both clauses). The bell is what's tested here: the page's
  // looking is answered without reaching Den.
  await ctx.route("**/api/notifications/looking", (r) =>
    r.fulfill({ json: { ok: true } }),
  );
  const p: Page = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await signInPage(p, s!.stateDir, s!.base, url);
  return { p, errors };
}

const row = (p: Page) => p.locator('#agl .agst[data-agent="scout"]');

function bellNotes(): { msg?: { key?: string }; subject?: string }[] {
  try {
    const f = JSON.parse(
      fs.readFileSync(path.join(s!.stateDir, "notifications.json"), "utf-8"),
    ) as { items?: { msg?: { key?: string }; subject?: string }[] };
    return (f.items ?? []).filter((n) => n.msg?.key === "bell.m.compacting");
  } catch {
    return [];
  }
}

describe("issue 278: an agent stuck compacting, on the Agents page", () => {
  it("clauses 1 and 2: the row and the pane bar say so, with the cause and Stop; one bell", async () => {
    if (skip()) return;
    const { p, errors } = await open(
      `/agents?ws=north&open=${sessionId}&layout=tabs`,
    );
    await row(p).locator("[data-compacting]").waitFor({ timeout: 30_000 });
    expect(
      (await row(p).locator("[data-compacting]").textContent())?.trim(),
    ).toBe("Compacting repeatedly");
    const msg = (
      await row(p).locator("[data-compacting-msg]").textContent()
    )?.trim();
    expect(msg).toContain("Compacting repeatedly: 5 automatic compactions");
    expect(msg).toContain(
      "Likely cause: its instruction files are 840 KB, more than 15% of its context",
    );
    expect(msg).toContain("The largest is CLAUDE.md (840 KB)");
    expect(await row(p).locator('[data-act="stop"]').count()).toBe(1);
    expect(await row(p).locator('[data-act="ctx-clear"]').count()).toBe(1);
    // Clause 2: the instructions tag, naming the file.
    const ins = row(p).locator("[data-instructions]");
    expect((await ins.textContent())?.trim()).toBe("Large instructions");
    expect(await ins.getAttribute("title")).toContain("CLAUDE.md (840 KB)");
    // The pane bar: the tag beside its own Stop, and (a release gate
    // found them missing) what is happening, the likely cause and Clear,
    // on a line of its own; Stop only once, the bar's own.
    const bar = p.locator(".bar2").first();
    await bar.locator("[data-compacting]").waitFor({ timeout: 10_000 });
    expect(await bar.locator('[data-act="stop"]').count()).toBe(1);
    const said = bar.locator("[data-compacting-bar] [data-compacting-msg]");
    expect(await said.textContent()).toContain(
      "Compacting repeatedly: 5 automatic compactions",
    );
    expect(await said.textContent()).toContain(
      "Likely cause: its instruction files are 840 KB",
    );
    expect(
      await bar.locator('[data-compacting-bar] [data-act="ctx-clear"]').count(),
    ).toBe(1);
    // The bar's Clear sends the same request as the row's (answered here,
    // so the loop stays for clause 3).
    await p.route("**/agents/scout/compacting-clear", (r) =>
      r.fulfill({ json: { ok: true } }),
    );
    const cleared = p.waitForRequest(
      (r) =>
        r.method() === "POST" &&
        r.url().endsWith("/api/workspaces/north/agents/scout/compacting-clear"),
      { timeout: 15_000 },
    );
    await bar.locator('[data-compacting-bar] [data-act="ctx-clear"]').click();
    await cleared;
    // One bell for the episode, however many looks.
    expect(bellNotes()).toHaveLength(1);
    expect(bellNotes()[0].subject).toBe("agent:scout");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("clause 3: Clear ends it; a new loop after it rings again; the row's Stop stops it", async () => {
    if (skip()) return;
    const { p, errors } = await open(`/agents?ws=north`);
    await row(p).locator("[data-compacting]").waitFor({ timeout: 30_000 });
    await row(p).locator('[data-act="ctx-clear"]').click();
    await row(p)
      .locator("[data-compacting]")
      .waitFor({ state: "detached", timeout: 15_000 });
    expect(readCompacting(files())).toMatchObject({ active: false });
    expect(typeof readCompacting(files())?.clearedAt).toBe("string");
    // A new loop after the clear: a new episode, a second bell.
    await new Promise((r) => setTimeout(r, 1100));
    const now = Date.now();
    fs.appendFileSync(
      transcript(),
      [1, 2, 3, 4]
        .map((i) =>
          JSON.stringify({
            type: "system",
            subtype: "compact_boundary",
            timestamp: new Date(now + i).toISOString(),
            compactMetadata: { trigger: "auto" },
          }),
        )
        .join("\n") + "\n",
    );
    await row(p).locator("[data-compacting]").waitFor({ timeout: 30_000 });
    expect(bellNotes().length).toBeGreaterThanOrEqual(1);
    // The same Stop as its pane's: POST …/stop (an interactive sh may
    // outlive the TERM, so the answer may be "still stopping").
    const stopped = p.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url().endsWith("/api/workspaces/north/agents/scout/stop"),
      { timeout: 30_000 },
    );
    await row(p).locator('[data-act="stop"]').click();
    expect([200, 202]).toContain((await stopped).status());
    const rec = JSON.parse(
      fs.readFileSync(path.join(s!.stateDir, "agents", "scout.json"), "utf-8"),
    ) as { stoppedAt?: string };
    expect(typeof rec.stoppedAt).toBe("string");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 120_000);
});
