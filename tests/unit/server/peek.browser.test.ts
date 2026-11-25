/**
 * Issue 791: Peek in a real browser, the approved mock's rules table (in
 * Hub, Den project: "Peek: answer one agent without leaving your view
 * (mock)", version 2), at 1280 and 390 px:
 *
 *   - Opens from: a click on an agent's bell row opens the panel over the
 *     page (the page stays); the row's Open in Agents link goes to the page.
 *   - What it is: the agent's live terminal (its output shows) in the
 *     kit's dialog with Report; typing reaches that agent.
 *   - Seen: opening it marks the agent's items read.
 *   - Closes: Esc, ×, a click on the dim area (1280) or the back arrow
 *     (390); focus goes back to the bell row; nothing is left open.
 *   - Keep it: Open in layout links to the agent in the Agents layout.
 *   - Another agent needs you: a strip with Switch; one panel, never two.
 *   - Phone: a full-screen sheet.
 *   - Size: over the Agents page with the agent's own pane open, the panel
 *     never resizes the agent's terminal by opening or closing.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): nothing really runs.
 * DEN_HELPERS_BROWSER=webkit runs it in WebKit. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { NotificationStore } from "../../../src/shared/notifications.js";
import { signIn } from "./helpers/signed-in.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let pty: ScriptedPty;
let latest = "";
const errors: string[] = [];
const PLANNER = "/agents?project=north&agent=planner";

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    browser = await launchBrowser(pw[engine]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:planner",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  pty = s.made.at(-1)!;
  const [newest] = (await (await fetch(`${s.base}/api/changelog`)).json()) as {
    version: string;
  }[];
  latest = newest?.version ?? "";
  s.seed({
    id: "planner",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:planner",
  });
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

/**
 * Two agents need the person, filed as from Hub (Den's own sweep drops a
 * question whose agent isn't waiting). Filed again when gone.
 */
function ask(): void {
  const st = new NotificationStore(s.stateDir);
  const have = st.list().filter((n) => n.kind === "waiting" && !n.read);
  for (const [agent, ws] of [
    ["planner", "north"],
    ["reviewer", "south"],
  ] as const) {
    if (have.some((n) => n.subject === `agent:${agent}`)) continue;
    st.add({
      kind: "waiting",
      subject: `agent:${agent}`,
      scope: `workspace/${ws}`,
      text: `${agent} needs your permission`,
      link: `/agents?project=${ws}&agent=${agent}`,
      source: "hub",
    });
  }
}

async function open(width: number, path = "/services"): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 860 },
    reducedMotion: "reduce",
  });
  // What's new seen up to this version: it never opens over the bell.
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
    const w = window as unknown as Record<string, unknown>;
    const Real = window.WebSocket;
    window.WebSocket = class extends Real {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        ((w.__socks ??= []) as WebSocket[]).push(this);
      }
    };
  }, latest);
  await signIn(ctx, s.stateDir, s.base);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${width}: ${e.message}`));
  ask();
  await p.route("**/api/notifications/read", (r) =>
    r.fulfill({ json: { ok: true } }),
  );
  await p.goto(`${s.base}${path}`);
  await p.waitForSelector("#den-bell");
  return p;
}

async function openBell(p: Page): Promise<void> {
  // A closed peek leaves the bell open (focus back on its row): a click
  // on the bell then would close it.
  if (!(await p.locator("#den-bell-pop").isVisible()))
    await p.click("#den-bell");
  await p
    .locator('#den-bell-pop [data-kind="waiting"]:has(a[data-peek="planner"])')
    .waitFor();
}

const plannerRow = (p: Page) =>
  p.locator("#den-bell-pop [data-kind]", {
    has: p.locator(`a[data-peek="planner"]`),
  });

async function peek(p: Page): Promise<void> {
  await openBell(p);
  await plannerRow(p).locator('a[data-bell="open"]').click();
  await p.locator("dialog#den-peek[open]").waitFor({ timeout: 10_000 });
}

/** Every socket the page opened is closed (or closing). */
const allClosed = (p: Page) =>
  p.evaluate(() =>
    (
      ((window as unknown as { __socks?: WebSocket[] }).__socks ??
        []) as WebSocket[]
    ).every((x) => x.readyState >= 2),
  );

async function eventually(
  pred: () => Promise<boolean> | boolean,
  ms = 10_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.each([1280, 390])("issue 791: Peek (%i px)", (width) => {
  it("a click on the agent's bell row opens its live terminal over the page; typing reaches it; the page stays", async () => {
    if (skip()) return;
    const p = await open(width);
    let read: unknown = null;
    await p.unroute("**/api/notifications/read");
    await p.route("**/api/notifications/read", (r) => {
      read = r.request().postDataJSON();
      return r.fulfill({ json: { ok: true } });
    });
    await peek(p);
    expect(new URL(p.url()).pathname).toBe("/services");
    const d = p.locator("dialog#den-peek");
    await expect(
      d.getByRole("heading", { level: 2 }).textContent(),
    ).resolves.toBe("planner");
    // Report, as every pop-up has.
    expect(await d.getAttribute("data-dk-report")).not.toBeNull();
    // Seen: the agent's items are read.
    await eventually(() => read !== null);
    expect(read).toEqual({ subject: "agent:planner", seen: true });
    // Live: the agent's output shows.
    // Not live in time: say what the dialog was doing, so a red run in CI
    // tells a refused socket from a retry loop from a slow first load.
    await p
      .locator('dialog#den-peek[data-conn="live"]')
      .waitFor({ timeout: 15_000 })
      .catch(async (e: Error) => {
        const conn = await d.getAttribute("data-conn").catch(() => "?");
        const status = await d
          .locator("[role=status]")
          .allTextContents()
          .catch(() => []);
        throw new Error(
          `${e.message}\npeek data-conn=${conn} status=${JSON.stringify(status)} pageerrors=${JSON.stringify(errors)}`,
        );
      });
    const mark = `peek-${Math.random().toString(36).slice(2, 8)}`;
    pty.emit(`${mark}$ `);
    await p.waitForFunction(
      (m) =>
        document
          .querySelector("#den-peek [data-peek-term]")
          ?.textContent?.includes(m),
      mark,
      { timeout: 15_000 },
    );
    // The footer says who typing goes to; typing reaches the agent.
    await expect(
      d.locator("[data-peek-foot]").textContent(),
    ).resolves.toContain("planner");
    const writes = pty.writes.length;
    await p.focus("#den-peek .xterm-helper-textarea");
    await p.keyboard.type("y");
    await eventually(() =>
      Buffer.concat(pty.writes.slice(writes)).toString().includes("y"),
    );
    // Keep it: Open in layout is the agent's place in the Agents layout.
    expect(await d.locator('[data-peek="layout"]').getAttribute("href")).toBe(
      PLANNER,
    );
    // Esc closes; focus back on the bell row; nothing left open.
    await p.keyboard.press("Escape");
    await d.waitFor({ state: "detached" });
    await eventually(() => allClosed(p));
    await eventually(() =>
      p.evaluate(
        () => document.activeElement?.getAttribute("data-peek") === "planner",
      ),
    );
    // Esc never reached the agent.
    expect(Buffer.concat(pty.writes.slice(writes)).toString()).not.toContain(
      "\x1b",
    );
    await p.context().close();
  }, 90_000);

  it("× closes it (and the dim area on a desk, the back arrow on a phone)", async () => {
    if (skip()) return;
    const p = await open(width);
    await peek(p);
    await p.locator('#den-peek [data-dk="close"]').click();
    await p.locator("dialog#den-peek").waitFor({ state: "detached" });
    await eventually(() => allClosed(p));
    await peek(p);
    if (width > 640) {
      // The dim area: a press outside the panel's box.
      await p.mouse.click(5, 855);
    } else {
      await p.locator('#den-peek [data-peek="back"]').click();
    }
    await p.locator("dialog#den-peek").waitFor({ state: "detached" });
    await eventually(() => allClosed(p));
    await p.context().close();
  }, 90_000);

  it("the page behind keeps its scroll: open and close a peek, and it hasn't moved", async () => {
    if (skip()) return;
    const p = await open(width);
    // The Services page's own scroll pane, made tall and scrolled down.
    const pane = ".services-pane";
    await p.waitForSelector(pane);
    await p.evaluate((sel) => {
      const sc = document.querySelector<HTMLElement>(sel)!;
      // A block after the cards, in CSS: the page's re-render of its
      // cards (a bell read can cause one) keeps it.
      const st = document.createElement("style");
      st.textContent = `${sel}::after { content: ""; display: block; flex: none; height: 4000px; }`;
      document.head.appendChild(st);
      sc.scrollTop = 600;
    }, pane);
    const scrollOf = () => p.$eval(pane, (el) => (el as HTMLElement).scrollTop);
    // Settled: the cards loaded, the pane's height and scroll still for 1 s.
    await p.waitForFunction(
      (sel) => {
        const el = document.querySelector<HTMLElement>(sel)!;
        const w = window as unknown as { __st?: [string, number] };
        const k = `${el.scrollHeight}:${el.scrollTop}`;
        if (w.__st?.[0] !== k) w.__st = [k, Date.now()];
        return Date.now() - w.__st[1] >= 1000;
      },
      pane,
      { polling: 200, timeout: 20_000 },
    );
    const before = await scrollOf();
    expect(before).toBeGreaterThan(0);
    await peek(p);
    await p.keyboard.press("Escape");
    await p.locator("dialog#den-peek").waitFor({ state: "detached" });
    expect(await scrollOf()).toBe(before);
    await p.context().close();
  }, 90_000);

  it("another agent needs you: a strip offers Switch, and switching keeps one panel", async () => {
    if (skip()) return;
    const p = await open(width);
    await peek(p);
    const sw = p.locator('#den-peek [data-peek="switch"]');
    await sw.waitFor({ timeout: 10_000 });
    expect(await sw.getAttribute("data-agent")).toBe("reviewer");
    await sw.click();
    await eventually(
      async () =>
        (await p
          .locator("#den-peek")
          .getByRole("heading", { level: 2 })
          .textContent()) === "reviewer",
    );
    expect(await p.locator("dialog#den-peek").count()).toBe(1);
    await p.context().close();
  }, 90_000);

  it("the row's Open in Agents link goes to the page, as the row did", async () => {
    if (skip()) return;
    const p = await open(width);
    await openBell(p);
    await plannerRow(p).locator('a[data-bell="page"]').click();
    await p.waitForURL(/\/agents\?project=north&agent=planner/);
    await p.context().close();
  }, 90_000);
});

describe("issue 791: Peek on a phone is a full-screen sheet", () => {
  it("390 px: the panel fills the screen, with the back arrow", async () => {
    if (skip()) return;
    const p = await open(390);
    await peek(p);
    const box = await p.locator("dialog#den-peek").boundingBox();
    expect(Math.round(box!.width)).toBe(390);
    expect(Math.round(box!.height)).toBe(860);
    expect(await p.locator('#den-peek [data-peek="back"]').isVisible()).toBe(
      true,
    );
    await p.context().close();
  }, 90_000);
});

describe("issue 791: the panel never resizes the agent's terminal for the full view", () => {
  it("over the Agents page with the agent's pane open: opening and closing the peek leave the PTY's size alone", async () => {
    if (skip()) return;
    const p = await open(1440, `/agents?open=${sid}`);
    await p.locator(`[data-id="${sid}"][data-cols]`).waitFor({
      timeout: 20_000,
    });
    // The page's pane leads: the PTY is its size.
    await eventually(async () => {
      const [c] = pty.resizes.at(-1) ?? [0, 0];
      const cols = await p.evaluate(
        (id) =>
          Number(
            document.querySelector<HTMLElement>(`.pane[data-id="${id}"]`)
              ?.dataset.cols ?? 0,
          ),
        sid,
      );
      return c > 0 && c === cols;
    });
    const before = pty.resizes.length;
    const size = pty.resizes.at(-1);
    await peek(p);
    // The server heard the panel's size and kept the PTY's (the page's
    // pane leads): the panel follows. Only then is "no resize" proved.
    await p
      .locator('dialog#den-peek[data-conn="live"][data-following]')
      .waitFor({ timeout: 15_000 });
    expect(pty.resizes.slice(before)).toEqual([]);
    await p.keyboard.press("Escape");
    await p.locator("dialog#den-peek").waitFor({ state: "detached" });
    // The server saw the panel go: the page's pane is the one viewer.
    await p
      .locator(`[data-id="${sid}"][data-cols][data-viewers="1"]`)
      .waitFor({ timeout: 15_000 });
    expect(pty.resizes.at(-1)).toEqual(size);
    await p.context().close();
  }, 90_000);

  it("raised no page errors", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
  });
});
