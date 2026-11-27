import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { startDenServer } from "../../child-servers.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { signIn } from "./helpers/signed-in.js";
import { launchBrowser } from "../helpers/browser.js";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let base = "";
let server: ChildProcess;
let browser: Browser | null = null;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-837-")));
  const root = path.join(tmp, "dist");
  const repo = path.join(tmp, "repos", "kettle");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "kettle:\n  gh: acme/kettle\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    `active: [north]\nfocus: north\nworkspaces:\n  north:\n    services:\n      kettle:\n        mode: dev-managed\n        path: ${repo}\n`,
  );
  write(
    path.join(repo, ".den.yml"),
    'name: kettle\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n',
  );
  const started = await startDenServer(
    path.join(ENGINE, "node_modules", ".bin", "tsx"),
    [path.join(ENGINE, "src", "ui", "server", "index.ts")],
    {
      cwd: root,
      env: {
        HOME: path.join(tmp, "home"),
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DEN_ROOT: root,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_EDGE_DIR: path.join(tmp, "edge-state"),
        DEN_HOME: path.join(tmp, "home", ".den"),
        DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
        DEN_NO_OPEN: "1",
        NO_COLOR: "1",
      },
    },
  );
  server = started.server;
  base = `http://localhost:${started.port}`;
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

type Win = {
  denShell?: { api: (m: string, u: string, b?: unknown) => Promise<unknown> };
};

const POP = "dialog#dg-pop";
const CARD = '[role="group"][data-id]';
const SIDE_POP = "[data-popout]:visible";

const SIDE_SHOWN_JS = `[...document.querySelectorAll("[data-popout]")].some((b) => !b.closest("dialog") && b.checkVisibility())`;

async function details(lang = "en"): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await signIn(ctx, path.join(tmp, "home", ".den"), base);
  await ctx.route("**/api/changelog", (r) => r.fulfill({ json: [] }));
  const p = await ctx.newPage();
  await p.route(/\/api\/health(\/stream)?(\?|$)/, () => undefined);
  await p.goto(`${base}/settings`);
  await p.waitForFunction(() => !!(window as unknown as Win).denShell?.api);
  await p.evaluate(
    (language) =>
      (window as unknown as Win).denShell!.api("POST", "/api/settings", {
        language,
      }),
    lang,
  );
  await p.goto(`${base}/graph?ws=north`);
  await p.locator(CARD).waitFor({ timeout: 30_000 });
  await p.locator(CARD).click();
  await p.locator(SIDE_POP).waitFor();
  return p;
}

async function popOut(p: Page): Promise<void> {
  await p.locator(SIDE_POP).click();
  await p.locator(`${POP}[open]`).waitFor();
}

describe("issue 837: the graph's popped-out details on the kit's dialog", () => {
  it("is the kit's frame: a modal <dialog> named by the service, Close and Report inside, no page layer", async () => {
    if (!browser) return;
    const p = await details();
    await popOut(p);
    const got = await p.evaluate(
      ({ sel }) => {
        const d = document.querySelector(sel) as HTMLDialogElement;
        const h = document.getElementById(
          d.getAttribute("aria-labelledby") || "",
        );
        return {
          kit: d.dataset.dkKind === "panel",
          modal: d.matches(":modal"),
          modals: document.querySelectorAll(":modal").length,
          name: h?.textContent ?? "",
          close: !!d.querySelector('[data-dk="close"]'),
          report: d.querySelectorAll("[data-den-report]").length,
          tabs: d.querySelectorAll('[role="tab"]').length > 0,
          focusIn: d.contains(document.activeElement),
        };
      },
      { sel: POP },
    );
    const side = await p.evaluate<boolean>(SIDE_SHOWN_JS);
    expect(side).toBe(false);
    expect(got).toEqual({
      kit: true,
      modal: true,
      modals: 1,
      name: expect.stringMatching(/api|kettle/),
      close: true,
      report: 1,
      tabs: true,
      focusIn: true,
    });
    await p.context().close();
  }, 90_000);

  it("Report stays one through a repaint (another tab)", async () => {
    if (!browser) return;
    const p = await details();
    await popOut(p);
    const id = await p.evaluate((sel) => {
      const t = document.querySelector<HTMLElement>(
        `${sel} [role="tab"][aria-selected="false"]`,
      );
      t?.click();
      return t?.dataset.tab ?? "";
    }, POP);
    if (id)
      await p
        .locator(`${POP} [data-tab="${id}"][aria-selected="true"]`)
        .waitFor();
    expect(await p.locator(`${POP} [data-den-report]`).count()).toBe(1);
    expect(await p.locator(`${POP}[open]`).count()).toBe(1);
    await p.context().close();
  }, 90_000);

  it("Esc closes it, the details are shut, and focus goes back to the card", async () => {
    if (!browser) return;
    const p = await details();
    await popOut(p);
    await p.keyboard.press("Escape");
    await p.locator(`${POP}[open]`).waitFor({ state: "detached" });
    const after = {
      side: await p.evaluate<boolean>(SIDE_SHOWN_JS),
      onCard: await p.evaluate(
        () => !!document.activeElement?.closest('[role="group"][data-id]'),
      ),
    };
    expect(after).toEqual({ side: false, onCard: true });
    await p.context().close();
  }, 90_000);

  it("Dock puts the same details back in the side panel", async () => {
    if (!browser) return;
    const p = await details();
    await popOut(p);
    await p.locator(`${POP} [data-popout]`).click();
    await p.locator(`${POP}[open]`).waitFor({ state: "detached" });
    await p.locator(SIDE_POP).waitFor();
    await p.context().close();
  }, 90_000);

  it("its words are the page's language (es)", async () => {
    if (!browser) return;
    const p = await details("es");
    await popOut(p);
    const dock = await p
      .locator(`${POP} [data-popout]`)
      .getAttribute("aria-label");
    await p.evaluate(() =>
      (window as unknown as Win).denShell!.api("POST", "/api/settings", {
        language: "en",
      }),
    );
    const es = fs.readFileSync(
      path.join(ENGINE, "src/ui/server/public/i18n/es.js"),
      "utf8",
    );
    expect(dock).toBe(/"gr\.dock":\s*"([^"]+)"/.exec(es)?.[1]);
    await p.context().close();
  }, 90_000);
});
