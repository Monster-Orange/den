/**
 * Environments (0.4.17, the 0.4.14 walk's bug 9) against a real dead host:
 * notes' health URL is a local port that accepts and never answers. On
 * the real server and its real health stream, in a real browser:
 *
 *   - notes' row says "timed out after N s" in its own cell; blog's row
 *     resolves on its own, never held up by notes';
 *   - the page's controls stay usable while notes' check runs.
 *
 * And the top bar's View on one workspace (south), with the real stream:
 * Environments lists only south's row; Releases (its config and status
 * stubbed, two repos) lists only south's repo, with the View's note.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as net from "net";
import type { AddressInfo } from "net";
import type { Browser, Page } from "playwright";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let dead: net.Server | null = null;
const held: net.Socket[] = [];
const errors: string[] = [];
let latest = "";

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  // A host that takes the connection and never says a word.
  dead = net.createServer((sock) => {
    held.push(sock);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => dead!.listen(0, "localhost", r));
  const port = (dead.address() as AddressInfo).port;
  s = await startAgentsPageServer({
    health: { notes: `http://localhost:${port}/health` },
  });
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
  for (const x of held) x.destroy();
  await new Promise<void>((r) => (dead ? dead.close(() => r()) : r()));
});

const skip = () => !browser;

async function page(): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
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
  return p;
}

async function setView(scope: string): Promise<void> {
  const r = await fetch(`${s!.base}/api/scope`, {
    method: "POST",
    headers: { "content-type": "application/json", ...denAuth(s!.stateDir) },
    body: JSON.stringify({ scope }),
  });
  if (!r.ok) throw new Error(`POST /api/scope: ${r.status}`);
}

const cell = (svc: string) => `tr[data-svc="${svc}"] td[data-env="local"]`;

describe("Environments against a dead host (0.4.17)", () => {
  it("the dead host's row says it timed out; the other row and the controls never wait", async () => {
    if (skip()) return;
    const p = await page();
    const t0 = Date.now();
    await p.goto(`${s!.base}/environments`);
    await p.waitForSelector(`tr[data-svc="notes/notes"] [data-checking]`);
    // blog lands while notes' check still runs.
    await p.waitForFunction(
      () =>
        !document.querySelector('tr[data-svc="blog/blog"] [data-checking]') &&
        !!document.querySelector('tr[data-svc="notes/notes"] [data-checking]'),
      undefined,
      { timeout: 10_000 },
    );
    expect(await p.isEnabled("#refresh")).toBe(true);
    // notes: its own cell says how long it waited.
    await p.waitForFunction(
      (sel) =>
        /timed out after \d+ s/.test(
          document.querySelector(sel)?.textContent ?? "",
        ),
      cell("notes/notes"),
      { timeout: 20_000 },
    );
    expect(Date.now() - t0).toBeLessThan(20_000);
    await p.context().close();
  }, 60_000);
});

describe("one workspace in the View (0.4.17)", () => {
  it("Environments lists only that workspace's rows, from the real stream", async () => {
    if (skip()) return;
    await setView("south");
    try {
      const p = await page();
      await p.goto(`${s!.base}/environments`);
      await p.waitForSelector('tr[data-svc="blog/blog"]');
      await p.waitForFunction(
        () =>
          !document.querySelector('tr[data-svc="blog/blog"] [data-checking]'),
        undefined,
        { timeout: 15_000 },
      );
      expect(await p.$('tr[data-svc="notes/notes"]')).toBeNull();
      expect(await p.textContent("#view-note")).toBe(
        "Shows project south, as the top bar's View. Change it there.",
      );
      await p.context().close();
    } finally {
      await setView("all");
    }
  }, 60_000);

  it("Releases lists only that workspace's repos", async () => {
    if (skip()) return;
    await setView("south");
    try {
      const p = await page();
      await p.route("**/api/release/config", (r) =>
        r.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            environments: ["dev"],
            repos: [
              { name: "notes", wave: 1 },
              { name: "blog", wave: 1 },
            ],
          }),
        }),
      );
      const row = (repo: string) => ({
        repo,
        gh: `acme/${repo}`,
        wave: 1,
        workflow: "cd.yml",
        environment: "dev",
        sourceBranch: "main",
        mainSha: null,
        mainShort: null,
        deployedSha: null,
        deployedShort: null,
        branch: null,
        deployedAt: null,
        runId: null,
        runUrl: null,
        deployer: null,
        status: { kind: "none", text: "—" },
      });
      await p.route("**/api/release/status**", (r) =>
        r.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            env: "dev",
            rows: [row("notes"), row("blog")],
            fetchedAt: new Date().toISOString(),
          }),
        }),
      );
      await p.goto(`${s!.base}/release`);
      await p.waitForFunction(
        () =>
          [...document.querySelectorAll("td.repo-cell")].some((c) =>
            (c.textContent ?? "").includes("blog"),
          ),
        undefined,
        { timeout: 15_000 },
      );
      const repos = await p.$$eval("td.repo-cell", (cs) =>
        cs.map((c) => (c.textContent ?? "").trim()),
      );
      expect(repos).toEqual(["blog"]);
      expect(await p.textContent("#view-note")).toBe(
        "Shows project south, as the top bar's View. Change it there.",
      );
      await p.context().close();
    } finally {
      await setView("all");
    }
  }, 60_000);

  it("raised no page errors", () => {
    expect(errors).toEqual([]);
  });
});
