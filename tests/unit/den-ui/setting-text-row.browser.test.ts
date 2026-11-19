/**
 * den-ui, issue 584: the settings row's text-field variant, in a browser,
 * on a bare page built from the kit's own files (Chromium, headless; the
 * page's clock is faked):
 *
 *   - Save is disabled until the value changes, then enabled; typing it
 *     back disables it again. A form row (drawn enabled, for no script) is
 *     disabled once wired.
 *   - Save calls the host's onSave with the value; "Saving…" past 400 ms
 *     (savestate.js's SAVING_AFTER_MS), then "Saved", and the field shows
 *     the saved value (what onSave resolved with, if text); Save is
 *     disabled again.
 *   - With `action` (a working pop-up action the host registered), Save
 *     runs through the kit's working pop-up: it opens past 300 ms, Save is
 *     held, and it closes when the save is done; focus is on the field.
 *   - A failed save: the error line under the input says the host's words
 *     (the rejection's fieldError) or the kit's; the input is invalid;
 *     Save stays enabled to try again.
 *
 * DEN_SKIP_BROWSER_TESTS=1 skips it.
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
  await closeBrowserSuite({ browsers: [browser] });
});

const skip = () => !browser;

function pageHtml(lang: string): string {
  const css = ["tokens", "base", "button", "savestate", "busy", "setting-row"]
    .map((n) => `<link rel="stylesheet" href="/${n}.css">`)
    .join("");
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${css}</head>
<body><main><section id="one"></section><section id="many"></section>
<section id="pop"></section><section id="posts"></section></main>
<script type="module">
import { mountSettingField, settingFieldHtml, hydrateSettingField } from "/setting-row.js";
import { registerActions, configureBusy } from "/busy.js";
configureBusy({ lang: () => "${lang}", toast: () => {} });
registerActions({
  "folders.save": { who: "Acme", words: { en: { working: "Saving folders", success: "Saved", failure: "Not saved" } } },
});
window.saves = [];
window.plan = { ms: 10, ok: true, answer: undefined, fieldError: undefined };
const onSave = (value, headers) => {
  saves.push({ value, id: headers ? Object.keys(headers).length : 0 });
  const p = window.plan;
  return new Promise((res, rej) => setTimeout(() => {
    if (p.ok) return res(p.answer);
    const e = new Error("down");
    if (p.fieldError) e.fieldError = p.fieldError;
    rej(e);
  }, p.ms));
};
window.one = mountSettingField(document.getElementById("one"), {
  id: "host", lang: "${lang}", label: "Host name", value: "web", onSave,
});
window.many = mountSettingField(document.getElementById("many"), {
  id: "folders", lang: "${lang}", label: "Folders", multiline: true,
  value: "notes\\ndrafts", help: "One per line.", onSave,
});
window.pop = mountSettingField(document.getElementById("pop"), {
  id: "popped", lang: "${lang}", label: "Folders", value: "a",
  action: "folders.save", onSave,
});
const posts = document.getElementById("posts");
posts.innerHTML = settingFieldHtml({
  id: "posted", lang: "${lang}", label: "Name", value: "x",
  form: { action: "/s", csrf: "t" },
});
window.posted = hydrateSettingField(posts.firstElementChild, { onSave });
window.ready = true;
</script></body></html>`;
}

async function open(lang = "en"): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
    timezoneId: "UTC",
    locale: lang,
  });
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date("2026-11-18T10:42:00Z") });
  await p.clock.pauseAt(new Date("2026-11-18T10:42:00Z"));
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: pageHtml(lang) });
    const f = u.pathname.slice(1);
    if (/^[a-z0-9-]+\.(js|css)$/.test(f) && fs.existsSync(path.join(SRC, f)))
      return r.fulfill({
        contentType: f.endsWith(".css") ? "text/css" : "text/javascript",
        body: fs.readFileSync(path.join(SRC, f)),
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
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

const state = (p: Page, id: string) =>
  p.evaluate((id) => {
    const s = document.getElementById(`${id}-state`)!;
    return `${s.getAttribute("data-state")}|${s.textContent}`;
  }, id);
const saves = (p: Page) =>
  p.evaluate(() => (window as unknown as { saves: unknown[] }).saves);
const plan = (p: Page, o: object) =>
  p.evaluate((o) => {
    Object.assign((window as unknown as { plan: object }).plan, o);
  }, o);
const saveOf = (id: string) => `#${id} [data-den-setfield-save]`;

describe("the settings field row (setting-row.js)", () => {
  it("Save is disabled until the value changes, then enabled; the same value again disables it", async () => {
    if (skip()) return;
    const p = await open();
    expect(await p.isDisabled(saveOf("host"))).toBe(true);
    expect(await p.isDisabled(saveOf("folders"))).toBe(true);
    await p.fill("#host-in", "web2");
    expect(await p.isDisabled(saveOf("host"))).toBe(false);
    await p.fill("#host-in", "web");
    expect(await p.isDisabled(saveOf("host"))).toBe(true);
    // The textarea's value is the data's, its newlines kept.
    expect(await p.inputValue("#folders-in")).toBe("notes\ndrafts");
    await p.fill("#folders-in", "notes\ndrafts\nsongs");
    expect(await p.isDisabled(saveOf("folders"))).toBe(false);
    // A form row is drawn enabled (it posts with no script); wired, it waits too.
    expect(await p.isDisabled(saveOf("posted"))).toBe(true);
    await p.fill("#posted-in", "y");
    expect(await p.isDisabled(saveOf("posted"))).toBe(false);
    await p.context().close();
  });

  it("Save calls onSave with the value; Saving… past 400 ms; Saved; the saved value shows; Save waits again", async () => {
    if (skip()) return;
    const p = await open();
    await plan(p, { ms: 1000, answer: "notes\ndrafts\nsongs" });
    await p.fill("#folders-in", "notes\ndrafts\nsongs\n");
    await p.click(saveOf("folders"));
    expect(await saves(p)).toEqual([
      { value: "notes\ndrafts\nsongs\n", id: 0 },
    ]);
    await p.clock.runFor(390);
    expect(await state(p, "folders")).toBe("idle|");
    await p.clock.runFor(20);
    expect(await state(p, "folders")).toBe("saving|Saving…");
    // A second press while it saves does nothing.
    await p.click(saveOf("folders"), { force: true });
    expect((await saves(p)).length).toBe(1);
    await p.clock.runFor(700);
    expect(await state(p, "folders")).toBe("saved|Saved");
    expect(await p.inputValue("#folders-in")).toBe("notes\ndrafts\nsongs");
    expect(await p.isDisabled(saveOf("folders"))).toBe(true);
    expect(await p.evaluate(() => document.activeElement!.id)).toBe(
      "folders-in",
    );
    // A change after Saved clears it, and Save is back.
    await p.fill("#folders-in", "x");
    expect(await state(p, "folders")).toBe("idle|");
    expect(await p.isDisabled(saveOf("folders"))).toBe(false);
    await p.context().close();
  });

  it("with action: Save runs through the working pop-up, which closes when it saved", async () => {
    if (skip()) return;
    const p = await open();
    await plan(p, { ms: 1500 });
    await p.fill("#popped-in", "b");
    await p.click(saveOf("popped"));
    // busy.js loads on first use: a few turns of the page's loop.
    for (let i = 0; i < 50 && !(await saves(p)).length; i++)
      await p.evaluate(() => new Promise((r) => setTimeout(r, 0)));
    // The request id rides in the headers the pop-up gives.
    expect(await saves(p)).toEqual([{ value: "b", id: 1 }]);
    expect(await p.isDisabled(saveOf("popped"))).toBe(true);
    expect(await p.locator("den-busy dialog[open]").count()).toBe(0);
    await p.clock.runFor(320);
    expect(await p.locator("den-busy dialog[open]").count()).toBe(1);
    expect(await p.textContent("den-busy #bz-h")).toBe("Saving folders");
    await p.clock.runFor(1500);
    expect(await p.locator("den-busy").count()).toBe(0);
    expect(await state(p, "popped")).toBe("saved|Saved");
    expect(await p.isDisabled(saveOf("popped"))).toBe(true);
    // Save waits again, so focus is on the field, not lost.
    expect(await p.evaluate(() => document.activeElement!.id)).toBe(
      "popped-in",
    );
    await p.context().close();
  });

  it("a failed save: the error line under the input, the input invalid, Save still there", async () => {
    if (skip()) return;
    const p = await open("es");
    await plan(p, { ms: 10, ok: false, fieldError: "Esa carpeta no existe." });
    await p.fill("#host-in", "nope");
    await p.click(saveOf("host"));
    await p.clock.runFor(20);
    expect(await p.textContent("#host-err")).toBe("Esa carpeta no existe.");
    expect(await p.getAttribute("#host-in", "aria-invalid")).toBe("true");
    expect(await state(p, "host")).toBe("idle|");
    expect(await p.isDisabled(saveOf("host"))).toBe(false);
    // No words of the host's: the kit's own, in the page's language.
    await plan(p, { fieldError: undefined });
    await p.click(saveOf("host"));
    await p.clock.runFor(20);
    expect(await p.textContent("#host-err")).toBe(
      "No se guardó. Inténtalo de nuevo.",
    );
    // A save that works clears it.
    await plan(p, { ok: true });
    await p.click(saveOf("host"));
    await p.clock.runFor(20);
    expect(await p.textContent("#host-err")).toBe("");
    expect(await p.getAttribute("#host-in", "aria-invalid")).toBe(null);
    expect(await state(p, "host")).toBe("saved|Guardado");
    await p.context().close();
  });
});
