/**
 * Session rotation (den#4) on the Agents page, in a real browser:
 *
 *   - a rotated agent with a handoff that passes reads "Ready to relaunch
 *     (3 compactions)" or "(PR merged)", with Relaunch from handoff as its
 *     primary button (the 0.4.8 stopped row's den-btn sm primary), then
 *     Start fresh and Remove; no Resume;
 *   - Relaunch from handoff starts a fresh conversation (--session-id, a
 *     new id) whose first prompt is the handoff, in the agent's folder,
 *     and opens its pane;
 *   - a rotated agent with no handoff.md says so, and keeps Resume and
 *     Start fresh;
 *   - no page errors.
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
import { writeRotation } from "../../../src/shared/agents/rotation.js";
import { loadPty } from "../../../src/shared/sessions/pty.js";
import { GOOD_HANDOFF } from "../agents/helpers/handoff.js";
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
  relay: "55555555-5555-4555-8555-555555555555",
  drift: "66666666-6666-4666-8666-666666666666",
  merger: "77777777-7777-4777-8777-777777777777",
};
const STOPPED_AT = "2026-11-06T10:00:00.000Z";
const files = (id: string) => path.join(s!.stateDir, "agent-files", id);

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  // relay rotated after 3 compactions and wrote its handoff; drift rotated
  // and wrote none; merger's pull request merged, with a handoff.
  for (const [id, compactions] of [
    ["relay", 3],
    ["drift", 3],
    ["merger", 1],
  ] as const) {
    s.seed({
      id,
      persona: "reviewer",
      workspace: "north",
      resumeToken: TOKEN[id],
      stoppedAt: STOPPED_AT,
      ...(id === "merger"
        ? {
            outcome: {
              prOpened: "https://github.com/acme/notes/pull/9",
              prMerged: true,
            },
          }
        : {}),
    });
    writeRotation(files(id), {
      conversation: TOKEN[id],
      compactions,
      after: 3,
      ...(compactions >= 3 ? { due: "compactions" as const } : {}),
    });
    if (id !== "drift")
      fs.writeFileSync(path.join(files(id), "handoff.md"), GOOD_HANDOFF);
  }
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
  await p.goto(signInUrl(s!.stateDir, s!.base, `/agents?ws=${ws}`));
  await p.waitForSelector("#agl:not([aria-busy]) .agst", { timeout: 20_000 });
  return p;
}

const row = (p: Page, id: string) =>
  p.locator(`#agl .agst[data-agent="${id}"]`);
const acts = (p: Page, id: string) =>
  row(p, id)
    // D37: the one-line row's buttons, then its callout's.
    .locator(".agacts [data-act], .agcallout [data-act]")
    .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.act));
const text = async (p: Page, id: string, sel: string) =>
  (await row(p, id).locator(sel).textContent())?.replace(/\s+/g, " ").trim();

describe("rotated agents on the Agents page (den#4)", () => {
  it("read Ready to relaunch, with Relaunch from handoff as the primary button and no Resume", async () => {
    if (skip()) return;
    const p = await open("north");
    expect(await row(p, "relay").getAttribute("data-rotation")).toBe("ready");
    expect(await text(p, "relay", ".agr .stchip")).toBe(
      "Ready to relaunch (3 compactions)",
    );
    expect(await acts(p, "relay")).toEqual([
      "fresh",
      "row-more",
      "relaunch",
      "rot-keep",
    ]);
    expect(await text(p, "merger", ".agr .stchip")).toBe(
      "Ready to relaunch (PR merged)",
    );
    expect(await acts(p, "merger")).toEqual([
      "fresh",
      "row-more",
      "relaunch",
      "rot-keep",
    ]);
    // The 0.4.8 stopped row's buttons: den-btn sm, the primary first, the
    // mock's .btn.sm (2px 9px, 12.5px).
    const btn = row(p, "relay").locator('[data-act="relaunch"]');
    expect(await btn.getAttribute("class")).toBe("den-btn sm primary");
    expect((await btn.textContent())?.trim()).toBe("Relaunch now");
    expect(
      await btn.evaluate((b) => {
        const c = getComputedStyle(b);
        return { padding: c.padding, size: c.fontSize };
      }),
    ).toEqual({ padding: "2px 9px", size: "12.5px" });
    // The same look as Resume on a plain stopped row.
    const [relaunchBg, freshBg] = await Promise.all([
      btn.evaluate((b) => getComputedStyle(b).backgroundColor),
      row(p, "relay")
        .locator('[data-act="fresh"]')
        .evaluate((b) => getComputedStyle(b).backgroundColor),
    ]);
    expect(relaunchBg).not.toBe(freshBg);
    await p.context().close();
  }, 60_000);

  it("one with no handoff.md says so, and keeps Resume and Start fresh", async () => {
    if (skip()) return;
    const p = await open("north");
    expect(await row(p, "drift").getAttribute("data-rotation")).toBe("due");
    expect(await acts(p, "drift")).toEqual([
      "resume",
      "row-more",
      "relaunch",
      "rot-keep",
    ]);
    expect(await text(p, "drift", '[data-handoff="missing"]')).toBe(
      "Due (3 compactions). It has no handoff yet.",
    );
    expect(
      await row(p, "drift")
        .locator(".agcant[data-rot-msg]")
        .evaluate((e) => getComputedStyle(e).fontSize),
    ).toBe("12px");
    await p.context().close();
  }, 60_000);

  it("Relaunch from handoff starts a fresh conversation from the handoff and opens its pane", async () => {
    if (skip() || !PTY) return;
    const p = await open("north");
    const before = s!.made.length;
    const res = p.waitForResponse(
      (r) =>
        new URL(r.url()).pathname ===
        "/api/workspaces/north/agents/relay/relaunch",
    );
    await row(p, "relay")
      .getByRole("button", { name: "Relaunch relay now" })
      .click();
    expect((await res).status()).toBe(200);
    await p.waitForSelector(".pane .xterm", { timeout: 20_000 });
    const made = s!.made
      .slice(before)
      .filter((m) => m.opts.env?.DEN_AGENT === "agent:relay");
    expect(made).toHaveLength(1);
    const args = made[0].args;
    expect(args[0]).toBe("--session-id");
    expect(args[1]).not.toBe(TOKEN.relay);
    expect(args).not.toContain("--resume");
    expect(args[args.length - 1]).toContain(GOOD_HANDOFF);
    expect(made[0].opts.cwd).toBe(s!.wsDir("north"));
    await p.waitForSelector(
      '#agl .agr[data-kind="agent"][data-state="running"]',
    );
    expect(await row(p, "relay").count()).toBe(0);
    expect(fs.existsSync(path.join(files("relay"), "handoff.md"))).toBe(false);
    await p.context().close();
  }, 60_000);

  it("raised no page errors and ran nothing real", () => {
    if (skip()) return;
    expect(fs.existsSync(s!.ran)).toBe(false);
    expect(errors).toEqual([]);
  });
});
