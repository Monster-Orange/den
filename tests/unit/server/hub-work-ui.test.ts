/**
 * Issue 754: the Work in Hub card (home page), the agent row's current
 * Hub item (Agents page) and the quiet no-Hub line. Pure renderers; the
 * bed walks the real pages.
 */
import { describe, expect, it } from "@jest/globals";

const tt = (k: string, v?: Record<string, unknown>) =>
  `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;
const mod = () =>
  import("../../../src/ui/server/public/hub-work.js") as Promise<{
    hubWorkCardHtml: (b: unknown, t: typeof tt) => string;
    hubCurrentHtml: (c: unknown, t: typeof tt) => string;
    hubQuietLineHtml: (t: typeof tt) => string;
  }>;

const work = (needs: number) => ({
  needsYou: { count: needs, url: "https://hub.example/needs" },
  building: { count: 5, url: "https://hub.example/building" },
  blocked: { count: 1, url: null },
  visions: [
    {
      id: "v1",
      title: "Den <shows> work",
      url: "https://hub.example/v/1",
      done: 3,
      total: 8,
    },
  ],
});

describe("hubWorkCardHtml", () => {
  it("one project: the three counts and each vision's bar, opening Hub", async () => {
    const { hubWorkCardHtml } = await mod();
    const html = hubWorkCardHtml(
      { hub: "ok", projects: [{ project: "den", work: work(2) }] },
      tt,
    );
    expect(html).toContain('id="hub-work-card"');
    expect(html).toContain("[hw.title]");
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/hub.example\/needs"[^>]*>[^]*?2[^]*?\[hw.needsYou\]/,
    );
    expect(html).toMatch(/href="https:\/\/hub.example\/building"/);
    // A count without a link is text, never a link.
    expect(html).toContain('data-count="blocked"');
    expect(html).not.toMatch(/href="null"/);
    // The vision: escaped title, its link, a bar of done of total.
    expect(html).toContain("Den &lt;shows&gt; work");
    expect(html).toMatch(/href="https:\/\/hub.example\/v\/1"/);
    expect(html).toMatch(
      /<progress [^>]*value="3" max="8"[^>]*>|role="progressbar"[^>]*aria-valuenow="3"[^>]*aria-valuemax="8"/,
    );
    expect(html).toContain("[hw.doneOf:3|8]");
    expect(html).not.toContain("hw-proj");
  });

  it("All projects: one row per project", async () => {
    const { hubWorkCardHtml } = await mod();
    const html = hubWorkCardHtml(
      {
        hub: "ok",
        projects: [
          { project: "den", name: "Den", work: work(2) },
          { project: "web", work: work(0) },
          { project: "off", work: null },
        ],
      },
      tt,
    );
    expect(html.match(/class="hw-proj"/g)?.length).toBe(2);
    expect(html).toContain('data-project="den"');
    expect(html).toContain('data-project="web"');
    expect(html).not.toContain('data-project="off"');
  });

  it("no Hub: the quiet line to Connect, no card", async () => {
    const { hubWorkCardHtml, hubQuietLineHtml } = await mod();
    const html = hubWorkCardHtml({ hub: "none" }, tt);
    expect(html).not.toContain("hub-work-card");
    expect(html).toBe(hubQuietLineHtml(tt));
    expect(hubQuietLineHtml(tt)).toMatch(
      /<p class="[^"]*hub-quiet[^"]*"[^>]*>[^]*<a href="\/settings#agents.hub">\[hub.quiet.connect\]<\/a>/,
    );
  });

  it("a 403 with a plan code: the quiet plan line, no card", async () => {
    const { hubWorkCardHtml } = await mod();
    const html = hubWorkCardHtml(
      {
        hub: "refused",
        plan: true,
        code: "groups_not_in_plan",
        error: "Groups aren't in your plan",
      },
      tt,
    );
    expect(html).not.toContain("hub-work-card");
    expect(html).toMatch(
      /<p class="[^"]*hub-quiet[^"]*"[^>]*data-hub-quiet="plan"/,
    );
    expect(html).toContain("[hub.quiet.plan]");
    expect(html).not.toContain("hub.quiet.refused");
  });

  it("any other 403: Hub refused: <error> (escaped), no card", async () => {
    const { hubWorkCardHtml } = await mod();
    const html = hubWorkCardHtml(
      { hub: "refused", plan: false, code: "forbidden", error: "No <b>" },
      tt,
    );
    expect(html).not.toContain("hub-work-card");
    expect(html).toMatch(/data-hub-quiet="refused"/);
    expect(html).toContain("[hub.quiet.refused:No &lt;b&gt;]");
    expect(html).not.toContain("hub.quiet.plan");
  });

  it("Hub has nothing for any project: nothing at all", async () => {
    const { hubWorkCardHtml } = await mod();
    expect(
      hubWorkCardHtml(
        { hub: "ok", projects: [{ project: "a", work: null }] },
        tt,
      ),
    ).toBe("");
    expect(hubWorkCardHtml(null, tt)).toBe("");
  });
});

describe("hubCurrentHtml", () => {
  const item = {
    id: "i1",
    title: "Card <b>",
    kind: "story",
    url: "https://hub.example/i/1",
  };
  const vision = { id: "v", title: "Vision", url: "https://hub.example/v" };
  it("working: Working on {item}, a Kind chip and the vision, opening Hub", async () => {
    const { hubCurrentHtml } = await mod();
    const html = hubCurrentHtml(
      { item, vision, source: "working", since: "2026-11-20T10:00:00Z" },
      tt,
    );
    expect(html).toContain('data-hubcurrent="working"');
    expect(html).toContain("[hw.workingOn:");
    expect(html).toMatch(
      /<a [^>]*href="https:\/\/hub.example\/i\/1"[^>]*>Card &lt;b&gt;<\/a>/,
    );
    expect(html).toMatch(/class="[^"]*hw-kind[^"]*" data-hw-kind>story</);
    expect(html).toMatch(/href="https:\/\/hub.example\/v"[^>]*>Vision</);
  });
  it("recent: Last on {item}", async () => {
    const { hubCurrentHtml } = await mod();
    const html = hubCurrentHtml(
      { item, vision: null, source: "recent", since: null },
      tt,
    );
    expect(html).toContain('data-hubcurrent="recent"');
    expect(html).toContain("[hw.lastOn:");
  });
  it("no item: nothing", async () => {
    const { hubCurrentHtml } = await mod();
    expect(hubCurrentHtml({ item: null, vision, source: "working" }, tt)).toBe(
      "",
    );
    expect(hubCurrentHtml(undefined, tt)).toBe("");
  });
});
