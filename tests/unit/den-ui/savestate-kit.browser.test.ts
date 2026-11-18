/**
 * den-ui: the save-state line in a browser, with no product around it: a
 * bare page loads tokens.css, base.css and savestate.js, and wires a
 * textarea to a stub save. The page's clock is faked.
 *
 *   - the element: class, role, aria-live="off", data-state; idle is empty
 *     and keeps its 20 px; saved says "Saved" with title "Saved at {time}"
 *   - 800 ms after typing; at once on blur and on hidden; Saving… only past
 *     400 ms
 *   - error: the words, Copy text copies what the host gives; retries on
 *     `online`; success is Saved again
 *   - the live region says only the error and its recovery
 *   - es and ja words
 *   - colours by state, light and dark; only the dot's colour moves, over
 *     --dur-fast, and not at all under reduced motion
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

const PAGE = (lang: string, mode: string) => `<!doctype html>
<html lang="${lang}"${mode ? ` data-mode="${mode}"` : ""}><head><meta charset="utf-8">
<link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/base.css"></head>
<body><textarea id="f"></textarea><button id="other">Other</button>
<p id="line"></p>
<script type="module">
import { createSaveState } from "/savestate.js";
window.saves = [];
window.copied = [];
// http://kit.test is not a secure context: no clipboard of its own.
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: async (t) => { window.copied.push(t); } },
});
window.plan = [{ ms: 10, ok: true }];
const f = document.getElementById("f");
window.line = createSaveState(document.getElementById("line"), {
  save: () => {
    const step = plan[Math.min(saves.length, plan.length - 1)];
    saves.push(f.value);
    return new Promise((res, rej) =>
      setTimeout(() => (step.ok ? res() : rej(new Error("down"))), step.ms));
  },
  copyText: () => "Title\\n\\n" + f.value,
  watch: f,
});
window.ready = true;
</script></body></html>`;

async function open(
  o: { lang?: string; mode?: string; reduce?: boolean } = {},
): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: o.reduce === false ? "no-preference" : "reduce",
    colorScheme: o.mode === "dark" ? "dark" : "light",
    timezoneId: "UTC",
    locale: o.lang ?? "en",
  });
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date("2026-11-18T10:42:00Z") });
  await p.route(`${ORIGIN}/**`, async (r: Route) => {
    const u = new URL(r.request().url());
    if (u.pathname === "/")
      return r.fulfill({
        contentType: "text/html",
        body: PAGE(o.lang ?? "en", o.mode ?? ""),
      });
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
      {
        timeout: 10_000,
      },
    )
    .catch((e: Error) => {
      throw new Error(`page not ready: ${errors.join("; ") || e.message}`);
    });
  return p;
}

const line = (p: Page) => p.locator("#line");
const live = (p: Page) => p.locator(".den-savestate-sr");
const state = (p: Page) => line(p).getAttribute("data-state");
const saves = (p: Page) =>
  p.evaluate(() => (window as unknown as { saves: string[] }).saves);
const setPlan = (p: Page, plan: { ms: number; ok: boolean }[]) =>
  p.evaluate((pl) => {
    (window as unknown as { plan: unknown }).plan = pl;
  }, plan);
const type = (p: Page, text: string) => p.fill("#f", text);
/** Intl's time puts a narrow no-break space before AM: read as a space. */
const plain = (s: string | null) => (s ?? "").replace(/\u202f/g, " ");

describe("savestate in a browser", () => {
  it("is a status line: class, role, aria-live off; idle is empty and keeps its 20 px", async () => {
    if (skip()) return;
    const p = await open();
    const l = line(p);
    // savestate.css, linked beside tokens.css by the line itself.
    expect(
      await p.evaluate(() =>
        Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
          (l) => new URL((l as HTMLLinkElement).href).pathname,
        ),
      ),
    ).toEqual(["/tokens.css", "/base.css", "/savestate.css"]);
    expect(await l.getAttribute("class")).toBe("den-savestate");
    expect(await l.getAttribute("role")).toBe("status");
    expect(await l.getAttribute("aria-live")).toBe("off");
    expect(await state(p)).toBe("idle");
    expect((await l.textContent())!.trim()).toBe("");
    const box = await l.boundingBox();
    expect(box!.height).toBe(20);
    // The live region is polite, beside the line, and unseen.
    expect(await live(p).getAttribute("aria-live")).toBe("polite");
    const lb = await live(p).boundingBox();
    expect(lb!.width).toBeLessThanOrEqual(1);
    await p.context().close();
  });

  it("saves 800 ms after typing; Saved with its time as the title", async () => {
    if (skip()) return;
    const p = await open();
    await type(p, "a");
    await p.clock.runFor(500);
    await type(p, "ab");
    await p.clock.runFor(799);
    expect(await saves(p)).toEqual([]);
    await p.clock.runFor(1);
    expect(await saves(p)).toEqual(["ab"]);
    // A 10 ms save: never Saving…, straight to Saved.
    await p.clock.runFor(10);
    expect(await state(p)).toBe("saved");
    expect(await line(p).locator(".den-savestate-text").textContent()).toBe(
      "Saved",
    );
    expect(plain(await line(p).getAttribute("title"))).toBe(
      "Saved at 10:42 AM",
    );
    // Routine saves are not announced.
    expect(await live(p).textContent()).toBe("");
    expect(await line(p).locator("button").count()).toBe(0);
    await p.context().close();
  });

  it("Saving… only when the save takes past 400 ms", async () => {
    if (skip()) return;
    const p = await open();
    await setPlan(p, [{ ms: 1000, ok: true }]);
    await type(p, "a");
    await p.clock.runFor(800 + 399);
    expect(await state(p)).toBe("idle");
    await p.clock.runFor(1);
    expect(await state(p)).toBe("saving");
    expect(await line(p).textContent()).toBe("Saving…");
    await p.clock.runFor(600);
    expect(await state(p)).toBe("saved");
    await p.context().close();
  });

  it("saves at once on blur, and when the page goes hidden", async () => {
    if (skip()) return;
    const p = await open();
    await type(p, "on blur");
    await p.focus("#other");
    expect(await saves(p)).toEqual(["on blur"]);
    await p.clock.runFor(10);
    await type(p, "on hidden");
    await p.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(await saves(p)).toEqual(["on blur", "on hidden"]);
    // The 800 ms saves were taken: nothing more to save.
    await p.clock.runFor(2000);
    expect((await saves(p)).length).toBe(2);
    await p.context().close();
  });

  it("error: the words, Copy text, a retry on online; the live region says only the error and the recovery", async () => {
    if (skip()) return;
    const p = await open();
    // A routine save first: nothing said.
    await type(p, "one");
    await p.clock.runFor(810);
    expect(await live(p).textContent()).toBe("");
    await setPlan(p, [
      { ms: 0, ok: true },
      { ms: 0, ok: false },
      { ms: 0, ok: true },
    ]);
    // Leaving the field saves at once (and keeps Copy text's click from
    // being a blur that saves again).
    await type(p, "two");
    await p.focus("#other");
    await p.clock.runFor(1);
    expect(await state(p)).toBe("error");
    expect(await line(p).locator(".den-savestate-text").textContent()).toBe(
      "Not saved. Retrying…",
    );
    expect(await live(p).textContent()).toBe("Not saved. Retrying…");
    const copy = line(p).locator("button.den-savestate-copy");
    expect(await copy.textContent()).toBe("Copy text");
    await copy.click();
    expect(
      await p.evaluate(
        () => (window as unknown as { copied: string[] }).copied,
      ),
    ).toEqual(["Title\n\ntwo"]);
    // Back online: a retry at once (before the 2 s one), and it saves.
    await p.evaluate(() => window.dispatchEvent(new Event("online")));
    await p.clock.runFor(1);
    expect(await saves(p)).toEqual(["one", "two", "two"]);
    expect(await state(p)).toBe("saved");
    expect(await copy.count()).toBe(0);
    expect(plain(await live(p).textContent())).toBe("Saved at 10:42 AM");
    // The next routine save says nothing new.
    await type(p, "three");
    await p.clock.runFor(810);
    expect(await state(p)).toBe("saved");
    expect(plain(await live(p).textContent())).toBe("Saved at 10:42 AM");
    await p.context().close();
  });

  it("speaks es and ja", async () => {
    if (skip()) return;
    for (const [lang, saved, title, err] of [
      ["es", "Guardado", "Guardado a las 10:42", "No se guardó. Reintentando…"],
      [
        "ja",
        "保存しました",
        "10:42 に保存しました",
        "保存できていません。再試行しています…",
      ],
    ] as const) {
      const p = await open({ lang });
      await type(p, "x");
      await p.clock.runFor(810);
      expect(await line(p).textContent()).toBe(saved);
      expect(await line(p).getAttribute("title")).toBe(title);
      await setPlan(p, [{ ms: 0, ok: false }]);
      await type(p, "y");
      await p.clock.runFor(810);
      expect(await line(p).locator(".den-savestate-text").textContent()).toBe(
        err,
      );
      await p.context().close();
    }
  });

  it.each(["light", "dark"])(
    "colours by state (%s): faint, ok and bad dots, bad words in error",
    async (mode) => {
      if (skip()) return;
      const p = await open({ mode, reduce: false });
      const look = () =>
        p.evaluate(() => {
          const el = document.getElementById("line")!;
          // The dot's colour change, run to its end (transitions keep real
          // time, not the page's faked clock).
          for (const a of document.getAnimations()) a.finish();
          const dot = getComputedStyle(el, "::before");
          const tok = (n: string) => {
            const probe = document.createElement("i");
            probe.style.color = `var(${n})`;
            document.body.append(probe);
            const c = getComputedStyle(probe).color;
            probe.remove();
            return c;
          };
          return {
            dot: dot.backgroundColor,
            visible: dot.visibility,
            size: `${dot.width}×${dot.height}`,
            text: getComputedStyle(el).color,
            transition: `${dot.transitionProperty} ${dot.transitionDuration}`,
            faint: tok("--faint"),
            ok: tok("--ok"),
            bad: tok("--bad"),
            muted: tok("--muted"),
            durFast: getComputedStyle(document.documentElement)
              .getPropertyValue("--dur-fast")
              .trim(),
          };
        });
      const idle = await look();
      expect(idle.visible).toBe("hidden");
      expect(idle.size).toBe("6px×6px");
      // Only the dot's colour moves, over --dur-fast (120 ms).
      expect(idle.durFast).toBe("120ms");
      expect(idle.transition).toBe("background-color 0.12s");
      await setPlan(p, [
        { ms: 1000, ok: true },
        { ms: 0, ok: false },
      ]);
      await type(p, "a");
      await p.clock.runFor(1200);
      const saving = await look();
      expect([saving.dot, saving.text]).toEqual([saving.faint, saving.muted]);
      await p.clock.runFor(600);
      const saved = await look();
      expect([saved.dot, saved.text]).toEqual([saved.ok, saved.muted]);
      await type(p, "b");
      await p.clock.runFor(810);
      const error = await look();
      expect([error.dot, error.text]).toEqual([error.bad, error.bad]);
      // The mode's own --ok and --bad (tokens.css), not one colour for both.
      expect([saved.dot, error.dot]).toEqual(
        mode === "light"
          ? ["rgb(39, 97, 59)", "rgb(152, 49, 36)"]
          : ["rgb(111, 194, 143)", "rgb(239, 127, 106)"],
      );
      await p.context().close();
    },
  );

  it("no motion under reduced motion", async () => {
    if (skip()) return;
    const p = await open({ reduce: true });
    const t = await p.evaluate(() => {
      const dot = getComputedStyle(
        document.getElementById("line")!,
        "::before",
      );
      // Its own rule, not just no stylesheet: the dot is still drawn.
      return `${dot.width} ${dot.transitionDuration}`;
    });
    expect(t).toBe("6px 0s");
    await p.context().close();
  });
});
