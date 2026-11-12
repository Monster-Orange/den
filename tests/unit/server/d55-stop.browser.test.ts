/**
 * D55: Stop in the runs dock stops the run on the server; closing the
 * page only stops watching. In a real browser on the real web server
 * (helpers/agents-page-server.ts), notes' `down` takes a few seconds and
 * then marks that it finished:
 *
 *   - the Services page (/services): a run's tab carries Stop; Stop asks
 *     the server to stop the run, the down never finishes, the tab ends;
 *   - the Tests page's services view (/tests#services): its Stop does the
 *     same;
 *   - a page closed mid-run: the down still finishes.
 *
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Browser, Page } from "playwright";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;
let tmp: string;
let browser: Browser | null = null;
let latest = "";
const marker = () => path.join(tmp, "down-ran");

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d55b-")));
  s = await startAgentsPageServer({
    root: tmp,
    down: { notes: `sleep 3; touch ${path.join(tmp, "down-ran")}` },
  });
  latest =
    (
      (await (await fetch(`${s.base}/api/changelog`)).json()) as {
        version: string;
      }[]
    )[0]?.version ?? "";
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS !== "1") throw err;
  }
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

async function open(url: string): Promise<{ p: Page; stops: string[] }> {
  const ctx = await browser!.newContext({
    viewport: { width: 1280, height: 800 },
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
  const stops: string[] = [];
  p.on("request", (r) => {
    const u = new URL(r.url());
    if (
      r.method() === "POST" &&
      /^\/api\/exec\/jobs\/[^/]+\/stop$/.test(u.pathname)
    )
      stops.push(u.pathname);
  });
  await p.goto(`${s.base}${url}`);
  await p.waitForSelector("#den-dock .den-bar");
  return { p, stops };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Click the selected run's Stop in the dock (opening the dock first). */
async function stopInDock(p: Page): Promise<void> {
  if (!(await p.$("#den-dock-out")))
    await p.click('#den-dock [data-act="dock"]');
  await p.click('#den-dock button[data-ract]:has-text("Stop")');
}

const tabText = (p: Page, id: string) =>
  p.evaluate(
    (i) =>
      (
        window as unknown as {
          denShell: { runs: { text(id: string): string } };
        }
      ).denShell.runs.text(i),
    id,
  );

describe("D55: Stop in the runs dock", () => {
  for (const [page, url] of [
    ["the Services page", "/services"],
    ["the Tests page's services view", "/tests#services"],
  ] as const)
    it(`${page}: Stop stops the run on the server; the down never finishes`, async () => {
      if (!browser) return;
      fs.rmSync(marker(), { force: true });
      const { p, stops } = await open(url);
      await p.click('.cmd-btn[data-repo="notes"][data-cmd="down"]');
      await p.waitForSelector('#den-dock .den-rtab:has-text("down notes")');
      // The run has its job before Stop has one to stop.
      await p.waitForFunction(() =>
        (localStorage.getItem("acme-runs") ?? "").includes("run_"),
      );
      await stopInDock(p);
      for (let i = 0; i < 50 && !stops.length; i++) await sleep(50);
      expect(stops).toHaveLength(1);
      expect(await tabText(p, "notes/notes")).toMatch(/Stop/);
      // The tab says stopped: not failed, not done.
      const tab = await p.evaluate(() =>
        (
          window as unknown as {
            denShell: {
              runs: {
                list(): { id: string; error: boolean; stopped: boolean }[];
              };
            };
          }
        ).denShell.runs
          .list()
          .find((r) => r.id === "notes/notes"),
      );
      expect(tab).toMatchObject({ error: false, stopped: true });
      const label = await p
        .locator('#den-dock .den-rtab:has-text("down notes")')
        .first()
        .innerText();
      expect(label).not.toMatch(/failed/);
      expect(
        await p
          .locator('#den-dock .den-rtab:has-text("down notes") .den-sr')
          .first()
          .textContent(),
      ).toBe(", stopped");
      // Longer than the down's sleep: it was stopped, not left to finish.
      await sleep(4000);
      expect(fs.existsSync(marker())).toBe(false);
      const id = stops[0].split("/")[4];
      const job = (await (
        await fetch(`${s.base}/api/exec/jobs/${id}`)
      ).json()) as {
        stopped: boolean;
      };
      expect(job.stopped).toBe(true);
      await p.context().close();
    }, 40_000);

  it("the page closed mid-run: the down still finishes", async () => {
    if (!browser) return;
    fs.rmSync(marker(), { force: true });
    const { p, stops } = await open("/services");
    await p.click('.cmd-btn[data-repo="notes"][data-cmd="down"]');
    await p.waitForFunction(() =>
      (localStorage.getItem("acme-runs") ?? "").includes("run_"),
    );
    await p.context().close();
    for (let i = 0; i < 100 && !fs.existsSync(marker()); i++) await sleep(100);
    expect(fs.existsSync(marker())).toBe(true);
    expect(stops).toEqual([]);
  }, 40_000);
});
