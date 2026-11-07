/**
 * The Start agent dialog states readiness up front (AG-0.2), and never
 * asks for the admin password (LK-0), in a real browser on the real server:
 *
 *   - a runtime that can't run here disables Start, and the line under
 *     the runtime says why and how to fix it (install it, or set
 *     agents.runtimes.<id>.bin in the user.yml it names, or run
 *     `<cli> agents doctor`), in the Agents tab's dialog and on the
 *     Workspaces page's form; nothing fails only after Start;
 *   - one that can shows its version and the path it will run;
 *   - with no admin password set (and a sudo that needs one), the dialog
 *     has no password field, and Start starts the agent: it is for sudo,
 *     and starting an agent runs none (LK-0).
 *
 * The demo distribution (acme) with a scripted PTY (helpers/
 * agents-page-server.ts): nothing really runs. The `claude` shim answers
 * --version only; the `sudo` shim takes one invented password (never a
 * real sudo, never printed). Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it. DEN_AGENTS_SHOTS=<dir> writes
 * screenshots.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const PTY = loadPty().available;
const SHOTS = process.env.DEN_AGENTS_SHOTS;
// An invented password the sudo shim takes; it is no one's.
const PW = "open-sesame-test";

let browser: Browser | null = null;
let missing: AgentsPageServer | null = null;
let ready: AgentsPageServer | null = null;
let latest = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  [missing, ready] = await Promise.all([
    startAgentsPageServer({ runtime: "missing" }),
    startAgentsPageServer({ sudoPassword: PW }),
  ]);
  latest =
    (
      (await (await fetch(`${ready.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await missing?.stop();
  await ready?.stop();
});

const skip = () => !browser;
const errors: string[] = [];

async function page(s: AgentsPageServer, url: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      // No What's new dialog over the page: its latest version is seen.
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(url.startsWith("http") ? url : `${s.base}${url}`);
  return p;
}

const text = (p: Page, sel: string) =>
  p.$eval(sel, (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());

describe("AG-0.2: the runtime's readiness, before Start", () => {
  it("unavailable: Start is disabled and the line says why and how to fix it (the Agents dialog)", async () => {
    if (skip()) return;
    const p = await page(missing!, "/agents?start=1");
    await p.waitForSelector("#ag-dlg[open]");
    await p.waitForSelector("#ag-r-ready:not([hidden])");
    expect(await p.isDisabled("#ag-go")).toBe(true);
    expect(await p.getAttribute("#ag-r-ready", "data-tone")).toBe("warn");
    const user = path.join(missing!.tmp, "dist", "config", "local", "user.yml");
    expect(await text(p, "#ag-r-ready")).toBe(
      "Claude Code not found. Searched: " +
        `${path.join(missing!.tmp, "bin")}, /usr/bin, /bin. ` +
        `Install it, or set agents.runtimes.den-claude.bin to its path in ${user}, or run acme agents doctor.`,
    );
    // The disabled den-claude option says why too.
    expect(
      await p.$$eval("#ag-runtime option", (os) =>
        os.map((o) => [o.textContent, (o as HTMLOptionElement).disabled]),
      ),
    ).toEqual([
      ["Claude Code (persona default)", false],
      ["Claude Code — claude not found (searched 3 directories)", true],
      ["Generic command", false],
    ]);
    // Enter doesn't start it either.
    await p.press("#ag-persona", "Enter");
    expect(await p.isVisible("#ag-dlg")).toBe(true);
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "ag0-unavailable.png") });
    // Picking a runtime that can run lifts it.
    await p.selectOption("#ag-runtime", "generic");
    expect(await p.isDisabled("#ag-go")).toBe(false);
    expect(await p.isHidden("#ag-r-ready")).toBe(true);
    await p.context().close();
  }, 60_000);

  it("unavailable on the Workspaces page's form too", async () => {
    if (skip()) return;
    const p = await page(
      missing!,
      signInUrl(missing!.stateDir, missing!.base, "/?ws=north"),
    );
    await p.waitForSelector("#agent-start-open");
    await p.click("#agent-start-open");
    await p.waitForSelector(
      "#agent-start-form:not([hidden]) [data-runtime-ready]:not([hidden])",
    );
    expect(await p.isDisabled("#agent-start-go")).toBe(true);
    expect(await text(p, "#agent-start-form [data-runtime-ready]")).toMatch(
      /^Claude Code not found\. Searched: .*Install it, or set agents\.runtimes\.den-claude\.bin to its path in .*user\.yml, or run acme agents doctor\.$/,
    );
    await p.context().close();
  }, 60_000);

  it("available: its version and path; Start is enabled", async () => {
    if (skip()) return;
    const p = await page(ready!, "/agents?start=1");
    await p.waitForSelector("#ag-dlg[open]");
    await p.waitForSelector("#ag-r-ready:not([hidden])");
    expect(await text(p, "#ag-r-ready")).toBe(
      `Starts Claude Code 9.9.9 from ${path.join(ready!.tmp, "bin", "claude")}`,
    );
    expect(await p.getAttribute("#ag-r-ready", "data-tone")).toBe("");
    expect(await p.isDisabled("#ag-go")).toBe(false);
    expect(
      await p.$$eval("#ag-runtime option", (os) =>
        os.map((o) => o.textContent),
      ),
    ).toEqual([
      "Claude Code (persona default)",
      "Claude Code · 9.9.9",
      "Generic command",
    ]);
    await p.context().close();
  }, 60_000);
});

describe("LK-0: starting an agent never asks for the admin password", () => {
  it("with no password set and sudo needing one, the dialog has no password field, and Start starts the agent", async () => {
    if (skip() || !PTY) return;
    const p = await page(ready!, "/agents?start=1");
    await p.waitForSelector("#ag-dlg[open]");
    // No password field in the dialog, and no prompt or sudo chip.
    expect(await p.$$("#ag-dlg input[type=password]")).toHaveLength(0);
    expect(await p.$("#den-lock-pop")).toBeNull();
    expect(await p.isHidden("#den-lock")).toBe(true);
    const top = await p.$$eval("#ag-form > *", (els) =>
      els.filter((e) => !(e as HTMLElement).hidden).map((e) => e.id),
    );
    expect(top[0]).toBe("ag-dlg-h");
    expect(top).not.toContain("ag-lock");
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, "lk0-start.png") });
    const made = ready!.made.length;
    const [res] = await Promise.all([
      p.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/north/agents",
        { timeout: 20_000 },
      ),
      p.click("#ag-go"),
    ]);
    expect(res.status()).toBe(200);
    await p.waitForFunction(
      () => !(document.getElementById("ag-dlg") as HTMLDialogElement).open,
    );
    expect(ready!.made.length).toBe(made + 1);
    expect(await p.$("#den-lock-pop")).toBeNull();
    expect(await p.isHidden("#den-lock")).toBe(true);
    await p.context().close();
  }, 60_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
