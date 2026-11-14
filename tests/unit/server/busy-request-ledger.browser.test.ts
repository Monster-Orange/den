/**
 * BUSY-1: Try again resends the same request id (X-Den-Request-Id) and Den
 * runs the action once; Check again asks GET /api/requests/<id> how it
 * ended and never resends. Ids are each signed-in person's own.
 *
 * The demo distribution (helpers/agents-page-server.ts), a scripted PTY.
 * Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer | null = null;
const STOPPED_AT = "2026-11-06T10:30:00.000Z";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  s.seed({
    id: "once-one",
    persona: "planner",
    workspace: "north",
    stoppedAt: STOPPED_AT,
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function signedIn(): Promise<Page> {
  const ctx = await browser!.newContext();
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, "/settings"));
  await p.waitForFunction(() => !!(window as { denShell?: unknown }).denShell);
  return p;
}

/** POST through the page (its fetch adds the CSRF header). */
const post = (p: Page, url: string, id: string) =>
  p.evaluate(
    async ([u, rid]) => {
      const r = await fetch(u, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Den-Request-Id": rid,
        },
        body: "{}",
      });
      return {
        status: r.status,
        replayed: r.headers.get("x-den-replayed"),
        rid: r.headers.get("x-request-id"),
        body: await r.text(),
      };
    },
    [url, id] as const,
  );

const status = (p: Page, id: string) =>
  p.evaluate(
    async (rid) => (await fetch(`/api/requests/${rid}`)).json(),
    id,
  ) as Promise<{ state: string; status?: number }>;

describe("BUSY-1: a write sent again with its id runs once", () => {
  it("Try again after the answer replays it; the agent starts once", async () => {
    if (skip()) return;
    const p = await signedIn();
    const url = "/api/workspaces/north/agents/once-one/fresh";
    const id = "busy-0000-try-again";
    expect(await status(p, id)).toMatchObject({ state: "unknown" });
    const before = s!.made.length;
    const first = await post(p, url, id);
    expect(first.status).toBeLessThan(400);
    expect(first.rid).toBe(id);
    expect(s!.made.length).toBe(before + 1);
    const again = await post(p, url, id);
    expect(again.replayed).toBe("1");
    expect(again.status).toBe(first.status);
    expect(again.body).toBe(first.body);
    expect(s!.made.length).toBe(before + 1);
    expect(await status(p, id)).toMatchObject({
      state: "done",
      status: first.status,
    });
    // Another signed-in browser never sees this person's ids.
    const other = await signedIn();
    expect(await status(other, id)).toMatchObject({ state: "unknown" });
  }, 60_000);

  it("refuses an id that isn't 8 to 64 letters, digits or dashes", async () => {
    if (skip()) return;
    const p = await signedIn();
    const r = await p.evaluate(
      async () => (await fetch("/api/requests/no!")).status,
    );
    expect(r).toBe(400);
  }, 30_000);
});
