/**
 * Issue 805: every button in a kit dialog's footer (Report, the primary,
 * the secondary) has one height, one font size, one line height and one
 * font family, set in the kit, not per page. Report's ⌘⇧F keeps its
 * smaller hint style and never makes the button taller.
 *
 * Three pop-ups: What's new, a Yes/No question (the kit's confirm) and a
 * large dialog (the kit's panel frame with its own actions). Each in light
 * and dark, on every built-in theme, at 1280 and 390 wide. The kit's
 * sheets (dialog.css, shell.css) are served as ui-assets.ts lists them.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { pageImport } from "./helpers/page-import.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let base = "";
let server: ChildProcess;
let browser: Browser | null = null;

/** Den's built-in themes: each folder under themes/ with a manifest. */
const THEMES = fs
  .readdirSync(path.join(ENGINE, "themes"))
  .filter((d) =>
    fs.existsSync(path.join(ENGINE, "themes", d, "den-theme.json")),
  );
const MODES = ["light", "dark"] as const;
const WIDTHS = [1280, 390] as const;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-805-")));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    "environments: [local]\n",
  );
  // A repo in a project: not a fresh Den, so What's new opens.
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    "active: [default]\nfocus: default\nworkspaces:\n  default:\n    services:\n      web:\n        mode: dev-managed\n        path: /nowhere/web\n",
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: dist,
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home"),
        HOME: path.join(tmp, "home"),
        DEN_NO_OPEN: "1",
      },
    },
  );
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
}, 60_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
    servers: [server],
    after: () => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
});

type PageWin = {
  denShell?: { api: (m: string, u: string, b?: unknown) => Promise<unknown> };
};

/** One footer button, as the browser draws it. */
type Btn = {
  what: string;
  fontSize: string;
  lineHeight: string;
  fontFamily: string;
  height: number;
  /** The kit's tap height for this width: --tap at 480px and under, else --tap-min. */
  want: number;
  kbd: { fontSize: string; family: string } | null;
};

/**
 * Every shown button in the footer of the pop-up `sel`: the Report
 * button's row (Report is first in every kit dialog's footer).
 */
function footerOf(p: Page, sel: string): Promise<Btn[]> {
  return p.evaluate((sel) => {
    const d = document.querySelector(sel);
    const rb = d ? [...d.querySelectorAll("[data-den-report]")].pop() : null;
    const foot = rb?.parentElement;
    if (!foot) return [];
    // The token's own height, measured in the footer.
    const probe = document.createElement("div");
    probe.style.height = matchMedia("(max-width: 480px)").matches
      ? "var(--tap)"
      : "var(--tap-min)";
    foot.appendChild(probe);
    const want = Math.round(probe.getBoundingClientRect().height * 10) / 10;
    probe.remove();
    return [...foot.children]
      .filter((b) => /^(BUTTON|A)$/.test(b.tagName))
      .filter((b) => b.getClientRects().length > 0)
      .map((b) => {
        const cs = getComputedStyle(b);
        const k = b.querySelector("kbd");
        const kcs = k && k.getClientRects().length ? getComputedStyle(k) : null;
        return {
          what: `${b.tagName.toLowerCase()}.${[...b.classList].join(".")}`,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          fontFamily: cs.fontFamily,
          height: Math.round(b.getBoundingClientRect().height * 10) / 10,
          want,
          kbd: kcs ? { fontSize: kcs.fontSize, family: kcs.fontFamily } : null,
        };
      });
  }, sel);
}

/** What differs between the footer's buttons ([] when nothing). */
export function mismatches(btns: Btn[]): string[] {
  const out: string[] = [];
  if (btns.length < 2) return [`only ${btns.length} footer button(s)`];
  if (!btns.some((b) => b.what.includes("den-rb")))
    out.push("no Report button in the footer");
  const [first, ...rest] = btns;
  for (const b of rest)
    for (const k of ["fontSize", "lineHeight", "fontFamily", "height"] as const)
      if (b[k] !== first[k])
        out.push(`${b.what} ${k} ${b[k]}, ${first.what} ${first[k]}`);
  // Equal is not enough: each is the kit's tap height (Builder 2's review:
  // at 390 wide the footer's own buttons fell to --tap-min, all equal).
  for (const b of btns)
    if (b.height !== b.want)
      out.push(`${b.what} height ${b.height}, the tap height is ${b.want}`);
  for (const b of btns)
    if (b.kbd && parseFloat(b.kbd.fontSize) >= parseFloat(b.fontSize))
      out.push(`${b.what}: its key hint is ${b.kbd.fontSize}, not smaller`);
  return out;
}

async function pageOn(
  theme: string,
  mode: (typeof MODES)[number],
  width: number,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 860 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, path.join(tmp, "home"), base);
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem("den-changelog-seen", "0.0.0-unseen");
    } catch {
      /* none */
    }
  });
  const p = await ctx.newPage();
  await p.goto(`${base}/settings`);
  await p.waitForFunction(
    () => !!(window as unknown as PageWin).denShell?.api,
    undefined,
    { timeout: 20_000 },
  );
  await p.evaluate(
    (a) =>
      (window as unknown as PageWin).denShell!.api("POST", "/api/settings", {
        appearance: a,
      }),
    { theme, mode },
  );
  await p.goto(`${base}/agents`);
  return p;
}

const WHATS_NEW = "#cl-overlay.open";
const OPEN = "dialog.dk-dlg[open]";

const CASES = THEMES.flatMap((theme) =>
  MODES.flatMap((mode) => WIDTHS.map((width) => ({ theme, mode, width }))),
);

describe("issue 805: a kit dialog's footer buttons share one size and font", () => {
  it.each(CASES)(
    "$theme, $mode, $width wide",
    async ({ theme, mode, width }) => {
      if (!browser) return;
      const p = await pageOn(theme, mode, width);
      // What's new, on its own (this version unseen).
      await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
      expect(await footerOf(p, "#cl-overlay")).not.toEqual([]);
      const wn = await footerOf(p, "#cl-overlay");
      expect({ whatsNew: mismatches(wn) }).toEqual({ whatsNew: [] });
      await p.keyboard.press("Escape");
      await p.locator(WHATS_NEW).waitFor({ state: "detached" });

      // A Yes/No question.
      await p.evaluate(
        `${pageImport("/dialog-den.js")}.then((m) => void m.askConfirm({ title: "Turn it off?", message: "Two systems need it." }))`,
      );
      await p.locator(OPEN).waitFor();
      const cf = await footerOf(p, OPEN);
      expect({ confirm: mismatches(cf) }).toEqual({ confirm: [] });
      await p.keyboard.press("Escape");
      await p.locator(OPEN).waitFor({ state: "detached" });

      // A large dialog with its own actions.
      await p.evaluate(
        `${pageImport("/dialog-den.js")}.then((m) => m.mountDialog(m.dialogHtml({ kind: "panel", id: "t805", title: "Edit", body: "<p>Body</p>", actions: [{ label: "Cancel", value: "cancel" }, { label: "Save", value: "ok", kind: "primary" }] })).show())`,
      );
      await p.locator(OPEN).waitFor();
      const pn = await footerOf(p, OPEN);
      expect({ panel: mismatches(pn) }).toEqual({ panel: [] });
      await p.context().close();
    },
    90_000,
  );

  it("the check can fail", () => {
    const b = (
      what: string,
      height: number,
      fontSize = "13px",
      want = 36,
    ): Btn => ({
      what,
      fontSize,
      lineHeight: "normal",
      fontFamily: "x",
      height,
      want,
      kbd: null,
    });
    expect(
      mismatches([b("button.den-rb", 38), b("button.dk-btn", 36)]),
    ).not.toEqual([]);
    expect(
      mismatches([b("button.den-rb", 36, "12px"), b("button.dk-btn", 36)]),
    ).not.toEqual([]);
    // All equal, but under the tap height.
    expect(
      mismatches([
        b("button.den-rb", 36, "13px", 44),
        b("button.dk-btn", 36, "13px", 44),
      ]),
    ).not.toEqual([]);
    expect(
      mismatches([b("button.den-rb", 36), b("button.dk-btn", 36)]),
    ).toEqual([]);
  });
});
