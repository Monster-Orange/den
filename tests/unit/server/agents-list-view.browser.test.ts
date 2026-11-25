/**
 * The agents page's list, on Ward's report on 0.4.89 ("By group | by
 * product → centered, smaller"; "list of agents ... scrolls both
 * vertically and horizontally"):
 *
 *   1. The view switch (By project | By group) sits centred above the
 *      list, at the layout switch's size (Focus | Tabs | Tile: the page's
 *      other segmented control).
 *   2. On a narrow screen with an agent open, the list keeps three whole
 *      agent rows in view when they fit (390x1000): its notes and the view
 *      switch never take their room. It held about none (a 6rem floor,
 *      mostly notes).
 *   3. Where they don't fit (390x844, the runs dock open) the pane's To
 *      line stays above the dock (issue 170) and the list keeps at least
 *      one whole row, then scrolls.
 *
 * Long agent names, personas and model labels, and many Hub groups (this
 * test's own answer to GET /api/hub/groups: here there is no Hub).
 * Invented names only. Chromium and WebKit; DEN_SKIP_BROWSER_TESTS=1
 * skips it.
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
/** No agent open, or the running ones open in a layout. */
type Layout = "none" | "focus" | "tabs" | "tile";

let s: AgentsPageServer | null = null;
let host: HostClient | null = null;
/** The running agents' session ids, opened in the pane. */
const sids: string[] = [];
const southSids: string[] = [];
const browsers: Partial<Record<BrowserEngine, Browser>> = {};

/** A long name with nowhere to break, as an agent id can be. */
const LONG = (n: number) => `releasecoordinatorforthenorthandsouthprojects${n}`;
const IDS = Array.from({ length: 14 }, (_, i) =>
  i % 2 ? LONG(i) : `agent-${i}`,
);
const RUNNING = [LONG(91), LONG(92), "runner-3"];
/** South's running agents: two, so its third row is a stopped one. */
const SOUTH = ["south-a", "south-b"];

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
  // Two running agents in south, above its stopped ones (a shut Stopped).
  for (const [i, id] of SOUTH.entries()) {
    const info = await host.start({
      name: `acme-south:${id}`,
      cwd: s.wsDir("south"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    southSids.push(info.ref.id);
    s.seed({
      id,
      persona: "planner",
      workspace: "south",
      session: { backend: "den-pty", id: info.ref.id },
      sessionName: `acme-south:${id}`,
      startedAt: `2026-11-13T11:0${i}:00.000Z`,
    });
    s.made[s.made.length - 1].emit(`${id} ready\r\n$ `);
  }
  IDS.forEach((id, i) =>
    s!.seed({
      id,
      persona: i % 3 ? "planner" : "a-persona-with-a-very-long-name-too",
      workspace: i % 2 ? "north" : "south",
      startedAt: `2026-11-13T09:${String(i).padStart(2, "0")}:00.000Z`,
      // Stopped by a person: Stopped (n), not Interrupted.
      stoppedAt: `2026-11-13T09:${String(i).padStart(2, "0")}:30.000Z`,
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
  height = 800,
  path?: string,
): Promise<Page> {
  const ctx = await browsers[engine]!.newContext({
    viewport: { width, height },
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
  await p.addInitScript(
    ({ by, shut }) => {
      try {
        localStorage.setItem("den-agents-by", by);
        // Stopped (n) shut, as a person left it.
        if (shut) localStorage.setItem("den-agents-stopped-open", "0");
      } catch {
        /* none */
      }
    },
    { by, shut: !!path },
  );
  await signInPage(
    p,
    s!.stateDir,
    s!.base,
    path ??
      (layout === "none"
        ? "/agents"
        : `/agents?open=${sids.join(",")}&layout=${layout}`),
  );
  await p.waitForSelector("[data-by-switch]");
  // What's new, over the page on a first visit: seen.
  await p
    .getByRole("button", { name: "Got it" })
    .click({ timeout: 3000 })
    .catch(() => {});
  await p.waitForFunction(
    (n) => document.body.textContent!.includes(n),
    path ? SOUTH[1] : IDS[1],
  );
  if (layout !== "none") {
    await p.waitForFunction(
      (n) =>
        Array.from(
          document.querySelectorAll("#agl button[data-kind][aria-pressed]"),
        ).some((b) => b.getAttribute("aria-pressed") === "true") ||
        document.body.textContent!.includes(n),
      "runner-3 ready",
    );
  }
  return p;
}

const skip = () =>
  !Object.keys(browsers).length && process.env.DEN_SKIP_BROWSER_TESTS === "1";

describe("the agents page's list", () => {
  for (const engine of ENGINES)
    it(`${engine}: the view switch is centred above the list, the layout switch's size`, async () => {
      if (skip()) return;
      const p = await open(engine, 1280, "group");
      try {
        const m = await p.evaluate(() => {
          const sw = document.querySelector("[data-by-switch]")!;
          const box = sw.parentElement!.getBoundingClientRect();
          const r = sw.getBoundingClientRect();
          const by = sw.querySelector("button")!;
          const lay = document.querySelector("[data-layouts] button")!;
          const cs = (e: Element) => {
            const c = getComputedStyle(e);
            return {
              font: c.fontSize,
              pad: `${c.paddingTop} ${c.paddingRight}`,
              height: Math.round(e.getBoundingClientRect().height),
            };
          };
          return {
            centred: Math.abs(r.left - box.left - (box.right - r.right)) <= 2,
            by: cs(by),
            layout: cs(lay),
          };
        });
        expect(m.centred).toBe(true);
        expect(m.by).toEqual(m.layout);
      } finally {
        await p.context().close();
      }
    }, 60_000);

  for (const engine of ENGINES)
    for (const by of ["project", "group"] as const)
      it(`${engine}, 390x1000, By ${by}, an agent open: the list keeps three whole rows in view (two By group, under its long group headers)`, async () => {
        if (skip()) return;
        const p = await open(engine, 390, by, "focus", 1000);
        try {
          const m = await p.evaluate(() => {
            const list = document.getElementById("agl")!;
            list.scrollTop = 0;
            const box = list.getBoundingClientRect();
            const rows = Array.from(
              list.querySelectorAll("button[data-kind]"),
            ).filter((r) => {
              const b = r.getBoundingClientRect();
              return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
            });
            return {
              rows: rows.length,
              listHeight: Math.round(box.height),
            };
          });
          // By group, each group's header (its name, lead and Message group)
          // takes rows' room too: with this test's long two-line names, two
          // whole rows fit at 390x1000.
          expect(m.rows).toBeGreaterThanOrEqual(by === "project" ? 3 : 2);
        } finally {
          await p.context().close();
        }
      }, 60_000);

  // A phone (390x844) with the runs dock shut: the page header, the
  // pane's minimum and the To line above the dock bar (issue 170) leave the
  // list room for two whole rows, past its note and the view switch. On
  // 0.4.89 it held one at most: the note and the switch filled its 6rem.
  for (const engine of ENGINES)
    it(`${engine}, 390x844, By project, an agent open, the runs dock shut: two whole rows in view`, async () => {
      if (skip()) return;
      const p = await open(engine, 390, "project", "focus", 844);
      try {
        const rows = await p.evaluate(() => {
          const list = document.getElementById("agl")!;
          list.scrollTop = 0;
          const box = list.getBoundingClientRect();
          return Array.from(list.querySelectorAll("button[data-kind]")).filter(
            (r) => {
              const b = r.getBoundingClientRect();
              return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
            },
          ).length;
        });
        expect(rows).toBeGreaterThanOrEqual(2);
      } finally {
        await p.context().close();
      }
    }, 60_000);

  for (const engine of ENGINES)
    it(`${engine}, 390x844, By project, an agent open, the runs dock open: the To line stays above the dock, the list keeps a whole row`, async () => {
      if (skip()) return;
      const p = await open(engine, 390, "project", "focus", 844);
      try {
        const saved = () =>
          p.waitForResponse(
            (r) =>
              r.url().endsWith("/api/settings") &&
              r.request().method() === "POST",
          );
        const isOpen = () => p.locator("#den-dock-out").count();
        // Open it (a saved choice: a case before may have left it open).
        if (!(await isOpen())) {
          const wrote = saved();
          await p.click('[data-act="dock"]');
          await p.waitForSelector("#den-dock-out");
          await wrote;
        }
        const look = () =>
          p.evaluate(() => {
            const list = document.getElementById("agl")!;
            list.scrollTop = 0;
            const c = document.getElementById("den-content")!;
            c.scrollTop = c.scrollHeight;
            window.scrollTo(0, document.documentElement.scrollHeight);
            const box = list.getBoundingClientRect();
            const rows = Array.from(
              list.querySelectorAll("button[data-kind]"),
            ).filter((r) => {
              const b = r.getBoundingClientRect();
              return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
            }).length;
            // The open pane's To line (the one shown).
            const to = Array.from(
              document.querySelectorAll("#agr [data-to]"),
            ).find((e) => e.getBoundingClientRect().height > 0)!;
            return {
              rows,
              to: to.getBoundingClientRect().bottom,
              dock: document.getElementById("den-dock")!.getBoundingClientRect()
                .top,
            };
          });
        // The floor follows the dock (a ResizeObserver, before a paint):
        // two frames on, it has.
        await p.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
        const m = await look();
        expect(m.to).toBeLessThanOrEqual(m.dock + 0.5);
        expect(m.rows).toBeGreaterThanOrEqual(1);
      } finally {
        // Shut again: the choice is saved, and the other cases start shut.
        if (await p.locator("#den-dock-out").count()) {
          const wrote = p.waitForResponse(
            (r) =>
              r.url().endsWith("/api/settings") &&
              r.request().method() === "POST",
          );
          await p.click('[data-act="dock"]');
          await wrote;
        }
        await p.context().close();
      }
    }, 60_000);

  // A project with two running agents, then its stopped ones in a shut
  // Stopped section: the floor counts only rows that are drawn.
  for (const engine of ENGINES) {
    it(`${engine}, 390x844, two running agents and a shut Stopped, one open: both running rows whole`, async () => {
      if (skip()) return;
      const p = await open(
        engine,
        390,
        "project",
        "focus",
        844,
        `/agents?project=south&open=${southSids[0]}&layout=focus`,
      );
      try {
        const m = await p.evaluate(() => {
          const list = document.getElementById("agl")!;
          list.scrollTop = 0;
          const box = list.getBoundingClientRect();
          const whole = Array.from(
            list.querySelectorAll('button[data-kind][data-state="running"]'),
          ).filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top >= box.top - 0.5 && b.bottom <= box.bottom + 0.5;
          }).length;
          return {
            whole,
            floor: document
              .getElementById("agx")!
              .style.getPropertyValue("--agl-floor"),
          };
        });
        expect(m).toEqual({
          whole: 2,
          floor: expect.stringMatching(/^\d+px$/),
        });
      } finally {
        await p.context().close();
      }
    }, 60_000);

    it(`${engine}, 390x844, two running agents and a shut Stopped, none open: the floor ends at the last drawn row, never negative`, async () => {
      if (skip()) return;
      const p = await open(
        engine,
        390,
        "project",
        "none",
        844,
        "/agents?project=south",
      );
      try {
        // The floor ends at the last row drawn (the second running one),
        // never at a row in the shut Stopped (n), and is never negative.
        const m = await p.evaluate(() => {
          const el = document.getElementById("agl")!;
          const top = el.getBoundingClientRect().top - el.scrollTop;
          const border = el.offsetHeight - el.clientHeight;
          const running = Array.from(
            el.querySelectorAll('button[data-kind][data-state="running"]'),
          );
          const last = running[running.length - 1].getBoundingClientRect();
          return {
            floor: parseFloat(
              document
                .getElementById("agx")!
                .style.getPropertyValue("--agl-floor"),
            ),
            want: Math.max(96, Math.ceil(last.bottom - top + border)),
          };
        });
        expect(m.floor).toBeGreaterThanOrEqual(0);
        expect(Math.abs(m.floor - m.want)).toBeLessThanOrEqual(1);
      } finally {
        await p.context().close();
      }
    }, 60_000);
  }
});
