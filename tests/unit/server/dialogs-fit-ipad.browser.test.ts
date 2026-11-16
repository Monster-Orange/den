/**
 * iPad hotfix: a modal <dialog> sits at inset-block 0. Desktop browsers
 * give it height: fit-content; iPad's WebKit leaves height auto, and auto
 * between inset 0 and 0 fills the window, so every pop-up stretched from
 * the top of the window to the bottom.
 *
 * This models iPad's default with `dialog{height:auto}` as the page's
 * first stylesheet (before Den's CSS), in a cascade layer so it ranks
 * below every page rule as the browser's own sheet does. Then at
 * 820×1180 it opens the kit's confirm, the working pop-up, the Report
 * dialog (without its screenshot, so its content is short too), the
 * Agents page's Rename and Move, and a persona dialog. Each must be well under the window's height and
 * not start at its top. Chromium and WebKit (with DEN_PW_WS).
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = process.env.DEN_PW_WS
        ? await kind.connect(process.env.DEN_PW_WS, {
            exposeNetwork: "<loopback>",
          })
        : await kind.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
}, 60_000);

afterAll(async () => {
  for (const b of Object.values(browsers)) await b.close();
  await s?.stop();
});

/** iPad's default for a dialog, ahead of every page stylesheet. */
const IPAD_DEFAULT = () => {
  const put = () => {
    const st = document.createElement("style");
    // A cascade layer, so it ranks like the browser's own sheet: any
    // unlayered page rule beats it, whatever its specificity.
    st.textContent = "@layer ipad-default { dialog { height: auto; } }";
    document.head.prepend(st);
  };
  if (document.head) put();
  else document.addEventListener("DOMContentLoaded", put, { once: true });
};

type Kit = {
  fitKit: {
    askConfirm(o: unknown): Promise<unknown>;
    busyAction(n: string, run: () => Promise<unknown>): Promise<unknown>;
    openReport(): Promise<unknown>;
  };
};

/** Opens pop-up `k`; the selector of its open dialog. */
async function open(p: Page, k: string): Promise<string> {
  return p.evaluate(async (kind) => {
    if (kind === "confirm") {
      void (window as unknown as Kit).fitKit.askConfirm({
        title: "Remove it?",
        message: "It goes.",
      });
      return ".dk-dlg";
    }
    if (kind === "busy") {
      void (window as unknown as Kit).fitKit.busyAction(
        "save",
        () => new Promise(() => {}),
      );
      return ".bz-dlg";
    }
    if (kind === "report") {
      void (window as unknown as Kit).fitKit.openReport();
      return ".fb-dlg";
    }
    if (kind === "persona") {
      const d = document.createElement("dialog");
      d.className = "pe-dlg den-ap-dlg";
      d.innerHTML = `<form method="dialog"><h2>Allow?</h2><p>One line.</p></form>`;
      document.body.append(d);
      d.showModal();
      return ".pe-dlg.den-ap-dlg";
    }
    (document.getElementById(kind) as HTMLDialogElement).showModal();
    return `#${kind}`;
  }, k);
}

const KINDS = ["confirm", "busy", "report", "ag-rn", "ag-mv", "persona"];

describe("iPad: pop-ups fit their content", () => {
  for (const name of ["chromium", "webkit"])
    it(`${name} at 820×1180`, async () => {
      const b = browsers[name];
      if (!b) return;
      const ctx = await b.newContext({
        viewport: { width: 820, height: 1180 },
        reducedMotion: "reduce",
      });
      await ctx.addInitScript(IPAD_DEFAULT);
      const p = await ctx.newPage();
      // No screenshot, so the Report dialog's content is short too.
      await p.route("**/report-shot.js?v=*", (r) => r.fulfill({ status: 404 }));
      await p.goto(signInUrl(s!.stateDir, s!.base, "/agents"));
      await p.waitForFunction(() => "denShell" in window, undefined, {
        timeout: 20_000,
      });
      await p.waitForSelector("#ag-rn", { state: "attached", timeout: 20_000 });
      await p.addScriptTag({
        type: "module",
        content: [
          'import { askConfirm } from "/dialog-den.js";',
          'import { busyAction } from "/busy-den.js";',
          'import { openReport } from "/report-dialog.js";',
          "window.fitKit = { askConfirm, busyAction, openReport };",
        ].join("\n"),
      });
      await p.waitForFunction(() => "fitKit" in window);
      const tall: string[] = [];
      for (const k of KINDS) {
        const sel = await open(p, k);
        await p.waitForSelector(`${sel}[open]`, { timeout: 10_000 });
        const m = await p.evaluate((q) => {
          const r = document.querySelector(q)!.getBoundingClientRect();
          return { top: r.top, h: r.height, vh: window.innerHeight };
        }, sel);
        if (m.h >= m.vh * 0.7 || m.top <= 0)
          tall.push(
            `${k}: top ${m.top.toFixed(0)}, h ${m.h.toFixed(0)} of ${m.vh}`,
          );
        await p.evaluate((q) => {
          for (const d of document.querySelectorAll<HTMLDialogElement>(q))
            d.close();
          document.querySelector("den-busy")?.remove();
        }, sel);
      }
      expect(tall).toEqual([]);
      await ctx.close();
    }, 90_000);
});
