/**
 * D28: a due agent's callout has buttons, running or stopped, on its row
 * and in its pane bar, and says what happens from its on_due:
 *
 *   - before, a running agent whose rotation was due got a tag and nothing
 *     to press (Relaunch only rendered on a stopped row);
 *   - auto (the default): "Den asks it for its handoff when it is idle,
 *     then relaunches it", with Relaunch now, Write handoff, Keep this
 *     conversation (+ don't ask again) and Settings;
 *   - Keep with "don't ask again": the count starts again and the agent's
 *     override is never; the callout goes;
 *   - Settings › Agents › Rotation: this install's values and overrides,
 *     saved to agent-rotation.json.
 *
 * At 1280 and 375 px, no horizontal scroll. The demo distribution with a
 * session host in this process (helpers/agents-page-server.ts). Needs
 * Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import {
  readRotation,
  writeRotation,
} from "../../../src/shared/agents/rotation.js";
import {
  readRotateFile,
  setRotateValue,
} from "../../../src/shared/agents/rotate-settings.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { signInUrl } from "./helpers/den-auth.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let sessionId = "";
const TOKEN = "88888888-8888-4888-8888-888888888888";
const files = () => path.join(s!.stateDir, "agent-files", "scout");

function due(): void {
  writeRotation(files(), {
    conversation: TOKEN,
    compactions: 3,
    after: 3,
    due: "compactions",
  });
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
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
  due();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(
  width: number,
  url = `/agents?ws=north&open=${sessionId}&layout=tabs`,
) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
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
  const p: Page = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, url));
  return { p, errors };
}

const row = (p: Page) => p.locator('#agl .agst[data-agent="scout"]');
const acts = (p: Page) =>
  row(p)
    .locator(".agacts [data-act]")
    .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.act));
const hScroll = (p: Page) =>
  p.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );

describe("a due agent's callout (D28)", () => {
  for (const width of [1280, 375])
    it(`running, auto: says what Den does, with its buttons, on the row and in the pane bar (${width} px)`, async () => {
      if (!browser) return;
      due();
      const { p, errors } = await open(width);
      await row(p).waitFor({ timeout: 20_000 });
      expect(await row(p).getAttribute("data-state")).toBe("running");
      expect(
        (await row(p).locator("[data-rot-msg]").textContent())?.trim(),
      ).toBe(
        "Due (3 compactions). Den asks it for its handoff when it is idle, then relaunches it.",
      );
      expect(
        (await row(p).locator("[data-rot-from]").textContent())?.trim(),
      ).toBe(
        "Rotates after 3 compactions (default); when due: relaunch by itself (default)",
      );
      expect(await acts(p)).toEqual(["relaunch", "rot-write", "rot-keep"]);
      expect(await row(p).locator("[data-rot-never]").count()).toBe(1);
      expect(
        await row(p).locator("[data-rot-settings]").getAttribute("href"),
      ).toBe("/settings?q=rotation#agents");
      if (width === 1280) {
        const bar = p.locator(`.pane[data-id="${sessionId}"] [data-rot-bar]`);
        await bar.waitFor({ timeout: 10_000 });
        expect(
          await bar
            .locator("[data-act]")
            .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.act)),
        ).toEqual(["relaunch", "rot-write", "rot-keep"]);
      }
      for (const b of await row(p).locator(".agacts button").all())
        expect(await b.isVisible()).toBe(true);
      expect(await hScroll(p)).toBe(false);
      expect(errors).toEqual([]);
      await p.context().close();
    }, 60_000);

  it("ask: says it has no handoff; Keep with don't ask again resets it and sets never", async () => {
    if (!browser) return;
    due();
    setRotateValue(s!.stateDir, "install", undefined, "on_due", "ask");
    const { p, errors } = await open(1280);
    await row(p).waitFor({ timeout: 20_000 });
    expect((await row(p).locator("[data-rot-msg]").textContent())?.trim()).toBe(
      "Due (3 compactions). It has no handoff yet.",
    );
    await row(p).locator("[data-rot-never]").check();
    const res = p.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/workspaces/north/agents/scout/keep",
    );
    await row(p)
      .getByRole("button", { name: "Keep scout's conversation" })
      .click();
    expect((await res).status()).toBe(200);
    await p.locator('#agl .agst[data-agent="scout"]').waitFor({
      state: "detached",
      timeout: 10_000,
    });
    expect(readRotation(files())?.compactions).toBe(0);
    expect(readRotateFile(s!.stateDir).overrides?.agent?.scout).toEqual({
      after_compactions: "never",
    });
    expect(errors).toEqual([]);
    await p.context().close();
    setRotateValue(
      s!.stateDir,
      "agent",
      "scout",
      "after_compactions",
      undefined,
    );
    setRotateValue(s!.stateDir, "install", undefined, "on_due", undefined);
  }, 60_000);

  it("off: no callout", async () => {
    if (!browser) return;
    due();
    setRotateValue(s!.stateDir, "agent", "scout", "on_due", "off");
    const { p } = await open(1280);
    await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
    expect(await row(p).count()).toBe(0);
    expect(await p.locator("[data-rot-bar]").count()).toBe(0);
    await p.context().close();
    setRotateValue(s!.stateDir, "agent", "scout", "on_due", undefined);
  }, 60_000);
});

describe("Settings › Agents › Rotation (D28)", () => {
  for (const width of [1280, 375])
    it(`saves this install's value and an override (${width} px)`, async () => {
      if (!browser) return;
      fs.rmSync(path.join(s!.stateDir, "agent-rotation.json"), { force: true });
      const { p, errors } = await open(width, "/settings?q=rotation#agents");
      const host = p.locator("[data-rotation-settings]");
      await host.waitFor({ timeout: 20_000 });
      const saved = () =>
        p.waitForResponse(
          (r) =>
            new URL(r.url()).pathname === "/api/agents/rotation" &&
            r.request().method() === "PUT",
        );
      let res = saved();
      await p.selectOption("#rot-on_due", "ask");
      expect((await res).status()).toBe(200);
      await p
        .locator('[data-rot-key="on_due"] [data-rot-src]')
        .filter({
          hasText: "this install",
        })
        .waitFor();
      await p.selectOption("#rot-a-scope", "persona");
      await p.fill("#rot-a-target", "builder");
      await p.fill("#rot-a-value", "5");
      res = saved();
      await p.getByRole("button", { name: "Add override" }).click();
      expect((await res).status()).toBe(200);
      await p.locator("[data-rot-row]").first().waitFor();
      expect(readRotateFile(s!.stateDir)).toEqual({
        install: { on_due: "ask" },
        overrides: { persona: { builder: { after_compactions: 5 } } },
      });
      res = saved();
      await p
        .getByRole("button", {
          name: "Clear after_compactions for persona builder",
        })
        .click();
      expect((await res).status()).toBe(200);
      expect(await hScroll(p)).toBe(false);
      expect(errors).toEqual([]);
      await p.context().close();
      fs.rmSync(path.join(s!.stateDir, "agent-rotation.json"), { force: true });
    }, 60_000);
});
