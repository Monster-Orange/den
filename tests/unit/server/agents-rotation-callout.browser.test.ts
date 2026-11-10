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
  for (const [width, layout] of [
    [1280, "tabs"],
    [375, "tabs"],
    [375, "focus"],
  ] as const)
    it(`running, auto: says what Den does, with its buttons, on the row and in the pane bar (${width} px, ${layout})`, async () => {
      if (!browser) return;
      due();
      const { p, errors } = await open(
        width,
        `/agents?ws=north&open=${sessionId}&layout=${layout}`,
      );
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
      const bar = p.locator(`.pane[data-id="${sessionId}"] [data-rot-bar]`);
      await bar.waitFor({ timeout: 10_000 });
      expect(
        await bar
          .locator("[data-act]")
          .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.act)),
      ).toEqual(["relaunch", "rot-write", "rot-keep"]);
      // At 375 px: the callout takes a line of its own below the bar's
      // own buttons, so a long name never puts Stop over Write handoff.
      if (width === 375)
        expect(
          await p
            .locator(`.pane[data-id="${sessionId}"] .bar2`)
            .evaluate(
              (b) =>
                b.querySelector("[data-rot-bar]")!.getBoundingClientRect()
                  .top >=
                b.querySelector(".x")!.getBoundingClientRect().bottom - 1,
            ),
        ).toBe(true);
      // At 375 px: no callout button lies under another bar control (Stop).
      expect(
        await p.locator(`.pane[data-id="${sessionId}"] .bar2`).evaluate((b) => {
          const box = (e: Element) => e.getBoundingClientRect();
          const hit = (a: DOMRect, c: DOMRect) =>
            a.left < c.right &&
            c.left < a.right &&
            a.top < c.bottom &&
            c.top < a.bottom;
          const rot = [...b.querySelectorAll("[data-rot-bar] button")];
          const rest = [...b.querySelectorAll("button")].filter(
            (x) => !x.closest("[data-rot-bar]"),
          );
          return rot.flatMap((r) =>
            rest
              .filter((o) => hit(box(r), box(o)))
              .map(
                (o) =>
                  `${r.textContent?.trim()} / ${o.getAttribute("aria-label") ?? o.textContent?.trim()}`,
              ),
          );
        }),
      ).toEqual([]);
      for (const b of await row(p).locator(".agacts button").all())
        expect(await b.isVisible()).toBe(true);
      expect(await hScroll(p)).toBe(false);
      expect(errors).toEqual([]);
      await p.context().close();
    }, 60_000);

  it("one compaction: the from line says compaction; a fallen-back agent with a bad handoff says so", async () => {
    if (!browser) return;
    writeRotation(files(), {
      conversation: TOKEN,
      compactions: 1,
      after: 1,
      due: "compactions",
      asked: 2,
      fellBack: true,
    });
    setRotateValue(s!.stateDir, "agent", "scout", "after_compactions", 1);
    fs.writeFileSync(path.join(files(), "handoff.md"), "## Objective\n");
    const { p, errors } = await open(1280);
    await row(p).waitFor({ timeout: 20_000 });
    expect(
      (await row(p).locator("[data-rot-from]").textContent())?.trim(),
    ).toBe(
      "Rotates after 1 compaction (agent scout); when due: relaunch by itself (default)",
    );
    expect((await row(p).locator("[data-rot-msg]").textContent())?.trim()).toBe(
      "Due (1 compaction). Its handoff still fails the check after 2 asks.",
    );
    expect(errors).toEqual([]);
    await p.context().close();
    fs.rmSync(path.join(files(), "handoff.md"), { force: true });
    setRotateValue(
      s!.stateDir,
      "agent",
      "scout",
      "after_compactions",
      undefined,
    );
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
    // Nor a "Handoff due" tag: under off nothing will happen.
    expect(
      await p
        .locator(
          '#agl .agr[data-agent="scout"] .agrot, #agl .agr[data-agent="scout"] [data-rotation]',
        )
        .count(),
    ).toBe(0);
    expect(await p.locator("#agl").textContent()).not.toMatch(/Handoff due/);
    await p.context().close();
    setRotateValue(s!.stateDir, "agent", "scout", "on_due", undefined);
  }, 60_000);
});

describe("the add override form (D30)", () => {
  for (const width of [1280, 375])
    it(`picks an agent by its name with the keyboard; the table shows names, a gone one greyed (${width} px)`, async () => {
      if (!browser) return;
      fs.rmSync(path.join(s!.stateDir, "agent-rotation.json"), { force: true });
      // An agent with a name a person gave it, and an override for one
      // that no longer exists.
      s!.seed({
        id: "scout",
        persona: "builder",
        runtime: "den-claude",
        workspace: "north",
        resumeToken: TOKEN,
        session: { backend: "den-pty", id: sessionId },
        sessionName: "acme-north:scout",
        displayName: "Scout the builder",
      });
      setRotateValue(s!.stateDir, "agent", "ghost", "on_due", "off");
      const { p, errors } = await open(width, "/settings?q=rotation#agents");
      await p.locator("[data-rotation-settings]").waitFor({ timeout: 20_000 });
      const gone = p.locator("[data-rot-row][data-rot-gone]");
      await gone.waitFor();
      expect((await gone.locator('[data-l="For"]').textContent())?.trim()).toBe(
        "ghost (gone)",
      );
      expect(
        await gone
          .getByRole("button", { name: /^Remove When due for ghost$/ })
          .count(),
      ).toBe(1);

      const saved = p.waitForResponse(
        (r) =>
          new URL(r.url()).pathname === "/api/agents/rotation" &&
          r.request().method() === "PUT",
      );
      // Agent is the first scope; its picker lists names, not ids.
      await p.focus("#rot-a-agent");
      await p.keyboard.type("scou");
      const opts = p.locator("#rot-a-agent-list [role=option]");
      await opts.first().waitFor();
      expect(
        (await opts.first().locator(".den-combo-l").textContent())?.trim(),
      ).toBe("Scout the builder");
      expect(
        (await opts.first().locator(".den-combo-s").textContent())?.trim(),
      ).toMatch(/^north · /);
      await p.keyboard.press("Enter");
      expect(await p.inputValue("#rot-a-agent")).toBe("Scout the builder");
      await p.keyboard.press("Tab");
      // Setting: When due; the value is a choice, not free text.
      await p.selectOption("#rot-a-key", "on_due");
      expect(await p.isVisible("#rot-a-due")).toBe(true);
      expect(await p.isVisible("#rot-a-n")).toBe(false);
      await p.selectOption("#rot-a-due", "ask");
      await p.getByRole("button", { name: "Add override" }).click();
      expect((await saved).status()).toBe(200);
      expect(readRotateFile(s!.stateDir).overrides?.agent?.scout).toEqual({
        on_due: "ask",
      });
      const row = p.locator("[data-rot-row]:not([data-rot-gone])");
      await row.first().waitFor();
      expect(
        (await row.first().locator('[data-l="For"]').textContent())?.trim(),
      ).toBe("Scout the builder (north)");
      expect(
        (await row.first().locator('[data-l="Value"]').textContent())?.trim(),
      ).toBe("Ask");
      // No id is shown anywhere for it.
      expect(await p.locator(".rot-ov").textContent()).not.toMatch(/\bscout\b/);
      expect(await hScroll(p)).toBe(false);
      expect(errors).toEqual([]);
      await p.context().close();
      fs.rmSync(path.join(s!.stateDir, "agent-rotation.json"), { force: true });
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
      // D30: the persona is picked by name (type, Enter), never typed as an id.
      await p.selectOption("#rot-a-scope", "persona");
      await p.click("#rot-a-persona");
      await p.keyboard.type("be-d");
      await p.keyboard.press("Enter");
      await p.selectOption("#rot-a-key", "after_compactions");
      await p.fill("#rot-a-n", "5");
      res = saved();
      await p.getByRole("button", { name: "Add override" }).click();
      expect((await res).status()).toBe(200);
      await p.locator("[data-rot-row]").first().waitFor();
      // Lines of the overrides table: no word (a header, or a key like
      // after_compactions) is split across two lines.
      expect(
        await p.locator(".rot-ov").evaluate((t) => {
          const split: string[] = [];
          const walk = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const text = n.textContent ?? "";
            for (const m of text.matchAll(/\S+/g)) {
              const r = document.createRange();
              r.setStart(n, m.index!);
              r.setEnd(n, m.index! + m[0].length);
              const tops = new Set(
                [...r.getClientRects()]
                  .filter((x) => x.width > 0)
                  .map((x) => Math.round(x.top)),
              );
              if (tops.size > 1) split.push(m[0]);
            }
          }
          // Header labels drawn by CSS (narrow cards) are checked too.
          return split;
        }),
      ).toEqual([]);
      expect(readRotateFile(s!.stateDir)).toEqual({
        install: { on_due: "ask" },
        overrides: { persona: { "be-dev": { after_compactions: 5 } } },
      });
      res = saved();
      await p
        .getByRole("button", {
          name: "Clear After compactions for be-dev",
        })
        .click();
      expect((await res).status()).toBe(200);
      expect(await hScroll(p)).toBe(false);
      expect(errors).toEqual([]);
      await p.context().close();
      fs.rmSync(path.join(s!.stateDir, "agent-rotation.json"), { force: true });
    }, 60_000);
});
