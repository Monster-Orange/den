/**
 * D68: every Den dialog opens centred in the window: its centre within
 * 2 px of the viewport's, or, taller than the window, top-aligned with
 * 16 px margins. At 1280×800 and 390×844, scrolled and not. The kinds:
 * the approval dialog's (pe-dlg den-ap-dlg), the Agents page's (ag-dlg:
 * Start, Rename, Move), Restart Den's (rd-dlg) and the workspace
 * delete's (wsd-dlg). Chromium by default; DEN_DIALOGS_BROWSER=webkit
 * (with DEN_PW_WS) runs WebKit. DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const kind =
      process.env.DEN_DIALOGS_BROWSER === "webkit" ? pw.webkit : pw.chromium;
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
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

/** Open dialog kind `k` on page `p`; its selector. */
async function openKind(p: Page, k: string): Promise<string> {
  return p.evaluate(async (kind) => {
    const filler = (n: number) =>
      Array.from({ length: n }, (_, i) => `<p>line ${i}</p>`).join("");
    const make = (cls: string, html: string) => {
      const d = document.createElement("dialog");
      d.className = cls;
      d.id = `probe-${kind}`;
      d.innerHTML = `<form method="dialog">${html}</form>`;
      document.body.append(d);
      d.showModal();
      return `#${d.id}`;
    };
    if (kind === "ap")
      return make("pe-dlg den-ap-dlg", `<h2>Allow?</h2>${filler(3)}`);
    if (kind === "ap-tall")
      return make("pe-dlg den-ap-dlg", `<h2>Allow?</h2>${filler(80)}`);
    if (kind === "hp") return make("hp-dlg", `<h2>Helpers</h2>${filler(4)}`);
    if (kind === "tx") return make("tx-dlg", `<h2>Transcript</h2>${filler(4)}`);
    if (kind === "ag-rn") {
      (document.getElementById("ag-rn") as HTMLDialogElement).showModal();
      return "#ag-rn";
    }
    if (kind === "ag-mv") {
      (document.getElementById("ag-mv") as HTMLDialogElement).showModal();
      return "#ag-mv";
    }
    if (kind === "wsd") {
      const w = window as unknown as {
        denAskWorkspaceAgents(o: unknown): Promise<unknown>;
      };
      void w.denAskWorkspaceAgents({
        ws: "south",
        agents: [{ id: "keeper", running: false }],
        others: ["north"],
      });
      return "#wsd-dlg";
    }
    return make(
      "rd-dlg",
      `<div class="rd-b"><h2>Restart Den?</h2>${filler(2)}</div>`,
    );
  }, k);
}

async function measure(p: Page, sel: string) {
  return p.evaluate((q) => {
    const r = document.querySelector(q)!.getBoundingClientRect();
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      top: r.top,
      bottom: r.bottom,
      h: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }, sel);
}

const PAGES = [
  "/agents",
  "/",
  "/services",
  "/local-dev",
  "/settings",
  "/workspaces",
  "/graph",
];
const COMMON = ["ap", "ap-tall", "hp", "tx", "rd", "wsd"];

describe("D68: dialogs open centred", () => {
  for (const path of PAGES)
    for (const size of SIZES)
      for (const scrolled of [false, true])
        it(`${path} at ${size.width}×${size.height}${scrolled ? ", scrolled" : ""}`, async () => {
          if (!browser) return;
          const ctx = await browser.newContext({
            viewport: size,
            reducedMotion: "reduce",
          });
          const p = await ctx.newPage();
          await p.goto(signInUrl(s!.stateDir, s!.base, path));
          await p.waitForFunction(() => "denShell" in window, undefined, {
            timeout: 20_000,
          });
          if (path === "/agents")
            await p.waitForSelector("#ag-rn", {
              state: "attached",
              timeout: 20_000,
            });
          await p.addScriptTag({ type: "module", url: "/restart-den.js" });
          await p.addScriptTag({ type: "module", url: "/ws-delete-agents.js" });
          await p.waitForFunction(() => "denAskWorkspaceAgents" in window);
          if (scrolled)
            await p.evaluate(() => {
              const pad = document.createElement("div");
              pad.style.height = "4000px";
              document.body.append(pad);
              window.scrollTo(0, 1500);
              for (const el of document.querySelectorAll(
                "main, .den-main, #agx",
              ))
                (el as HTMLElement).scrollTop = 300;
            });
          const off: string[] = [];
          for (const k of path === "/agents"
            ? [...COMMON, "ag-rn", "ag-mv"]
            : COMMON) {
            const sel = await openKind(p, k);
            await p.waitForSelector(`${sel}[open]`);
            const m = await measure(p, sel);
            const tall = m.h > m.vh - 32;
            const ok = tall
              ? Math.abs(m.top - 16) <= 2 && m.bottom <= m.vh - 14
              : Math.abs(m.x - m.vw / 2) <= 2 && Math.abs(m.y - m.vh / 2) <= 2;
            if (!ok)
              off.push(
                `${k}: centre ${m.x.toFixed(0)},${m.y.toFixed(0)} in ${m.vw}×${m.vh} (top ${m.top.toFixed(0)}, h ${m.h.toFixed(0)})`,
              );
            await p.evaluate(
              (q) => (document.querySelector(q) as HTMLDialogElement).close(),
              sel,
            );
          }
          expect(off).toEqual([]);
          await ctx.close();
        }, 90_000);
});
