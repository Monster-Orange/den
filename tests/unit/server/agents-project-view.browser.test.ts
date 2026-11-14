/**
 * #80 (0.4.45): in a project, the Agents page holds only that project's
 * agents and shells, plus the server agent. 0.4.44 added the open tabs'
 * projects to the list, so a tabs link from another project showed every
 * project's agents and mixed their tabs in.
 *
 *   1. In a project: the list, the tabs and ?open= hold only its own.
 *   2. ?open= naming another project's sessions: they leave the tabs, and
 *      one line says "N tabs from other projects hidden · Show in All
 *      active", which shows them all.
 *   3. A link to one agent in another project (?agent=, as ⌘K, a bell
 *      item or another page link it) switches to that agent's project,
 *      then opens it, and says so: "Switched to south · Back to north".
 *   4. Scope wins: when the top bar's project changes, the list, the pane
 *      and the To line follow it together. The pane moves to that
 *      project's most recent running agent, else "Pick an agent in
 *      <project>"; the old agent keeps running, counted as hidden.
 *   5. The To line names the agent and its project, the top bar's.
 *   6. A reload keeps the pair: every ?open= id is in ?project=.
 *   7. Stop-ship: what a person types reaches exactly the agent the To
 *      line names, after a project switch, a tab switch and a reload.
 *
 * The demo distribution (acme; north and south active) with a session
 * host in this process and a scripted PTY: nothing really runs.
 * Needs Playwright's chromium; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../../sessions/helpers/fake-pty.js";
import { signInUrl } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer | null = null;
let browser: Browser | null = null;
let host: HostClient | null = null;
/** Running agents: their session ids and PTYs. */
const sid: Record<string, string> = {};
const ptys: Record<string, ScriptedPty> = {};
/** A shell in north and one in south, by id. */
const shells: Record<string, string> = {};

beforeAll(async () => {
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
  await run("ada", "north", "2026-11-13T09:00:00.000Z");
  for (const ws of ["north", "south"]) {
    const p = await open(`/agents?terminal=1&ws=${ws}`);
    await p.waitForFunction(() => !/terminal=1/.test(location.search));
    await p.waitForFunction(
      () => !!new URLSearchParams(location.search).get("open"),
    );
    const ids = (new URL(p.url()).searchParams.get("open") ?? "").split(",");
    shells[ws] = ids.find((x) => !Object.values(shells).includes(x)) ?? "";
    await p.context().close();
  }
}, 90_000);

afterAll(async () => {
  await browser?.close();
  host?.close();
  await s?.stop();
});

/** A running agent `id` in `ws`, as `agents start` leaves one. */
async function run(id: string, ws: string, startedAt: string): Promise<void> {
  const info = await host!.start({
    name: `acme-${ws}:${id}`,
    cwd: s!.wsDir(ws),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  sid[id] = info.ref.id;
  ptys[id] = s!.made[s!.made.length - 1];
  s!.seed({
    id,
    persona: "planner",
    workspace: ws,
    session: { backend: "den-pty", id: info.ref.id },
    sessionName: `acme-${ws}:${id}`,
    startedAt,
  });
  ptys[id].emit(`${id} ready\r\n$ `);
}

/** The top bar's project pick: the view, then the page's address (header.js). */
async function chooseInTopBar(p: Page, ws: string): Promise<void> {
  await p.evaluate(
    (ws) =>
      (
        window as unknown as {
          denShell: { api(m: string, u: string, b: unknown): Promise<unknown> };
        }
      ).denShell.api("POST", "/api/scope", { scope: ws }),
    ws,
  );
  const u = new URL(p.url());
  u.searchParams.delete("ws");
  u.searchParams.set("project", ws);
  await p.goto(u.toString());
}

const param = (p: Page, k: string) => new URL(p.url()).searchParams.get(k);
/** The pane in front's To line, as shown. */
const toLine = async (p: Page) =>
  (
    await p
      .locator(".pane:not([hidden]) .agto")
      .first()
      .textContent({ timeout: 5000 })
  )?.trim() ?? "";
const frontId = (p: Page) =>
  p.$eval(".pane:not([hidden])", (x) => (x as HTMLElement).dataset.id ?? "");

async function open(next: string): Promise<Page> {
  const ctx = await browser!.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const st = document.createElement("style");
      st.textContent = "#cl-overlay{display:none!important}";
      document.head.appendChild(st);
    });
    try {
      localStorage.removeItem("den-agents-open");
    } catch {
      /* none */
    }
  });
  const p = await ctx.newPage();
  await p.goto(signInUrl(s!.stateDir, s!.base, next));
  return p;
}

/** The projects of the list's groups, and the tabs' ids. */
const listed = (p: Page) =>
  p.$$eval("#agl .wsg", (xs) => xs.map((x) => (x as HTMLElement).dataset.ws));
const tabs = (p: Page) =>
  p.$$eval(".agtab[data-id]", (xs) =>
    xs.map((x) => (x as HTMLElement).dataset.id),
  );
const openParam = (p: Page) =>
  (new URL(p.url()).searchParams.get("open") ?? "").split(",").filter(Boolean);

describe("#80: a project's view holds only its own", () => {
  it("the list, the tabs and ?open= hold north's; south's tab is hidden, said in one line", async () => {
    if (!browser) return;
    expect(shells.north && shells.south).toBeTruthy();
    const p = await open(
      `/agents?ws=north&layout=tabs&open=${shells.north},${shells.south}`,
    );
    await p.waitForSelector("#agl .wsg");
    await p.waitForTimeout(500);
    expect(await listed(p)).toEqual(["north"]);
    expect(await tabs(p)).toEqual([shells.north]);
    expect(openParam(p)).toEqual([shells.north]);
    const note = p.locator('#agl [data-note="other-tabs"]');
    expect((await note.textContent())?.replace(/\s+/g, " ").trim()).toBe(
      "1 tab from other projects hidden · Show in All active",
    );
    // Show in All active: every project, and both tabs.
    await note.locator("button").click();
    await p.waitForFunction(
      () => !new URLSearchParams(location.search).get("ws"),
    );
    await p.waitForSelector(`.agtab[data-id="${shells.south}"]`);
    expect((await tabs(p)).sort()).toEqual([shells.north, shells.south].sort());
    expect((await listed(p)).sort()).toEqual(["north", "south"]);
    await p.context().close();
  }, 60_000);

  it("a link to one agent in another project switches to its project, then opens it", async () => {
    if (!browser) return;
    s!.seed({
      id: "scout",
      persona: "reviewer",
      workspace: "south",
      resumeToken: "77777777-7777-4777-8777-777777777777",
      stoppedAt: "2026-11-06T10:00:00.000Z",
    });
    const p = await open(`/agents?ws=north&agent=scout`);
    await p.waitForFunction(
      () =>
        new URLSearchParams(location.search).get("ws") === "south" ||
        new URLSearchParams(location.search).get("project") === "south",
    );
    await p.waitForSelector('#agl .agst[data-agent="scout"]');
    expect(await listed(p)).not.toContain("north");
    await p.context().close();
  }, 60_000);

  it("deliberately opening another project's agent says so, and Back returns", async () => {
    if (!browser) return;
    const p = await open(`/agents?project=north&agent=scout`);
    await p.waitForFunction(
      () => new URLSearchParams(location.search).get("project") === "south",
    );
    const note = p.locator('#agl [data-note="switched"]');
    await note.waitFor();
    expect((await note.textContent())?.replace(/\s+/g, " ").trim()).toBe(
      "Switched to south · Back to north",
    );
    // The top bar says south too: the scope and the pane agree.
    await p.waitForFunction(() =>
      /south/.test(document.getElementById("ws-pill")?.textContent ?? ""),
    );
    // A reload keeps the pair: every tab is south's.
    await p.reload();
    await p.waitForSelector("#agl .wsg");
    expect(param(p, "project")).toBe("south");
    expect(await listed(p)).toEqual(["south"]);
    await p.context().close();
  }, 60_000);

  it("Back to the project you came from", async () => {
    if (!browser) return;
    const p = await open(`/agents?project=north&agent=scout`);
    const note = p.locator('#agl [data-note="switched"]');
    await note.waitFor();
    await note.locator("button").click();
    await p.waitForFunction(
      () => new URLSearchParams(location.search).get("project") === "north",
    );
    await p.waitForFunction(() =>
      Array.from(document.querySelectorAll("#agl .wsg")).every(
        (x) => (x as HTMLElement).dataset.ws === "north",
      ),
    );
    expect(await listed(p)).toEqual(["north"]);
    await expect(p.locator("#ws-pill").textContent()).resolves.toContain(
      "north",
    );
    await p.context().close();
  }, 60_000);
});

describe("#80: scope wins", () => {
  it("choosing a project with no running agent: the pane says to pick one there", async () => {
    if (!browser) return;
    const p = await open(`/agents?project=north&layout=focus&open=${sid.ada}`);
    await p.waitForSelector(`.pane[data-id="${sid.ada}"]`);
    expect(await toLine(p)).toBe("To ada · north");
    await chooseInTopBar(p, "south");
    await p.waitForSelector("#agl .wsg");
    await p.waitForTimeout(500);
    expect(await listed(p)).toEqual(["south"]);
    expect(
      await p.$$(`.pane[data-id="${sid.ada}"]:not([hidden])`),
    ).toHaveLength(0);
    expect((await p.locator("#agr").textContent())?.trim()).toContain(
      "Pick an agent in south",
    );
    // ada keeps running, counted as hidden.
    expect(ptys.ada.signals).toEqual([]);
    expect(
      (await p.locator('#agl [data-note="other-tabs"]').textContent())
        ?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 tab from other projects hidden · Show in All active");
    await p.context().close();
  }, 60_000);

  it("choosing a project moves the pane and the To line to its most recent agent", async () => {
    if (!browser) return;
    await run("bo", "south", "2026-11-13T09:05:00.000Z");
    const p = await open(`/agents?project=north&layout=focus&open=${sid.ada}`);
    await p.waitForSelector(`.pane[data-id="${sid.ada}"]`);
    await chooseInTopBar(p, "south");
    await p.waitForSelector(`.pane[data-id="${sid.bo}"]:not([hidden])`);
    expect(await listed(p)).toEqual(["south"]);
    expect(await frontId(p)).toBe(sid.bo);
    expect(await toLine(p)).toBe("To bo · south");
    // The pair holds in the address too.
    expect(param(p, "project")).toBe("south");
    expect(openParam(p)).toEqual([sid.bo]);
    await p.context().close();
  }, 60_000);

  it("stop-ship: typing reaches exactly the To line's agent after a project switch, a tab switch and a reload", async () => {
    if (!browser) return;
    if (!sid.bo) await run("bo", "south", "2026-11-13T09:05:00.000Z");
    const p = await open(`/agents?project=north&layout=tabs&open=${sid.ada}`);
    await p.waitForSelector(`.pane[data-id="${sid.ada}"]`);
    // A project switch …
    await chooseInTopBar(p, "south");
    await p.waitForSelector(`.pane[data-id="${sid.bo}"]:not([hidden])`);
    // … a tab switch (south's shell, then bo again) …
    await p.click(`#agl .agr[data-id="${shells.south}"]`);
    await p.waitForSelector(`.pane[data-id="${shells.south}"]:not([hidden])`);
    await p.click(`.agtab[data-id="${sid.bo}"]`);
    await p.waitForSelector(`.pane[data-id="${sid.bo}"]:not([hidden])`);
    // … and a reload.
    await p.reload();
    await p.waitForSelector(".pane:not([hidden]) .agto:not(:empty)");
    // The reload keeps bo in front, and the To line names it and south.
    expect(await frontId(p)).toBe(sid.bo);
    expect(param(p, "project")).toBe("south");
    expect(await toLine(p)).toBe("To bo · south");
    await p.click(".pane:not([hidden]) .term");
    // Every PTY, the shells' too: only bo's gets the typing.
    const from = s!.made.map((x) => x.writes.length);
    await p.keyboard.type("zz-stop-ship");
    await p.waitForTimeout(500);
    const got = s!.made.filter((x, i) =>
      Buffer.concat(x.writes.slice(from[i]))
        .toString()
        .includes("zz-stop-ship"),
    );
    expect(got).toEqual([ptys.bo]);
    await p.context().close();
  }, 90_000);
});
