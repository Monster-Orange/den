/**
 * Issue 805: every button in a kit dialog's footer (Report, the main
 * action and the others) has one height, one font size, one line height
 * and one font family, set in the kit (dialog.css), not per page.
 *
 * Opened in a real browser: What's new (a large dialog of the kit's, with
 * Report, "Show all versions" and "Got it"), a Yes/No question (the kit's
 * confirm) and a large dialog (the kit's panel). On every built-in theme,
 * light and dark, at 1280 and 390 wide.
 *
 * The Report button's shortcut hint (the key cap) keeps its smaller hint
 * style: where it shows, its font is smaller than the button's, and it
 * does not make the button taller (the height check covers that).
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

/** Every built-in theme: each folder under themes/ with a manifest. */
const THEMES = fs
  .readdirSync(path.join(ENGINE, "themes"))
  .filter((d) =>
    fs.existsSync(path.join(ENGINE, "themes", d, "den-theme.json")),
  );

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
    "active: [default]\nfocus: default\nworkspaces:\n  default:\n    services:\n      shop:\n        mode: dev-managed\n        path: /nowhere/shop\n",
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

/** A signed-in page on /agents, on this theme, mode and width. */
async function pageOn(
  theme: string,
  mode: "light" | "dark",
  width: number,
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 860 },
    colorScheme: mode,
    reducedMotion: "reduce",
  });
  await signIn(ctx, path.join(tmp, "home"), base);
  // This version unseen: What's new opens on its own.
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
    ([theme, mode]) =>
      (window as unknown as PageWin).denShell!.api("POST", "/api/settings", {
        appearance: { theme, mode },
      }),
    [theme, mode] as const,
  );
  await p.goto(`${base}/agents`);
  return p;
}

/** Each visible footer button of the open dialog `sel`, as drawn. */
type Btn = {
  what: string;
  report: boolean;
  fontSize: string;
  lineHeight: string;
  fontFamily: string;
  height: number;
  /** The shortcut hint's font size, when it shows. */
  kbdSize: string | null;
};
function footerButtons(p: Page, sel: string): Promise<Btn[]> {
  return p.evaluate((sel) => {
    const d = document.querySelector(sel);
    const foot = d ? [...d.querySelectorAll(".dk-ft")].pop() : null;
    if (!foot) return [];
    const out: Btn[] = [];
    for (const el of foot.querySelectorAll("button, a")) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      const kbd = el.querySelector("kbd");
      const kbdShown = !!kbd && !!kbd.getClientRects().length;
      out.push({
        what:
          (el.id ? `#${el.id}` : "") +
          "." +
          [...el.classList].join(".") +
          ` "${(el.textContent ?? "").trim()}"`,
        report: el.hasAttribute("data-den-report"),
        fontSize: cs.fontSize,
        lineHeight: cs.lineHeight,
        fontFamily: cs.fontFamily,
        height: Math.round(el.getBoundingClientRect().height * 10) / 10,
        kbdSize: kbdShown ? getComputedStyle(kbd).fontSize : null,
      });
    }
    return out;
  }, sel);
}

/** What differs between a footer's buttons ([] when they all match). */
export function mismatches(btns: Btn[]): string[] {
  const out: string[] = [];
  if (btns.length < 2) out.push(`only ${btns.length} footer button(s)`);
  if (!btns.some((b) => b.report)) out.push("no Report button in the footer");
  const first = btns[0];
  for (const b of btns.slice(1)) {
    for (const k of [
      "fontSize",
      "lineHeight",
      "fontFamily",
      "height",
    ] as const) {
      if (b[k] !== first[k])
        out.push(`${k}: ${first.what} is ${first[k]}, ${b.what} is ${b[k]}`);
    }
  }
  for (const b of btns) {
    if (b.kbdSize && parseFloat(b.kbdSize) >= parseFloat(b.fontSize))
      out.push(
        `${b.what}: the hint is ${b.kbdSize}, not smaller than ${b.fontSize}`,
      );
  }
  return out;
}

const WHATS_NEW = "#cl-overlay.open";
const CONFIRM = "dialog.dk-dlg[data-dk-kind=confirm][open]";
const PANEL = "dialog#dk-805-panel[open]";

const CASES = THEMES.flatMap((theme) =>
  (["light", "dark"] as const).flatMap((mode) =>
    [1280, 390].map((width) => ({ theme, mode, width })),
  ),
);

describe("issue 805: a kit dialog's footer buttons share one size and font", () => {
  it("finds the built-in themes", () => {
    expect(THEMES.length).toBeGreaterThan(0);
  });

  it("the check can fail", () => {
    const b = (o: Partial<Btn>): Btn => ({
      what: "b",
      report: false,
      fontSize: "13px",
      lineHeight: "normal",
      fontFamily: "sans-serif",
      height: 36,
      kbdSize: null,
      ...o,
    });
    expect(mismatches([b({ report: true }), b({})])).toEqual([]);
    expect(
      mismatches([b({ report: true, fontSize: "12px" }), b({})]),
    ).toHaveLength(1);
    expect(mismatches([b({ report: true, height: 32 }), b({})])).toHaveLength(
      1,
    );
    expect(
      mismatches([b({ report: true, kbdSize: "13px" }), b({})]),
    ).toHaveLength(1);
    expect(mismatches([b({}), b({})])).toHaveLength(1);
  });

  it.each(CASES)(
    "$theme, $mode, $width wide: What's new, a confirm and a large dialog",
    async ({ theme, mode, width }) => {
      if (!browser) return;
      const p = await pageOn(theme, mode, width);
      const bad: string[] = [];

      // What's new, on its own the first time.
      await p.locator(WHATS_NEW).waitFor({ timeout: 20_000 });
      for (const m of mismatches(await footerButtons(p, "#cl-overlay")))
        bad.push(`What's new: ${m}`);
      await p.keyboard.press("Escape");
      await p.locator(WHATS_NEW).waitFor({ state: "detached" });

      // A Yes/No question. A string, so the browser does the import.
      await p.evaluate(
        `${pageImport("/dialog-den.js")}.then((m) => void m.askConfirm({ title: "Turn it off?", message: "Two systems need it." }))`,
      );
      await p.locator(CONFIRM).waitFor();
      for (const m of mismatches(await footerButtons(p, CONFIRM)))
        bad.push(`confirm: ${m}`);
      await p.keyboard.press("Escape");
      await p.locator(CONFIRM).waitFor({ state: "detached" });

      // A large dialog.
      await p.evaluate(
        `${pageImport("/dialog-den.js")}.then((m) => void m.mountDialog(m.dialogHtml({ kind: "panel", id: "dk-805-panel", title: "Settings", body: "<p>Body</p>", actions: [{ label: "Back", value: "back" }, { label: "Save", value: "save", kind: "primary" }] })).show())`,
      );
      await p.locator(PANEL).waitFor();
      for (const m of mismatches(await footerButtons(p, PANEL)))
        bad.push(`large dialog: ${m}`);

      expect(bad).toEqual([]);
      await p.context().close();
    },
    60_000,
  );
});
