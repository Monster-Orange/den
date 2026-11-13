/**
 * 0.4.40: an agent's card says what Hub comments it has: "Working on N Hub
 * comments · <artifact>" (its turn took them) or "N Hub comments wait for
 * it" (stopped or mid-turn), the artifact a link to Hub. Translated.
 *
 * The demo distribution (helpers/agents-page-server.ts); the list's
 * hubWork is added to the real /api/sessions answer (the delivery loop's
 * own tests cover where it comes from). Invented names only.
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
let latest = "";
const errors: string[] = [];

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  s.seed({
    id: "hub-one",
    persona: "planner",
    workspace: "north",
    stoppedAt: "2026-11-12T10:00:00.000Z",
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

const skip = () => !browser;

async function open(work: Record<string, unknown>): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript((v) => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, v);
    } catch {
      /* none */
    }
  }, latest);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  await p.route("**/api/sessions*", async (r) => {
    const res = await r.fetch();
    const b = (await res.json()) as { sessions?: { agent?: string }[] };
    for (const row of b.sessions ?? [])
      if (row.agent === "hub-one")
        (row as Record<string, unknown>).hubWork = work;
    await r.fulfill({ response: res, json: b });
  });
  await p.goto(signInUrl(s!.stateDir, s!.base, "/agents?ws=north"));
  await p.waitForSelector("#agl:not([aria-busy]) .agr", {
    state: "attached",
    timeout: 20_000,
  });
  const group = p.locator("#agl details[data-stopped]");
  if ((await group.count()) && (await group.getAttribute("open")) === null)
    await group.locator("summary").click();
  return p;
}

const line = '.agst[data-agent="hub-one"] [data-hubwork]';

describe("0.4.40: Hub comments on the agent's card", () => {
  it("queued: how many wait, and the artifact, linked", async () => {
    if (skip()) return;
    const p = await open({
      working: 0,
      queued: 2,
      artifact: "Pricing page",
      url: "https://hub.example.test/a/doc#th_1",
    });
    await p.waitForSelector(line);
    expect(await p.getAttribute(line, "data-hubwork")).toBe("queued");
    expect((await p.textContent(line))?.trim()).toBe(
      "2 Hub comments wait for it · Pricing page",
    );
    expect(await p.getAttribute(`${line} a`, "href")).toBe(
      "https://hub.example.test/a/doc#th_1",
    );
    expect(await p.getAttribute(`${line} a`, "rel")).toContain("noopener");
    await p.context().close();
  }, 60_000);

  it("working on one: singular; a link that isn't http(s) isn't a link", async () => {
    if (skip()) return;
    const p = await open({
      working: 1,
      queued: 0,
      artifact: "Pricing page",
      url: "javascript:alert(1)",
    });
    await p.waitForSelector(line);
    expect((await p.textContent(line))?.trim()).toBe(
      "Working on 1 Hub comment · Pricing page",
    );
    expect(await p.$(`${line} a`)).toBeNull();
    await p.context().close();
  }, 60_000);

  it("nothing: no line", async () => {
    if (skip()) return;
    const p = await open({ working: 0, queued: 0 });
    expect(await p.$(line)).toBeNull();
    await p.context().close();
  }, 60_000);

  it("in Japanese", async () => {
    if (skip()) return;
    expect(await s!.settings({ language: "ja" })).toBe(200);
    try {
      const p = await open({ working: 3, queued: 0 });
      await p.waitForSelector(line);
      expect((await p.textContent(line))?.trim()).toBe(
        "Hub のコメント 3 件に対応中",
      );
      await p.context().close();
    } finally {
      await s!.settings({ language: null });
    }
  }, 60_000);

  it("no page errors", () => {
    expect(errors).toEqual([]);
  });
});
