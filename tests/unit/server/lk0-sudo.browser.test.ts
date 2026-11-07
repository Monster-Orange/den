/**
 * LK-0 in a real browser on the real server (Ward, 2026-11-06: the admin
 * password is for sudo, and nothing else), with no password set and a
 * sudo that needs one:
 *
 *   - there is no Locked/Unlocked chip: the top bar's sudo chip shows only
 *     while a run waits for the password;
 *   - a service with no elevated steps starts with no prompt;
 *   - a service whose `up` runs sudo: the prompt appears, in the top
 *     layer, saying "sudo <command> needs your admin password", and after
 *     the password the action runs again, and its command runs;
 *   - Settings says whether it is saved, with Forget.
 *
 * (The Start dialog's side, no password field and no prompt, is in
 * agent-start-ready.browser.test.ts.) The demo distribution (acme) with
 * PATH shims (helpers/agents-page-server.ts): the `sudo` shim takes one
 * invented password (never a real sudo, never printed). Needs Playwright's
 * chromium; DEN_SKIP_BROWSER_TESTS=1 skips it. DEN_AGENTS_SHOTS=<dir>
 * writes screenshots.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { denAuth, signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

const SHOTS = process.env.DEN_AGENTS_SHOTS;
// An invented password the sudo shim takes; it is no one's.
const PW = "open-sesame-test";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
let latest = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({ sudoPassword: PW, elevatedUp: true });
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;
const errors: string[] = [];

async function page(url: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      // No What's new dialog over the page: its latest version is seen.
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
    // Every run's events, for the test to read (__sse).
    const w = window as unknown as {
      EventSource: typeof EventSource;
      __sse: { type?: string; url?: string }[];
    };
    const E = w.EventSource;
    w.__sse = [];
    w.EventSource = class extends E {
      constructor(u: string | URL, o?: EventSourceInit) {
        super(u, o);
        const url = new URL(String(u), location.href).pathname;
        this.addEventListener("message", (e) => {
          try {
            w.__sse.push({
              url,
              ...JSON.parse((e as MessageEvent).data as string),
            });
          } catch {
            /* not JSON */
          }
        });
      }
    };
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(`${url}: ${e.message}`));
  await p.goto(signInUrl(s!.stateDir, s!.base, url));
  return p;
}

const text = (p: Page, sel: string) =>
  p.$eval(sel, (e) => (e.textContent ?? "").replace(/\s+/g, " ").trim());

async function api(method: string, p: string, body?: unknown) {
  const r = await fetch(`${s!.base}${p}`, {
    method,
    headers: {
      ...denAuth(s!.stateDir),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return r.status;
}

type Ev = { type?: string; url?: string; exitCode?: number; text?: string };
const RUN = "/api/workspace/exec";

/** Local Dev's runCmd (a card's Start), once its workspace is shown. */
async function startService(p: Page, repo: string): Promise<void> {
  await p.waitForSelector("#ws-agents-count");
  await p.waitForFunction(
    () =>
      typeof (window as unknown as { runCmd?: unknown }).runCmd === "function",
  );
  await p.evaluate(
    (r) =>
      void (
        window as unknown as {
          runCmd: (a: string, r: string, s: string, c: string) => unknown;
        }
      ).runCmd(r, r, r, "up"),
    repo,
  );
}

/** The service runs' events so far. */
const runEvents = async (p: Page): Promise<Ev[]> =>
  (await p.evaluate(() => (window as unknown as { __sse: Ev[] }).__sse)).filter(
    (m) => m.url === RUN,
  );

/** Wait for a run event of `type`. */
async function waitForEvent(p: Page, type: string): Promise<void> {
  await p.waitForFunction(
    ([t, run]) =>
      (window as unknown as { __sse: Ev[] }).__sse.some(
        (m) => m.url === run && m.type === t,
      ),
    [type, RUN],
  );
}

async function waitFor(cond: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("LK-0: the admin password is asked for only when sudo needs it", () => {
  it("no Locked/Unlocked chip: the sudo chip is hidden while nothing waits", async () => {
    if (skip()) return;
    const p = await page("/?ws=north");
    await p.waitForSelector("#den-status");
    await p.waitForSelector("#den-lock", { state: "attached" });
    expect(await p.isHidden("#den-lock")).toBe(true);
    const chips = await text(p, ".den-chips");
    expect(chips).not.toMatch(/Locked|Unlocked/);
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "lk0-no-chip.png") });
    await p.context().close();
  }, 60_000);

  it("a service with no elevated steps starts with no prompt", async () => {
    if (skip()) return;
    const p = await page("/?ws=north");
    await startService(p, "notes");
    await waitForEvent(p, "done");
    const evs = await runEvents(p);
    expect(evs.filter((m) => m.type === "label")).toEqual([
      { url: RUN, type: "label", text: "notes" },
    ]);
    expect(evs.filter((m) => m.type === "needs-sudo")).toEqual([]);
    expect(evs.find((m) => m.type === "done")).toMatchObject({ exitCode: 0 });
    expect(await p.$("#den-lock-pop")).toBeNull();
    expect(await p.isHidden("#den-lock")).toBe(true);
    await p.context().close();
  }, 60_000);

  it("a service whose up runs sudo: the prompt names the command, and after the password the action runs", async () => {
    if (skip()) return;
    const p = await page("/?ws=south");
    await startService(p, "blog");
    await waitForEvent(p, "needs-sudo");
    await p.waitForSelector("#den-lock-pop #den-lock-pw");
    expect(await text(p, "#den-lock-t")).toBe(
      `sudo touch ${s!.elevated} needs your admin password`,
    );
    expect(await p.isVisible("#den-lock")).toBe(true);
    expect(await text(p, "#den-lock")).toBe("🔑Admin password needed");
    // In the top layer, focused, and nothing covers it.
    expect(await p.evaluate(() => document.activeElement?.id)).toBe(
      "den-lock-pw",
    );
    const hit = await p.evaluate(() => {
      const r = document.getElementById("den-lock-pw")!.getBoundingClientRect();
      return document.elementFromPoint(r.x + 4, r.y + 4)?.id;
    });
    expect(hit).toBe("den-lock-pw");
    expect(fs.existsSync(s!.elevated)).toBe(false);
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "lk0-needs-sudo.png") });
    // A wrong one says so; nothing runs.
    await p.fill("#den-lock-pw", "not-it");
    await p.click("#den-lock-go");
    await p.waitForSelector("#den-lock-err:not([hidden])");
    expect(await text(p, "#den-lock-err")).toBe(
      "Incorrect password — try again",
    );
    // The right one: the action runs again, and its sudo runs.
    await p.fill("#den-lock-pw", PW);
    await p.press("#den-lock-pw", "Enter");
    await waitFor(() => fs.existsSync(s!.elevated));
    await p.waitForSelector("#den-lock-pop", { state: "detached" });
    expect(await p.isHidden("#den-lock")).toBe(true);
    await p.context().close();
  }, 60_000);

  it("Settings: Admin password is saved or not, with Forget", async () => {
    if (skip()) return;
    expect(await api("POST", "/api/sudo-password/forget", {})).toBe(200);
    const p = await page("/settings#cli");
    await p.waitForSelector("#set-sudo", { state: "attached" });
    await p.waitForFunction(
      () => document.getElementById("set-sudo")?.textContent !== "",
    );
    expect(await text(p, "#set-sudo")).toBe("Not saved");
    expect(await p.$("#set-sudo-forget")).toBeNull();
    expect(await api("POST", "/api/sudo-password", { password: PW })).toBe(200);
    await p.reload();
    await p.waitForSelector("#set-sudo-forget");
    expect(await text(p, "#set-sudo")).toBe("Saved for this session");
    if (SHOTS)
      await p.screenshot({ path: path.join(SHOTS, "lk0-settings.png") });
    await p.click("#set-sudo-forget");
    await p.waitForSelector("#set-sudo-forget", { state: "detached" });
    expect(await text(p, "#set-sudo")).toBe("Not saved");
    await p.context().close();
  }, 60_000);

  it("raised no page errors, and never printed the password", () => {
    if (skip()) return;
    expect(errors).toEqual([]);
    expect(s!.log().includes(PW)).toBe(false);
  });
});
