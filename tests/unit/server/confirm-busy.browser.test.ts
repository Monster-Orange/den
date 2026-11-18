/**
 * Issue 133: the confirm actions on the Projects and Services pages send
 * their request through the working pop-up (denShell.busyAction): Delete
 * project and Remove service. Their answer is held here until the pop-up
 * shows (a slow answer), so no wait is judged by the clock: the pop-up is
 * open and working, the request carries the pop-up's request id (what Try
 * again resends), and it closes once the answer comes.
 *
 * The real server and pages; the DELETE itself is answered here, so
 * nothing is deleted. Invented names only. DEN_PW_WS uses Den's own
 * Playwright server; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = process.env.DEN_PW_WS
      ? await chromium.connect(process.env.DEN_PW_WS, {
          exposeNetwork: "<loopback>",
        })
      : await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const skip = () => !browser;

async function page(at: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
  });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(signInUrl(s!.stateDir, s!.base, at));
  await p.waitForFunction(
    () =>
      !!(window as { denShell?: unknown }).denShell &&
      typeof (window as { deleteWorkspace?: unknown }).deleteWorkspace ===
        "function",
  );
  return p;
}

interface Held {
  /** The held request's X-Den-Request-Id ("" when it had none). */
  id: Promise<string>;
  /** Answer it (200, ok). */
  answer(): void;
}

/** Hold `method url` (path) until answer(); every other request goes on. */
async function hold(p: Page, method: string, pathname: string): Promise<Held> {
  let release: () => void = () => {};
  const go = new Promise<void>((r) => (release = r));
  let seen: (id: string) => void = () => {};
  const id = new Promise<string>((r) => (seen = r));
  await p.route(
    (u) => u.pathname === pathname,
    async (r: Route) => {
      if (r.request().method() !== method) return r.fallback();
      seen(r.request().headers()["x-den-request-id"] ?? "");
      await go;
      await r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    },
  );
  return { id, answer: release };
}

/** Answer each shared confirm: the first with OK, every later one Cancel. */
async function confirmFirst(p: Page, done: Promise<unknown>): Promise<void> {
  let first = true;
  let over = false;
  void done.then(() => (over = true));
  while (!over) {
    const open = p.locator(".dk-dlg[open]");
    if (await open.count()) {
      await open
        .locator(first ? '[data-dk="ok"]' : '[data-dk="cancel"]')
        .click();
      first = false;
    }
    await p.waitForTimeout(100);
  }
}

/** The working pop-up shows while the answer is held, then closes. */
async function expectWorking(p: Page, held: Held): Promise<void> {
  const id = await held.id;
  try {
    // The pop-up's request id: Try again resends it.
    expect(id).not.toBe("");
    const dlg = p.locator('dialog.bz-dlg[open][data-state="working"]');
    await dlg.waitFor({ state: "visible", timeout: 20_000 });
    expect(await dlg.locator(".bz-bar").count()).toBe(1);
  } finally {
    held.answer();
  }
  await p.locator("dialog.bz-dlg[open]").waitFor({
    state: "detached",
    timeout: 20_000,
  });
}

describe("issue 133: confirm actions go through the working pop-up", () => {
  it("Projects page: Delete project, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/local-dev?ws=south");
    const held = await hold(p, "DELETE", "/api/workspaces");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            deleteWorkspace(e: Event, n: string): Promise<void>;
          }
        ).deleteWorkspace(new Event("click"), "south"),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    const sent = held.id.then(() => true);
    await confirmFirst(p, sent);
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Projects page: Remove service, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/local-dev?ws=north");
    const held = await hold(p, "DELETE", "/api/workspaces/services");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            removeService(w: string, a: string): Promise<void>;
          }
        ).removeService("north", "notes"),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await confirmFirst(
      p,
      held.id.then(() => true),
    );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Services page: Delete project, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/services");
    const held = await hold(p, "DELETE", "/api/workspaces");
    const run = p
      .evaluate(() =>
        (
          window as unknown as { deleteWorkspace(): Promise<void> }
        ).deleteWorkspace(),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await confirmFirst(
      p,
      held.id.then(() => true),
    );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Services page: Remove service, a slow answer shows the working pop-up", async () => {
    if (skip()) return;
    const p = await page("/services");
    const held = await hold(p, "DELETE", "/api/workspaces/services");
    const run = p
      .evaluate(() =>
        (
          window as unknown as { removeService(a: string): Promise<void> }
        ).removeService("notes"),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("Projects page: Turn off auto-start, OK sends through the working pop-up", async () => {
    if (skip()) return;
    const p = await withDependent(await page("/local-dev?ws=north"));
    const held = await hold(p, "POST", "/api/workspaces/services/autostart");
    const run = p
      .evaluate(() =>
        (
          window as unknown as {
            toggleAutostart(r: string, on: boolean): unknown;
          }
        ).toggleAutostart("notes", false),
      )
      .then(
        () => null,
        (e: unknown) => String(e),
      );
    await confirmFirst(
      p,
      held.id.then(() => true),
    );
    await expectWorking(p, held);
    expect(await run).toBeNull();
    await p.context().close();
  }, 90_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});

/**
 * The graph the page draws from, with one hard dependent of notes
 * ("ledger"), so Turn off auto-start asks first. Reloads to take it.
 */
async function withDependent(p: Page): Promise<Page> {
  await p.route(
    (u) => u.pathname === "/api/graph",
    (r: Route) =>
      r.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          nodes: [{ id: "notes" }, { id: "ledger" }],
          edges: [{ from: "ledger", to: "notes", blocking: "hard" }],
        }),
      }),
  );
  const graph = p.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/graph",
  );
  const svcs = p.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/services",
  );
  await p.reload();
  await graph;
  await svcs;
  await p.waitForFunction(
    () =>
      typeof (window as { toggleAutostart?: unknown }).toggleAutostart ===
      "function",
  );
  return p;
}

/** The auto-start words each language must show (i18n/es.js, i18n/ja.js). */
const AUTO_OFF = {
  es: {
    title: "¿Desactivar el inicio automático de notes?",
    ok: "Desactivar",
    cancel: "Cancelar",
  },
  ja: {
    title: "notes の自動起動をオフにしますか?",
    ok: "オフにする",
    cancel: "キャンセル",
  },
} as const;

describe("issue 133: Turn off auto-start asks with Den's dialog, in the page's language", () => {
  afterAll(async () => {
    await s?.settings({ language: "en" });
  });

  it.each(["es", "ja"] as const)(
    "%s: translated, names what it turns off, Cancel focused; Esc cancels, nothing sent, focus goes back",
    async (lang) => {
      if (skip()) return;
      await s!.settings({ language: lang });
      const p = await withDependent(await page("/local-dev?ws=north"));
      const natives: string[] = [];
      p.on("dialog", (d) => {
        natives.push(d.message());
        void d.dismiss();
      });
      const posts: string[] = [];
      p.on("request", (r) => {
        if (
          r.method() === "POST" &&
          new URL(r.url()).pathname === "/api/workspaces/services/autostart"
        )
          posts.push(r.postData() ?? "");
      });
      await p.evaluate(() => {
        const b = document.createElement("button");
        b.id = "as-opener";
        b.textContent = "x";
        document.body.append(b);
        b.focus();
        void (
          window as unknown as {
            toggleAutostart(r: string, on: boolean): unknown;
          }
        ).toggleAutostart("notes", false);
      });
      try {
        await p.waitForSelector("dialog.dk-dlg[open]", { timeout: 10_000 });
      } catch (err) {
        const shown = await p.evaluate(
          () =>
            document.getElementById("autostart-confirm-overlay")?.textContent ??
            "",
        );
        throw new Error(
          `no kit dialog; shown instead: ${JSON.stringify(shown)}; natives: ${JSON.stringify(natives)} (${String(err)})`,
        );
      }
      const st = await p.evaluate(() => {
        const d = document.querySelector("dialog.dk-dlg[open]")!;
        const byId = (id: string | null) =>
          id ? (document.getElementById(id)?.textContent ?? null) : null;
        const a = document.activeElement as HTMLElement | null;
        return {
          role: d.getAttribute("role"),
          name: byId(d.getAttribute("aria-labelledby")),
          description: byId(d.getAttribute("aria-describedby")) ?? "",
          ok: d.querySelector('[data-dk="ok"]')?.textContent,
          cancel: d.querySelector('[data-dk="cancel"]')?.textContent,
          focusIn: !!a && d.contains(a),
          focusOn: a?.dataset?.dk ?? null,
        };
      });
      const w = AUTO_OFF[lang];
      expect(st.role).toBe("alertdialog");
      expect(st.name).toBe(w.title);
      expect(st.ok).toBe(w.ok);
      expect(st.cancel).toBe(w.cancel);
      expect(st.focusIn).toBe(true);
      expect(st.focusOn).toBe("cancel");
      // It names the dependent, in the page's language (no English left).
      expect(st.description).toContain("ledger");
      expect(st.description).not.toMatch(/hard dependency|readiness/);
      await p.keyboard.press("Escape");
      await p.waitForSelector("dialog.dk-dlg", { state: "detached" });
      await p.waitForTimeout(300);
      expect(await p.evaluate(() => document.activeElement?.id)).toBe(
        "as-opener",
      );
      expect(posts).toEqual([]);
      expect(natives).toEqual([]);
      await p.context().close();
    },
    90_000,
  );
});
