/**
 * AG-14 on the Agents page, in a real browser:
 *
 *   - stopped agents stay listed, in "Stopped (n)" after the running ones,
 *     one line each (D37): a hollow dot, the name, a chip, when, Resume
 *     and ⋯ (Start fresh, Remove); why it stopped and the rest in its
 *     tooltip; no Rename;
 *   - Resume continues the same conversation (`--resume <token>`, in the
 *     agent's own cwd) and opens its pane;
 *   - Remove is one click, with Undo in its toast;
 *   - a runtime that can't resume offers Start fresh, and says why;
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
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
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
  // Attached: a closed "Stopped (n)" hides its rows (D37).
  await p.waitForSelector("#agl:not([aria-busy]) .agr", {
    state: "attached",
    timeout: 20_000,
  });
  return p;
}

const row = (p: Page, id: string) =>
  p.locator(`#agl .agst[data-agent="${id}"]`);
const acts = (p: Page, id: string) =>
  row(p, id)
    .locator(".agacts [data-act]")
    .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.act));

/** The ⋯ menu of a stopped row: its items' names. */
async function menuOf(p: Page, id: string): Promise<string[]> {
  await row(p, id).locator('[data-act="row-more"]').click();
  const menu = p.locator('.den-pop[role="menu"]');
  await menu.waitFor();
  const items = await menu
    .locator(".den-mi")
    .evaluateAll((xs) => xs.map((x) => (x.textContent ?? "").trim()));
  await p.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" }).catch(() => undefined);
  return items;
}

describe("stopped agents on the Agents page (AG-14, D37)", () => {
  it("are listed one line each: a hollow dot, the name, a chip, when; Resume and ⋯", async () => {
    if (skip()) return;
    const p = await open("north");
    expect(await row(p, "scout").getAttribute("data-state")).toBe("stopped");
    expect(await acts(p, "scout")).toEqual(["resume", "row-more"]);
    expect(await menuOf(p, "scout")).toEqual(["Start fresh", "Remove"]);
    expect(
      (await row(p, "scout").locator(".stchip").textContent())?.trim(),
    ).toBe("Stopped");
    expect(
      (await row(p, "scout").locator(".when").textContent())?.trim(),
    ).not.toBe("");
    // Its persona, id, runtime, folder and why: the tooltip, not lines.
    const tip = (await row(p, "scout").locator(".agr").getAttribute("title"))!;
    expect(tip).toContain("reviewer · scout");
    expect(tip).toMatch(/stopped/i);
    expect(await row(p, "scout").locator(".meta, .why").count()).toBe(0);
    // No Rename on an agent that isn't running.
    expect(await row(p, "scout").locator('[data-act="rename"]').count()).toBe(
      0,
    );
    // The ended dot, hollow.
    expect(
      await row(p, "scout").locator(".den-dot").getAttribute("class"),
    ).toMatch(/\boff\b.*\bhollow\b/);
    expect(
      await row(p, "scout")
        .locator(".den-dot")
        .evaluate((d) => getComputedStyle(d).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    // The mock's .btn.sm; Resume is the primary one.
    const btn = await row(p, "scout")
      .locator('[data-act="resume"]')
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
    // One line: its row, its buttons, on the same line.
    const [r1, b1] = await Promise.all([
      row(p, "scout").boundingBox(),
      row(p, "scout").locator('[data-act="resume"]').boundingBox(),
    ]);
    expect(r1!.height).toBeLessThanOrEqual(40);
    expect(b1!.y).toBeGreaterThanOrEqual(r1!.y);
    expect(b1!.y + b1!.height).toBeLessThanOrEqual(r1!.y + r1!.height);
    // In "Stopped (3)", open (3 or fewer).
    const group = p.locator("#agl details[data-stopped]");
    expect((await group.locator("summary").textContent())?.trim()).toBe(
      "Stopped (3)",
    );
    expect(await group.getAttribute("open")).not.toBeNull();
    // Clear stopped shows while anything stopped is in view.
    expect(await p.locator("#ag-clear").isVisible()).toBe(true);
    await p.context().close();
  }, 60_000);

  it("a runtime that can't resume offers Start fresh, and says why in its tooltip", async () => {
    if (skip()) return;
    const p = await open("north");
    expect(await acts(p, "lookout")).toEqual(["fresh", "row-more"]);
    expect(await menuOf(p, "lookout")).toEqual(["Remove"]);
    expect(
      await row(p, "lookout").locator(".agr").getAttribute("title"),
    ).toContain("codex can't resume a conversation");
    await p.context().close();
  }, 60_000);

  it("its pane has the details the row leaves out, and Resume, Start fresh and Remove", async () => {
    if (skip() || !PTY) return;
    // Its session ended on its own (exited 3): its pane opens, ended.
    const before = s!.made.length;
    const host = await connectHost(sessionPaths(s!.stateDir).socket);
    const info = await host.start({
      name: "acme-north:ender",
      cwd: s!.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    host.close();
    s!.made[before].exit(3);
    s!.seed({
      id: "ender",
      persona: "reviewer",
      workspace: "north",
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: "acme-north:ender",
      resumeToken: "88888888-8888-4888-8888-888888888888",
    });
    const p = await open("north");
    // 4 stopped: "Stopped (4)" starts closed.
    const group = p.locator("#agl details[data-stopped]");
    await group.waitFor();
    if ((await group.getAttribute("open")) === null)
      await group.locator("summary").click();
    await row(p, "ender").waitFor({ timeout: 15_000 });
    expect(
      (await row(p, "ender").locator(".stchip").textContent())?.trim(),
    ).toBe("Exited");
    // D45: the row opens its details; its output is one click from there.
    await row(p, "ender").locator(".agr").click();
    await p.locator('.den-agd [data-agd="open"]').click();
    const bar = p.locator(".pane .bar2", { hasText: "ender" }).first();
    await bar.locator('[data-act="resume"]').waitFor({ timeout: 15_000 });
    expect(await bar.locator(".where").textContent()).toContain(
      "reviewer · ender",
    );
    expect((await bar.locator("[data-why]").textContent())?.trim()).toMatch(
      /exited/i,
    );
    await bar.locator('[data-act="more"]').click();
    const menu = p.locator('.den-pop[role="menu"]');
    await menu.waitFor();
    const items = await menu
      .locator(".den-mi")
      .evaluateAll((xs) => xs.map((x) => (x.textContent ?? "").trim()));
    expect(items).toContain("Start fresh");
    expect(items).toContain("Remove");
    expect(items.some((x) => /^Rename/.test(x))).toBe(false);
    await p.keyboard.press("Escape");
    // Gone for the tests after it (their counts).
    await row(p, "ender").locator('[data-act="row-more"]').click();
    await p
      .locator('.den-pop[role="menu"] .den-mi', { hasText: "Remove" })
      .click();
    await row(p, "ender").waitFor({ state: "detached" });
    await p.context().close();
  }, 60_000);

  describe("D45: a stopped agent's details, from its row", () => {
    const det = (p: Page) => p.locator('.den-agd[role="dialog"]');
    const btn = (p: Page, id: string) => row(p, id).locator(".agr");
    async function shown(p: Page): Promise<void> {
      const g = p.locator("#agl details[data-stopped]");
      if ((await g.count()) && (await g.getAttribute("open")) === null)
        await g.locator("summary").click();
    }

    it("a click opens them beside the row: who, how it ended, what it was last asked, where; Resume first", async () => {
      if (skip()) return;
      // What scout was last asked: its transcript, by D39's rules (the
      // summary after it is no ask).
      const dir = path.join(s!.tmp, "home", ".claude", "projects", "-seeded");
      fs.mkdirSync(dir, { recursive: true });
      const line = (o: unknown) => `${JSON.stringify(o)}\n`;
      fs.writeFileSync(
        path.join(dir, `${TOKEN.scout}.jsonl`),
        line({
          type: "user",
          timestamp: "2026-11-06T09:30:00.000Z",
          message: { role: "user", content: "Review the north release notes" },
        }) +
          line({
            type: "assistant",
            message: {
              role: "assistant",
              stop_reason: "end_turn",
              content: [],
            },
          }) +
          line({
            type: "user",
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
            message: {
              role: "user",
              content: "This session is being continued",
            },
          }),
      );
      const p = await open("north");
      await shown(p);
      await btn(p, "scout").click();
      await det(p).waitFor();
      expect(await btn(p, "scout").getAttribute("aria-expanded")).toBe("true");
      const text = (await det(p).textContent()) ?? "";
      for (const want of ["reviewer", "den-claude", "Stopped", "north"])
        expect(text).toContain(want);
      await det(p)
        .getByText("Review the north release notes")
        .waitFor({ timeout: 10_000 });
      expect(text).not.toContain("This session is being continued");
      const actions = await det(p)
        .locator(".den-svp-acts .den-btn")
        .evaluateAll((bs) =>
          bs.map((b) => [
            (b as HTMLElement).dataset.agd,
            b.classList.contains("primary"),
          ]),
        );
      expect(actions.slice(0, 3)).toEqual([
        ["resume", true],
        ["fresh", false],
        ["remove", false],
      ]);
      // Focus is in it: its first action.
      expect(
        await p.evaluate(
          () => (document.activeElement as HTMLElement)?.dataset?.agd,
        ),
      ).toBe("resume");
      // The row keeps its own Resume.
      expect(await acts(p, "scout")).toContain("resume");
      await p.context().close();
    }, 60_000);

    it("Esc closes them and focus goes back to the row; a click outside closes them; Enter on the row opens them", async () => {
      if (skip()) return;
      const p = await open("north");
      await shown(p);
      await btn(p, "scout").click();
      await det(p).waitFor();
      await p.keyboard.press("Escape");
      await det(p).waitFor({ state: "detached" });
      expect(
        await p.evaluate(() =>
          (document.activeElement as HTMLElement)
            ?.closest(".agst")
            ?.getAttribute("data-agent"),
        ),
      ).toBe("scout");
      expect(await btn(p, "scout").getAttribute("aria-expanded")).toBe("false");
      // Enter on the focused row opens them again.
      await p.keyboard.press("Enter");
      await det(p).waitFor();
      await p.mouse.click(5, 5);
      await det(p).waitFor({ state: "detached" });
      await p.context().close();
    }, 60_000);

    it("a runtime that can't resume: Start fresh is first, and there is no Resume", async () => {
      if (skip()) return;
      const p = await open("north");
      await shown(p);
      await btn(p, "lookout").click();
      await det(p).waitFor();
      const first = det(p).locator(".den-svp-acts .den-btn").first();
      expect(await first.getAttribute("data-agd")).toBe("fresh");
      expect(await first.getAttribute("class")).toContain("primary");
      expect(await det(p).locator('[data-agd="resume"]').count()).toBe(0);
      await p.context().close();
    }, 60_000);

    it("at 390px they are a bottom sheet inside the window, and touch closes them", async () => {
      if (skip()) return;
      const ctx = await browser!.newContext({
        viewport: { width: 390, height: 800 },
        hasTouch: true,
        isMobile: true,
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
      await p.goto(signInUrl(s!.stateDir, s!.base, "/agents?ws=north"));
      await p.waitForSelector("#agl:not([aria-busy]) .agr", {
        state: "attached",
        timeout: 20_000,
      });
      await shown(p);
      await btn(p, "scout").tap();
      await det(p).waitFor();
      expect(await det(p).getAttribute("class")).toContain("den-sheet");
      const box = (await det(p).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(
        await p.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await p.locator(".den-svp-scrim").tap({ position: { x: 10, y: 10 } });
      await det(p).waitFor({ state: "detached" });
      await ctx.close();
    }, 60_000);
  });

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
    await row(p, "keeper").locator('[data-act="row-more"]').click();
    await p
      .locator('.den-pop[role="menu"] .den-mi', { hasText: "Remove" })
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

describe("D25: Rename, visible, by touch or keyboard (D37: a running agent's)", () => {
  // Its own running agent: the tests above remove theirs.
  beforeAll(async () => {
    if (!s) return;
    const host = await connectHost(sessionPaths(s.stateDir).socket);
    const info = await host.start({
      name: "acme-north:namer",
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    host.close();
    s.seed({
      id: "namer",
      persona: "planner",
      workspace: "north",
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: "acme-north:namer",
      resumeToken: "55555555-5555-4555-8555-555555555555",
    });
  });

  /** namer's pane, then ⋯ › Rename…. */
  async function rename(p: Page) {
    const agr = p
      .locator('#agl .agr[data-kind="agent"][data-state="running"]', {
        hasText: "namer",
      })
      .first();
    const id = await agr.getAttribute("data-id");
    await agr.click();
    const bar = p.locator(`.pane[data-id="${id}"] .bar2`);
    await bar.locator('[data-act="more"]').click();
    await p
      .locator('.den-pop[role="menu"] .den-mi', { hasText: "Rename…" })
      .click();
  }

  it("a running agent's Rename opens a dialog that names what peers will see, and Enter saves it", async () => {
    if (skip() || !PTY) return;
    const p = await open("north");
    await rename(p);
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
      [...document.querySelectorAll("#agl .agr .nm")].some((n) =>
        n.textContent?.includes("Night watch"),
      ),
    );
    const rec = JSON.parse(
      fs.readFileSync(path.join(s!.stateDir, "agents", "namer.json"), "utf-8"),
    ) as { displayName?: string };
    expect(rec.displayName).toBe("Night watch");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("fits a 375px screen, with Cancel and Rename in view", async () => {
    if (skip() || !PTY) return;
    const p = await open("north");
    await p.setViewportSize({ width: 375, height: 700 });
    await rename(p);
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

describe("D37: Stopped (n), one line each, at the bottom", () => {
  // 1 running (namer, above) and 3 stopped.
  beforeAll(() => {
    for (const [i, id] of ["east", "west", "mid"].entries())
      s?.seed({
        id,
        persona: "reviewer",
        workspace: "north",
        resumeToken: `6666666${i}-6666-4666-8666-666666666666`,
        stoppedAt: STOPPED_AT,
      });
  });
  const group = (p: Page) => p.locator("#agl details[data-stopped]");

  it("below the running ones; open for 3; a person's close or open is kept across a reload", async () => {
    if (skip()) return;
    const p = await open("north");
    await group(p).waitFor();
    expect((await group(p).locator("summary").textContent())?.trim()).toBe(
      "Stopped (3)",
    );
    // Last in the list, after every workspace's running ones.
    expect(
      await p.evaluate(() => {
        const g = document.querySelector("#agl details[data-stopped]")!;
        return [...document.querySelectorAll("#agl .wsg")].pop() === g;
      }),
    ).toBe(true);
    for (const id of ["east", "west", "mid"]) {
      const b = (await row(p, id).boundingBox())!;
      expect(b.height).toBeLessThanOrEqual(40);
    }
    expect(await group(p).getAttribute("open")).not.toBeNull();
    if (process.env.DEN_AGENTS_SHOTS)
      await p.locator("#agl").screenshot({
        path: path.join(process.env.DEN_AGENTS_SHOTS, "d37-stopped.png"),
      });
    // Closed by a person: still closed after a reload.
    await group(p).locator("summary").click();
    expect(await group(p).getAttribute("open")).toBeNull();
    expect(await row(p, "east").isVisible()).toBe(false);
    await p.reload();
    await group(p).waitFor();
    expect(await group(p).getAttribute("open")).toBeNull();
    // A refresh poll later, still closed.
    await p.waitForTimeout(5_000);
    expect(await group(p).getAttribute("open")).toBeNull();
    // By keyboard: the summary is one focus stop; Enter opens it.
    await group(p).locator("summary").focus();
    await p.keyboard.press("Enter");
    expect(await group(p).getAttribute("open")).not.toBeNull();
    await p.reload();
    await group(p).waitFor();
    expect(await group(p).getAttribute("open")).not.toBeNull();
    // Tab from a row reaches Resume, then ⋯.
    await row(p, "east").locator(".agr").focus();
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLElement)?.dataset.act,
      ),
    ).toBe("resume");
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLElement)?.dataset.act,
      ),
    ).toBe("row-more");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("closed by default for more than 3", async () => {
    if (skip()) return;
    s?.seed({
      id: "late",
      persona: "reviewer",
      workspace: "north",
      resumeToken: "77777777-7777-4777-8777-777777777777",
      stoppedAt: STOPPED_AT,
    });
    const p = await open("north");
    await p.waitForFunction(
      () =>
        document
          .querySelector("#agl details[data-stopped] summary")
          ?.textContent?.includes("(4)"),
      undefined,
      { timeout: 15_000 },
    );
    expect(await group(p).getAttribute("open")).toBeNull();
    await p.context().close();
  }, 60_000);

  it("Resume works from the row", async () => {
    if (skip() || !PTY) return;
    const p = await open("north");
    await group(p).waitFor();
    if ((await group(p).getAttribute("open")) === null)
      await group(p).locator("summary").click();
    const res = p.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
        "/api/workspaces/north/agents/east/resume",
    );
    await row(p, "east").getByRole("button", { name: "Resume east" }).click();
    expect((await res).status()).toBe(200);
    await row(p, "east").waitFor({ state: "detached", timeout: 15_000 });
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});
