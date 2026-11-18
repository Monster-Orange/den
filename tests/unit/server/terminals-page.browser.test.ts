/**
 * Issue 482 (model A, mock v3): terminals get their own list.
 *
 *   1. /terminals lists plain shells only; /agents lists agents only, with
 *      a one-time "N shells moved to Terminals. Nothing was closed." note.
 *   2. The list follows the project filter; each row shows its project
 *      (All projects only), folder, running or exited, and last used.
 *   3. A click anywhere on a row opens that shell. Exited rows are dimmed
 *      to 55%, with Restart and Remove, which don't open the row. A
 *      running shell has no Remove.
 *   4. "New terminal" is one click on the page and on each project.
 *   5. The rail's Terminals opens the running shell used last (issue 448's
 *      shell-pick.js), or starts one with a toast.
 *   6. Shells that were in the Agents list are all still reachable: the
 *      old links land on Terminals.
 *   8. The rail, the page title and the tooltip say "Terminals".
 *   States: loading, empty, error (with Try again) and none running.
 *   Phone (390): rows ≥ 64 px, buttons ≥ 44 px, New terminal 48 px; a
 *   shell opens full screen with a back arrow and the keys row.
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
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const errors: string[] = [];

describe.each(["chromium", "webkit"] as const)("issue 482 in %s", (name) => {
  let browser: Browser | null = null;
  let s: AgentsPageServer | null = null;
  let latest = "";
  const contexts: BrowserContext[] = [];
  const ptys = new Map<string, ScriptedPty>();

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
    await scope("all");
  }, 90_000);

  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await closeBrowserSuite({ browsers: [browser], servers: [s] });
  });

  const skip = () => !browser;

  async function scope(v: string) {
    const r = await fetch(`${s!.base}/api/scope`, {
      method: "POST",
      headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
      body: JSON.stringify({ scope: v }),
    });
    expect(r.status).toBe(200);
  }

  /** A shell started in `ws`, as an older release's Terminal did. */
  async function startShell(ws: string): Promise<string> {
    const r = await fetch(`${s!.base}/api/workspaces/${ws}/sessions`, {
      method: "POST",
      headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
      body: "{}",
    });
    const { session } = (await r.json()) as { session: { id: string } };
    ptys.set(session.id, s!.made.at(-1)!);
    ptys.get(session.id)!.emit("$ ");
    await new Promise((r) => setTimeout(r, 20));
    return session.id;
  }

  async function sessions() {
    return (
      (await (await fetch(`${s!.base}/api/sessions`)).json()) as {
        sessions: { id: string; kind: string; exited?: boolean }[];
      }
    ).sessions;
  }

  async function endShell(id: string) {
    ptys.get(id)!.exit(0);
    const deadline = Date.now() + 10_000;
    while (!(await sessions()).find((x) => x.id === id)?.exited) {
      if (Date.now() > deadline) throw new Error(`${id} never exited`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function open(
    path: string,
    opts: { width?: number; height?: number; seen?: boolean } = {},
  ): Promise<Page> {
    const ctx = await browser!.newContext({
      viewport: { width: opts.width ?? 1280, height: opts.height ?? 860 },
      reducedMotion: "reduce",
      ...(opts.width && opts.width <= 480 ? { hasTouch: true } : {}),
    });
    contexts.push(ctx);
    await ctx.addInitScript(
      ([v, seen]) => {
        try {
          for (const k of ["den-changelog-seen", "acme-changelog-seen"])
            localStorage.setItem(k, v as string);
          if (seen) localStorage.setItem("den-shells-moved-seen", "1");
        } catch {
          /* none */
        }
      },
      [latest, opts.seen !== false] as const,
    );
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
    await p.goto(signInUrl(s!.stateDir, s!.base, path));
    return p;
  }

  const row = (p: Page, id: string) => p.locator(`#agl .tmr[data-shell="${id}"]`);

  let n1 = "";
  let n2 = "";
  let s1 = "";
  let gone = "";

  it("clause 6: shells from before are all reachable on Terminals; the old links land there", async () => {
    if (skip()) return;
    n1 = await startShell("north");
    n2 = await startShell("north");
    s1 = await startShell("south");
    gone = await startShell("south");
    await endShell(gone);
    const p = await open("/terminals");
    for (const id of [n1, n2, s1, gone])
      await row(p, id).waitFor({ state: "attached" });
    // An old link to a shell's pane on Agents opens it on Terminals.
    const q = await open(`/agents?open=${n1}`);
    await q.waitForURL(/\/terminals\?/);
    await q.waitForSelector(`.pane[data-id="${n1}"] .xterm-rows`);
    // The rail's old Terminal link too.
    const r = await open("/agents?terminal=1&project=north");
    await r.waitForURL(/\/terminals/);
  }, 120_000);

  it("clause 1 + 8: Terminals lists shells only and is named Terminals; Agents lists agents only", async () => {
    if (skip() || !n1) return;
    s!.seed({
      id: "planner",
      persona: "reviewer",
      workspace: "north",
      resumeToken: "77777777-7777-4777-8777-777777777777",
      stoppedAt: new Date().toISOString(),
    });
    const p = await open("/terminals");
    await row(p, n1).waitFor();
    expect((await p.locator("#ag-h").textContent())?.trim()).toBe("Terminals");
    expect(await p.title()).toMatch(/· Terminals$/);
    const rail = p.locator('#den-rail [data-nav="terminal"]');
    expect((await rail.textContent())?.trim()).toBe("Terminals");
    expect(await rail.getAttribute("aria-current")).toBe("page");
    expect(await rail.getAttribute("title")).toBe(
      "Your shells, each in a project's folder",
    );
    expect(await p.locator('#agl [data-kind="agent"]').count()).toBe(0);
    const a = await open("/agents");
    await a.waitForSelector('#agl [data-agent="planner"]');
    expect(await a.locator('#agl [data-kind="session"]').count()).toBe(0);
    expect(await a.locator("#agl .tmr").count()).toBe(0);
    expect(
      await a.locator('#den-rail [data-nav="terminal"]').getAttribute(
        "aria-current",
      ),
    ).toBeNull();
  }, 90_000);

  it("clause 2: rows follow the project filter, running first, with project, folder and last used", async () => {
    if (skip() || !n1) return;
    const p = await open("/terminals");
    await row(p, gone).waitFor();
    const ids = await p.$$eval("#agl .tmr", (els) =>
      els.map((e) => [(e as HTMLElement).dataset.shell, e.closest("[data-group]")?.getAttribute("data-group")]),
    );
    expect(ids.map((x) => x[1])).toEqual([
      "running",
      "running",
      "running",
      "exited",
    ]);
    expect(ids.at(-1)![0]).toBe(gone);
    const meta = (await row(p, s1).locator(".meta").first().textContent()) ?? "";
    expect(meta).toMatch(/^south · /);
    expect(meta).toContain(s!.wsDir("south"));
    expect(await row(p, s1).locator(".when").textContent()).toMatch(
      /^Last used /,
    );
    // One project: only its shells, and no project name on a row.
    await scope("north");
    try {
      const q = await open("/terminals?project=north");
      await row(q, n1).waitFor();
      expect(await q.locator("#agl .tmr").count()).toBe(2);
      const m = (await row(q, n1).locator(".meta").first().textContent()) ?? "";
      expect(m).not.toMatch(/^north · /);
      expect((await q.locator("#ag-sub").textContent())?.trim()).toBe(
        "Shells in north. Switch the project at the top to see others.",
      );
    } finally {
      await scope("all");
    }
  }, 90_000);

  it("clause 3: a click anywhere on a row opens it; there is no Open link", async () => {
    if (skip() || !n2) return;
    const p = await open("/terminals");
    await row(p, n2).waitFor();
    expect(await row(p, n2).getByText(/^Open$/).count()).toBe(0);
    const box = (await row(p, n2).boundingBox())!;
    // Bottom right: the row's edge, not its name.
    await p.mouse.click(box.x + box.width - 6, box.y + box.height - 4);
    await p.waitForSelector(`.pane[data-id="${n2}"] .xterm-rows`);
    expect(
      await row(p, n2).locator("button.agr").getAttribute("aria-pressed"),
    ).toBe("true");
    // The selected row: a 2 px accent edge, as the Agents list.
    const edge = await row(p, n2).evaluate(
      (el) => getComputedStyle(el).borderLeftWidth,
    );
    expect(edge).toBe("2px");
  }, 90_000);

  it("clause 3: an exited row is dimmed to 55%, with Restart and Remove that don't open it; a running row has neither", async () => {
    if (skip() || !gone) return;
    const p = await open("/terminals");
    await row(p, gone).waitFor();
    expect(await row(p, n1).locator('[data-act="remove-shell"]').count()).toBe(0);
    expect(await row(p, n1).locator('[data-act="restart-shell"]').count()).toBe(0);
    const op = await row(p, gone).evaluate((el) => [
      getComputedStyle(el.querySelector(".nm")!).opacity,
      getComputedStyle(el.querySelector(".meta")!).opacity,
      getComputedStyle(el.querySelector('[data-act="restart-shell"]')!).opacity,
    ]);
    expect(op).toEqual(["0.55", "0.55", "1"]);
    // Restart: a new shell in the same project; the ended one goes; the
    // row's pane never opened for it.
    const before = s!.made.length;
    await row(p, gone).locator('[data-act="restart-shell"]').click();
    await row(p, gone).waitFor({ state: "detached" });
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
    expect(await p.locator(`.pane[data-id="${gone}"]`).count()).toBe(0);
    // Remove: asks nothing, and doesn't open the row.
    const fresh = (await sessions()).find(
      (x) => x.kind === "session" && !x.exited && ![n1, n2, s1].includes(x.id),
    )!.id;
    ptys.set(fresh, s!.made.at(-1)!);
    await endShell(fresh);
    await row(p, fresh).locator('[data-act="remove-shell"]').waitFor();
    await row(p, fresh).locator('[data-act="remove-shell"]').click();
    await row(p, fresh).waitFor({ state: "detached" });
    expect(await p.locator(`.pane[data-id="${fresh}"]`).count()).toBe(0);
    expect((await sessions()).some((x) => x.id === fresh)).toBe(false);
  }, 120_000);

  it("clause 4: New terminal is one click on the page and on each project", async () => {
    if (skip()) return;
    const p = await open("/terminals?project=south");
    const btn = p.locator("#tm-new");
    await btn.waitFor();
    expect((await btn.textContent())?.trim()).toBe("New terminal");
    let before = s!.made.length;
    await btn.click();
    await p.waitForSelector(".pane[data-id] .xterm-rows");
    for (let i = 0; i < 100 && s!.made.length === before; i++)
      await p.waitForTimeout(50);
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("south"));
    // A project's card: New terminal, where Terminal here was.
    const q = await open("/?ws=north");
    const here = q.locator("#ws-term-here");
    await here.waitFor();
    expect((await here.textContent())?.trim()).toBe("New terminal");
    expect(await q.getByText("Terminal here", { exact: true }).count()).toBe(0);
    before = s!.made.length;
    await here.click();
    await q.waitForURL(/\/terminals/);
    await q.waitForSelector(".pane[data-id] .xterm-rows");
    expect(s!.made.length).toBe(before + 1);
    expect(s!.made.at(-1)!.opts.cwd).toBe(s!.wsDir("north"));
  }, 120_000);

  it("clause 6: Agents says once that the shells moved; never again", async () => {
    if (skip() || !n1) return;
    const p = await open("/agents", { seen: false });
    const note = p.locator('#agl [data-note="moved"]');
    await note.waitFor();
    expect(await note.textContent()).toMatch(
      /^\d+ shells moved to Terminals\. Nothing was closed\./,
    );
    expect(
      await note.locator('[data-act="open-terminals"]').getAttribute("href"),
    ).toBe("/terminals");
    await p.reload();
    await p.waitForSelector('#agl [data-agent="planner"]');
    await p.waitForTimeout(300);
    expect(await p.locator('#agl [data-note="moved"]').count()).toBe(0);
    // Dismiss hides it at once.
    const q = await open("/agents", { seen: false });
    await q.locator('[data-note="moved"] [data-act="dismiss-moved"]').click();
    await q
      .locator('[data-note="moved"]')
      .waitFor({ state: "detached", timeout: 5_000 });
  }, 90_000);

  it("states: loading, then error with Try again, then the list", async () => {
    if (skip()) return;
    const ctx = await browser!.newContext({
      viewport: { width: 1280, height: 860 },
    });
    contexts.push(ctx);
    const p = await ctx.newPage();
    let fail = true;
    let hold: (() => void) | null = null;
    const held = new Promise<void>((r) => (hold = r));
    await p.route("**/api/sessions*", async (route) => {
      await held;
      if (fail) return route.fulfill({ status: 503, body: "{}" });
      return route.continue();
    });
    await p.goto(signInUrl(s!.stateDir, s!.base, "/terminals"));
    await p.locator('[data-state-card="loading"]').waitFor();
    expect(await p.locator("#tm-new").isDisabled()).toBe(true);
    hold!();
    const err = p.locator('[data-state-card="error"]');
    await err.waitFor();
    expect(await err.textContent()).toContain("Can’t list terminals");
    fail = false;
    await err.locator('[data-act="retry"]').click();
    await p.locator("#agl .tmr").first().waitFor();
    expect(await p.locator('[data-state-card="error"]').count()).toBe(0);
  }, 90_000);

  it("states: empty, then none running (the rail's Terminals starts one, with a toast)", async () => {
    if (skip()) return;
    // A project with no shell yet: inactive "east" is not here; use the
    // filter on a project after closing its shells.
    for (const x of await sessions())
      if (x.kind === "session" && ptys.has(x.id) && !x.exited)
        await endShell(x.id);
    for (const x of await sessions())
      if (x.kind === "session")
        await fetch(`${s!.base}/api/sessions/${x.id}/close`, {
          method: "POST",
          headers: { ...denAuth(s!.stateDir), "content-type": "application/json" },
          body: "{}",
        });
    await scope("north");
    try {
      const p = await open("/terminals?project=north");
      const empty = p.locator('[data-state-card="empty"]');
      await empty.waitFor();
      expect((await empty.textContent())?.replace(/\s+/g, " ").trim()).toBe(
        "No terminals yet Press New terminal to open a shell in north.",
      );
      // None running: only an exited one.
      const x = await startShell("north");
      await endShell(x);
      const q = await open("/terminals?project=north");
      await row(q, x).waitFor();
      expect(await q.locator('[data-group="running"]').count()).toBe(0);
      const before = s!.made.length;
      await q.locator('#den-rail [data-nav="terminal"]').click();
      await q.waitForSelector(".pane[data-id] .xterm-rows");
      for (let i = 0; i < 100 && s!.made.length === before; i++)
        await q.waitForTimeout(50);
      expect(s!.made.length).toBe(before + 1);
      await q.getByText("Terminal opened in north").waitFor();
    } finally {
      await scope("all");
    }
  }, 120_000);

  it("phone 390: touch sizes; a shell opens full screen with a back arrow and the keys row", async () => {
    if (skip()) return;
    const sid = await startShell("south");
    const p = await open("/terminals?project=south", {
      width: 390,
      height: 844,
    });
    await scope("south");
    try {
      await row(p, sid).waitFor();
      const h = async (sel: string) =>
        (await p.locator(sel).first().boundingBox())!.height;
      expect(await h(`#agl .tmr[data-shell="${sid}"]`)).toBeGreaterThanOrEqual(64);
      expect(await h("#tm-new")).toBeGreaterThanOrEqual(48);
      // No horizontal scroll at 390.
      expect(
        await p.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
      await row(p, sid).locator("button.agr").tap();
      const pane = p.locator(`.pane[data-id="${sid}"]`);
      await pane.locator(".xterm-rows").waitFor();
      const box = (await pane.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(388);
      expect(await p.locator("#agl").isVisible()).toBe(false);
      const back = pane.locator(".tm-back");
      expect((await back.textContent())?.trim()).toBe("‹ Terminals");
      expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      const keys = await pane.$$eval(".tm-keys button", (b) =>
        b.map((x) => [x.textContent?.trim(), x.getBoundingClientRect().height]),
      );
      expect(keys.map((k) => k[0])).toEqual(["Esc", "Tab", "Ctrl", "↑", "↓"]);
      for (const k of keys) expect(k[1]).toBeGreaterThanOrEqual(44);
      const pty = ptys.get(sid)!;
      const n = pty.writes.length;
      await pane.locator('.tm-keys button[data-key="esc"]').tap();
      for (let i = 0; i < 100 && pty.writes.length === n; i++)
        await p.waitForTimeout(50);
      expect(Buffer.concat(pty.writes.slice(n)).toString()).toBe("\u001b");
      await back.tap();
      await p.locator("#agl").waitFor({ state: "visible" });
      expect(await pane.isVisible()).toBe(false);
    } finally {
      await scope("all");
    }
  }, 120_000);
});

it("no page errors", () => {
  expect(errors).toEqual([]);
});
