// The kit's holdOpen per container kind, and mountDialog's form= post, in Chromium and WebKit.
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/busy.css"><link rel="stylesheet" href="/dialog.css">
<link rel="stylesheet" href="/popover.css">
</head><body>
<button id="outside" type="button">Outside</button>
<dialog id="dlg"><p>Resolve all?</p>
  <a id="d-cancel" href="#cancel">Cancel</a>
  <button id="d-other" type="button">Later</button>
  <button id="d-go" type="button" value="go">Resolve all</button></dialog>
<details id="menu"><summary id="m-sum">More</summary>
  <div role="menu"><button id="m-go" type="button" role="menuitem">Mark shipped</button>
  <button id="m-other" type="button" role="menuitem">Mark building</button></div></details>
<div id="pop" popover="auto"><button id="p-go" type="button">Approve all</button>
  <button id="p-other" type="button">Later</button></div>
<button id="kit-anchor" type="button">Open card</button>
<form id="pageform" action="/post" method="post"><input name="q" value="1"></form>
<script type="module">
import { holdOpen, mountDialog } from "/dialog.js";
import { openPopover } from "/popover.js";
window.log = [];
window.holdOpen = holdOpen;
window.mountDialog = mountDialog;
window.openPopover = openPopover;
window.answer = null;
window.pending = () =>
  new Promise((ok, no) => (window.answer = { ok, no }));
for (const id of ["d-other", "m-other", "p-other", "outside"])
  document.getElementById(id).addEventListener("click", () => log.push(id));
document.getElementById("pageform").addEventListener("submit", (e) => {
  e.preventDefault();
  log.push("page-post");
});
window.ready = true;
</script></body></html>`;

async function openPage(browser: Browser, width = 1280): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
    const f = u.pathname.slice(1);
    if (/^[a-z-]+\.(js|css)$/.test(f) && fs.existsSync(path.join(SRC, f)))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f), "utf-8"),
      });
    return r.fulfill({ status: 404, body: "" });
  });
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${ORIGIN}/`);
  await p
    .waitForFunction(
      () => (window as { ready?: boolean }).ready === true,
      null,
      { timeout: 10_000 },
    )
    .catch(() => {
      throw new Error(
        `the page never got ready: ${errors.join("; ") || "no error"}`,
      );
    });
  return p;
}

type W = Window & {
  log: string[];
  answer: { ok: (v?: unknown) => void; no: (e: unknown) => void } | null;
  pending: () => Promise<unknown>;
  holdOpen: (
    c: Element,
    work: unknown,
    o?: {
      button?: Element;
      value?: string;
      closeNow?: boolean;
    },
  ) => Promise<{ ok: boolean; value?: unknown; error?: unknown }>;
  mountDialog: (el: Element, o: Record<string, unknown>) => unknown;
  openPopover: (a: Element, o: Record<string, unknown>) => { el: Element };
  result?: { ok: boolean; value?: unknown };
  dlgClosed?: string;
  failed?: string;
};

const log = (p: Page) => p.evaluate(() => (window as unknown as W).log);
const active = (p: Page) => p.evaluate(() => document.activeElement?.id ?? "");
const attr = (p: Page, sel: string, a: string) =>
  p.locator(sel).evaluate((el, a) => el.getAttribute(a), a);
const answer = (p: Page, ok: boolean) =>
  p.evaluate((ok) => {
    const w = window as unknown as W;
    if (ok) w.answer!.ok("done");
    else {
      w.failed = `refused ${Date.now()}`;
      w.answer!.no(new Error(w.failed));
    }
  }, ok);
const settled = (p: Page) =>
  p.waitForFunction(() => !!(window as unknown as W).result);

const hold = (p: Page, container: string, button: string) =>
  p.evaluate(
    ([c, b]) => {
      const w = window as unknown as W;
      w.result = undefined;
      const btn = document.querySelector(b)!;
      (btn as HTMLElement).focus();
      void w
        .holdOpen(document.querySelector(c)!, w.pending(), { button: btn })
        .then((r) => (w.result = r));
    },
    [container, button],
  );

async function expectHeld(p: Page, button: string, other: string) {
  expect(await attr(p, button, "aria-busy")).toBe("true");
  expect(await active(p)).toBe(button.slice(1));
  const before = (await log(p)).length;
  await p.locator(other).dispatchEvent("click");
  expect((await log(p)).slice(before)).toEqual([]);
  expect(
    await p
      .locator(other)
      .evaluate(
        (el) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true",
      ),
  ).toBe(true);
  await p.keyboard.press("Tab");
  expect(await active(p)).toBe(button.slice(1));
}

async function expectFailed(p: Page, button: string, other: string) {
  await settled(p);
  const r = await p.evaluate(() => (window as unknown as W).result);
  expect(r?.ok).toBe(false);
  expect(await attr(p, button, "aria-busy")).toBeNull();
  const alert = p.locator('[role="alert"]');
  expect(await alert.count()).toBe(1);
  expect(await alert.textContent()).toBe(
    await p.evaluate(() => (window as unknown as W).failed),
  );
  expect(
    await p
      .locator(other)
      .evaluate(
        (el) =>
          (el as HTMLButtonElement).disabled ||
          el.getAttribute("aria-disabled") === "true",
      ),
  ).toBe(false);
  expect(await active(p)).toBe(button.slice(1));
}

const openKitPopover = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as W;
    const box = document.createElement("div");
    box.innerHTML =
      '<button id="k-go" type="button">Approve all</button> <button id="k-other" type="button">Later</button>';
    box
      .querySelector("#k-other")!
      .addEventListener("click", () => w.log.push("k-other"));
    w.openPopover(document.getElementById("kit-anchor")!, {
      content: box,
      label: "Card",
    });
  });

describe.each(["chromium", "webkit"])(
  "the kit's holdOpen in %s (issue 2013)",
  (name) => {
    const skip = () => !browsers[name];

    it("a dialog stays open while its request runs, and closes on success", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() =>
        (document.getElementById("dlg") as HTMLDialogElement).showModal(),
      );
      await hold(p, "#dlg", "#d-go");
      await p.keyboard.press("Escape");
      await p.evaluate(() =>
        (document.getElementById("dlg") as HTMLDialogElement).close(),
      );
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(true);
      await expectHeld(p, "#d-go", "#d-other");
      await answer(p, true);
      await settled(p);
      expect(await p.evaluate(() => (window as unknown as W).result)).toEqual({
        ok: true,
        value: "done",
      });
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(false);
      expect(await attr(p, "#d-go", "aria-busy")).toBeNull();
      await p.context().close();
    });

    it("a dialog stays open with the error on failure", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() =>
        (document.getElementById("dlg") as HTMLDialogElement).showModal(),
      );
      await hold(p, "#dlg", "#d-go");
      await answer(p, false);
      await expectFailed(p, "#d-go", "#d-other");
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(true);
      await p.keyboard.press("Escape");
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(false);
      await p.context().close();
    });

    it("with no request it holds until the page leaves (a page form posting)", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() => {
        const w = window as unknown as W;
        (document.getElementById("dlg") as HTMLDialogElement).showModal();
        const b = document.getElementById("d-go")!;
        b.focus();
        void w
          .holdOpen(document.getElementById("dlg")!, undefined, { button: b })
          .then((r) => (w.result = r));
      });
      await p.keyboard.press("Escape");
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(true);
      expect(await attr(p, "#d-go", "aria-busy")).toBe("true");
      expect(
        await p.evaluate(() => (window as unknown as W).result),
      ).toBeUndefined();
      await p.context().close();
    });

    it("a press on a held dialog's link, then on its scrim, leaves focus on the button at 390", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name], 390);
      await p.evaluate(() =>
        (document.getElementById("dlg") as HTMLDialogElement).showModal(),
      );
      await hold(p, "#dlg", "#d-go");
      await p.evaluate(() =>
        document
          .getElementById("d-go")!
          .addEventListener("blur", () =>
            (window as unknown as W).log.push("blur"),
          ),
      );
      await p.locator("#d-cancel").click({ force: true });
      expect(await active(p)).toBe("d-go");
      await p.mouse.click(4, 790);
      expect(await active(p)).toBe("d-go");
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(true);
      expect(await p.evaluate(() => location.hash)).toBe("");
      expect(await log(p)).not.toContain("blur");
      await p.context().close();
    });

    it("with no request it lets go when the busy hold ends (a failed page post)", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() => {
        const w = window as unknown as W;
        (document.getElementById("dlg") as HTMLDialogElement).showModal();
        const b = document.getElementById("d-go")!;
        b.setAttribute("aria-busy", "true");
        b.setAttribute("aria-disabled", "true");
        b.focus();
        void w.holdOpen(document.getElementById("dlg")!, undefined, {
          button: b,
        });
      });
      expect(await attr(p, "#d-other", "disabled")).toBe("");
      await p.evaluate(() => {
        const b = document.getElementById("d-go")!;
        b.removeAttribute("aria-busy");
        b.removeAttribute("aria-disabled");
      });
      await p.waitForFunction(
        () =>
          !(document.getElementById("d-other") as HTMLButtonElement).disabled,
      );
      await p.keyboard.press("Escape");
      expect(
        await p.locator("#dlg").evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(false);
      await p.context().close();
    });

    it("closeNow shuts a menu at once and holds its summary until the answer", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.locator("#m-sum").click();
      await p.evaluate(() => {
        const w = window as unknown as W;
        w.result = undefined;
        void w
          .holdOpen(document.getElementById("menu")!, w.pending(), {
            button: document.getElementById("m-sum")!,
            closeNow: true,
          })
          .then((r) => (w.result = r));
      });
      const open = () =>
        p.locator("#menu").evaluate((d) => (d as HTMLDetailsElement).open);
      expect(await open()).toBe(false);
      expect(await attr(p, "#m-sum", "aria-busy")).toBe("true");
      expect(await attr(p, "#m-sum", "aria-disabled")).toBe("true");
      expect(await active(p)).toBe("m-sum");
      await p.keyboard.press("Enter");
      await p.locator("#m-sum").click({ force: true });
      expect(await open()).toBe(false);
      await answer(p, false);
      await settled(p);
      expect(await attr(p, "#m-sum", "aria-busy")).toBeNull();
      expect(
        await p
          .locator("#menu")
          .evaluate((d) => d.nextElementSibling?.getAttribute("role") ?? ""),
      ).toBe("alert");
      expect(await active(p)).toBe("m-sum");
      await p.locator("#m-sum").click();
      expect(await open()).toBe(true);
      await p.context().close();
    });

    it("a <details> menu stays open while its item's request runs", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.locator("#m-sum").click();
      await hold(p, "#menu", "#m-go");
      await p.locator("#m-sum").dispatchEvent("click");
      await p.evaluate(() => {
        (document.getElementById("menu") as HTMLDetailsElement).open = false;
      });
      await p.waitForFunction(
        () => (document.getElementById("menu") as HTMLDetailsElement).open,
      );
      await p.keyboard.press("Escape");
      expect(
        await p
          .locator("#menu")
          .evaluate((d) => (d as HTMLDetailsElement).open),
      ).toBe(true);
      await expectHeld(p, "#m-go", "#m-other");
      await answer(p, true);
      await settled(p);
      expect(
        await p
          .locator("#menu")
          .evaluate((d) => (d as HTMLDetailsElement).open),
      ).toBe(false);
      await p.context().close();
    });

    it("a <details> menu keeps the error beside its item on failure", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.locator("#m-sum").click();
      await hold(p, "#menu", "#m-go");
      await answer(p, false);
      await expectFailed(p, "#m-go", "#m-other");
      expect(
        await p
          .locator("#menu")
          .evaluate((d) => (d as HTMLDetailsElement).open),
      ).toBe(true);
      expect(
        await p
          .locator("#m-go")
          .evaluate((b) => b.nextElementSibling?.getAttribute("role") ?? ""),
      ).toBe("alert");
      await p.context().close();
    });

    it("a [popover] stays open through a press outside, and hides on success", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() => document.getElementById("pop")!.showPopover());
      await hold(p, "#pop", "#p-go");
      await p.mouse.click(600, 700);
      await p.keyboard.press("Escape");
      expect(
        await p.locator("#pop").evaluate((el) => el.matches(":popover-open")),
      ).toBe(true);
      await expectHeld(p, "#p-go", "#p-other");
      await answer(p, true);
      await settled(p);
      expect(
        await p.locator("#pop").evaluate((el) => el.matches(":popover-open")),
      ).toBe(false);
      await p.context().close();
    });

    it("a [popover] stays open with the error on failure", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() => document.getElementById("pop")!.showPopover());
      await hold(p, "#pop", "#p-go");
      await answer(p, false);
      await expectFailed(p, "#p-go", "#p-other");
      expect(
        await p.locator("#pop").evaluate((el) => el.matches(":popover-open")),
      ).toBe(true);
      await p.context().close();
    });

    it("the kit's popover stays open with the error on failure", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await openKitPopover(p);
      await hold(p, '[aria-label="Card"]', "#k-go");
      await answer(p, false);
      await expectFailed(p, "#k-go", "#k-other");
      expect(await p.locator('[aria-label="Card"]').count()).toBe(1);
      await p.context().close();
    });

    it("the kit's popover stays open while held, and closes on success", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await openKitPopover(p);
      await hold(p, '[aria-label="Card"]', "#k-go");
      await p.mouse.click(600, 700);
      await p.keyboard.press("Escape");
      expect(await p.locator('[aria-label="Card"]').count()).toBe(1);
      await expectHeld(p, "#k-go", "#k-other");
      await answer(p, true);
      await settled(p);
      expect(await p.locator('[aria-label="Card"]').count()).toBe(0);
      await p.context().close();
    });

    it("mountDialog's onAction holds a button that posts a page form through form=", async () => {
      if (skip()) return;
      const p = await openPage(browsers[name]);
      await p.evaluate(() => {
        const w = window as unknown as W;
        const d = document.createElement("dialog");
        d.innerHTML =
          '<p>Approve all?</p><div class="dk-ft"><button id="f-cancel" type="button">Cancel</button>' +
          '<button id="f-go" type="submit" form="pageform" value="approve">Approve all</button></div>';
        document.body.append(d);
        w.mountDialog(d, {
          onAction: (v: string) => {
            w.log.push(`action:${v}`);
            return w.pending();
          },
          onClose: (v: string) => (w.dlgClosed = v),
        });
      });
      await p.locator("#f-go").click();
      expect(await log(p)).toContain("action:approve");
      expect(await attr(p, "#f-go", "aria-busy")).toBe("true");
      await p.keyboard.press("Escape");
      expect(
        await p
          .locator("dialog:not(#dlg)")
          .evaluate((d) => (d as HTMLDialogElement).open),
      ).toBe(true);
      await answer(p, true);
      await p.waitForFunction(
        () => (window as unknown as W).dlgClosed === "approve",
      );
      await p.context().close();
    });
  },
);
