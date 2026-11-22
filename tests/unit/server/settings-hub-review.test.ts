/**
 * Issue 646: Settings › Hub's review, the page half (pure): a row per
 * project with its target and why, Change on each, the picker as a list to
 * pick from (search, the suggestion on top, Use / Create instead / Cancel,
 * point 7), one button, Connect and link all, and what it sends; the
 * summary after. The browser suite walks it in a page; this holds the
 * words and the rules. Keys stand in for words (tt).
 */
import { describe, expect, it } from "@jest/globals";

const tt = (k: string, v?: Record<string, unknown>) =>
  `[${k}${v ? `:${Object.values(v).join("|")}` : ""}]`;
type Mod = {
  hubReviewAsks: (rows: unknown[], sel: Record<string, unknown>) => unknown[];
  hubReviewHtml: (v: Record<string, unknown>, t: typeof tt) => string;
  hubPickerHtml: (o: Record<string, unknown>, t: typeof tt) => string;
  hubReviewResultHtml: (r: unknown, company: string, t: typeof tt) => string;
  hubHtml: (b: unknown, f: unknown, t: typeof tt) => string;
};
const mod = () =>
  import("../../../src/ui/server/public/settings-registry.js") as unknown as Promise<Mod>;

const WEB = { id: "proj_web1", slug: "web", name: "Web" };
const DOCS = { id: "proj_docs1", slug: "docs", name: "Docs" };
const OTHER = { id: "proj_o1", slug: "other", name: "Other" };
const data = {
  ok: true,
  connected: true,
  projects: [WEB, DOCS, OTHER],
  rows: [
    {
      project: "north",
      name: "North",
      linked: null,
      proposal: { kind: "link", hub: WEB, why: "repo" },
    },
    {
      project: "south",
      name: "south",
      linked: null,
      proposal: { kind: "link", hub: DOCS, why: "name" },
    },
    {
      project: "east",
      name: "East",
      linked: null,
      proposal: { kind: "create", name: "East" },
    },
  ],
};

describe("issue 646: what Connect and link all sends", () => {
  it("each proposal, a person's change in its place; a pick waits", async () => {
    const { hubReviewAsks } = await mod();
    expect(hubReviewAsks(data.rows, {})).toEqual([
      { project: "north", hub: WEB.id },
      { project: "south", hub: DOCS.id },
      { project: "east", create: "East" },
    ]);
    expect(
      hubReviewAsks(data.rows, {
        south: { hub: OTHER.id },
        east: { hub: WEB.id },
      }),
    ).toEqual([
      { project: "north", hub: WEB.id },
      { project: "south", hub: OTHER.id },
      { project: "east", hub: WEB.id },
    ]);
    expect(
      hubReviewAsks(
        [
          {
            project: "west",
            linked: null,
            proposal: { kind: "pick", choices: [] },
          },
        ],
        {},
      ),
    ).toEqual([]);
  });

  it("a linked row goes only when changed", async () => {
    const { hubReviewAsks } = await mod();
    const rows = [{ project: "north", linked: WEB, proposal: null }];
    expect(hubReviewAsks(rows, {})).toEqual([]);
    expect(hubReviewAsks(rows, { north: { hub: WEB.id } })).toEqual([]);
    expect(hubReviewAsks(rows, { north: { hub: DOCS.id } })).toEqual([
      { project: "north", hub: DOCS.id },
    ]);
  });
});

describe("issue 646: the review", () => {
  it("a row per project with its target and why, Change on each, and one button", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml({ data, sel: {}, company: "Acme" }, tt);
    expect(html).toContain("[hubrv.title:Acme]");
    expect(html.match(/data-hub-rv-row=/g)).toHaveLength(3);
    expect(html).toContain("[hubrv.why.repo]");
    expect(html).toContain("[hubrv.why.name]");
    expect(html).toContain("[hubrv.create:East]");
    expect(html).toContain("[hubrv.why.new]");
    expect(html.match(/data-hub-rv-change=/g)).toHaveLength(3);
    expect(html).toMatch(/data-hub-rv-apply>\[hubrv.apply\]/);
    // Den's name, with its key beside it when they differ (point 9).
    expect(html).toContain(
      'North <span class="den-mono hub-rv-key">north</span>',
    );
  });

  it("all linked: says so, no button", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml(
      {
        data: {
          ...data,
          rows: [
            {
              project: "north",
              name: "north",
              linked: { ...WEB, why: "repo" },
              proposal: null,
            },
          ],
        },
        sel: {},
      },
      tt,
    );
    expect(html).toContain("[hubrv.allMatch:1]");
    expect(html).not.toContain("data-hub-rv-apply");
  });

  it("a link to another Hub is said on its row", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml(
      {
        data: {
          ...data,
          rows: [
            {
              ...data.rows[0],
              elsewhere: {
                name: "Web",
                origin: "https://old.example.test",
                company: "acme",
              },
            },
          ],
        },
        sel: {},
      },
      tt,
    );
    expect(html).toContain(
      "[hubrv.wasCo:Web|old.example.test|acme|[hubrv.why.repo]]",
    );
  });

  it("Hub not answering (mock v4, 2e): says so, Try again on each row, the button on screen but off", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml(
      {
        data: {
          ...data,
          connected: false,
          rows: data.rows.map((r) => ({ ...r, proposal: null })),
        },
        sel: {},
      },
      tt,
    );
    expect(html).toContain("[hubrv.offline]");
    expect(html.match(/data-hub-rv-retry=/g)).toHaveLength(3);
    expect(html).toMatch(/data-hub-rv-apply disabled>\[hubrv.apply\]/);
  });

  it("every row a clear match (mock v4, 2d): 'All N match', and the button stays", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml(
      { data: { ...data, rows: data.rows.slice(0, 2) }, sel: {} },
      tt,
    );
    expect(html).toContain("[hubrv.allMatch:2]");
    expect(html).toMatch(/data-hub-rv-apply>\[hubrv.apply\]/);
    // A create or a pick left: not "all match".
    expect(hubReviewHtml({ data, sel: {} }, tt)).not.toContain(
      "hubrv.allMatch",
    );
  });

  it("under the heading (mock v4, 2a): the Hub's host, the person's role and login", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml(
      {
        data,
        sel: {},
        company: "Acme",
        host: "hub.example.test",
        role: "owner",
        login: "sam",
      },
      tt,
    );
    expect(html).toContain(
      "data-hub-rv-sub>hub.example.test · [hubrv.youAre:[hubrv.role.owner]] · [hubrv.signedAs:sam]<",
    );
    const bare = hubReviewHtml({ data, sel: {}, host: "hub.example.test" }, tt);
    expect(bare).toContain("data-hub-rv-sub>hub.example.test<");
  });

  it("a member's creates go to an owner: the review says so", async () => {
    const { hubReviewHtml } = await mod();
    expect(hubReviewHtml({ data, sel: {}, owner: false }, tt)).toContain(
      "[hubrv.member:1]",
    );
    expect(hubReviewHtml({ data, sel: {}, owner: true }, tt)).not.toContain(
      "hubrv.member",
    );
  });

  it("Change opens the picker inside the row", async () => {
    const { hubReviewHtml } = await mod();
    const html = hubReviewHtml(
      { data, sel: {}, open: "south", picked: DOCS.id },
      tt,
    );
    expect(html).toContain('data-hub-pick="south"');
    expect(html.match(/data-hub-rv-change=/g)).toHaveLength(2);
  });
});

describe("issue 646 point 7: Choose a Hub project, a list to pick from", () => {
  it("search, the suggestion on top and tagged, every company project, Use / Create instead / Cancel", async () => {
    const { hubPickerHtml } = await mod();
    const html = hubPickerHtml(
      {
        project: "west",
        suggestions: [{ ...DOCS, why: "name" }],
        projects: [WEB, DOCS, OTHER],
        pickedId: DOCS.id,
        createName: "West",
      },
      tt,
    );
    expect(html).toContain("data-hub-pick-q");
    expect(html).toContain("[hubrv.search:3]");
    const ids = [...html.matchAll(/data-hub-pick-id="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(ids).toEqual([DOCS.id, WEB.id, OTHER.id]);
    expect(html).toContain("[hubrv.suggested]");
    expect(html).toMatch(
      /role="option" aria-selected="true" data-hub-pick-id="proj_docs1"/,
    );
    expect(html).toContain("[hubrv.use:Docs]");
    expect(html).toContain("[hubrv.createInstead:West]");
    expect(html).toContain("[hubrv.cancel]");
  });

  it("Hub has no projects: says so, rather than only Create", async () => {
    const { hubPickerHtml } = await mod();
    const html = hubPickerHtml(
      { project: "west", suggestions: [], projects: [], createName: "West" },
      tt,
    );
    expect(html).toContain("[hubrv.noProjects]");
    expect(html).toContain("[hubrv.createInstead:West]");
    expect(html).not.toContain("data-hub-pick-use");
  });
});

describe("issue 646: what Settings says Connect does", () => {
  it("not connected: Connect shows each project's suggestion, and the press links them (never 'Connect links')", async () => {
    const { hubHtml } = await mod();
    const html = hubHtml(
      { configured: true, state: "no_token", url: "https://hub.example.test" },
      null,
      tt,
    );
    const line = /data-hub-connect-does>([^<]*)</.exec(html)?.[1];
    expect(line).toBe(
      "After Connect, each project here shows its suggested Hub project. Check them, then press Connect and link all.",
    );
  });
});

describe("issue 646: done, and Switch company", () => {
  it("the summary: a line per link with why, the creates waiting, Hub's plan page", async () => {
    const { hubReviewResultHtml } = await mod();
    const html = hubReviewResultHtml(
      {
        linked: [{ project: "north", hub: WEB, why: "repo" }],
        creating: [{ project: "east", name: "East", slug: "east" }],
        plan: { url: "https://hub.example.test/plans/1" },
        skipped: [{ project: "south", code: "offline", why: "x" }],
      },
      "Acme",
      tt,
    );
    expect(html).toContain("[hubrv.doneTitle:Acme]");
    expect(html).toContain("[hubrv.linkedLine:north|Web|[hubrv.why.repo]]");
    expect(html).toContain("[hubrv.creatingLine:east|East]");
    expect(html).toContain("[hubrv.skip.offline:south|x]");
    expect(html).toContain('href="https://hub.example.test/plans/1"');
  });

  it("connected: Switch company starts the same Connect", async () => {
    const { hubHtml } = await mod();
    const html = hubHtml(
      {
        configured: true,
        connected: true,
        state: "connected",
        url: "https://hub.example.test",
        team: "Acme",
      },
      null,
      tt,
    );
    expect(html).toMatch(
      /data-hub-action="switch" data-hub-switch>\[hubrv.switch\]/,
    );
  });
});
