/**
 * Issue 750: the agents page's By group view (agent-groups.js), the parts
 * that need no browser (Spec GR v6, frame g-den-nohub; GR-T12, GR-T19).
 * Without Hub's groups, By project shows as today, with no By group switch
 * and no Message group, and one line by Hub's answer:
 * - no Hub: "Groups come with Den Hub." with Connect Den Hub;
 * - 403 groups_not_in_plan: not in the plan, with Open Hub;
 * - any other 403 (a guest): a guest, not shown here;
 * - no answer or 5xx: Can't reach Den Hub, with Try again.
 * With Hub's groups: a By project / By group switch; each group's kit
 * header (lead marked, opens the group in Hub, Message group to Hub's
 * composer); its members that are this Den's own agents (`here`), the
 * lead first; "Not in a group" for the rest; none at all: No groups yet,
 * with Open Groups in Hub.
 * An agent whose Hub tools failed to load: "Can't reach Hub" with Restart.
 * The browser half is gate/750.mjs. Invented names only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  byGroupSections,
  groupsLineHtml,
  groupsOffered,
  groupsViewHtml,
  viewSwitchHtml,
} from "../../../src/ui/server/public/agent-groups.js";

const t = (k: string, v: Record<string, unknown> = {}) =>
  `${k}${
    Object.keys(v).length
      ? `(${Object.entries(v)
          .map(([a, b]) => `${a}=${b}`)
          .join(",")})`
      : ""
  }`;

const row = (agent: string, extra: Record<string, unknown> = {}) => ({
  id: `s-${agent}`,
  kind: "agent",
  agent,
  workspace: "north",
  state: "running",
  ...extra,
});

const HUB = "https://hub.example.test/acme";
const OK = {
  state: "ok",
  rule: "advise",
  hub: HUB,
  groupsUrl: `${HUB}/groups`,
  groups: [
    {
      name: "Web Delivery",
      slug: "web-delivery",
      all: "web-delivery/all",
      address: "web-delivery/lead",
      lead: {
        name: "Web Review",
        kind: "agent",
        agentId: "review",
        here: true,
      },
      members: [
        {
          role: "planner",
          address: "web-delivery/planner",
          name: "Web Planner",
          kind: "agent",
          agentId: "planner",
          here: true,
        },
        {
          role: "review",
          address: "web-delivery/review",
          name: "Web Review",
          kind: "agent",
          agentId: "review",
          here: true,
        },
        // Another person's agent with an id this Den also has: not ours.
        {
          role: "solo",
          address: "web-delivery/solo",
          name: "Sam's Solo",
          kind: "agent",
          agentId: "solo",
        },
        {
          role: "owner",
          address: "web-delivery/owner",
          name: "Pat Example",
          kind: "person",
        },
      ],
      open: `${HUB}/groups/web-delivery`,
      compose: `${HUB}/groups/web-delivery?compose=1`,
    },
    {
      name: "Docs",
      slug: "docs",
      all: "docs/all",
      address: "docs/lead",
      lead: { name: "Pat Example", kind: "person", login: "pat" },
      members: [],
      open: `${HUB}/groups/docs`,
      compose: `${HUB}/groups/docs?compose=1`,
    },
  ],
};

describe("issue 750: without Hub's groups, one line and no group UI", () => {
  it("no Hub connected: Groups come with Den Hub, with Connect Den Hub", () => {
    const read = { state: "none" };
    expect(groupsOffered(read)).toBe(false);
    const h = groupsLineHtml(read, t);
    expect(h).toContain("ag.grp.noHub");
    expect(h).toContain('href="/settings#agents.hub"');
    expect(h).toContain("ag.grp.connect");
    expect(viewSwitchHtml(read, "group", t)).toBe("");
  });

  it("GR-T19: 403 groups_not_in_plan: not in the plan, with Open Hub", () => {
    const h = groupsLineHtml({ state: "unavailable", hub: HUB }, t);
    expect(h).toContain("ag.grp.notInPlan");
    expect(h).toContain(`href="${HUB}" target="_blank"`);
    expect(h).toContain("ag.grp.openHub");
    expect(h).not.toContain("ag.grp.noHub");
    expect(viewSwitchHtml({ state: "unavailable" }, "group", t)).toBe("");
  });

  it("GR-T19: any other 403: a guest, with no button", () => {
    const h = groupsLineHtml({ state: "refused" }, t);
    expect(h).toContain("ag.grp.guest");
    expect(h).not.toMatch(/<a |<button/);
    expect(viewSwitchHtml({ state: "refused" }, "group", t)).toBe("");
  });

  it("no answer or a 5xx: Can't reach Den Hub, with Try again", () => {
    for (const state of ["unreachable", "rejected"]) {
      const h = groupsLineHtml({ state }, t);
      expect(h).toContain("ag.grp.unreachable");
      expect(h).toContain('data-act="groups-retry"');
      expect(h).toContain("ag.grp.retry");
    }
  });

  it("not read yet: nothing at all", () => {
    expect(groupsLineHtml(null, t)).toBe("");
    expect(viewSwitchHtml(null, "group", t)).toBe("");
  });

  it("Hub's groups: no line, and the switch", () => {
    expect(groupsLineHtml(OK, t)).toBe("");
    expect(groupsOffered(OK)).toBe(true);
    const s = viewSwitchHtml(OK, "group", t);
    expect(s).toContain('data-by="project" aria-pressed="false"');
    expect(s).toContain('data-by="group" aria-pressed="true"');
    expect(s).toContain("ag.by.project");
    expect(s).toContain("ag.by.group");
  });
});

describe("issue 750 (GR-T12): By group", () => {
  const rows = [
    row("planner"),
    row("review"),
    row("solo"),
    {
      id: "sh-1",
      kind: "session",
      label: "zsh",
      workspace: "north",
      state: "running",
    },
  ];

  it("this Den's own members, lead first; the rest Not in a group", () => {
    const s = byGroupSections(rows, OK.groups);
    expect(
      s.groups.map((g) => [g.group.slug, g.rows.map((r) => r.id)]),
    ).toEqual([
      ["web-delivery", ["s-review", "s-planner"]],
      ["docs", []],
    ]);
    // "solo" shares an id with another person's agent: not in the group.
    expect(s.none.map((r) => r.id)).toEqual(["s-solo", "sh-1"]);
  });

  it("the kit header per group: lead marked, opens in Hub, Message group", () => {
    const h = groupsViewHtml(rows, OK.groups, {
      t,
      rowHtml: (r: { id: string }) => `<row ${r.id}>`,
      groupsUrl: OK.groupsUrl,
    });
    expect(h).toContain('class="den-grph" data-group="web-delivery"');
    expect(h).toContain(`href="${HUB}/groups/web-delivery" target="_blank"`);
    expect(h).toContain("ag.grp.lead(name=Web Review)");
    expect(h).toContain(
      `href="${HUB}/groups/web-delivery?compose=1" target="_blank"`,
    );
    expect(h).toContain("ag.grp.message");
    expect(h).toContain("ag.grp.empty");
    const notIn = h.indexOf("ag.grp.notIn");
    expect(notIn).toBeGreaterThan(h.indexOf('data-group="docs"'));
    expect(h.indexOf("<row s-solo>")).toBeGreaterThan(notIn);
    expect(h.indexOf("<row s-review>")).toBeLessThan(
      h.indexOf("<row s-planner>"),
    );
    expect(h).not.toContain("ag.grp.noGroups");
  });

  it("Hub has no groups: No groups yet, with Open Groups in Hub", () => {
    const h = groupsViewHtml(rows, [], {
      t,
      rowHtml: (r: { id: string }) => `<row ${r.id}>`,
      groupsUrl: OK.groupsUrl,
    });
    expect(h).toContain("ag.grp.noGroups");
    expect(h).toContain(`href="${HUB}/groups" target="_blank"`);
    expect(h).toContain("ag.grp.openGroups");
    expect(h).toContain("<row s-planner>");
  });
});
