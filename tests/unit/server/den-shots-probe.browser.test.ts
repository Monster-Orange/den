/** Throwaway probe (den-design, Harmony inventory): Den's own screens, in WebKit, at 1280 and 390. Not for merge. */
import { afterAll, beforeAll, describe, it } from "@jest/globals";
import * as fs from "fs";
import type { Browser, BrowserContext } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";

const OUT = process.env.PROBE_OUT!;
let s: AgentsPageServer;
let browser: Browser;
let latest = "";
const ctxs: BrowserContext[] = [];

beforeAll(async () => {
  const pw = await import("playwright");
  browser = process.env.DEN_PW_WS
    ? await pw.webkit.connect(process.env.DEN_PW_WS, { exposeNetwork: "<loopback>" })
    : await pw.webkit.launch();
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as { version: string }[]
    )[0]?.version ?? "";
  fs.mkdirSync(OUT, { recursive: true });
}, 90_000);
afterAll(async () => {
  for (const c of ctxs) await c.close().catch(() => {});
  await closeBrowserSuite({ browsers: [browser], servers: [s] });
});

const PAGES: [string, string][] = [
  ["rail-topbar-agents", "/agents"],
  ["settings-access", "/settings#access"],
  ["settings-top", "/settings"],
  ["projects", "/workspaces"],
  ["services", "/services"],
  ["logs", "/logs"],
  ["edge", "/edge"],
];

describe("den shots for Harmony", () => {
  it.each([
    [1280, 860],
    [390, 844],
  ])("%d wide", async (w, h) => {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      reducedMotion: "reduce",
      ...(w <= 480 ? { hasTouch: true, isMobile: true, deviceScaleFactor: 3 } : {}),
    });
    ctxs.push(ctx);
    await ctx.addInitScript(
      ([v]) => {
        try {
          for (const k of ["den-changelog-seen", "acme-changelog-seen"]) localStorage.setItem(k, v as string);
        } catch {}
      },
      [latest] as const,
    );
    for (const [name, path] of PAGES) {
      const p = await ctx.newPage();
      await p.goto(signInUrl(s.stateDir, s.base, path));
      await p.waitForTimeout(1200);
      await p.screenshot({ path: `${OUT}/den-${name}-${w}.png` });
      // The rail foot entry's measured values, for #406 (one line or two).
      const acct = await p.evaluate(() => {
        const e = document.querySelector("[data-den-account]") as HTMLElement | null;
        if (!e) return null;
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return { text: e.innerText.replace(/\n+/g, " | "), w: Math.round(r.width), h: Math.round(r.height), fontSize: cs.fontSize, current: e.getAttribute("aria-current") };
      });
      fs.appendFileSync(`${OUT}/report.jsonl`, JSON.stringify({ name, w, acct }) + "\n");
      await p.close();
    }
  }, 240_000);
});
