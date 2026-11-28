import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import { RETRY_MS } from "../../../packages/den-ui/src/savestate.js";

const SRC = path.join(__dirname, "../../../packages/den-ui/src");
const ORIGIN = "http://kit.test";
let browser: Browser | null = null;

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await launchBrowser(chromium);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: [browser] });
});

const skip = () => !browser;

const PAGE = `<!doctype html><html lang="en"><head>
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/button.css"><link rel="stylesheet" href="/savestate.css">
<link rel="stylesheet" href="/checks.css">
<style>body { margin: 16px; background: var(--bg); }</style></head>
<body><div id="host"></div><div id="ro"></div>
<script type="module">
import { mountChecks } from "/checks.js";
window.calls = [];
window.mode = "ok";
window.acted = 0;
const held = [];
window.release = () => held.splice(0).forEach((r) => r());
window.list = mountChecks(document.getElementById("host"), {
  id: "jobs",
  legend: "Who",
  items: [
    { value: "a", label: "Alpha", help: "First one." },
    { value: "b", label: "Beta", help: "Second one." },
    { value: "c", label: "Gamma", help: "Third one." },
  ],
  checked: ["b"],
  empty: "Nobody.",
  onSave(values) {
    window.calls.push(values);
    if (window.mode === "hold") return new Promise((r) => held.push(r));
    if (window.mode === "network") return Promise.reject({ network: true });
    if (window.mode === "refuse") return Promise.reject(new Error("Refused here."));
    return Promise.resolve();
  },
});
mountChecks(document.getElementById("ro"), {
  id: "ro",
  legend: "Read only",
  items: [{ value: "x", label: "Ex" }],
  disabled: true,
  note: "Unreadable.",
  noteAction: { label: "Again", onClick: () => { window.acted += 1; } },
});
window.ready = true;
</script></body></html>`;

async function open(width = 1280, touch = false): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width, height: 800 },
    hasTouch: touch,
    isMobile: touch,
  });
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date("2026-11-27T10:00:00Z") });
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({ contentType: "text/html", body: PAGE });
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
    .waitForFunction(() => (window as { ready?: boolean }).ready === true)
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

const calls = (p: Page) =>
  p.evaluate(() => (window as unknown as { calls: string[][] }).calls);
const ticked = (p: Page) =>
  p.evaluate(() =>
    [...document.querySelectorAll<HTMLInputElement>("#host input")]
      .filter((b) => b.checked)
      .map((b) => b.value),
  );
const setMode = (p: Page, m: string) =>
  p.evaluate((v) => ((window as unknown as { mode: string }).mode = v), m);
const state = (p: Page) =>
  p.locator("#host").getByRole("status").getAttribute("data-state");
const settle = (p: Page) => p.clock.runFor(1);

describe("the checkbox list in a browser", () => {
  it("is a named group of named, described boxes", async () => {
    if (skip()) return;
    const p = await open();
    await expect(p.getByRole("group", { name: "Who" }).count()).resolves.toBe(
      1,
    );
    for (const [name, help] of [
      ["Alpha", "First one."],
      ["Beta", "Second one."],
      ["Gamma", "Third one."],
    ]) {
      const box = p.getByRole("checkbox", { name, exact: true });
      await expect(box.count()).resolves.toBe(1);
      const desc = await box.evaluate((b) =>
        (b.getAttribute("aria-describedby") || "")
          .split(" ")
          .map((id) => document.getElementById(id)?.textContent)
          .join(" "),
      );
      expect(desc).toBe(help);
    }
    await p.context().close();
  });

  it("Tab moves box to box, Space ticks, and each tick saves the ticked values", async () => {
    if (skip()) return;
    const p = await open();
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLInputElement).value,
      ),
    ).toBe("a");
    await p.keyboard.press("Space");
    await settle(p);
    await p.keyboard.press("Tab");
    expect(
      await p.evaluate(
        () => (document.activeElement as HTMLInputElement).value,
      ),
    ).toBe("b");
    await p.keyboard.press("Space");
    await settle(p);
    expect(await calls(p)).toEqual([["a", "b"], ["a"]]);
    expect(await ticked(p)).toEqual(["a"]);
    expect(await state(p)).toBe("saved");
    await p.context().close();
  });

  it("a click anywhere on a row ticks its box", async () => {
    if (skip()) return;
    const p = await open();
    await p.getByText("Third one.").click();
    await settle(p);
    expect(await ticked(p)).toEqual(["b", "c"]);
    expect(await calls(p)).toEqual([["b", "c"]]);
    await p.context().close();
  });

  it("saves one at a time, sending only the newest list after a save ends", async () => {
    if (skip()) return;
    const p = await open();
    await setMode(p, "hold");
    const box = (v: string) => p.locator(`#host input[value="${v}"]`);
    await box("a").click();
    await settle(p);
    await box("c").click();
    await box("b").click();
    await settle(p);
    expect(await calls(p)).toEqual([["a", "b"]]);
    await setMode(p, "ok");
    await p.evaluate(() =>
      (window as unknown as { release(): void }).release(),
    );
    await settle(p);
    expect(await calls(p)).toEqual([
      ["a", "b"],
      ["a", "c"],
    ]);
    expect(await state(p)).toBe("saved");
    await p.context().close();
  });

  it("a network failure keeps the tick and retries on the back-off", async () => {
    if (skip()) return;
    const p = await open();
    await setMode(p, "network");
    await p.locator('#host input[value="a"]').click();
    await settle(p);
    expect(await ticked(p)).toEqual(["a", "b"]);
    expect(await state(p)).toBe("error");
    await setMode(p, "ok");
    await p.clock.runFor(RETRY_MS[0] - 50);
    expect(await calls(p)).toHaveLength(1);
    await p.clock.runFor(100);
    await settle(p);
    expect(await calls(p)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(await state(p)).toBe("saved");
    await p.context().close();
  });

  it("a refusal puts the boxes back as last saved and shows its message", async () => {
    if (skip()) return;
    const p = await open();
    await p.locator('#host input[value="a"]').click();
    await settle(p);
    await setMode(p, "refuse");
    await p.locator('#host input[value="c"]').click();
    await settle(p);
    expect(await ticked(p)).toEqual(["a", "b"]);
    expect(await state(p)).toBe("error");
    expect(
      await p.locator("#host").getByRole("status").textContent(),
    ).toContain("Refused here.");
    await p.clock.runFor(RETRY_MS[RETRY_MS.length - 1] * 2);
    expect(await calls(p)).toHaveLength(2);
    await p.context().close();
  });

  it("shows the host's empty line only while nothing is ticked", async () => {
    if (skip()) return;
    const p = await open();
    const note = p.locator("#host").getByText("Nobody.");
    await expect(note.isVisible()).resolves.toBe(false);
    await p.locator('#host input[value="b"]').click();
    await settle(p);
    expect(await calls(p)).toEqual([[]]);
    await expect(note.isVisible()).resolves.toBe(true);
    await p.locator('#host input[value="a"]').click();
    await settle(p);
    await expect(note.isVisible()).resolves.toBe(false);
    await p.context().close();
  });

  it("a disabled list keeps its note's button live", async () => {
    if (skip()) return;
    const p = await open();
    await expect(p.locator('#ro input[value="x"]').isDisabled()).resolves.toBe(
      true,
    );
    const act = p.locator("#ro").getByRole("button", { name: "Again" });
    await expect(act.isVisible()).resolves.toBe(true);
    await expect(act.isDisabled()).resolves.toBe(false);
    await act.click();
    expect(
      await p.evaluate(() => (window as unknown as { acted: number }).acted),
    ).toBe(1);
    await p.context().close();
  });

  it("at 390 every row is a 44px target, with no sideways scroll", async () => {
    if (skip()) return;
    const p = await open(390, true);
    const heights = await p
      .locator("fieldset label")
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    expect(
      await p.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await p.context().close();
  });
});
