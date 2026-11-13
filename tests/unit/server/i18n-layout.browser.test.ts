/**
 * Translated pages still fit (0.4.45, after the project names review found
 * ja table headings broken into single characters, an es title wrapped
 * under its pills, a repo table wider than its card, and a help line shown
 * twice). The real es and ja catalogs, at 390 px and 1280 px:
 *
 * - no heading (h1, h2, th) breaks inside a word: each run of text without
 *   a space sits on one line;
 * - a project's title on Manage projects is one line (the title wins);
 * - no table is wider than the box it sits in (on a phone, a box may
 *   scroll sideways);
 * - the Name row shows one help line;
 * - a toast never covers the terminal's "To" line.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ inactive: ["alpha", "zeta"] });
  const yml = path.join(s.tmp, "dist", "config", "local", "workspaces.yml");
  fs.writeFileSync(
    yml,
    fs
      .readFileSync(yml, "utf-8")
      .replace(
        "  north:\n",
        "  north:\n    hub_project: { id: proj_north1, slug: north-star, name: North Star }\n",
      ),
  );
}, 60_000);
afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(lang: string, width: number, next: string): Promise<Page> {
  await s!.settings({ language: lang });
  const p = await browser!.newPage({ viewport: { width, height: 900 } });
  await p.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, next));
  return p;
}

/** Headings broken inside a word, tables wider than their box. */
function misfits(
  p: Page,
  titleSel: string | null,
  phone = false,
): Promise<string[]> {
  return p.evaluate(
    ([titleSel, phone]) => {
      const out: string[] = [];
      const main = document.querySelector("#den-content") ?? document.body;
      // Shown to the eye: not hidden, and not clipped away for screen
      // readers only (clip: rect(0 0 0 0), as .den-sr does).
      const clipped = (e: Element) => {
        for (let a: Element | null = e; a; a = a.parentElement)
          if (
            /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(
              getComputedStyle(a).clip,
            )
          )
            return true;
        return false;
      };
      const shown = (e: Element) =>
        !!(e as HTMLElement).offsetParent &&
        !e.closest("[hidden]") &&
        !clipped(e);
      // The lines each run of text without a space lands on.
      const brokenWords = (el: Element) => {
        const bad: string[] = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = n.textContent ?? "";
          for (const m of text.matchAll(/\S+/g)) {
            const tops = new Set<number>();
            for (let i = m.index!; i < m.index! + m[0].length; i++) {
              const r = document.createRange();
              r.setStart(n, i);
              r.setEnd(n, i + 1);
              const rect = r.getClientRects()[0];
              if (rect && rect.width) tops.add(Math.round(rect.top / 4));
            }
            if (tops.size > 1) bad.push(m[0]);
          }
        }
        return bad;
      };
      for (const h of Array.from(main.querySelectorAll("h1, h2, th"))) {
        if (!shown(h)) continue;
        const bad = brokenWords(h);
        if (bad.length)
          out.push(
            `<${h.tagName.toLowerCase()}> breaks inside: ${bad.join(" ")}`,
          );
      }
      if (titleSel) {
        const t = document.querySelector(titleSel);
        if (!t) out.push(`no ${titleSel}`);
        else {
          const lh = parseFloat(getComputedStyle(t).lineHeight) || 20;
          if (t.getBoundingClientRect().height > lh * 1.5)
            out.push(`title wraps: ${t.textContent?.trim()}`);
        }
      }
      for (const tb of Array.from(main.querySelectorAll("table"))) {
        if (!shown(tb)) continue;
        // The box it sits in: the nearest parent with a border or a clip.
        let box = tb.parentElement;
        while (box && box !== main) {
          const cs = getComputedStyle(box);
          if (parseFloat(cs.borderRightWidth) > 0 || cs.overflowX !== "visible")
            break;
          box = box.parentElement;
        }
        if (!box) continue;
        const over =
          tb.getBoundingClientRect().right - box.getBoundingClientRect().right;
        const cs = getComputedStyle(box);
        // On a phone a box may scroll sideways; on a desktop it must fit.
        const scrolls = cs.overflowX === "auto" || cs.overflowX === "scroll";
        if (over > 1 && !(phone && scrolls))
          out.push(
            `table ${tb.id || tb.className || ""} is ${Math.round(over)}px wider than its box`,
          );
      }
      return out;
    },
    [titleSel, phone] as const,
  );
}

const CASES: [string, number][] = [
  ["es", 1280],
  ["ja", 1280],
  ["es", 390],
  ["ja", 390],
];

describe("translated pages fit", () => {
  it.each(CASES)(
    "Manage projects in %s at %ipx",
    async (lang, width) => {
      if (!browser) return;
      const p = await open(lang, width, "/local-dev?ws=north");
      await p.waitForSelector("#ws-list .ws-item", { state: "attached" });
      await p.waitForSelector("#content h2");
      await p.waitForSelector("#repo-table tbody tr");
      await p.waitForTimeout(400);
      const found = await misfits(p, "#content h2", width <= 480);
      await p.close();
      expect(found).toEqual([]);
    },
    60_000,
  );

  it.each(CASES)(
    "Settings › Project setup in %s at %ipx: one help line on Name",
    async (lang, width) => {
      if (!browser) return;
      const p = await open(lang, width, "/settings?ws=north#workspace");
      await p.waitForSelector('[data-setting="workspace.name"] [data-pname]');
      const helps = await p.$$eval(
        '[data-setting="workspace.name"] .d, [data-setting="workspace.name"] .set-note',
        (xs) =>
          xs.filter((x) => {
            const r = x.getBoundingClientRect();
            return (
              !x.closest("[hidden]") &&
              !/rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(
                getComputedStyle(x).clip,
              ) &&
              (x as HTMLElement).offsetParent &&
              r.width > 2 &&
              r.height > 2
            );
          }).length,
      );
      const found = await misfits(p, null, width <= 480);
      await p.close();
      expect({ helps, found }).toEqual({ helps: 1, found: [] });
    },
    60_000,
  );

  it.each(CASES)(
    "the terminal in %s at %ipx: its toast leaves the To line clear",
    async (lang, width) => {
      if (!browser) return;
      const p = await open(lang, width, "/agents?terminal=1");
      await p.waitForSelector(".den-toast");
      await p.waitForSelector(".agto[data-toast-clear]");
      // The toast looks again 0.5 s after it shows (the line may come later).
      await p.waitForTimeout(700);
      const overlap = await p.evaluate(() => {
        const t = document.querySelector(".den-toast")!.getBoundingClientRect();
        return Array.from(document.querySelectorAll(".agto"))
          .map((x) => x.getBoundingClientRect())
          .filter(
            (m) =>
              m.width &&
              t.left < m.right &&
              t.right > m.left &&
              t.top < m.bottom &&
              t.bottom > m.top,
          ).length;
      });
      await p.close();
      expect(overlap).toBe(0);
    },
    60_000,
  );
});
