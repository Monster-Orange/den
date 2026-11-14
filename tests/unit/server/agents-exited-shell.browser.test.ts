/**
 * #80 (0.4.45): an exited shell had no way out of the Agents list. It
 * stayed in its project's group ("exited (0)"), because only an agent
 * counted as stopped, and its pane's Close went with its exit. Now:
 *
 *   1. A shell that exits moves into Stopped, with Remove on its row.
 *   2. Remove takes it out; Clear stopped takes out exited shells and
 *      stopped agents together.
 *   3. A running shell never shows Remove; its pane shows Close.
 *   4. An exited shell with nothing unread leaves by itself after
 *      agents.exited_shell_minutes (default 10); one with unread output
 *      stays until removed.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY: nothing really runs. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../../sessions/helpers/fake-pty.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let host: HostClient | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
}, 60_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

/** A plain shell `name` in north: its session id and PTY. */
async function shell(name: string): Promise<{ id: string; pty: ScriptedPty }> {
  const info = await host!.start({
    name: `acme-north:${name}`,
    cwd: s!.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  const pty = s!.made[s!.made.length - 1];
  pty.emit("$ ");
  return { id: info.ref.id, pty };
}

/** Until the host says `id` exited. */
async function exited(id: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const x = (await host!.list()).find((v) => v.ref.id === id);
    if (x?.exited) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${id} never exited`);
}

async function open(next: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, next));
  return p;
}

const inStopped = (p: Page, id: string) =>
  p.locator(`#agl details[data-stopped] [data-shell="${id}"]`);
const inGroup = (p: Page, id: string) =>
  p.locator(`#agl .wsg:not([data-stopped]) .agr[data-id="${id}"]`);
const listed = async (id: string) =>
  (await host!.list()).some((v) => v.ref.id === id);

describe("#80: an exited shell has a way out", () => {
  it("a running shell shows Close, never Remove; once it exits it moves to Stopped, with Remove", async () => {
    if (!browser) return;
    const sh = await shell("one");
    const p = await open(`/agents?project=north&layout=focus&open=${sh.id}`);
    await p.waitForSelector(
      `.pane[data-id="${sh.id}"] [data-act="close-shell"]`,
    );
    await expect(inGroup(p, sh.id).count()).resolves.toBe(1);
    expect(await p.$$(`#agl [data-act="remove-shell"]`)).toHaveLength(0);
    sh.pty.exit(0);
    await exited(sh.id);
    await inStopped(p, sh.id).waitFor({ state: "attached", timeout: 15_000 });
    await expect(inGroup(p, sh.id).count()).resolves.toBe(0);
    // Remove takes it out, here and on the host.
    await p.$eval("#agl details[data-stopped]", (d) => {
      (d as HTMLDetailsElement).open = true;
    });
    await inStopped(p, sh.id).locator('[data-act="remove-shell"]').click();
    await inStopped(p, sh.id).waitFor({ state: "detached" });
    expect(await listed(sh.id)).toBe(false);
    await p.context().close();
  }, 60_000);

  it("Clear stopped takes out exited shells and stopped agents together", async () => {
    if (!browser) return;
    const sh = await shell("two");
    sh.pty.exit(0);
    await exited(sh.id);
    s!.seed({
      id: "idle",
      persona: "reviewer",
      workspace: "north",
      resumeToken: "66666666-6666-4666-8666-666666666666",
      stoppedAt: "2026-11-06T10:00:00.000Z",
    });
    const p = await open(`/agents?project=north&layout=focus`);
    await inStopped(p, sh.id).waitFor({ state: "attached" });
    await p.locator("#ag-clear").click();
    await inStopped(p, sh.id).waitFor({ state: "detached" });
    await p.waitForSelector('#agl .agst[data-agent="idle"]', {
      state: "detached",
    });
    expect(await listed(sh.id)).toBe(false);
    await p.context().close();
  }, 60_000);

  it("after agents.exited_shell_minutes, one with nothing unread leaves by itself; one with unread output stays", async () => {
    if (!browser) return;
    // The demo distribution's config file.
    const yml = path.join(s!.tmp, "dist", "config", "acme.yml");
    const was = fs.readFileSync(yml, "utf-8");
    // 0.01 minutes: 0.6 s.
    fs.writeFileSync(yml, `${was}\nagents:\n  exited_shell_minutes: 0.01\n`);
    try {
      const seen = await shell("seen");
      const unseen = await shell("unseen");
      // `seen` exits with its pane open; `unseen` prints while no one
      // looks, then exits.
      const p = await open(
        `/agents?project=north&layout=focus&open=${seen.id}`,
      );
      await p.waitForSelector(`.pane[data-id="${seen.id}"] .agto:not(:empty)`);
      await p.waitForTimeout(300);
      seen.pty.exit(0);
      unseen.pty.emit("a result no one read\r\n");
      unseen.pty.exit(0);
      await exited(seen.id);
      await exited(unseen.id);
      await p.waitForTimeout(1500);
      await p.reload();
      await p.waitForSelector("#agl .wsg");
      expect(await listed(seen.id)).toBe(false);
      expect(await listed(unseen.id)).toBe(true);
      await expect(inStopped(p, unseen.id).count()).resolves.toBe(1);
      await p.context().close();
    } finally {
      fs.writeFileSync(yml, was);
    }
  }, 60_000);
});
