/**
 * AG-14 on the Agents page, in a real browser:
 *
 *   - stopped agents stay listed, after the running ones, each with why it
 *     stopped, and Resume, Start fresh and Remove (the mock's .btn.sm,
 *     starting under the row's name; the mock's ended dot);
 *   - Resume continues the same conversation (`--resume <token>`, in the
 *     agent's own cwd) and opens its pane;
 *   - Remove is one click, with Undo in its toast;
 *   - a runtime that can't resume offers Start fresh only, and says why;
 *   - after a restart, one line: "N agents were interrupted when … restarted
 *     · Resume all · Review"; Review marks them, Resume all resumes each;
 *   - Clear stopped removes every stopped agent in view, never a running one;
 *   - never the admin password, and no page errors.
 *
 * The demo distribution (acme; north, south) with a session host in this
 * process and a scripted PTY (helpers/agents-page-server.ts): nothing
 * really runs. No token, cookie or login code is printed.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let latest = "";
const PTY = loadPty().available;
const errors: string[] = [];
const TOKEN = {
  scout: "11111111-1111-4111-8111-111111111111",
  night: "22222222-2222-4222-8222-222222222222",
  dawn: "33333333-3333-4333-8333-333333333333",
};
const STOPPED_AT = "2026-11-06T10:00:00.000Z";

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
  // north: three stopped agents. scout can resume; lookout's runtime
  // can't; keeper is the one to remove.
  s.seed({
    id: "scout",
    persona: "reviewer",
    workspace: "north",
    resumeToken: TOKEN.scout,
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "lookout",
    persona: "devops",
    workspace: "north",
    runtime: "codex",
    stoppedAt: STOPPED_AT,
  });
  s.seed({
    id: "keeper",
    persona: "planner",
    workspace: "north",
    resumeToken: "44444444-4444-4444-8444-444444444444",
    stoppedAt: STOPPED_AT,
  });
  // south: two agents a restart interrupted (no stop, no exit, no session).
  s.seed({
    id: "night",
    persona: "reviewer",
    workspace: "south",
    resumeToken: TOKEN.night,
  });
  s.seed({
    id: "dawn",
    persona: "devops",
    workspace: "south",
    resumeToken: TOKEN.dawn,
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
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  // Resume and Start fresh are shell-grade (SEC-1b): signed in as a person.
  await p.goto(signInUrl(s!.stateDir, s!.base, `/agents?ws=${ws}`));
  await p.waitForSelector("#agl:not([aria-busy]) .agst", { timeout: 20_000 });
  return p;
}

const row = (p: Page, id: string) =>
  p.locator(`#agl .agst[data-agent="${id}"]`);
const acts = (p: Page, id: string) =>
  row(p, id)
    .locator(".agacts [data-act]")
    .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.act));

describe("stopped agents on the Agents page (AG-14)", () => {
  it("are listed with why they stopped and their actions, laid out as the mock's", async () => {
    if (skip()) return;
    const p = await open("north");
    expect(await row(p, "scout").getAttribute("data-state")).toBe("stopped");
    expect(
      (await row(p, "scout").locator(".why").textContent())?.trim(),
    ).toMatch(/stopped/i);
    expect(await acts(p, "scout")).toEqual([
      "resume",
      "fresh",
      "rename",
      "remove",
    ]);
    // The mock's ended dot.
    expect(
      await row(p, "scout").locator(".den-dot").getAttribute("class"),
    ).toMatch(/\boff\b/);
    // The mock's .btn.sm: 2px 9px, 12.5px; Resume is the primary one.
    const btn = await row(p, "scout")
      .locator('[data-act="fresh"]')
      .evaluate((b) => {
        const c = getComputedStyle(b);
        return { padding: c.padding, size: c.fontSize };
      });
    expect(btn).toEqual({ padding: "2px 9px", size: "12.5px" });
    expect(
      await row(p, "scout")
        .locator('[data-act="resume"]')
        .getAttribute("class"),
    ).toMatch(/\bprimary\b/);
    // The actions start under the name: the row's 12px padding, 2px
    // border, the 8px dot and its 5px margins, the 8px gap.
    const [nm, first, agr] = await Promise.all([
      row(p, "scout").locator(".agr .nm").boundingBox(),
      row(p, "scout").locator(".agacts [data-act]").first().boundingBox(),
      row(p, "scout").locator(".agr").boundingBox(),
    ]);
    expect(Math.abs(first!.x - nm!.x)).toBeLessThanOrEqual(1);
    expect(Math.round(nm!.x - agr!.x)).toBe(40);
    // Clear stopped shows while anything stopped is in view.
    expect(await p.locator("#ag-clear").isVisible()).toBe(true);
    await p.context().close();
  }, 60_000);

  it("a runtime that can't resume offers Start fresh only, and says why", async () => {
    if (skip()) return;
    const p = await open("north");
    expect(await acts(p, "lookout")).toEqual(["fresh", "rename", "remove"]);
    expect(
      (
        await row(p, "lookout").locator("[data-no-resume]").textContent()
      )?.trim(),
    ).toBe("codex can't resume a conversation");
    const cant = await row(p, "lookout")
      .locator(".agcant")
      .evaluate((e) => getComputedStyle(e).fontSize);
    expect(cant).toBe("12px");
    await p.context().close();
  }, 60_000);

  it("Resume continues the same conversation, in the agent's own cwd, and opens its pane", async () => {
    if (skip() || !PTY) return;
    const p = await open("north");
    const before = s!.made.length;
    const res = p.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
        "/api/workspaces/north/agents/scout/resume",
    );
    await row(p, "scout").getByRole("button", { name: "Resume scout" }).click();
    expect((await res).status()).toBe(200);
    await p.waitForSelector(".pane .xterm", { timeout: 20_000 });
    const made = s!.made
      .slice(before)
      .filter((m) => m.opts.env?.DEN_AGENT === "agent:scout");
    expect(made).toHaveLength(1);
    const args = made[0].args;
    expect(
      args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2),
    ).toEqual(["--resume", TOKEN.scout]);
    expect(args).not.toContain("--session-id");
    expect(made[0].opts.cwd).toBe(s!.wsDir("north"));
    // Running now: listed first, no longer a stopped row.
    await p.waitForSelector(
      '#agl .agr[data-kind="agent"][data-state="running"]',
    );
    expect(await row(p, "scout").count()).toBe(0);
    await p.context().close();
  }, 60_000);

  it("Remove is one click; Undo in its toast brings the agent back", async () => {
    if (skip()) return;
    const p = await open("north");
    await row(p, "keeper")
      .getByRole("button", { name: "Remove keeper" })
      .click();
    const toast = p.locator(".den-toast.den-toast-act");
    await toast.waitFor();
    expect((await toast.locator("span").textContent())?.trim()).toBe(
      "Removed keeper",
    );
    await row(p, "keeper").waitFor({ state: "detached" });
    expect(fs.existsSync(path.join(s!.stateDir, "agents", "keeper.json"))).toBe(
      false,
    );
    await toast.getByRole("button", { name: "Undo" }).click();
    await row(p, "keeper").waitFor();
    expect(fs.existsSync(path.join(s!.stateDir, "agents", "keeper.json"))).toBe(
      true,
    );
    await p.context().close();
  }, 60_000);
});

describe("after a restart (AG-14.3)", () => {
  it("one line names the interrupted agents; Review marks them; Resume all resumes each with its token", async () => {
    if (skip() || !PTY) return;
    const p = await open("south");
    const note = p.locator('#agl .agnote[data-note="interrupted"]');
    await note.waitFor();
    expect((await note.textContent())?.replace(/\s+/g, " ").trim()).toMatch(
      /^2 agents were interrupted when .+ restarted · Resume all · Review$/,
    );
    // The mock's .lnk.
    const lnk = await note.locator('[data-act="review"]').evaluate((b) => {
      const c = getComputedStyle(b);
      return { size: c.fontSize, line: c.textDecorationLine };
    });
    expect(lnk).toEqual({ size: "12.5px", line: "underline" });
    for (const id of ["night", "dawn"])
      expect(await row(p, id).getAttribute("data-state")).toBe("interrupted");

    await note.getByRole("button", { name: "Review" }).click();
    expect(await p.locator("#agl .agst[data-review]").count()).toBe(2);

    const before = s!.made.length;
    const res = p.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/agents/resume-interrupted",
    );
    await note.getByRole("button", { name: "Resume all" }).click();
    expect((await res).status()).toBe(200);
    await note.waitFor({ state: "detached" });
    const made = s!.made.slice(before);
    expect(
      made
        .map((m) =>
          m.args.slice(
            m.args.indexOf("--resume"),
            m.args.indexOf("--resume") + 2,
          ),
        )
        .sort(),
    ).toEqual(
      [
        ["--resume", TOKEN.night],
        ["--resume", TOKEN.dawn],
      ].sort(),
    );
    for (const m of made) expect(m.opts.cwd).toBe(s!.wsDir("south"));
    await p.context().close();
  }, 60_000);
});

describe("Clear stopped (AG-14.1b)", () => {
  it("removes every stopped agent in view, never a running one, with Undo", async () => {
    if (skip()) return;
    const p = await open("north");
    await p.locator("#ag-clear").click();
    const toast = p.locator(".den-toast.den-toast-act");
    await toast.waitFor();
    expect((await toast.locator("span").textContent())?.trim()).toMatch(
      /^Removed \d+ stopped agents?$/,
    );
    await p.waitForFunction(
      () => !document.querySelector("#agl .agst"),
      undefined,
      { timeout: 15_000 },
    );
    expect(await p.locator("#ag-clear").isHidden()).toBe(true);
    // scout runs (resumed above, when the PTY module is here): still listed.
    if (PTY)
      expect(
        await p
          .locator('#agl .agr[data-kind="agent"][data-state="running"]')
          .count(),
      ).toBe(1);
    expect(
      fs.existsSync(path.join(s!.stateDir, "agents", "lookout.json")),
    ).toBe(false);
    await p.context().close();
  }, 60_000);

  it("asked for no admin password, and the pages raised no errors", () => {
    if (skip()) return;
    expect(s!.log()).not.toMatch(/sudo/i);
    expect(fs.existsSync(s!.ran)).toBe(false);
    expect(errors).toEqual([]);
  });
});

describe("D25: Rename, visible, by touch or keyboard", () => {
  // Its own stopped agent: the tests above remove theirs.
  beforeAll(() => {
    s?.seed({
      id: "namer",
      persona: "planner",
      workspace: "north",
      resumeToken: "55555555-5555-4555-8555-555555555555",
      stoppedAt: STOPPED_AT,
    });
  });

  it("a stopped agent's Rename opens a dialog that names what peers will see, and Enter saves it", async () => {
    if (skip()) return;
    const p = await open("north");
    await row(p, "namer").locator('[data-act="rename"]').click();
    const dlg = p.locator("#ag-rn");
    await dlg.waitFor({ state: "visible" });
    expect(await p.locator("#ag-rn-h").textContent()).toBe("Rename namer");
    expect(await p.locator("#ag-rn-help").textContent()).toMatch(
      /Other sessions see it as \S+-north:namer from its next start or resume/,
    );
    await p.locator("#ag-rn-name").fill("Night watch");
    expect(await p.locator("#ag-rn-help").textContent()).toMatch(
      /\S+-north:Night watch/,
    );
    await p.locator("#ag-rn-name").press("Enter");
    await dlg.waitFor({ state: "hidden" });
    await p.waitForFunction(() =>
      document
        .querySelector('#agl .agst[data-agent="namer"] .nm')
        ?.textContent?.includes("Night watch"),
    );
    const rec = JSON.parse(
      fs.readFileSync(path.join(s!.stateDir, "agents", "namer.json"), "utf-8"),
    ) as { displayName?: string };
    expect(rec.displayName).toBe("Night watch");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("fits a 375px screen, with Cancel and Rename in view", async () => {
    if (skip()) return;
    const p = await open("north");
    await p.setViewportSize({ width: 375, height: 700 });
    await row(p, "namer").locator('[data-act="rename"]').click();
    await p.locator("#ag-rn").waitFor({ state: "visible" });
    for (const sel of ["#ag-rn", "#ag-rn-cancel", "#ag-rn-go", "#ag-rn-name"]) {
      const b = (await p.locator(sel).boundingBox())!;
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(375);
    }
    await p.locator("#ag-rn-cancel").click();
    await p.locator("#ag-rn").waitFor({ state: "hidden" });
    await p.context().close();
  }, 60_000);
});
