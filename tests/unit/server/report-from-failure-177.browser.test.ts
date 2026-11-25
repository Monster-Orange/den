/**
 * Issue 177: Report from a failure pop-up starts filled in. A working
 * pop-up's failure (a stubbed 500) → Report → the form's title names the
 * action and the answer, its description carries the request id and the
 * route, the person can still change the title, and the report keeps the
 * secret scrub. Chromium and WebKit, 1280 and 375.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { shortDots } from "./helpers/short-dots.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

jest.setTimeout(90_000);

const ENGINES = ["chromium", "webkit"] as const;
const WIDTHS = [1280, 375] as const;
const PROBE = "/api/busy-probe";
const TOKEN = "den_hub_LIVETOKENabcdef0123456789";
const EDITED = "t177-edited-title";
const browsers: Partial<Record<(typeof ENGINES)[number], Browser>> = {};
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const e of ENGINES) browsers[e] = await launchBrowser(pw[e]);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers), servers: [s] });
});

const json = (r: Route, status: number, body: unknown) =>
  r.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

interface Seen {
  ids: string[];
  previews: Record<string, unknown>[];
}

async function page(
  engine: (typeof ENGINES)[number],
  width: number,
): Promise<{ p: Page; seen: Seen }> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  const p = await ctx.newPage();
  const seen: Seen = { ids: [], previews: [] };
  await p.route(`**${PROBE}**`, async (r) => {
    seen.ids.push(r.request().headers()["x-den-request-id"] ?? "");
    await json(r, 500, { ok: false, error: `bad token ${TOKEN}` });
  });
  await p.route("**/api/report**", async (r) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/api/report")
      return json(r, 200, {
        ok: true,
        enabled: true,
        repos: [{ repo: "acme-eng/engine" }],
        github: { signedIn: true, deviceFlow: true },
        maxPerHour: 5,
        sentThisHour: 0,
      });
    if (u.pathname === "/api/report/diagnostics")
      return json(r, 200, { ok: true, sections: { Den: "acme 9.9.9" } });
    if (u.pathname === "/api/report/preview") {
      seen.previews.push(r.request().postDataJSON?.() ?? {});
      return json(r, 200, {
        ok: true,
        title: "x",
        body: "x",
        repo: "acme-eng/engine",
      });
    }
    return json(r, 404, { ok: false });
  });
  await signInPage(p, s!.stateDir, s!.base, "/settings");
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  await shortDots(p);
  return { p, seen };
}

/** Den's "link" action against the stubbed route, on a page button. */
const start = (p: Page) =>
  p.evaluate((url) => {
    const b = document.createElement("button");
    b.id = "bz-btn";
    b.textContent = "Link ticked projects";
    document.body.append(b);
    type Fn = (...a: unknown[]) => Promise<unknown>;
    const shell = (
      window as unknown as { denShell: { busyAction: Fn; api: Fn } }
    ).denShell;
    void shell.busyAction(
      "link",
      (headers: Record<string, string>) =>
        shell.api("POST", `${url}?token=abc`, {}, { headers }),
      { button: b },
    );
  }, PROBE);

describe("issue 177: Report from a failure pop-up", () => {
  for (const engine of ENGINES)
    for (const width of WIDTHS)
      it(`${engine} ${width}: the title names the action and the answer; the request id and route are in`, async () => {
        if (!browsers[engine]) return;
        const { p, seen } = await page(engine, width);
        await start(p);
        const bz = p.locator("dialog:has([data-bz])");
        await bz.locator('[data-bz="retry"]').waitFor({ timeout: 10_000 });
        const failure = (await bz.locator("h2").textContent())!.trim();
        expect(failure.length).toBeGreaterThan(0);
        await bz.locator('[data-bz="report"]').click();

        const field = p.locator('dialog [data-f="title"]');
        await field.waitFor({ timeout: 10_000 });
        // The Report form's own dialog, kept past its first step.
        await field.evaluate((el) =>
          el.closest("dialog")!.setAttribute("data-t177", "report"),
        );
        const fb = p.locator('dialog[data-t177="report"]');
        const title = fb.locator('[data-f="title"]');
        const what = failure.replace(/[.。]+$/u, "");
        await expect(title.inputValue()).resolves.toBe(`${what}: error 500`);
        const desc = await fb.locator('[data-f="description"]').inputValue();
        expect(seen.ids).toHaveLength(1);
        expect(desc).toContain(seen.ids[0]!);
        expect(desc).toContain(`POST ${PROBE}`);
        for (const v of [await title.inputValue(), desc]) {
          expect(v).not.toContain(TOKEN);
          expect(v).not.toContain("token=");
        }

        await title.fill(EDITED);
        await expect(title.inputValue()).resolves.toBe(EDITED);
        await fb.locator('[data-act="next"]').click();
        await fb.locator('[data-act="review"]').click();
        // The preview's answer is in the form: its request was made.
        await p.waitForFunction(() => {
          const pre = document.querySelector("[data-preview]");
          return !!pre && pre.textContent !== "…";
        });
        expect(seen.previews[0]).toMatchObject({ title: EDITED });
        expect(seen.previews[0]!.redact).not.toBe(false);
        await p.context().close();
      });
});
