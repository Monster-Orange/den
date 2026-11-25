/**
 * Peek, one agent's live terminal in a panel over the page you
 * are on, from a bell row. The approved mock's rules table (in Hub, Den
 * project: "Peek: answer one agent without leaving your view (mock)",
 * version 2), one describe per rule, on the parts that need no browser
 * (public/peek.js and public/bell.js). The browser half (Esc, ×, the dim
 * area, focus back, nothing left open, the phone sheet, typing) is
 * peek.browser.test.ts. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";

const g = globalThis as unknown as { window?: unknown };
const had = g.window;
beforeAll(() => {
  g.window = {
    denShell: {
      t: (k: string, v?: Record<string, unknown>) =>
        `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`,
      lang: () => "en",
    },
  };
});
afterAll(() => {
  g.window = had;
});

const peek = () => import("../../../src/ui/server/public/peek.js");
const bell = () => import("../../../src/ui/server/public/bell.js");

const waiting = (agent: string, ws = "north", extra = {}) => ({
  id: `n-${agent}`,
  kind: "waiting",
  subject: `agent:${agent}`,
  scope: `workspace/${ws}`,
  text: `${agent} needs your permission`,
  link: `/agents?project=${ws}&agent=${agent}`,
  at: new Date().toISOString(),
  read: false,
  ...extra,
});

const bellOf = (...items: ReturnType<typeof waiting>[]) => ({
  groups: items.map((n) => ({
    scope: n.scope,
    subjects: [{ subject: n.subject, items: [n] }],
  })),
  unread: items.length,
});

const row = (agent: string, o: Record<string, unknown> = {}) => ({
  id: `sid-${agent}`,
  name: `acme-north:${agent}`,
  workspace: "north",
  kind: "agent",
  label: agent,
  agent,
  state: "running",
  exited: false,
  attachable: true,
  ...o,
});

describe("rule: Opens from (a click on a bell row; Open in Agents keeps the page)", () => {
  it("an agent's row is a peek: its link says so, and a small Open in Agents link goes to the page", async () => {
    const { bellHtml } = await bell();
    const h = bellHtml(bellOf(waiting("planner")));
    expect(h).toMatch(
      /<a href="\/agents\?project=north&amp;agent=planner" data-bell="open" data-peek="planner"[^>]*>/,
    );
    expect(h).toMatch(
      /<a href="\/agents\?project=north&amp;agent=planner" class="den-bell-page" data-bell="page">\[bell\.openInAgents\]<\/a>/,
    );
  });

  it("a row that isn't an agent's (Settings, Hub) opens as before: no peek, no second link", async () => {
    const { bellHtml } = await bell();
    const h = bellHtml(
      bellOf(
        waiting("x", "north", {
          subject: "record:hub-pick",
          kind: "decision",
          link: "/settings#agents.hub_link_all",
        }),
        waiting("hubby", "north", {
          kind: "answer",
          link: "https://hub.example.test/a/thing",
        }),
      ),
    );
    expect(h).not.toMatch(/data-peek/);
    expect(h).not.toMatch(/data-bell="page"/);
  });

  it("peekTarget: an agent subject with Den's own Agents link; nothing else", async () => {
    const { peekTarget } = await peek();
    expect(peekTarget(waiting("planner"))).toEqual({
      agent: "planner",
      workspace: "north",
      link: "/agents?project=north&agent=planner",
    });
    expect(peekTarget({ ...waiting("p"), link: undefined })).toEqual({
      agent: "p",
      workspace: "north",
      link: "/agents?project=north&agent=p",
    });
    expect(peekTarget({ ...waiting("p"), link: "https://x.test/" })).toBe(null);
    expect(peekTarget({ ...waiting("p"), subject: "thread:1" })).toBe(null);
    expect(peekTarget({ ...waiting("p"), link: "//evil.test/agents" })).toBe(
      null,
    );
  });
});

describe("rule: What it is (the agent's real terminal in a panel; typing works)", () => {
  it("the panel is the kit's dialog, named by the agent, with the terminal's place and who typing goes to", async () => {
    const { peekHtml, peekView } = await peek();
    const v = peekView(row("planner", { waiting: true }), {
      conn: "live",
      projectName: "north",
    });
    const h = peekHtml(v, "/agents?project=north&agent=planner");
    expect(h).toMatch(
      /^<dialog id="den-peek" class="dk-dlg dk-panel dk-sheet den-peek"/,
    );
    expect(h).toMatch(/aria-labelledby="den-peek-h"/);
    expect(h).toMatch(/<h2 id="den-peek-h" tabindex="-1">planner<\/h2>/);
    expect(h).toMatch(/class="den-peek-term"/);
    expect(h).toContain("[peek.footType:planner]");
  });

  it("typing goes nowhere while it connects, or once the agent stopped", async () => {
    const { peekView } = await peek();
    expect(
      peekView(row("planner"), { conn: "connecting", projectName: "north" })
        .typing,
    ).toBe(false);
    expect(
      peekView(row("planner", { exited: true, state: "stopped" }), {
        conn: "live",
        projectName: "north",
      }).typing,
    ).toBe(false);
    const c = peekView(row("planner"), {
      conn: "connecting",
      projectName: "north",
    });
    expect(c.foot).toBe("[peek.footEsc]");
    expect(c.body).toBe("[peek.connecting:planner]");
  });

  it("the name is the one the person gave the agent, when there is one", async () => {
    const { peekView } = await peek();
    expect(
      peekView(row("planner", { displayName: "Plans" }), {
        conn: "live",
        projectName: "north",
      }).name,
    ).toBe("Plans");
  });
});

describe("rule: Closes (Esc, ×, the dim area)", () => {
  it("× is labelled Close (Esc) in the page's language", async () => {
    const { peekHtml, peekView } = await peek();
    const h = peekHtml(
      peekView(row("planner"), { conn: "live", projectName: "north" }),
      "/agents",
    );
    expect(h).toMatch(
      /<button type="submit" class="[^"]*\bdk-x\b[^"]*" value="close" data-dk="close" aria-label="\[peek\.close\]" title="\[peek\.close\]">×<\/button>/,
    );
  });
});

describe("rule: Keep it (Open in layout)", () => {
  it("Open in layout is a link to the agent in the Agents layout", async () => {
    const { peekHtml, peekView } = await peek();
    const h = peekHtml(
      peekView(row("planner"), { conn: "live", projectName: "north" }),
      "/agents?project=north&agent=planner",
    );
    expect(h).toMatch(
      /<a class="[^"]*\bden-peek-layout\b[^"]*" href="\/agents\?project=north&amp;agent=planner" data-peek="layout">\[peek\.openInLayout\]<\/a>/,
    );
  });
});

describe("rule: Another agent needs you (a strip, Switch to …, never two panels)", () => {
  it("nextNeeding: the first other agent in Needs you, with its name, project and why", async () => {
    const { nextNeeding } = await peek();
    const b = bellOf(
      waiting("planner"),
      waiting("reviewer", "south"),
      waiting("third"),
    );
    const rows = [
      row("planner", { waiting: true, waitingWhy: "permission" }),
      row("reviewer", {
        workspace: "south",
        waiting: true,
        waitingWhy: "asked",
      }),
    ];
    expect(nextNeeding(b, rows, "planner")).toEqual({
      agent: "reviewer",
      workspace: "south",
      link: "/agents?project=south&agent=reviewer",
      name: "reviewer",
      why: "asked",
    });
    expect(nextNeeding(bellOf(waiting("planner")), rows, "planner")).toBe(null);
    expect(nextNeeding(null, rows, "planner")).toBe(null);
  });

  it("the strip names the next one and offers Switch to it", async () => {
    const { peekView, stripHtml } = await peek();
    const v = peekView(row("planner", { waiting: true }), {
      conn: "live",
      projectName: "north",
      next: {
        agent: "reviewer",
        workspace: "south",
        link: "/agents?project=south&agent=reviewer",
        name: "reviewer",
        why: "asked",
      },
    });
    expect(v.strip).toMatchObject({ kind: "warn", act: "switch" });
    const h = stripHtml(v);
    expect(h).toContain("[peek.next:reviewer|south|[ag.waiting.asked]]");
    expect(h).toMatch(
      /<button type="button" class="den-btn sm" data-peek="switch" data-agent="reviewer" data-ws="south">\[peek\.switch:reviewer\]<\/button>/,
    );
  });
});

describe("rule: The agent finishes or stops (the chip and a strip; Restart; the panel stays)", () => {
  it("waiting: Needs you, with why", async () => {
    const { peekView } = await peek();
    const v = peekView(
      row("planner", { waiting: true, waitingWhy: "permission" }),
      {
        conn: "live",
        projectName: "north",
      },
    );
    expect(v.mark).toBe("need");
    expect(v.chip).toEqual({
      kind: "need",
      text: "[peek.chipNeed:[ag.waiting.permission]]",
    });
  });

  it("finished while you looked: Done, and a strip saying it is Idle for you now", async () => {
    const { peekView } = await peek();
    const v = peekView(row("planner"), {
      conn: "live",
      projectName: "north",
      wasNeeding: true,
    });
    expect(v.mark).toBe("done");
    expect(v.chip).toEqual({ kind: "done", text: "[peek.chipDone]" });
    expect(v.strip).toMatchObject({
      kind: "ok",
      text: "[peek.finished:planner]",
      act: "close",
    });
  });

  it("stopped: the chip says so, and Restart (an agent that can resume)", async () => {
    const { peekView, stripHtml } = await peek();
    const v = peekView(row("planner", { exited: true, state: "stopped" }), {
      conn: "live",
      projectName: "north",
    });
    expect(v.mark).toBe("idle");
    expect(v.chip).toEqual({ kind: "idle", text: "[peek.chipStopped]" });
    expect(v.strip).toMatchObject({
      kind: "bad",
      text: "[peek.stopped:planner]",
      act: "restart",
    });
    expect(stripHtml(v)).toMatch(/data-peek="restart"/);
    // A plain shell has nothing to restart.
    const sh = peekView(
      row("sh", { kind: "session", agent: undefined, exited: true }),
      { conn: "live", projectName: "north" },
    );
    expect(sh.strip?.act).toBeUndefined();
  });

  it("could not connect: the strip says so, with Retry", async () => {
    const { peekView } = await peek();
    const v = peekView(row("planner"), {
      conn: "failed",
      projectName: "north",
    });
    expect(v.strip).toMatchObject({
      kind: "bad",
      text: "[peek.noConnect:planner]",
      act: "retry",
    });
    // An agent Den doesn't list (gone): the same, never a blank panel.
    const gone = peekView(null, {
      conn: "connecting",
      projectName: "north",
      agent: "ghost",
    });
    expect(gone.name).toBe("ghost");
    expect(gone.strip).toMatchObject({ kind: "bad", act: "retry" });
  });
});

describe("rule: Phone (a full-screen sheet with a back arrow to the bell)", () => {
  it("the header holds a back arrow, labelled Back to notifications", async () => {
    const { peekHtml, peekView } = await peek();
    const h = peekHtml(
      peekView(row("planner"), { conn: "live", projectName: "north" }),
      "/agents",
    );
    expect(h).toMatch(
      /<div class="dk-hd"><button type="button" class="den-peek-back" data-peek="back" aria-label="\[peek\.back\]">‹<\/button>/,
    );
  });
});
