/**
 * AG-0.5's runtime catalog in a real browser, on the real server:
 *
 *   - Settings › Agents › Runtimes lists every catalog runtime, installed
 *     first, each with its status, version, the path in use and where it
 *     came from; one that isn't Claude Code is tagged "Den tools: coming";
 *   - "Set path…" refuses a path that isn't that runtime, under the field,
 *     and saves one that is; the workspace selector edits that
 *     workspace's own path (config/local/workspaces.yml), and Clear
 *     removes it;
 *   - the Start agent dialog is the approved mock's width (den-shell.html's
 *     .dlg.wide, 638 outside at 1440), never wider than the viewport less
 *     16px a side, and lists the installed runtimes first.
 *
 * The demo distribution with fake CLIs on PATH (helpers/
 * agents-page-server.ts): each answers --version only and records any
 * other run. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips
 * it. DEN_AGENTS_SHOTS=<dir> writes screenshots.
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

const SHOTS = process.env.DEN_AGENTS_SHOTS;
let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
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
  s = await startAgentsPageServer({ bins: { codex: "codex-cli 0.50.0" } });
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function page(url: string, width = 1440, height = 900): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height },
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
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(url.startsWith("http") ? url : `${s!.base}${url}`);
  return p;
}

const text = (p: Page, sel: string) =>
  p.$eval(sel, (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());

/** A fake CLI: --version prints `version`; anything else is recorded. */
function fake(dir: string, name: string, version: string): string {
  const bin = path.join(s!.tmp, dir, name);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(
    bin,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  return bin;
}

describe("Settings › Agents › Runtimes (AG-0.5)", () => {
  it("lists each runtime, installed first, with its version, path and source; Set path refuses what isn't it; a workspace's own path is set and cleared", async () => {
    if (skip()) return;
    const p = await page(signInUrl(s!.stateDir, s!.base, "/settings#agents"));
    await p.waitForSelector('.rt[data-runtime="codex"]');
    expect(
      await p.$$eval(".rt", (els) =>
        els.map((e) => [
          (e as HTMLElement).dataset.runtime,
          (e as HTMLElement).dataset.available,
        ]),
      ),
    ).toEqual([
      ["den-claude", "true"],
      ["codex", "true"],
      ["gemini", "false"],
      ["grok", "false"],
    ]);
    const row = '.rt[data-runtime="codex"]';
    expect(await text(p, `${row} .rt-n`)).toBe(
      "Codex CLI OpenAI Den tools: coming",
    );
    expect(await text(p, `${row} .rt-s`)).toBe("✓ 0.50.0");
    expect(await text(p, `${row} .rt-w`)).toBe(
      `${path.join(s!.tmp, "bin", "codex")} detected · PATH`,
    );
    expect(await text(p, '.rt[data-runtime="den-claude"] .rt-n')).toBe(
      "Claude Code Anthropic",
    );
    expect(await text(p, '.rt[data-runtime="gemini"] .rt-s')).toBe(
      "Not installed",
    );
    if (SHOTS)
      await p.screenshot({
        path: path.join(SHOTS, "ag05-settings-runtimes.png"),
        fullPage: true,
      });

    // Set path… with a CLI that isn't Codex: refused, under the field.
    const other = fake("other", "codex", "1.2.3");
    await p.click(`${row} [data-set-path]`);
    await p.fill(`${row} input`, other);
    await p.click(`${row} .rt-f [type=submit]`);
    await p.waitForSelector(`${row} .rt-err:not([hidden])`);
    expect(await text(p, `${row} .rt-err`)).toMatch(/is not Codex CLI/);
    const userYml = path.join(s!.tmp, "dist", "config", "local", "user.yml");
    const before = fs.existsSync(userYml)
      ? fs.readFileSync(userYml, "utf-8")
      : "";
    expect(before).not.toContain(other);

    // North's own path: the selector, then Set path… and Clear.
    const north = fake("north-bin", "codex", "codex-cli 0.52.0");
    await p.selectOption("#rt-ws", "north");
    await p.waitForSelector(`${row} .rt-fl:has-text("for north")`, {
      state: "attached",
    });
    await p.click(`${row} [data-set-path]`);
    await p.fill(`${row} input`, north);
    await p.click(`${row} .rt-f [type=submit]`);
    await p.waitForSelector(`${row} [data-clear-path]`);
    expect(await text(p, `${row} .rt-s`)).toBe("✓ 0.52.0");
    expect(await text(p, `${row} .rt-w`)).toBe(`${north} workspace`);
    const wsYml = fs.readFileSync(
      path.join(s!.tmp, "dist", "config", "local", "workspaces.yml"),
      "utf-8",
    );
    expect(wsYml).toContain(north);
    if (SHOTS)
      await p.screenshot({
        path: path.join(SHOTS, "ag05-settings-workspace-path.png"),
        fullPage: true,
      });
    // Every workspace's view still runs the detected one.
    await p.selectOption("#rt-ws", "");
    await p.waitForFunction(
      (sel) =>
        document.querySelector(sel)?.textContent?.includes("detected · PATH"),
      `${row} .rt-w`,
    );
    // Clear it.
    await p.selectOption("#rt-ws", "north");
    await p.waitForSelector(`${row} [data-clear-path]`);
    await p.click(`${row} [data-clear-path]`);
    await p.waitForSelector(`${row} [data-clear-path]`, { state: "detached" });
    expect(await text(p, `${row} .rt-w`)).toContain("detected · PATH");
    expect(
      fs.readFileSync(
        path.join(s!.tmp, "dist", "config", "local", "workspaces.yml"),
        "utf-8",
      ),
    ).not.toContain(north);
    // Nothing but --version ever ran.
    expect(fs.existsSync(s!.ran)).toBe(false);
    await p.context().close();
  }, 60_000);
});

describe("the Start agent dialog (AG-0.5)", () => {
  it.each([
    [1440, 900, 638],
    [375, 812, 343],
  ])(
    "at %ix%i it is the mock's width (%ipx), with the installed runtimes first",
    async (width, height, want) => {
      if (skip()) return;
      const p = await page("/agents?start=1", width, height);
      await p.waitForSelector("#ag-dlg[open]");
      await p.waitForSelector('#ag-runtime option[value="codex"]', {
        state: "attached",
      });
      const box = await p.$eval("#ag-dlg", (e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, left: r.left, right: r.right };
      });
      expect(Math.round(box.w)).toBe(want);
      expect(box.left).toBeGreaterThanOrEqual(16 - 0.5);
      expect(box.right).toBeLessThanOrEqual(width - 16 + 0.5);
      expect(
        await p.$$eval("#ag-runtime option", (os) =>
          os.map((o) => o.textContent),
        ),
      ).toEqual([
        "Claude Code (persona default)",
        "Claude Code · 9.9.9",
        "Codex CLI · 0.50.0 · Den tools: coming",
        "Gemini CLI — not installed",
        "Grok Build — not installed",
        "Generic command — the persona has no argv template",
      ]);
      if (SHOTS)
        await p.screenshot({
          path: path.join(SHOTS, `ag05-start-dialog-${width}.png`),
        });
      await p.context().close();
    },
    60_000,
  );

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
