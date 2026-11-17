/**
 * den-ui UK-2: the kit's working pop-up in a browser, with no product
 * around it: a bare page loads tokens.css and busy.js, configures the kit
 * with stub hooks and registers invented actions. Every option the kit
 * offers is tested here (untested options don't ship).
 *
 *   - fast success: no pop-up; an auto-close action says so in a toast
 *   - slow: opens at 300 ms, no buttons and Esc does nothing while working
 *   - an error answer: Failure, Details without method or URL; Try again
 *     sends a new id
 *   - no answer (network): Try again sends the same id
 *   - 60 s: No answer; Check again asks the status URL and never resends:
 *     running, unknown, done
 *   - held: closes with no success line and opens the held page
 *   - quietFail, inlineError, skipDone, extra
 *   - reconnect: waits for the product to come back (a new pid), says the
 *     version, then calls done (default: reload); no answer to the request
 *     counts as going down; before and waitMs come from the product
 *   - ja words; 390 px: the primary alone on its row, buttons ≥ --tap
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: [browser],
  });
});

const skip = () => !browser;

const PAGE = (lang: string) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/tokens.css"></head>
<body><button id="go">Go</button>
<script type="module">
import * as kit from "/busy.js";
window.seen = { toasts: [], opened: [], reports: [], reloads: 0 };
kit.configureBusy({
  idHeader: "X-Probe-Id",
  statusUrl: (id) => "/status/" + id,
  toast: (t) => seen.toasts.push(t),
  open: (u) => seen.opened.push(u),
  report: (i) => seen.reports.push(i),
  logUrl: "/the-log",
  reconnect: {
    url: "/info",
    back: (now, before) => !!before && now.pid !== before.pid,
    version: (now) => now.version,
    waitMs: () => window.waitMs,
    done: (now) => { seen.reloads++; seen.back = now; },
  },
});
const words = (w) => ({ en: w, es: w, ja: w });
kit.registerActions({
  save: { who: "Probe", autoClose: true,
    words: { en: { working: "Saving", success: "Saved", failure: "Could not save" },
             es: { working: "Guardando", success: "Guardado", failure: "No se pudo guardar" },
             ja: { working: "保存中", success: "保存しました", failure: "保存できませんでした" } } },
  send: { who: "Probe", words: words({ working: "Sending", success: "Sent", failure: "Could not send" }) },
  quick: { who: "Probe", inline: true, autoClose: true, words: words({ working: "Checking", success: "Fine", failure: "Not fine" }) },
  restart: { who: "Probe", mode: "reconnect",
    words: words({ working: "Restarting", working_body: "Waiting for it to come back…",
      success: "Back", success_body: "Running {v}.", failure: "Not back yet", failure_body: "It has not come back." }) },
});
window.kit = kit;
window.go = (name, opts = {}) => {
  const b = document.getElementById("go");
  window.out = undefined;
  kit.busyAction(name, async (headers, progress) => {
    for (const line of window.steps || []) progress(line);
    const r = await fetch("/probe", { method: "POST", headers }).catch(() => {
      throw { network: true };
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { status: r.status, body: j };
    return j;
  }, { button: b, ...opts }).then(
    (d) => { window.out = { ok: d }; },
    (e) => { window.out = { err: e }; });
};
window.ready = true;
</script></body></html>`;

interface Probe {
  ids: string[];
  status: string[];
  infoPid: number;
  /** How many /info asks to leave unanswered (a request that hangs). */
  infoHang: number;
}

/** plan: each /probe answer in turn, [delay ms, status | "drop", body?]; a delay of 60 s or more never answers. */
async function open(
  plan: [number, number | "drop", unknown?][],
  o: {
    width?: number;
    lang?: string;
    clock?: boolean;
    statusAnswer?: unknown;
  } = {},
): Promise<{ p: Page; probe: Probe }> {
  const ctx = await browser!.newContext({
    viewport: { width: o.width ?? 1280, height: 800 },
    reducedMotion: "reduce",
  });
  const p = await ctx.newPage();
  if (o.clock) await p.clock.install();
  const probe: Probe = { ids: [], status: [], infoPid: 100, infoHang: 0 };
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: PAGE(o.lang ?? "en"),
      });
    if (u.pathname === "/busy.css")
      return r.fulfill({
        contentType: "text/css",
        body: fs.readFileSync(path.join(SRC, "busy.css"), "utf-8"),
      });
    if (u.pathname === "/busy.js" || u.pathname === "/busy-words.js")
      return r.fulfill({
        contentType: "text/javascript",
        body: fs.readFileSync(path.join(SRC, u.pathname.slice(1)), "utf-8"),
      });
    if (u.pathname === "/tokens.css")
      return r.fulfill({
        contentType: "text/css",
        body: fs.readFileSync(path.join(SRC, "tokens.css"), "utf-8"),
      });
    if (u.pathname === "/info") {
      if (probe.infoHang > 0) {
        probe.infoHang -= 1;
        return;
      }
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ pid: probe.infoPid, version: "9.9.9" }),
      });
    }
    if (u.pathname.startsWith("/status/")) {
      probe.status.push(u.pathname.slice("/status/".length));
      return r.fulfill({
        contentType: "application/json",
        body: JSON.stringify(o.statusAnswer ?? { state: "unknown" }),
      });
    }
    if (u.pathname === "/probe") {
      probe.ids.push(r.request().headers()["x-probe-id"] ?? "");
      const [ms, status, body] =
        plan[Math.min(probe.ids.length - 1, plan.length - 1)]!;
      // A wait past a minute never answers (the page's clock is faked).
      if (ms >= 60_000) return;
      if (ms) await new Promise((res) => setTimeout(res, ms));
      if (status === "drop") return r.abort("connectionreset");
      return r.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(
          body ??
            (status < 400 ? { ok: true } : { error: { message: "it broke" } }),
        ),
      });
    }
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto(`${ORIGIN}/`);
  await p.waitForFunction(() => (window as { ready?: boolean }).ready === true);
  return { p, probe };
}

const dlg = (p: Page) => p.locator("den-busy dialog");
const out = (p: Page) =>
  p
    .waitForFunction(() => (window as { out?: unknown }).out !== undefined)
    .then(() => p.evaluate(() => (window as { out?: unknown }).out));
const seen = (p: Page) =>
  p.evaluate(
    () =>
      (window as unknown as { seen: Record<string, unknown> }).seen as {
        toasts: string[];
        opened: string[];
        reports: { details: string; requestId: string }[];
        reloads: number;
      },
  );
const go = (p: Page, name: string, opts = "{}") =>
  p.evaluate(`window.go(${JSON.stringify(name)}, ${opts})`);

describe("UK-2 kit: the working pop-up", () => {
  it("a fast success opens nothing; an auto-close action says so in a toast", async () => {
    if (skip()) return;
    const { p } = await open([[0, 200]]);
    await go(p, "save");
    expect(await out(p)).toEqual({ ok: { ok: true } });
    expect(await dlg(p).count()).toBe(0);
    expect((await seen(p)).toasts).toEqual(["Saved"]);
    expect(await p.locator("#go").isDisabled()).toBe(false);
    await p.context().close();
  });

  it("a slow action opens at 300 ms, holds the button, has no buttons and ignores Esc while working", async () => {
    if (skip()) return;
    const { p } = await open([[1500, 200]]);
    await go(p, "save");
    expect(await p.locator("#go").isDisabled()).toBe(true);
    await p.waitForTimeout(150);
    expect(await dlg(p).count()).toBe(0);
    await dlg(p).waitFor({ state: "visible", timeout: 1000 });
    await expect(dlg(p).locator("h2").textContent()).resolves.toContain(
      "Saving",
    );
    expect(await dlg(p).locator("button").count()).toBe(0);
    expect(await dlg(p).locator(".bz-live").textContent()).toBe(
      "Waiting for Probe…",
    );
    await p.keyboard.press("Escape");
    expect(await dlg(p).isVisible()).toBe(true);
    // Success (Ward, UK-2): it closes at once and says so in the toast,
    // as for a fast action; never a Done to click.
    expect(await out(p)).toEqual({ ok: { ok: true } });
    expect(await dlg(p).count()).toBe(0);
    expect((await seen(p)).toasts).toEqual(["Saved"]);
    await p.context().close();
  });

  it("an error answer: Failure, Details without method or URL; Try again sends a new id", async () => {
    if (skip()) return;
    const { p, probe } = await open([
      [400, 500],
      [0, 200],
    ]);
    await go(p, "send");
    await dlg(p).locator("h2", { hasText: "Could not send" }).waitFor();
    const body = (await dlg(p).textContent()) ?? "";
    expect(body).toContain("Probe answered with an error (500).");
    expect(body).toContain("it broke");
    const details = (await dlg(p).locator("pre").textContent()) ?? "";
    expect(details).toContain(`request ${probe.ids[0]}`);
    expect(details).not.toMatch(/POST|\/probe|kit\.test/);
    await dlg(p).locator('[data-bz="report"]').click();
    expect((await seen(p)).reports[0]!.requestId).toBe(probe.ids[0]);
    await dlg(p).locator('[data-bz="retry"]').click();
    // Success after Try again: closes itself, the toast says so.
    expect(await out(p)).toEqual({ ok: { ok: true } });
    expect(await dlg(p).count()).toBe(0);
    expect((await seen(p)).toasts).toEqual(["Sent"]);
    expect(probe.ids).toHaveLength(2);
    expect(probe.ids[1]).not.toBe(probe.ids[0]);
    await p.context().close();
  });

  it("no answer (the connection dropped): Try again sends the same id", async () => {
    if (skip()) return;
    const { p, probe } = await open([
      [400, "drop"],
      [0, 200],
    ]);
    await go(p, "send");
    await dlg(p).locator("h2", { hasText: "Could not send" }).waitFor();
    expect(await dlg(p).textContent()).toContain("Couldn't reach Probe.");
    await dlg(p).locator('[data-bz="retry"]').click();
    await out(p);
    expect(await dlg(p).count()).toBe(0);
    expect(probe.ids).toHaveLength(2);
    expect(probe.ids[1]).toBe(probe.ids[0]);
    await p.context().close();
  });

  for (const [st, says] of [
    [{ state: "running" }, "Still running."],
    [{ state: "unknown" }, "Probe has no record of this request any more."],
  ] as const) {
    it(`60 s with no answer, then Check again: ${st.state} (never resends)`, async () => {
      if (skip()) return;
      const { p, probe } = await open([[120_000, 200]], {
        clock: true,
        statusAnswer: st,
      });
      await go(p, "send");
      await p.clock.runFor(61_000);
      await dlg(p)
        .locator("h2", { hasText: "No answer from Probe yet." })
        .waitFor();
      await dlg(p).locator('[data-bz="check"]').click();
      await dlg(p).locator("p", { hasText: says }).waitFor();
      expect(probe.status).toEqual([probe.ids[0]]);
      expect(probe.ids).toHaveLength(1);
      await p.context().close();
    });
  }

  it("Check again: done closes and says Success in the toast, from the record", async () => {
    if (skip()) return;
    const { p, probe } = await open([[120_000, 200]], {
      clock: true,
      statusAnswer: { state: "done", result: { ok: "late" } },
    });
    await go(p, "send");
    await p.clock.runFor(61_000);
    await dlg(p).locator('[data-bz="check"]').click();
    expect(await out(p)).toEqual({ ok: { ok: "late" } });
    expect(await dlg(p).count()).toBe(0);
    expect((await seen(p)).toasts).toEqual(["Sent"]);
    expect(probe.ids).toHaveLength(1);
    await p.context().close();
  });

  it("a held answer closes with no success line and opens the held page", async () => {
    if (skip()) return;
    const { p } = await open([
      [400, 200, { held: { id: "h1", url: "/held/h1" } }],
    ]);
    await go(p, "send");
    const o = (await out(p)) as { ok: { held: { url: string } } };
    expect(o.ok.held.url).toBe("/held/h1");
    expect(await dlg(p).count()).toBe(0);
    const s = await seen(p);
    expect(s.opened).toEqual(["/held/h1"]);
    expect(s.toasts).toEqual([]);
    await p.context().close();
  });

  it("quietFail: a fast refusal goes back to the caller, with no pop-up", async () => {
    if (skip()) return;
    const { p } = await open([[0, 409]]);
    await go(p, "send", "{ quietFail: true }");
    const o = (await out(p)) as { err: { status: number } };
    expect(o.err.status).toBe(409);
    expect(await dlg(p).count()).toBe(0);
    expect(await p.locator("#go").isDisabled()).toBe(false);
    await p.context().close();
  });

  it("inlineError: a fast network error goes back to the caller; a refusal still opens Failure", async () => {
    if (skip()) return;
    const a = await open([[0, "drop"]]);
    await go(a.p, "send", "{ inlineError: true }");
    expect(
      ((await out(a.p)) as { err: { network: boolean } }).err.network,
    ).toBe(true);
    expect(await dlg(a.p).count()).toBe(0);
    await a.p.context().close();
    const b = await open([[0, 500]]);
    await go(b.p, "send", "{ inlineError: true }");
    await dlg(b.p).locator("h2", { hasText: "Could not send" }).waitFor();
    await b.p.context().close();
  });

  it("an inline action gives back both kinds of fast failure", async () => {
    if (skip()) return;
    const { p } = await open([[0, 422]]);
    await go(p, "quick");
    expect(((await out(p)) as { err: { status: number } }).err.status).toBe(
      422,
    );
    expect(await dlg(p).count()).toBe(0);
    await p.context().close();
  });

  it("skipDone closes quietly; extra puts a node under the success line and waits for Close (never Done)", async () => {
    if (skip()) return;
    const a = await open([[400, 200]]);
    await go(a.p, "send", "{ skipDone: () => true }");
    await out(a.p);
    expect(await dlg(a.p).count()).toBe(0);
    await a.p.context().close();
    const b = await open([[0, 200]]);
    await go(
      b.p,
      "save",
      `{ extra: () => { const s = document.createElement("span"); s.id = "x"; s.textContent = "more"; return s; } }`,
    );
    await dlg(b.p).locator("#x").waitFor();
    await b.p.waitForTimeout(1500);
    expect(await dlg(b.p).isVisible()).toBe(true);
    expect(await dlg(b.p).locator('[data-bz="done"]').count()).toBe(0);
    await dlg(b.p).locator('[data-bz="close"]').click();
    await out(b.p);
    await b.p.context().close();
  });

  it("reconnect: waits for a new pid, says the version, then reloads", async () => {
    if (skip()) return;
    const { p, probe } = await open([[0, 202]]);
    await go(p, "restart");
    await dlg(p).locator("h2", { hasText: "Restarting" }).waitFor();
    expect(await dlg(p).locator(".bz-live").textContent()).toBe(
      "Waiting for it to come back…",
    );
    await p.waitForTimeout(1500);
    expect(await dlg(p).locator("h2").textContent()).toContain("Restarting");
    probe.infoPid = 200;
    await dlg(p).locator("h2", { hasText: "Back" }).waitFor({ timeout: 5000 });
    expect(await dlg(p).textContent()).toContain("Running 9.9.9.");
    await p.waitForFunction(
      () =>
        (window as unknown as { seen: { reloads: number } }).seen.reloads === 1,
    );
    expect(await out(p)).toEqual({ ok: { pid: 200, version: "9.9.9" } });
    await p.context().close();
  });

  it("reconnect: no answer to the request is the product going down; it waits, from the given before", async () => {
    if (skip()) return;
    const { p, probe } = await open([[0, "drop"]]);
    probe.infoPid = 300;
    // before: pid 300 is the old run, so the answer it has now is not back.
    await go(p, "restart", "{ before: { pid: 300 } }");
    await dlg(p).locator("h2", { hasText: "Restarting" }).waitFor();
    await p.waitForTimeout(1500);
    expect(await dlg(p).locator("h2").textContent()).toContain("Restarting");
    probe.infoPid = 301;
    await dlg(p).locator("h2", { hasText: "Back" }).waitFor({ timeout: 5000 });
    expect(await out(p)).toEqual({ ok: { pid: 301, version: "9.9.9" } });
    await p.context().close();
  });

  // A request in flight as the product goes down (or one a proxy holds) may
  // never be answered. Each ask has its own time limit, so the next one
  // still comes: one stuck ask must not stall the wait for good.
  it("reconnect: an ask that is never answered gives way to the next one", async () => {
    if (skip()) return;
    const { p, probe } = await open([[0, 202]]);
    probe.infoPid = 400;
    probe.infoHang = 1;
    await go(p, "restart", "{ before: { pid: 399 } }");
    await dlg(p)
      .locator("h2", { hasText: "Back" })
      .waitFor({ timeout: 10_000 });
    expect(await out(p)).toEqual({ ok: { pid: 400, version: "9.9.9" } });
    await p.context().close();
  });

  it("reconnect: an unanswered ask for before still sends the request", async () => {
    if (skip()) return;
    const { p, probe } = await open([[0, 202]]);
    probe.infoHang = 1;
    await go(p, "restart");
    const until = Date.now() + 10_000;
    while (probe.ids.length === 0 && Date.now() < until)
      await p.waitForTimeout(100);
    expect(probe.ids.length).toBe(1);
    await p.context().close();
  });

  it("reconnect: waitMs sets how long before Not back yet", async () => {
    if (skip()) return;
    const { p } = await open([[0, 202]], { clock: true });
    await p.evaluate(() => ((window as { waitMs?: number }).waitMs = 90_000));
    await go(p, "restart");
    // The kit reads "before" over the network first; move the faked clock
    // only once it waits (else the wait starts after the clock moved).
    await dlg(p).locator("h2", { hasText: "Restarting" }).waitFor();
    await p.clock.runFor(70_000);
    expect(await dlg(p).locator("h2").textContent()).toContain("Restarting");
    await p.clock.runFor(25_000);
    await dlg(p).locator("h2", { hasText: "Not back yet" }).waitFor();
    await p.context().close();
  });

  it("reconnect: not back after 60 s offers Report · Close · Open the log · Check again", async () => {
    if (skip()) return;
    const { p } = await open([[0, 202]], { clock: true });
    await go(p, "restart");
    await dlg(p).locator("h2", { hasText: "Restarting" }).waitFor();
    await p.clock.runFor(70_000);
    await dlg(p).locator("h2", { hasText: "Not back yet" }).waitFor();
    const keys = await dlg(p)
      .locator(".bz-ft button")
      .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.bz));
    expect(keys).toEqual(["report", "close", "log", "check"]);
    await dlg(p).locator('[data-bz="log"]').click();
    expect((await seen(p)).opened).toEqual(["/the-log"]);
    await p.context().close();
  });

  it("its look is busy.css, linked once: no <style> of its own (a strict CSP holds)", async () => {
    if (skip()) return;
    const { p } = await open([[400, 500]]);
    await go(p, "send");
    await dlg(p).locator('[data-bz="retry"]').waitFor();
    const css = await p.evaluate(() => ({
      styles: document.querySelectorAll("style").length,
      links: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map((l) => new URL((l as HTMLLinkElement).href).pathname)
        .filter((h) => h.endsWith("busy.css")),
      radius: getComputedStyle(document.querySelector(".bz-btn")!)
        .borderTopLeftRadius,
    }));
    expect(css.styles).toBe(0);
    expect(css.links).toEqual(["/busy.css"]);
    expect(css.radius).not.toBe("0px");
    await go(p, "send");
    expect(
      await p.evaluate(
        () =>
          [...document.querySelectorAll('link[rel="stylesheet"]')].filter((l) =>
            (l as HTMLLinkElement).href.endsWith("busy.css"),
          ).length,
      ),
    ).toBe(1);
    await p.context().close();
  });

  it("next: a failure with a next step offers its link in place of Try again", async () => {
    if (skip()) return;
    const { p } = await open([[400, 500]]);
    await go(
      p,
      "send",
      '{ next: { label: "Open Settings", href: "/settings" } }',
    );
    await dlg(p).locator("h2", { hasText: "Could not send" }).waitFor();
    expect(await dlg(p).locator('[data-bz="retry"]').count()).toBe(0);
    const link = dlg(p).locator("a.bz-btn.bz-primary");
    expect(await link.textContent()).toBe("Open Settings");
    expect(await link.getAttribute("href")).toBe("/settings");
    expect(await dlg(p).locator(".bz-next").textContent()).toBe(
      "Trying again won't help. Do this first:",
    );
    // Report and Close stay; the link is last, the primary.
    const order = await dlg(p)
      .locator(".bz-ft > *")
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLElement).dataset.bz ?? e.tagName),
      );
    expect(order).toEqual(["report", "close", "A"]);
    await p.context().close();
  });

  it("next: from the failure itself; none means Try again as before", async () => {
    if (skip()) return;
    const { p } = await open([
      [400, 403],
      [400, 500],
    ]);
    const opts =
      '{ next: (e) => e.status === 403 ? { label: "Sign in", href: "/sign-in" } : null }';
    await go(p, "send", opts);
    await dlg(p).locator('a[href="/sign-in"]').waitFor();
    expect(await dlg(p).locator('[data-bz="retry"]').count()).toBe(0);
    await dlg(p).locator('[data-bz="close"]').click();
    await go(p, "send", opts);
    await dlg(p).locator('[data-bz="retry"]').waitFor();
    expect(await dlg(p).locator(".bz-next").count()).toBe(0);
    await p.context().close();
  });

  it("next with no href: its words in place of Try again, and Close is the primary", async () => {
    if (skip()) return;
    const { p } = await open([[400, 500]]);
    await go(
      p,
      "send",
      '{ next: { label: "Ask the person who set up this project." } }',
    );
    await dlg(p).locator("h2", { hasText: "Could not send" }).waitFor();
    expect(await dlg(p).locator('[data-bz="retry"]').count()).toBe(0);
    expect(await dlg(p).locator("a").count()).toBe(0);
    expect(await dlg(p).locator(".bz-step").textContent()).toBe(
      "Ask the person who set up this project.",
    );
    expect(await dlg(p).locator(".bz-next").textContent()).toBe(
      "Trying again won't help. Do this first:",
    );
    const close = dlg(p).locator('[data-bz="close"]');
    expect(await close.getAttribute("class")).toContain("bz-primary");
    await close.click();
    expect(await out(p)).toEqual({ ok: null });
    await p.context().close();
  });

  it("progress: run's progress(text) lines show in order while working, then success closes with the toast", async () => {
    if (skip()) return;
    const { p } = await open([[1500, 200]]);
    await p.evaluate(() => {
      (window as unknown as { steps: string[] }).steps = [
        "Copying files",
        "Starting the service",
      ];
    });
    await go(p, "save");
    await dlg(p).waitFor({ state: "visible", timeout: 1000 });
    const list = dlg(p).locator("ol.bz-prog");
    expect(await list.getAttribute("aria-label")).toBe("Progress");
    expect(await list.locator("li").allTextContents()).toEqual([
      "Copying files",
      "Starting the service",
    ]);
    expect(await out(p)).toEqual({ ok: { ok: true } });
    expect(await dlg(p).count()).toBe(0);
    expect((await seen(p)).toasts).toEqual(["Saved"]);
    await p.context().close();
  });

  it("progress and next speak the page's language (es, ja)", async () => {
    if (skip()) return;
    for (const [lang, said, prog] of [
      ["es", "Intentar de nuevo no servirá. Haz esto primero:", "Progreso"],
      ["ja", "もう一度試しても解決しません。先にこちらを:", "進行状況"],
    ]) {
      const { p } = await open([[1200, 500]], { lang });
      await p.evaluate(() => {
        (window as unknown as { steps: string[] }).steps = ["…"];
      });
      await go(p, "send", '{ next: { label: "X", href: "/x" } }');
      await dlg(p).locator("ol.bz-prog").waitFor();
      expect(
        await dlg(p).locator("ol.bz-prog").getAttribute("aria-label"),
      ).toBe(prog);
      await dlg(p).locator(".bz-next").waitFor();
      expect(await dlg(p).locator(".bz-next").textContent()).toBe(said);
      await p.context().close();
    }
  });

  it("speaks the page's language (ja)", async () => {
    if (skip()) return;
    const { p } = await open([[400, 500]], { lang: "ja" });
    await go(p, "save");
    await dlg(p).locator("h2", { hasText: "保存できませんでした" }).waitFor();
    expect(await dlg(p).locator('[data-bz="retry"]').textContent()).toBe(
      "もう一度試す",
    );
    await p.context().close();
  });

  it("at 390 px the primary is alone on its row and every button is at least --tap tall", async () => {
    if (skip()) return;
    const { p } = await open([[400, 500]], { width: 390 });
    await go(p, "send");
    await dlg(p).locator('[data-bz="retry"]').waitFor();
    const boxes = await dlg(p)
      .locator(".bz-ft button")
      .evaluateAll((bs) =>
        bs.map((b) => {
          const r = b.getBoundingClientRect();
          return { k: (b as HTMLElement).dataset.bz, y: r.top, h: r.height };
        }),
      );
    const tap = await p.evaluate(() =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--tap"),
      ),
    );
    expect(tap).toBeGreaterThanOrEqual(36);
    for (const b of boxes) expect(b.h).toBeGreaterThanOrEqual(tap - 0.5);
    const primary = boxes.find((b) => b.k === "retry")!;
    for (const b of boxes.filter((x) => x.k !== "retry"))
      expect(b.y).not.toBe(primary.y);
    await p.context().close();
  });
});
