/**
 * The agents page fits its window: the list never makes the page scroll
 * sideways. A person saw the list break the page's width, so it scrolled
 * both ways, with long agent names and many groups.
 *
 * By project and By group; no agent open, and three running agents open
 * in Focus, Tabs and Tile; at 1280 and 390 wide: the page and every box
 * that scrolls on its own (the list too) fit their width. Agent names, a
 * persona and a model label are long with nowhere to break, and the
 * order error line under the list (a move Den refused, issue 1054) shows
 * at its longest. That line had no style, so at 390 it made the page
 * 644px wide.
 *
 * Hub's groups are this test's own answer to GET /api/hub/groups (Den
 * reads them from Hub; here there is no Hub). Invented names only.
 * Runs in Chromium and WebKit; DEN_SKIP_BROWSER_TESTS=1 skips it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page } from "playwright";
import {
  connectHost,
  type HostClient,
} from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import { signInPage } from "./helpers/signed-in.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser, type BrowserEngine } from "../helpers/browser.js";

const ENGINES: BrowserEngine[] = ["chromium", "webkit"];
/** No agent open, or the running ones open in each layout. */
type Layout = "none" | "focus" | "tabs" | "tile";
const LAYOUTS: Layout[] = ["none", "focus", "tabs", "tile"];
const WIDTHS = [1280, 390];

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
/** The running agents' session ids, opened in the pane. */
const sids: string[] = [];
const browsers: Partial<Record<BrowserEngine, Browser>> = {};

/** A long name with nowhere to break, as an agent id can be. */
const LONG = (n: number) => `releasecoordinatorforthenorthandsouthprojects${n}`;
const IDS = Array.from({ length: 14 }, (_, i) =>
  i % 2 ? LONG(i) : `agent-${i}`,
);
const RUNNING = [LONG(91), LONG(92), "runner-3"];

/** Many groups, some with long names, each holding a few of the agents. */
const GROUPS = Array.from({ length: 9 }, (_, g) => {
  const slug = `group-${g}`;
  const name =
    g % 3 === 0
      ? `The quality-and-release-readiness working group number ${g}`
      : `Group ${g}`;
  const members = [...RUNNING, ...IDS]
    .filter((_, i) => i % 9 === g)
    .map((id) => ({
      role: "member",
      address: `${slug}/${id}`,
      name: id,
      kind: "agent",
      agentId: id,
      here: true,
    }));
  return {
    name,
    slug,
    all: `${slug}/all`,
    address: `${slug}/lead`,
    // Hub's lead may be a person, named by a long address.
    lead:
      g % 2
        ? {
            role: "lead",
            address: `${slug}/lead`,
            name: "quality.and.release.readiness.lead@example-company.test",
            kind: "person",
          }
        : members[0]
          ? { ...members[0], role: "lead" }
          : null,
    members,
    open: `https://hub.example.test/acme/groups/${slug}`,
    compose: `https://hub.example.test/acme/compose?to=${slug}/all`,
  };
});

beforeAll(async () => {
  for (const engine of ENGINES) {
    try {
      const pw = await import("playwright");
      browsers[engine] = await launchBrowser(pw[engine]);
    } catch (err) {
      if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
      throw err;
    }
  }
  s = await startAgentsPageServer({});
  host = await connectHost(sessionPaths(s.stateDir).socket);
  // Three running agents, the first two with long names, persona and model.
  for (const [i, id] of RUNNING.entries()) {
    const info = await host.start({
      name: `acme-north:${id}`,
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    sids.push(info.ref.id);
    s.seed({
      id,
      persona:
        i < 2 ? "apersonawithaverylongnamethatcannotbreakanywhere" : "planner",
      model:
        i < 2
          ? "claude-model-with-a-very-long-pinned-version-name-20261124"
          : undefined,
      workspace: "north",
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-north:${id}`,
      startedAt: `2026-11-13T10:0${i}:00.000Z`,
    });
    s.made[s.made.length - 1].emit(`${id} ready\r\n$ `);
  }
  IDS.forEach((id, i) =>
    s!.seed({
      id,
      persona: i % 3 ? "planner" : "a-persona-with-a-very-long-name-too",
      workspace: i % 2 ? "north" : "south",
      startedAt: `2026-11-13T09:${String(i).padStart(2, "0")}:00.000Z`,
    }),
  );
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({
    browsers: Object.values(browsers),
    servers: [host, s],
  });
});

async function open(
  engine: BrowserEngine,
  width: number,
  by: "project" | "group",
  layout: Layout = "none",
): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width, height: 800 },
  });
  const p = await ctx.newPage();
  await p.route("**/api/hub/groups*", (r) =>
    r.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        state: "ok",
        rule: "",
        groups: GROUPS,
        hub: "https://hub.example.test/acme",
        groupsUrl: "https://hub.example.test/acme/groups",
      }),
    }),
  );
  await p.addInitScript((by) => {
    try {
      localStorage.setItem("den-agents-by", by);
    } catch {
      /* none */
    }
  }, by);
  await signInPage(
    p,
    s!.stateDir,
    s!.base,
    layout === "none"
      ? "/agents"
      : `/agents?open=${sids.join(",")}&layout=${layout}`,
  );
  await p.waitForSelector("[data-by-switch]");
  // What's new, over the page on a first visit: seen.
  await p
    .getByRole("button", { name: "Got it" })
    .click({ timeout: 3000 })
    .catch(() => {});
  await p.waitForFunction(
    (n) => document.body.textContent!.includes(n),
    IDS[1],
  );
  if (layout !== "none") {
    await p.waitForFunction(
      (n) =>
        Array.from(document.querySelectorAll(".agl .agr[aria-pressed]")).some(
          (b) => b.getAttribute("aria-pressed") === "true",
        ) || document.body.textContent!.includes(n),
      "runner-3 ready",
    );
  }
  // The page's one error line (a move in the list that Den refused),
  // at its longest: the agent's long name and a reason with nowhere to
  // break, as a path in it can be.
  await p.evaluate(
    ({ id, why }) => {
      const e = document.getElementById("ag-order-err")!;
      e.textContent = `Couldn't move ${id}. ${why}`;
      e.hidden = false;
    },
    {
      id: RUNNING[0],
      why: `/home/someone/.local/state/den/agents/${RUNNING[0]}/order.json`,
    },
  );
  return p;
}

const skip = () =>
  !Object.keys(browsers).length && process.env.DEN_SKIP_BROWSER_TESTS === "1";

describe("the agents page fits its window", () => {
  for (const engine of ENGINES)
    for (const width of WIDTHS)
      for (const by of ["project", "group"] as const)
        for (const layout of LAYOUTS)
          it(`${engine}, ${width} wide, By ${by}, ${layout === "none" ? "no agent open" : `agents open in ${layout}`}: no sideways scroll`, async () => {
            if (skip()) return;
            const p = await open(engine, width, by, layout);
            try {
              const m = await p.evaluate(() => {
                // The page, and every box that scrolls on its own (the list
                // is one): each one's content fits its width. For one that
                // doesn't, the child that ends furthest past its edge.
                // The tab strip (.agtabs) scrolls sideways by design: more
                // tabs than fit.
                const boxes = [document.scrollingElement!].concat(
                  Array.from(document.querySelectorAll("*")).filter(
                    (el) =>
                      !el.classList.contains("agtabs") &&
                      /auto|scroll/.test(getComputedStyle(el).overflowX),
                  ),
                );
                const name = (el: Element) =>
                  `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${String(
                    (el as HTMLElement).className,
                  )
                    .trim()
                    .replace(/\s+/g, ".")}`;
                return boxes
                  .filter(
                    (b) =>
                      b.clientWidth > 0 && b.scrollWidth > b.clientWidth + 1,
                  )
                  .map((b) => {
                    // What spills: the deepest element under this box whose
                    // content is wider than it, and not clipped on the way
                    // (a row's ellipsis hides its own).
                    const clipped = (el: Element) => {
                      for (
                        let x = el.parentElement;
                        x && x !== b;
                        x = x.parentElement
                      )
                        if (getComputedStyle(x).overflowX !== "visible")
                          return true;
                      return false;
                    };
                    const spills = Array.from(b.querySelectorAll("*")).filter(
                      (el) =>
                        getComputedStyle(el).overflowX === "visible" &&
                        el.scrollWidth > el.clientWidth + 1 &&
                        el.clientWidth > 0 &&
                        !clipped(el),
                    );
                    const worst = spills.length
                      ? name(spills[spills.length - 1])
                      : "";
                    return `${name(b)} ${b.scrollWidth} > ${b.clientWidth}: ${worst}`;
                  });
              });
              expect(m).toEqual([]);
            } finally {
              await p.context().close();
            }
          }, 60_000);
});
