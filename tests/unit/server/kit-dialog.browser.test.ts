/**
 * Issue 133 through the real server and pages: the Projects and Services
 * pages ask with the kit's dialog (/kit/dialog.js via /dialog-den.js),
 * never the browser's confirm(), prompt() or alert():
 *   - in Spanish and Japanese, Delete project shows Den's dialog in that
 *     language; page.on("dialog") (a native one) never fires;
 *   - it is an alertdialog, named by its title and described by its
 *     message; focus starts on Cancel (deleting is the danger) and goes
 *     back to what had it;
 *   - Esc cancels: nothing is deleted;
 *   - Report is in it;
 *   - at 375 px it fits, with no sideways scroll.
 * Invented names only. Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1
 * skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    // DEN_HELPERS_BROWSER=webkit|firefox runs it there (Safari too).
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    browser = await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 60_000);

afterAll(async () => {
  await s?.settings({ language: "en" });
  await closeBrowserSuite({
    browsers: [browser],
    servers: [s],
  });
});

/** The words each language must show (i18n/es.js, i18n/ja.js). */
const WORDS = {
  es: {
    title: "¿Eliminar el proyecto?",
    message: "¿Eliminar el proyecto “north”?",
    ok: "Eliminar",
    cancel: "Cancelar",
  },
  ja: {
    title: "プロジェクトを削除しますか?",
    message: "プロジェクト「north」を削除しますか?",
    ok: "削除",
    cancel: "キャンセル",
  },
} as const;

/** A page in `lang`; `natives` collects every native dialog it opens. */
async function open(
  lang: "es" | "ja",
  url: string,
  width = 1440,
): Promise<{ p: Page; natives: string[] }> {
  await s!.settings({ language: lang });
  const ctx = await browser!.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "999.0.0");
    } catch {
      /* none */
    }
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  const natives: string[] = [];
  p.on("dialog", (d) => {
    natives.push(`${d.type()}: ${d.message()}`);
    void d.dismiss();
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, url));
  await p.waitForFunction(
    () =>
      Boolean((window as never as { denShell?: unknown }).denShell) &&
      typeof (window as never as { deleteWorkspace?: unknown })
        .deleteWorkspace === "function",
  );
  return { p, natives };
}

/**
 * Focus a known button on the page, then Delete project "north" the way the
 * page's menu does. Waits for the kit's dialog, or fails with what showed.
 */
async function startDelete(p: Page, natives: string[], services = false) {
  await p.evaluate((svc) => {
    const b = document.createElement("button");
    b.id = "kd-opener";
    b.textContent = "x";
    document.body.append(b);
    b.focus();
    const w = window as never as {
      deleteWorkspace(e?: unknown, name?: string): Promise<void>;
    };
    void (svc
      ? w.deleteWorkspace()
      : w.deleteWorkspace({ stopPropagation() {} }, "north"));
  }, services);
  try {
    await p.waitForSelector("dialog.dk-dlg[open]", { timeout: 10_000 });
  } catch (err) {
    throw new Error(
      `no kit dialog; native dialogs: ${JSON.stringify(natives)} (${String(err)})`,
    );
  }
}

/** What the open kit dialog says and where focus is. */
const dialogState = (p: Page) =>
  p.evaluate(() => {
    const d = document.querySelector("dialog.dk-dlg[open]")!;
    const byId = (id: string | null) =>
      id ? (document.getElementById(id)?.textContent ?? null) : null;
    const a = document.activeElement as HTMLElement | null;
    const rb = d.querySelector("[data-den-report]") as HTMLElement | null;
    return {
      role: d.getAttribute("role"),
      name: byId(d.getAttribute("aria-labelledby")),
      description: byId(d.getAttribute("aria-describedby")),
      ok: d.querySelector('[data-dk="ok"]')?.textContent,
      okDanger: d
        .querySelector('[data-dk="ok"]')!
        .classList.contains("dk-danger"),
      cancel: d.querySelector('[data-dk="cancel"]')?.textContent,
      focusIn: !!a && d.contains(a),
      focusOn: a?.dataset?.dk ?? a?.tagName ?? null,
      report: !!rb && rb.getBoundingClientRect().width > 0,
    };
  });

const projects = async (): Promise<string[]> => {
  const r = await fetch(`${s!.base}/api/workspaces`);
  const j = (await r.json()) as { workspaces: Record<string, unknown> };
  return Object.keys(j.workspaces);
};

describe("issue 133: Delete project asks with Den's dialog, never a native one", () => {
  it.each(["es", "ja"] as const)(
    "%s: translated, an alertdialog, Cancel focused, Report in it; Esc cancels and focus goes back",
    async (lang) => {
      if (!browser) return;
      const { p, natives } = await open(lang, "/local-dev?ws=north");
      await startDelete(p, natives);
      const st = await dialogState(p);
      expect(st).toEqual({
        role: "alertdialog",
        name: WORDS[lang].title,
        description: WORDS[lang].message,
        ok: WORDS[lang].ok,
        okDanger: true,
        cancel: WORDS[lang].cancel,
        focusIn: true,
        focusOn: "cancel",
        report: true,
      });
      await p.keyboard.press("Escape");
      await p.waitForSelector("dialog.dk-dlg", { state: "detached" });
      // Cancelled: nothing else asked, nothing deleted.
      await p.waitForTimeout(300);
      expect(await p.locator("dialog.dk-dlg").count()).toBe(0);
      expect(await p.evaluate(() => document.activeElement?.id)).toBe(
        "kd-opener",
      );
      expect(natives).toEqual([]);
      expect(await projects()).toContain("north");
      await p.context().close();
    },
    60_000,
  );

  it("the Services page's Delete project too (es)", async () => {
    if (!browser) return;
    const { p, natives } = await open("es", "/services");
    await startDelete(p, natives, true);
    const st = await dialogState(p);
    expect(st.name).toBe(WORDS.es.title);
    expect(st.description).toBe(WORDS.es.message);
    expect(st.report).toBe(true);
    await p.keyboard.press("Escape");
    await p.waitForSelector("dialog.dk-dlg", { state: "detached" });
    expect(natives).toEqual([]);
    expect(await projects()).toContain("north");
    await p.context().close();
  }, 60_000);

  it("fits at 375 px (ja): inside the screen, every button inside it, no sideways scroll", async () => {
    if (!browser) return;
    const { p, natives } = await open("ja", "/local-dev?ws=north", 375);
    await startDelete(p, natives);
    const fit = await p.evaluate(() => {
      const d = document.querySelector("dialog.dk-dlg[open]")!;
      const r = d.getBoundingClientRect();
      const out = [...d.querySelectorAll("button")]
        .map((b) => b.getBoundingClientRect())
        .filter(
          (b) =>
            b.left < r.left - 0.5 ||
            b.right > r.right + 0.5 ||
            b.bottom > r.bottom + 0.5,
        ).length;
      return {
        left: r.left,
        right: r.right,
        vw: window.innerWidth,
        scroll: document.documentElement.scrollWidth,
        out,
      };
    });
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.vw);
    expect(fit.scroll).toBeLessThanOrEqual(fit.vw);
    expect(fit.out).toBe(0);
    await p.keyboard.press("Escape");
    expect(natives).toEqual([]);
    await p.context().close();
  }, 60_000);
});
