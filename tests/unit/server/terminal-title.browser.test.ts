/**
 * Issue 169 part 2 (Den Design, option a): every terminal is named
 * "Terminal N" (es "Terminal N", ja "ターミナル N"): N per project, the
 * lowest free number, stable for the session's life. An older session
 * named "shell-2" reads "Terminal 2", never "shell". The same title on the
 * Terminals rows (and their aria-labels), the open terminal's title bar
 * and the palette ("Terminals › north / Terminal 2"). A row's line 2 is
 * the project, then the folder.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY
 * (no real shell runs), in Chromium and WebKit. DEN_PW_WS: Den's own
 * Playwright server instead of a local browser. DEN_SKIP_BROWSER_TESTS=1
 * skips it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, BrowserContext, Page } from "playwright";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const errors: string[] = [];

describe.each(["chromium", "webkit"] as const)("issue 169 in %s", (name) => {
  let browser: Browser | null = null;
  let s: AgentsPageServer | null = null;
  let latest = "";
  const contexts: BrowserContext[] = [];
  /** The older "shell-2" in north, a new one in north, one in south. */
  let old = "";
  let fresh = "";
  let south = "";

  beforeAll(async () => {
    try {
      const pw = await import("playwright");
      const kind = pw[name];
      browser = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
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
    // An older release's second terminal: named "shell-2" on the host.
    const c = await connectHost(sessionPaths(s.stateDir).socket);
    try {
      const info = await c.start({
        name: "acme-north:shell-2",
        cwd: s.wsDir("north"),
        argv: ["/bin/sh"],
        env: {},
        cols: 80,
        rows: 24,
      });
      old = info.ref.id;
      s.made.at(-1)!.emit("$ ");
    } finally {
      c.close();
    }
    fresh = await startTerminal("north");
    south = await startTerminal("south");
  }, 90_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await closeBrowserSuite({ browsers: [browser], servers: [s] });
  });

  const skip = () => !browser;

  async function startTerminal(ws: string): Promise<string> {
    const r = await fetch(`${s!.base}/api/workspaces/${ws}/sessions`, {
      method: "POST",
      headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBeLessThan(300);
    const { session } = (await r.json()) as { session: { id: string } };
    s!.made.at(-1)!.emit("$ ");
    return session.id;
  }

  async function open(path: string): Promise<Page> {
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 860 },
      reducedMotion: "reduce",
    });
    contexts.push(ctx);
    await ctx.addInitScript((v) => {
      try {
        for (const k of ["den-changelog-seen", "acme-changelog-seen"])
          localStorage.setItem(k, v);
        localStorage.setItem("den-shells-moved-seen", "1");
      } catch {
        /* none */
      }
    }, latest);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => {
      if (
        name === "webkit" &&
        e.message.endsWith(" due to access control checks.")
      )
        return;
      errors.push(`${name}: ${e.message}`);
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, path));
    return p;
  }

  const row = (p: Page, id: string) =>
    p.locator(`#agl .tmr[data-shell="${id}"]`);
  const title = async (p: Page, id: string) =>
    ((await row(p, id).locator(".nm").textContent()) ?? "").trim();

  it("rows: shell-2 is Terminal 2, the new one Terminal 1, per project; never shell", async () => {
    if (skip()) return;
    const p = await open("/terminals");
    for (const id of [old, fresh, south]) await row(p, id).waitFor();
    expect(await title(p, old)).toBe("Terminal 2");
    expect(await title(p, fresh)).toBe("Terminal 1");
    expect(await title(p, south)).toBe("Terminal 1");
    expect(
      await row(p, old).locator("button.agr").getAttribute("aria-label"),
    ).toBe("Open north / Terminal 2");
    const all = (await p.locator("#agl").innerText()) ?? "";
    expect(all).not.toMatch(/shell/i);
    // Line 2: the project, then the folder.
    expect(
      ((await row(p, old).locator(".meta").first().textContent()) ?? "").trim(),
    ).toMatch(/^north · \S/);
    // Stable: the same after a reload.
    await p.reload();
    await row(p, old).waitFor();
    expect(await title(p, old)).toBe("Terminal 2");
    expect(await title(p, fresh)).toBe("Terminal 1");
  }, 90_000);

  it("the open terminal's title bar says Terminal 2", async () => {
    if (skip()) return;
    const p = await open("/terminals");
    await row(p, old).waitFor();
    await row(p, old).locator("button.agr").click();
    const bar = p.locator(`.pane[data-id="${old}"] .tm-title b`);
    await bar.waitFor();
    expect((await bar.textContent())?.trim()).toBe("Terminal 2");
    expect(
      await p.locator(`.pane[data-id="${old}"] .bar2`).innerText(),
    ).not.toMatch(/shell/i);
  }, 90_000);

  it("the palette: Terminals › north / Terminal 2", async () => {
    if (skip()) return;
    const p = await open("/terminals");
    await row(p, old).waitFor();
    await p.click("#den-search");
    await p.fill("#den-pal-q", "north");
    await p.waitForSelector('#den-pal-list li[role="option"]');
    const said = await p
      .locator('#den-pal-list li[role="option"] .den-pal-l')
      .allTextContents();
    expect(said).toEqual(
      expect.arrayContaining([
        "Terminals › north / Terminal 2",
        "Terminals › north / Terminal 1",
      ]),
    );
    expect(said.join("\n")).not.toMatch(/shell/i);
  }, 90_000);

  it.each([
    ["es", "Terminal 2", "Abrir north / Terminal 2"],
    ["ja", "ターミナル 2", "north / ターミナル 2 を開く"],
  ])(
    "%s: the row and the title bar say %s",
    async (lang, want, aria) => {
      if (skip()) return;
      expect(await s!.settings({ language: lang })).toBe(200);
      try {
        const p = await open("/terminals");
        await row(p, old).waitFor();
        expect(await title(p, old)).toBe(want);
        expect(
          await row(p, old).locator("button.agr").getAttribute("aria-label"),
        ).toBe(aria);
        await row(p, old).locator("button.agr").click();
        const bar = p.locator(`.pane[data-id="${old}"] .tm-title b`);
        await bar.waitFor();
        expect((await bar.textContent())?.trim()).toBe(want);
      } finally {
        await s!.settings({ language: null });
      }
    },
    90_000,
  );
});

it("no page errors", () => {
  expect(errors).toEqual([]);
});
